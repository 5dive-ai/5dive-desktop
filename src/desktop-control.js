// «Let my agent use this computer» (DIVE-9063, Windows only in slice 1).
//
// The owner's agent on their 5dive server asks for a snapshot of an app on this
// PC, or for a few steps (click, type, press…). The box queues the job; this app
// fetches it, runs the bundled agent-desktop binary (vercel-labs/agent-desktop,
// UI Automation), and sends the result back. No port opens on the PC: the app
// reaches the box the same way its inbox badge does (inbox.js), from inside the
// signed-in page, through the API exec tunnel.
//
//   _poll --computer=<uuid> --name=<host> --wait=20 --json  → {jobs:[…], cancel:[…]}
//   _result --id=<id> --json   (stdin: the result JSON, ≤ 64 KB)
//   _stopped --computer=<uuid> --json   (the owner pressed Stop)
//
// Rules this file keeps:
// - The switch is OFF until the owner turns it on in the app. Nothing the server
//   sends can turn it on, and while it is off not one poll goes out.
// - The app runs what it is handed: which kinds of step need the owner's OK is
//   decided on the box, before a job is queued.
// - Stop kills agent-desktop at once, drops every queued job and tells the box.
// - The activity list keeps metadata only: no snapshot content, and typed text
//   only as its length.
//
// Everything here is plain logic with exec / spawn / kill injected, so the tests
// run it on any machine; main.js wires it to Electron.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const WAIT_S = 20; // long-poll length the box holds a _poll open
const MAX_RESULT_BYTES = 64_000; // the exec tunnel's stdin cap is 64 KB; keep a margin
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024; // one agent-desktop run's stdout, before we give up on it
const STEP_TIMEOUT_MS = 120_000;
const ACTIVITY_CAP = 200;
const BACKOFF = { signedOut: 30_000, min: 2_000, max: 60_000, quick: 2_000 };

// ---------------------------------------------------------------------------
// The switch and the computer id: one small file in userData.
// ---------------------------------------------------------------------------

/** → { enabled, computerId }. A missing or odd file reads as OFF; a new id is made once and kept. */
function readSwitch(file) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  const id = raw && typeof raw.computerId === "string" && /^[0-9a-f-]{36}$/i.test(raw.computerId) ? raw.computerId : null;
  const s = { enabled: !!(raw && raw.enabled === true), computerId: id || crypto.randomUUID() };
  if (!id) writeSwitch(file, s);
  return s;
}

function writeSwitch(file, s) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ enabled: !!s.enabled, computerId: s.computerId }, null, 2));
  } catch {
    // A read-only data folder: the choice holds until the app quits.
  }
}

/**
 * Where the bundled agent-desktop is: resources/agent-desktop/ in the installed
 * app (electron-builder extraResources, Windows build only), third_party/ in a
 * checkout. FIVEDIVE_AGENT_DESKTOP points somewhere else (tests).
 */
function agentDesktopPath({ env = {}, packaged, resourcesPath, appRoot }) {
  if (env.FIVEDIVE_AGENT_DESKTOP) return env.FIVEDIVE_AGENT_DESKTOP;
  const dir = packaged ? path.join(resourcesPath, "agent-desktop") : path.join(appRoot, "third_party", "agent-desktop");
  return path.join(dir, "agent-desktop.exe");
}

// ---------------------------------------------------------------------------
// The step table: the contract's `do` values → real agent-desktop commands.
// One place, so the box half and this half can be read side by side.
// headed: Windows refuses these headless (they take focus or synthesize keys).
// ---------------------------------------------------------------------------

const REF = /^@[A-Za-z0-9][A-Za-z0-9:_.-]{0,95}$/;
const KEYS = /^[A-Za-z0-9+ _-]{1,64}$/;

const refOnly = (cmd, headed = false) => ({
  headed,
  build: (s) => (needRef(s), { args: [cmd, s.ref] }),
});

const STEPS = {
  click: refOnly("click"),
  "double-click": refOnly("double-click", true),
  "right-click": refOnly("right-click", true),
  // type inserts at the caret, as a person typing would; Windows needs --headed for it.
  // The text goes in on stdin, never in the process arguments.
  type: { headed: true, build: (s) => (needRef(s), { args: ["type", s.ref, "--stdin"], stdin: needText(s) }) },
  // set replaces the field's whole value (headless).
  set: { headed: false, build: (s) => (needRef(s), { args: ["set-value", s.ref, "--stdin"], stdin: needText(s) }) },
  clear: refOnly("clear"),
  focus: refOnly("focus", true),
  select: { headed: false, build: (s) => (needRef(s), { args: ["select", s.ref, needValue(s)] }) },
  toggle: refOnly("toggle"),
  check: refOnly("check"),
  uncheck: refOnly("uncheck"),
  expand: refOnly("expand"),
  collapse: refOnly("collapse"),
  "scroll-to": refOnly("scroll-to"),
  scroll: {
    headed: false,
    build: (s) => {
      needRef(s);
      const dir = ["up", "down", "left", "right"].includes(s.direction) ? s.direction : "down";
      return { args: ["scroll", s.ref, "--direction", dir] };
    },
  },
  // A scoped press to an app that is not in front needs --headed on Windows.
  press: {
    headed: (s) => !!s.app,
    build: (s) => {
      const keys = String(s.keys || "");
      if (!KEYS.test(keys)) throw new Error("press needs keys, e.g. ctrl+s");
      return { args: ["press", keys.toLowerCase().replace(/\s+/g, ""), ...appArg(s.app)] };
    },
  },
  launch: {
    headed: false,
    build: (s) => {
      const app = String(s.app || "");
      if (!app || app.startsWith("-")) throw new Error("launch needs an app, e.g. notepad.exe");
      return { args: ["launch", app] };
    },
  },
  // A pause between two steps.
  wait: {
    headed: false,
    build: (s) => {
      const ms = Number(s.ms);
      if (!Number.isInteger(ms) || ms < 0 || ms > 600_000) throw new Error("wait needs ms between 0 and 600000");
      return { args: ["wait", String(ms)], timeoutMs: ms + 30_000 };
    },
  },
};

function needRef(s) {
  if (!REF.test(String(s.ref || ""))) throw new Error("this step needs a ref from the last snapshot, e.g. @s8f3k2p9:e3");
}
function needText(s) {
  const t = typeof s.text === "string" ? s.text : "";
  if (Buffer.byteLength(t) > 10_000) throw new Error("text is over 10000 bytes");
  return t;
}
function needValue(s) {
  const v = s.value != null ? String(s.value) : typeof s.text === "string" ? s.text : "";
  if (!v || v.startsWith("-")) throw new Error("select needs a value");
  return v;
}
function appArg(app) {
  const a = String(app || "");
  return a && !a.startsWith("-") ? ["--app", a] : [];
}

/** One step → { args, stdin?, timeoutMs } for agent-desktop, or throws a sentence the agent reads. */
function stepCommand(step) {
  const s = step && typeof step === "object" ? step : {};
  const def = Object.prototype.hasOwnProperty.call(STEPS, s.do) ? STEPS[s.do] : null;
  if (!def) throw new Error(`unknown step "${String(s.do || "")}"; known: ${Object.keys(STEPS).join(", ")}`);
  const cmd = def.build(s);
  const headed = typeof def.headed === "function" ? def.headed(s) : def.headed;
  return { args: headed ? ["--headed", ...cmd.args] : cmd.args, stdin: cmd.stdin, timeoutMs: cmd.timeoutMs || STEP_TIMEOUT_MS };
}

function snapshotCommand(app, interactive) {
  return { args: ["snapshot", ...appArg(app), ...(interactive ? ["-i"] : [])], timeoutMs: STEP_TIMEOUT_MS };
}

// ---------------------------------------------------------------------------
// agent-desktop prints one JSON envelope: { ok, command, data } or { ok:false, error:{code,message} }.
// ---------------------------------------------------------------------------

function parseJson(stdout) {
  const s = String(stdout || "").trim();
  if (!s) return null;
  const lines = s.split(/\r?\n/).filter(Boolean);
  for (const c of [s, lines[lines.length - 1]]) {
    if (!c) continue;
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object") return v;
    } catch {}
  }
  return null;
}

/** A finished run → { ok, data?, error?, code? }. */
function readRun(run) {
  if (run.stopped) return { ok: false, error: "stopped by the owner", code: "STOPPED" };
  if (run.timedOut) return { ok: false, error: "agent-desktop timed out", code: "TIMEOUT" };
  const env = parseJson(run.stdout);
  if (env && env.ok === true) return { ok: true, data: env.data };
  if (env && env.error) {
    const code = String(env.error.code || "ERROR");
    return { ok: false, error: clip(`${code}: ${env.error.message || ""}`, 2000), code };
  }
  const why = String(run.spawnError || run.stderr || `exit ${run.code}`).trim();
  return { ok: false, error: clip(`agent-desktop failed: ${why}`, 2000), code: "FAILED" };
}

function clip(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ---------------------------------------------------------------------------
// The 64 KB result cap: a big snapshot loses its deepest levels first (each cut
// container keeps `children_count`, agent-desktop's own skeleton convention),
// and the result says `truncated: true`.
// ---------------------------------------------------------------------------

const bytes = (v) => Buffer.byteLength(JSON.stringify(v));

function depthOf(node) {
  if (!node || typeof node !== "object" || !Array.isArray(node.children) || !node.children.length) return 0;
  let d = 0;
  for (const c of node.children) d = Math.max(d, depthOf(c));
  return d + 1;
}

function cutTree(node, depth) {
  if (!node || typeof node !== "object" || !Array.isArray(node.children)) return node;
  if (depth <= 0) {
    const { children, ...rest } = node;
    return children.length ? { ...rest, children_count: children.length } : rest;
  }
  return { ...node, children: node.children.map((c) => cutTree(c, depth - 1)) };
}

function fitResult(result, max = MAX_RESULT_BYTES) {
  if (bytes(result) <= max) return result;
  const snap = result.snapshot;
  if (snap && typeof snap === "object" && snap.tree && typeof snap.tree === "object") {
    for (let d = depthOf(snap.tree) - 1; d >= 0; d--) {
      const next = { ...result, truncated: true, snapshot: { ...snap, complete: false, tree: cutTree(snap.tree, d) } };
      if (bytes(next) <= max) return next;
    }
  }
  // Still too big (a flat tree of huge names, or an unknown shape): a cut string.
  const rest = { ...result, truncated: true, snapshot: "" };
  const room = Math.max(0, max - bytes(rest) - 64);
  let text = typeof snap === "string" ? snap : JSON.stringify(snap);
  text = text.slice(0, room);
  while (bytes({ ...rest, snapshot: text }) > max && text.length) text = text.slice(0, Math.floor(text.length * 0.9));
  return { ...rest, snapshot: text };
}

// ---------------------------------------------------------------------------
// The activity list: what the agent did on this PC, kept in userData.
// ---------------------------------------------------------------------------

/** One job → the line the owner sees. Typed text becomes its length; snapshots never appear. */
function activityEntry(job, outcome, when = new Date()) {
  const steps = Array.isArray(job.steps)
    ? job.steps.map((s) => {
        const o = { do: String((s && s.do) || "") };
        if (s && s.ref) o.ref = String(s.ref);
        if (s && s.kind) o.kind = String(s.kind);
        if (s && typeof s.text === "string") o.chars = [...s.text].length;
        if (s && s.keys) o.keys = String(s.keys);
        if (s && s.app) o.app = String(s.app);
        return o;
      })
    : [];
  const e = {
    time: when.toISOString(),
    agent: String(job.agent || ""),
    op: String(job.op || ""),
    app: String(job.app || ""),
    steps,
    outcome: outcome.outcome,
  };
  // The error CODE only: a message could quote what is on the screen.
  if (outcome.code) e.error = String(outcome.code);
  return e;
}

function readActivity(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function appendActivity(file, entry, cap = ACTIVITY_CAP) {
  const list = [entry, ...readActivity(file)].slice(0, cap);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list, null, 1));
  } catch {}
  return list;
}

// ---------------------------------------------------------------------------
// Reaching the box. In the app: a script run inside the signed-in page (like
// inbox.js). In the Windows e2e only: a loopback stand-in for the box.
// ---------------------------------------------------------------------------

/** The script the page runs: POST /api/proxy/server/agents/exec with {args, stdin}. Never throws. */
function pageExecScript(args, stdin, office = false) {
  const body = JSON.stringify(JSON.stringify(stdin == null ? { args } : { args, stdin }));
  if (office) {
    return `(async () => {
  try {
    const r = await fetch("/api/proxy/server/agents/exec", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: ${body},
    });
    if (r.status === 401) return { kind: "signed-out" };
    if (!r.ok) return { kind: "http", status: r.status };
    const j = await r.json().catch(() => null);
    return { kind: "exec", stdout: (j && j.stdout) || "", code: j && j.code };
  } catch (e) {
    return { kind: "error", message: String(e && e.message || e) };
  }
})()`;
  }
  return `(async () => {
  try {
    const C = window.Clerk;
    if (!C || !C.loaded) return { kind: "loading" };
    if (!C.session) return { kind: "signed-out" };
    const token = await C.session.getToken();
    const headers = { Authorization: "Bearer " + (token || ""), "Content-Type": "application/json" };
    try {
      const s = JSON.parse(localStorage.getItem("5dive_connectord_tokens") || "null");
      const t = s && s.active && s.tokens && s.tokens[s.active];
      if (t) headers["x-connectord-token"] = t;
    } catch (e) {}
    const r = await fetch("/api/proxy/server/agents/exec", { method: "POST", headers, body: ${body} });
    if (r.status === 401) return { kind: "signed-out" };
    if (!r.ok) return { kind: "http", status: r.status };
    const j = await r.json().catch(() => null);
    return { kind: "exec", stdout: (j && j.stdout) || "", code: j && j.code };
  } catch (e) {
    return { kind: "error", message: String(e && e.message || e) };
  }
})()`;
}

/**
 * FIVEDIVE_DESKTOP_RELAY: the Windows e2e's stand-in for the box. Only a loopback
 * http address counts, so it can never send the app's calls anywhere else; in
 * normal use it is not set and the page path is the only one.
 */
function relayFromEnv(env) {
  const v = env && env.FIVEDIVE_DESKTOP_RELAY;
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function relayExec(url, args, stdin, fetchFn = fetch) {
  try {
    const r = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stdin == null ? { args } : { args, stdin }),
    });
    if (r.status === 401) return { kind: "signed-out" };
    if (!r.ok) return { kind: "http", status: r.status };
    const j = await r.json();
    return { kind: "exec", stdout: (j && j.stdout) || "", code: j && j.code };
  } catch (e) {
    return { kind: "error", message: String((e && e.message) || e) };
  }
}

/** An exec answer to _poll → { state: "ok", jobs, cancel } | { state: "signed-out" } | { state: "error" }. */
function readPoll(result) {
  if (!result || typeof result !== "object") return { state: "error" };
  if (result.kind === "signed-out") return { state: "signed-out" };
  if (result.kind !== "exec") return { state: result.kind === "loading" || result.kind === "not-ready" ? "signed-out" : "error" };
  if (result.code != null && Number(result.code) !== 0) return { state: "error" };
  const v = parseJson(result.stdout);
  const d = v && (Array.isArray(v.jobs) ? v : v.data && typeof v.data === "object" ? v.data : null);
  if (!d) return { state: "error" };
  const jobs = (Array.isArray(d.jobs) ? d.jobs : []).filter((j) => j && typeof j.id === "string" && j.id && (j.op === "snapshot" || j.op === "act"));
  const cancel = (Array.isArray(d.cancel) ? d.cancel : []).map(String);
  return { state: "ok", jobs, cancel };
}

// ---------------------------------------------------------------------------
// The controller: poll loop, job queue, the running child, Stop.
// ---------------------------------------------------------------------------

function realSleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.wake = () => (clearTimeout(t), resolve());
  });
}

/**
 * deps:
 *   exec(args, stdin) → Promise<{kind:"exec",stdout,code}|{kind:"signed-out"}|…>
 *   spawn(bin, args) → ChildProcess-like (pid, stdout, stderr, stdin, on("close"|"error"))
 *   kill(child) — kill it and its children at once
 *   binPath() → the agent-desktop executable
 *   computer → { id, name }
 *   onState({ enabled, running, job }) / onActivity(entry) — optional
 *   sleep(ms, signal) — optional, for tests
 */
function createController(deps) {
  const sleep = deps.sleep || realSleep;
  const onState = deps.onState || (() => {});
  const onActivity = deps.onActivity || (() => {});
  let enabled = false;
  let loopToken = 0; // a new loop per switch-on; an old one sees the change and ends
  let gen = 0; // bumped by Stop: a poll that left before it hands back nothing to run
  const queue = [];
  let running = null; // { job, aborted }
  let child = null;
  let working = false;
  let wakeSignal = null;
  const stats = { polls: 0 };

  const state = () => ({ enabled, running: !!running, job: running ? running.job : null, queued: queue.length });
  const emit = () => onState(state());
  const cmd = (...a) => ["desktop", ...a];

  function setEnabled(on) {
    on = !!on;
    if (on === enabled) return;
    enabled = on;
    if (on) {
      const token = ++loopToken;
      loop(token);
    } else {
      loopToken++;
      if (wakeSignal && wakeSignal.wake) wakeSignal.wake();
      // Turning it off mid-job is a Stop.
      if (running || queue.length) stop();
    }
    emit();
  }

  async function loop(token) {
    let delay = BACKOFF.min;
    while (enabled && token === loopToken) {
      const myGen = gen;
      const started = Date.now();
      stats.polls++;
      let res;
      try {
        res = readPoll(
          await deps.exec(cmd("_poll", `--computer=${deps.computer.id}`, `--name=${deps.computer.name}`, `--wait=${WAIT_S}`, "--json")),
        );
      } catch {
        res = { state: "error" };
      }
      if (!enabled || token !== loopToken || myGen !== gen) {
        // Switched off or Stopped while this poll was out: its jobs are not run.
        if (res.state === "ok") refuse(res.jobs);
        if (!enabled || token !== loopToken) return;
        continue;
      }
      let pause = 0;
      if (res.state === "ok") {
        delay = BACKOFF.min;
        handleCancel(res.cancel);
        for (const j of res.jobs) queue.push(j);
        if (res.jobs.length) work();
        // A box that answers at once with nothing: do not spin.
        else if (Date.now() - started < 1000) pause = BACKOFF.quick;
      } else if (res.state === "signed-out") {
        pause = BACKOFF.signedOut;
      } else {
        pause = delay;
        delay = Math.min(delay * 2, BACKOFF.max);
      }
      if (pause) {
        wakeSignal = {};
        await sleep(pause, wakeSignal);
        wakeSignal = null;
      }
    }
  }

  function refuse(jobs) {
    for (const j of jobs) sendResult(j, { ok: false, op: j.op, error: "stopped by the owner", steps: [] });
  }

  function handleCancel(ids) {
    if (!ids || !ids.length) return;
    const set = new Set(ids);
    for (let i = queue.length - 1; i >= 0; i--) if (set.has(queue[i].id)) queue.splice(i, 1);
    if (running && set.has(running.job.id)) {
      running.aborted = "cancel";
      killChild();
    }
  }

  async function sendResult(job, result) {
    try {
      await deps.exec(cmd("_result", `--id=${job.id}`, "--json"), JSON.stringify(fitResult(result)));
    } catch {}
  }

  function killChild() {
    if (!child) return;
    try {
      deps.kill(child);
    } catch {}
  }

  async function work() {
    if (working) return;
    working = true;
    try {
      while (queue.length && enabled) {
        const job = queue.shift();
        running = { job, aborted: false };
        emit();
        const r = running;
        let result;
        try {
          result = await runJob(job, r);
        } catch (e) {
          result = { ok: false, op: job.op, steps: [], error: String((e && e.message) || e) };
        }
        running = null;
        if (r.aborted === "stop") {
          onActivity(activityEntry(job, { outcome: "stopped", code: "STOPPED" }));
        } else {
          if (r.aborted === "cancel") result = { ok: false, op: job.op, steps: result.steps || [], error: "cancelled" };
          await sendResult(job, result);
          onActivity(activityEntry(job, { outcome: result.ok ? "ok" : "failed", code: result.ok ? null : result.code || "FAILED" }));
        }
        emit();
      }
    } finally {
      working = false;
      running = null;
    }
  }

  function run(command, r) {
    return new Promise((resolve) => {
      if (r.aborted) return resolve({ stopped: true });
      let out = [];
      let outBytes = 0;
      let err = "";
      let timedOut = false;
      let done = false;
      let c;
      try {
        c = deps.spawn(deps.binPath(), command.args);
      } catch (e) {
        return resolve({ spawnError: String((e && e.message) || e), code: -1 });
      }
      child = c;
      const finish = (extra) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (child === c) child = null;
        resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: err, timedOut, stopped: !!r.aborted, ...extra });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          deps.kill(c);
        } catch {}
      }, command.timeoutMs || STEP_TIMEOUT_MS);
      if (c.stdout)
        c.stdout.on("data", (d) => {
          outBytes += d.length;
          if (outBytes <= MAX_OUTPUT_BYTES) out.push(Buffer.from(d));
        });
      if (c.stderr) c.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
      c.on("error", (e) => finish({ spawnError: String((e && e.message) || e), code: -1 }));
      c.on("close", (code) => finish({ code }));
      if (c.stdin) {
        c.stdin.on("error", () => {});
        c.stdin.end(command.stdin != null ? command.stdin : undefined);
      }
    });
  }

  async function snapshot(app, interactive, r) {
    return readRun(await run(snapshotCommand(app, interactive), r));
  }

  async function runJob(job, r) {
    if (job.op === "snapshot") {
      const s = await snapshot(job.app, job.interactive, r);
      return s.ok ? { ok: true, op: "snapshot", snapshot: s.data } : { ok: false, op: "snapshot", error: s.error, code: s.code };
    }
    const steps = [];
    let failed = null;
    let lastApp = job.app || "";
    for (const step of Array.isArray(job.steps) ? job.steps : []) {
      if (step && step.app) lastApp = String(step.app);
      let command;
      try {
        command = stepCommand(step);
      } catch (e) {
        failed = { error: e.message, code: "INVALID_STEP" };
        steps.push({ ok: false, error: e.message });
        break;
      }
      const res = readRun(await run(command, r));
      if (!res.ok) {
        failed = res;
        steps.push({ ok: false, error: res.error });
        break;
      }
      steps.push({ ok: true });
    }
    if (r.aborted) return { ok: false, op: "act", steps, error: "stopped by the owner", code: "STOPPED" };
    // A fresh look at the same app, so the agent sees what its steps did.
    const s = await snapshot(job.app || lastApp, job.interactive, r);
    const result = { ok: !failed, op: "act", steps };
    if (s.ok) result.snapshot = s.data;
    if (failed) {
      result.error = failed.error;
      result.code = failed.code;
    } else if (!s.ok) {
      result.snapshot_error = s.error;
    }
    return result;
  }

  /** The owner pressed Stop: kill the child now, drop the queue, tell the box. */
  async function stop() {
    gen++;
    const dropped = queue.splice(0, queue.length);
    if (running) {
      running.aborted = "stop";
      killChild();
    }
    for (const j of dropped) onActivity(activityEntry(j, { outcome: "stopped", code: "STOPPED" }));
    emit();
    try {
      await deps.exec(cmd("_stopped", `--computer=${deps.computer.id}`, "--json"));
    } catch {}
  }

  return { setEnabled, stop, state, stats, _queue: queue };
}

module.exports = {
  WAIT_S,
  MAX_RESULT_BYTES,
  STEPS,
  readSwitch,
  writeSwitch,
  agentDesktopPath,
  stepCommand,
  snapshotCommand,
  readRun,
  fitResult,
  activityEntry,
  readActivity,
  appendActivity,
  pageExecScript,
  relayFromEnv,
  relayExec,
  readPoll,
  createController,
};
