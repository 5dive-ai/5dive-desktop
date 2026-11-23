const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const dc = require("../src/desktop-control");

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "5dive-dc-")), name);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await pause(5);
  }
  assert.fail(`timed out waiting for: ${what}`);
}

// A stand-in for agent-desktop: answer(args, stdin) → { stdout, code } or "hang".
function fakeSpawn(answer) {
  const runs = [];
  const killed = [];
  let pid = 1000;
  const spawn = (bin, args) => {
    const c = new EventEmitter();
    c.pid = ++pid;
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    const run = { bin, args, stdin: undefined, child: c };
    runs.push(run);
    c.stdin = {
      on() {},
      end(data) {
        run.stdin = data;
        setImmediate(() => {
          const a = answer(args, data);
          if (a === "hang") return;
          c.stdout.emit("data", Buffer.from(a.stdout || ""));
          c.emit("close", a.code || 0);
        });
      },
    };
    return c;
  };
  const kill = (c) => {
    killed.push(c.pid);
    setImmediate(() => c.emit("close", null));
  };
  return { spawn, kill, runs, killed };
}

// A stand-in for the box over the exec tunnel. A poll with nothing pending is held
// (a long-poll) until release().
function fakeBox() {
  const calls = [];
  let held = [];
  const answer = (jobs, cancel = []) => ({ kind: "exec", stdout: JSON.stringify({ jobs, cancel }), code: 0 });
  const box = {
    calls,
    pending: [], // job batches handed to the next polls
    exec: async (args, stdin) => {
      calls.push({ args, stdin });
      if (args[1] === "_poll") {
        if (box.pending.length) return answer(box.pending.shift());
        return new Promise((r) => held.push(r));
      }
      return { kind: "exec", stdout: '{"ok":true}', code: 0 };
    },
    release(jobs = [], cancel = []) {
      const h = held;
      held = [];
      for (const r of h) r(answer(jobs, cancel));
    },
    heldCount: () => held.length,
    of: (op) => calls.filter((c) => c.args[1] === op),
  };
  return box;
}

const snapEnv = (data) => JSON.stringify({ version: "2.6", ok: true, command: "snapshot", data });
const okEnv = (command) => JSON.stringify({ version: "2.6", ok: true, command, data: { action: command } });
const NOTEPAD = {
  app: "notepad.exe",
  snapshot_id: "s1",
  ref_count: 1,
  complete: true,
  tree: { role: "window", name: "Untitled - Notepad", children: [{ role: "document", ref_id: "@s1:e1", value: "" }] },
};
const COMPUTER = { id: "11111111-2222-4333-8444-555555555555", name: "OFFICE-PC" };

function controller(box, sp, platform = "linux") {
  const activity = [];
  const states = [];
  const c = dc.createController({
    platform,
    exec: (args, stdin) => box.exec(args, stdin),
    spawn: sp.spawn,
    kill: sp.kill,
    binPath: () => "C:\\5dive\\resources\\agent-desktop\\agent-desktop.exe",
    computer: COMPUTER,
    onActivity: (e) => activity.push(e),
    onState: (s) => states.push(s),
    sleep: () => pause(1),
  });
  return { c, activity, states };
}

// --- the switch ---------------------------------------------------------------

test("the switch is OFF by default and keeps one random computer id", () => {
  const file = tmp("desktop-control.json");
  const a = dc.readSwitch(file);
  assert.equal(a.enabled, false);
  assert.match(a.computerId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(dc.readSwitch(file), a, "the id is kept, not made again");
  dc.writeSwitch(file, { ...a, enabled: true });
  assert.equal(dc.readSwitch(file).enabled, true);
  // Anything but a real true reads as off.
  for (const v of ['{"enabled":"true"}', '{"enabled":1}', "not json", "[]"]) {
    fs.writeFileSync(file, v);
    assert.equal(dc.readSwitch(file).enabled, false, v);
  }
});

test("while the switch is off, not one poll goes out", async () => {
  const box = fakeBox();
  const sp = fakeSpawn(() => ({ stdout: "" }));
  const { c } = controller(box, sp);
  await pause(30);
  assert.equal(box.calls.length, 0);
  assert.equal(c.state().enabled, false);
  c.setEnabled(true);
  await until(() => box.of("_poll").length === 1, "first poll");
  assert.deepEqual(box.of("_poll")[0].args, ["desktop", "_poll", `--computer=${COMPUTER.id}`, "--name=OFFICE-PC", "--wait=20", "--json"]);
  c.setEnabled(false);
  box.release();
  await pause(30);
  assert.equal(box.of("_poll").length, 1, "no poll after switching off");
});

test("the server cannot turn the switch on: a poll answer carries no switch", () => {
  const r = dc.readPoll({ kind: "exec", stdout: JSON.stringify({ jobs: [], cancel: [], enabled: true, enable: true }), code: 0 });
  assert.deepEqual(r, { state: "ok", jobs: [], cancel: [] });
});

test("the bundled agent-desktop: resources in the installed app, an env override for tests", () => {
  const packaged = dc.agentDesktopPath({ packaged: true, resourcesPath: path.join("C:", "5dive", "resources"), appRoot: "x" });
  assert.equal(packaged, path.join("C:", "5dive", "resources", "agent-desktop", "agent-desktop.exe"));
  assert.equal(dc.agentDesktopPath({ packaged: false, appRoot: "/src/5dive" }), path.join("/src/5dive", "third_party", "agent-desktop", "agent-desktop.exe"));
  assert.equal(dc.agentDesktopPath({ env: { FIVEDIVE_AGENT_DESKTOP: "/tmp/ad" }, packaged: true, resourcesPath: "r" }), "/tmp/ad");
});

// --- jobs ---------------------------------------------------------------------

test("a snapshot job runs agent-desktop and sends its data back as _result", async () => {
  const box = fakeBox();
  box.pending.push([{ id: "j1", op: "snapshot", app: "notepad.exe", interactive: true, agent: "main" }]);
  const sp = fakeSpawn(() => ({ stdout: snapEnv(NOTEPAD) }));
  const { c, activity } = controller(box, sp);
  c.setEnabled(true);
  await until(() => box.of("_result").length === 1, "_result");
  assert.deepEqual(sp.runs[0].args, ["snapshot", "--app", "notepad.exe", "-i"]);
  assert.equal(sp.runs[0].bin, "C:\\5dive\\resources\\agent-desktop\\agent-desktop.exe");
  const sent = box.of("_result")[0];
  assert.deepEqual(sent.args, ["desktop", "_result", "--id=j1", "--json"]);
  assert.deepEqual(JSON.parse(sent.stdin), { ok: true, op: "snapshot", snapshot: NOTEPAD });
  await until(() => activity.length === 1, "activity");
  assert.equal(activity[0].op, "snapshot");
  assert.equal(activity[0].agent, "main");
  assert.equal(activity[0].outcome, "ok");
  assert.ok(!JSON.stringify(activity).includes("Untitled"), "no snapshot content in the activity list");
  c.setEnabled(false);
  box.release();
});

test("an act job maps each step, types through stdin, then snapshots the same app", async () => {
  const box = fakeBox();
  box.pending.push([
    {
      id: "j2",
      op: "act",
      app: "notepad.exe",
      agent: "main",
      steps: [
        { do: "click", ref: "@s1:e1" },
        { do: "type", ref: "@s1:e1", text: "hello from 5dive", kind: "send" },
        { do: "press", keys: "Ctrl + S" },
      ],
    },
  ]);
  const sp = fakeSpawn((args) => (args.includes("snapshot") ? { stdout: snapEnv(NOTEPAD) } : { stdout: okEnv(args[0]) }));
  const { c, activity } = controller(box, sp);
  c.setEnabled(true);
  await until(() => box.of("_result").length === 1, "_result");
  assert.deepEqual(
    sp.runs.map((r) => r.args),
    [
      ["click", "@s1:e1"],
      ["--headed", "type", "@s1:e1", "--stdin"],
      ["press", "ctrl+s"],
      ["snapshot", "--app", "notepad.exe"],
    ],
  );
  assert.equal(sp.runs[1].stdin, "hello from 5dive", "typed text goes on stdin");
  assert.ok(!sp.runs.some((r) => r.args.includes("hello from 5dive")), "never in the process arguments");
  const res = JSON.parse(box.of("_result")[0].stdin);
  assert.equal(res.ok, true);
  assert.equal(res.op, "act");
  assert.deepEqual(res.steps, [{ ok: true }, { ok: true }, { ok: true }]);
  assert.deepEqual(res.snapshot, NOTEPAD);
  await until(() => activity.length === 1, "activity");
  assert.ok(!JSON.stringify(activity).includes("hello from 5dive"), "typed text is not in the activity list");
  c.setEnabled(false);
  box.release();
});

test("a failing step stops the job there and its error goes back", async () => {
  const box = fakeBox();
  box.pending.push([{ id: "j3", op: "act", app: "notepad.exe", steps: [{ do: "click", ref: "@s1:e9" }, { do: "click", ref: "@s1:e1" }] }]);
  const sp = fakeSpawn((args) =>
    args[0] === "click"
      ? { stdout: JSON.stringify({ ok: false, error: { code: "STALE_REF", message: "take a new snapshot" } }), code: 1 }
      : { stdout: snapEnv(NOTEPAD) },
  );
  const { c, activity } = controller(box, sp);
  c.setEnabled(true);
  await until(() => box.of("_result").length === 1, "_result");
  const res = JSON.parse(box.of("_result")[0].stdin);
  assert.equal(res.ok, false);
  assert.deepEqual(res.steps, [{ ok: false, error: "STALE_REF: take a new snapshot" }]);
  assert.equal(sp.runs.filter((r) => r.args[0] === "click").length, 1, "the second step never ran");
  await until(() => activity.length === 1, "activity");
  assert.equal(activity[0].outcome, "failed");
  assert.equal(activity[0].error, "STALE_REF");
  c.setEnabled(false);
  box.release();
});

test("the step table refuses unknown steps and flag-like values", () => {
  assert.throws(() => dc.stepCommand({ do: "rm" }), /unknown step/);
  assert.throws(() => dc.stepCommand({ do: "__proto__" }), /unknown step/);
  assert.throws(() => dc.stepCommand({ do: "click", ref: "--help" }), /needs a ref/);
  assert.throws(() => dc.stepCommand({ do: "click" }), /needs a ref/);
  assert.throws(() => dc.stepCommand({ do: "launch", app: "--cdp" }), /needs an app/);
  assert.throws(() => dc.stepCommand({ do: "press", keys: "ctrl+s; rm" }), /needs keys/);
  assert.deepEqual(dc.stepCommand({ do: "launch", app: "notepad.exe" }).args, ["launch", "notepad.exe"]);
  assert.deepEqual(dc.stepCommand({ do: "press", keys: "return", app: "notepad.exe" }).args, ["--headed", "press", "return", "--app", "notepad.exe"]);
  assert.deepEqual(dc.stepCommand({ do: "set", ref: "@s1:e1", text: "x" }), { args: ["set-value", "@s1:e1", "--stdin"], stdin: "x", timeoutMs: 120000 });
  assert.deepEqual(dc.stepCommand({ do: "focus", ref: "@s1:e1" }).args, ["--headed", "focus", "@s1:e1"]);
  assert.deepEqual(dc.stepCommand({ do: "wait", ms: 500 }).args, ["wait", "500"]);
});

// --- the box's argv --------------------------------------------------------------

test("a job in the box's shape: argv run as given, stdin from the step, snapshot_argv for the closing look", async () => {
  const box = fakeBox();
  box.pending.push([
    {
      id: "b1",
      op: "act",
      app: "notepad.exe",
      agent: "main",
      interactive: true,
      snapshot_argv: ["snapshot", "--app", "notepad.exe", "-i", "--compact"],
      steps: [
        { do: "click", ref: "@s1:e1", argv: ["click", "@s1:e1"] },
        { do: "type", ref: "@s1:e1", text: "hi there", argv: ["type", "@s1:e1", "--stdin"], stdin: "hi there" },
        { do: "scroll", ref: "@s1:e1", argv: ["scroll", "@s1:e1", "--direction", "down", "--amount", "3"] },
      ],
    },
  ]);
  const sp = fakeSpawn((args) => (args.includes("snapshot") ? { stdout: snapEnv(NOTEPAD) } : { stdout: okEnv(args[0]) }));
  const { c, activity } = controller(box, sp, "linux");
  c.setEnabled(true);
  await until(() => box.of("_result").length === 1, "_result");
  assert.deepEqual(
    sp.runs.map((r) => r.args),
    [["click", "@s1:e1"], ["type", "@s1:e1", "--stdin"], ["scroll", "@s1:e1", "--direction", "down", "--amount", "3"], ["snapshot", "--app", "notepad.exe", "-i", "--compact"]],
  );
  assert.equal(sp.runs[1].stdin, "hi there");
  assert.equal(JSON.parse(box.of("_result")[0].stdin).ok, true);
  await until(() => activity.length === 1, "activity");
  assert.equal(activity[0].steps[1].chars, 8);
  assert.ok(!JSON.stringify(activity).includes("hi there"));
  c.setEnabled(false);
  box.release();
});

test("on Windows the app adds --headed where agent-desktop refuses headless", () => {
  const w = (argv) => dc.argvCommand(argv, null, { platform: "win32" }).args;
  assert.deepEqual(w(["type", "@s1:e1", "--stdin"]), ["--headed", "type", "@s1:e1", "--stdin"]);
  assert.deepEqual(w(["right-click", "@s1:e1"]), ["--headed", "right-click", "@s1:e1"]);
  assert.deepEqual(w(["press", "return", "--app", "notepad.exe"]), ["--headed", "press", "return", "--app", "notepad.exe"]);
  assert.deepEqual(w(["press", "ctrl+s"]), ["press", "ctrl+s"]);
  assert.deepEqual(w(["--headed", "focus", "@s1:e1"]), ["--headed", "focus", "@s1:e1"], "never twice");
  assert.deepEqual(w(["click", "@s1:e1"]), ["click", "@s1:e1"]);
  assert.deepEqual(dc.argvCommand(["type", "@s1:e1", "--stdin"], null, { platform: "linux" }).args, ["type", "@s1:e1", "--stdin"]);
  assert.equal(dc.argvCommand(["wait", "30000"]).timeoutMs, 60000);
});

test("an argv outside the agent-desktop allowlist never runs", async () => {
  for (const argv of [["powershell", "-c", "x"], ["--headed", "mcp"], ["sandbox", "exec"], [], ["click", 3], "click @s1:e1"]) {
    assert.throws(() => dc.argvCommand(argv), /not/, JSON.stringify(argv));
  }
  assert.throws(() => dc.argvCommand(["click", "@s1:e1"], null, { only: "snapshot" }), /not a command/);
  const box = fakeBox();
  box.pending.push([{ id: "bad", op: "act", app: "x", steps: [{ do: "click", argv: ["cmd.exe", "/c", "calc"] }] }]);
  const sp = fakeSpawn(() => ({ stdout: snapEnv(NOTEPAD) }));
  const { c } = controller(box, sp);
  c.setEnabled(true);
  await until(() => box.of("_result").length === 1, "_result");
  const res = JSON.parse(box.of("_result")[0].stdin);
  assert.equal(res.ok, false);
  assert.match(res.steps[0].error, /cmd\.exe/);
  assert.ok(!sp.runs.some((r) => r.args[0] === "cmd.exe"), "never spawned");
  c.setEnabled(false);
  box.release();
});

test("a bad snapshot_argv falls back to the app's own snapshot", () => {
  assert.deepEqual(dc.snapshotFromBox({ snapshot_argv: ["click", "@s1:e1"], interactive: true }, "notepad.exe").args, ["snapshot", "--app", "notepad.exe", "-i"]);
  assert.deepEqual(dc.snapshotFromBox({ snapshot_argv: ["snapshot", "--app", "a", "--compact"] }, "b").args, ["snapshot", "--app", "a", "--compact"]);
});

test("a _result answered delivered:false is dropped quietly", async () => {
  const box = fakeBox();
  const exec = box.exec;
  box.exec = async (args, stdin) => (args[1] === "_result" ? (box.calls.push({ args, stdin }), { kind: "exec", stdout: '{"ok":true,"delivered":false}', code: 0 }) : exec(args, stdin));
  box.pending.push([{ id: "x1", op: "snapshot", app: "a" }, { id: "x2", op: "snapshot", app: "a" }]);
  const sp = fakeSpawn(() => ({ stdout: snapEnv(NOTEPAD) }));
  const { c } = controller(box, sp);
  c.setEnabled(true);
  await until(() => box.of("_result").length === 2, "both results sent, the queue carried on");
  c.setEnabled(false);
  box.release();
});

// --- truncation -----------------------------------------------------------------

test("a snapshot over 64 KB loses its deepest levels and says truncated", () => {
  const leaf = (i) => ({ role: "listitem", name: "x".repeat(200) + i, ref_id: `@s1:e${i}` });
  const tree = {
    role: "window",
    name: "Big",
    children: Array.from({ length: 50 }, (_, i) => ({ role: "group", name: `g${i}`, children: Array.from({ length: 20 }, (_, k) => leaf(i * 100 + k)) })),
  };
  const result = { ok: true, op: "snapshot", snapshot: { app: "big.exe", snapshot_id: "s1", complete: true, tree } };
  assert.ok(Buffer.byteLength(JSON.stringify(result)) > dc.MAX_RESULT_BYTES);
  const fit = dc.fitResult(result);
  assert.ok(Buffer.byteLength(JSON.stringify(fit)) <= dc.MAX_RESULT_BYTES);
  assert.equal(fit.truncated, true);
  assert.equal(fit.snapshot.complete, false);
  assert.equal(fit.snapshot.tree.children.length, 50, "the top levels stay");
  assert.equal(fit.snapshot.tree.children[0].children_count, 20, "a cut container keeps its count");
  // A small one is untouched.
  const small = { ok: true, op: "snapshot", snapshot: NOTEPAD };
  assert.deepEqual(dc.fitResult(small), small);
  // An unknown huge shape becomes a cut string, still valid JSON under the cap.
  const odd = dc.fitResult({ ok: true, op: "snapshot", snapshot: { blob: "y".repeat(200_000) } });
  assert.equal(odd.truncated, true);
  assert.equal(typeof odd.snapshot, "string");
  assert.ok(Buffer.byteLength(JSON.stringify(odd)) <= dc.MAX_RESULT_BYTES);
});

test("the _result sent for a huge snapshot is under the cap", async () => {
  const box = fakeBox();
  box.pending.push([{ id: "j4", op: "snapshot", app: "big.exe" }]);
  const tree = { role: "window", children: Array.from({ length: 400 }, (_, i) => ({ role: "group", children: [{ role: "text", name: "z".repeat(300) + i }] })) };
  const sp = fakeSpawn(() => ({ stdout: snapEnv({ app: "big.exe", tree }) }));
  const { c } = controller(box, sp);
  c.setEnabled(true);
  await until(() => box.of("_result").length === 1, "_result");
  const stdin = box.of("_result")[0].stdin;
  assert.ok(Buffer.byteLength(stdin) <= 64 * 1024);
  assert.equal(JSON.parse(stdin).truncated, true);
  c.setEnabled(false);
  box.release();
});

// --- Stop -------------------------------------------------------------------------

test("Stop kills the running child, drops the queue, calls _stopped and sends no result", async () => {
  const box = fakeBox();
  box.pending.push([
    { id: "long", op: "act", app: "notepad.exe", agent: "main", steps: [{ do: "wait", ms: 60000 }] },
    { id: "next", op: "snapshot", app: "notepad.exe", agent: "main" },
  ]);
  const sp = fakeSpawn((args) => (args[0] === "wait" ? "hang" : { stdout: snapEnv(NOTEPAD) }));
  const { c, activity, states } = controller(box, sp);
  c.setEnabled(true);
  await until(() => sp.runs.length === 1, "the long step started");
  assert.equal(c.state().running, true);
  assert.equal(c.state().queued, 1);
  assert.ok(states.some((s) => s.running && s.job.id === "long"), "the indicator was told");
  const t0 = Date.now();
  await c.stop();
  assert.deepEqual(sp.killed, [sp.runs[0].child.pid], "the child was killed");
  assert.deepEqual(box.of("_stopped")[0].args, ["desktop", "_stopped", `--computer=${COMPUTER.id}`, "--json"]);
  assert.ok(Date.now() - t0 < 500);
  await until(() => !c.state().running, "idle after Stop");
  await pause(20);
  assert.equal(sp.runs.length, 1, "the queued job never ran, and no snapshot after the kill");
  assert.equal(box.of("_result").length, 0, "no _result: the box already failed the jobs");
  assert.deepEqual(activity.map((a) => [a.op, a.outcome]).sort(), [["act", "stopped"], ["snapshot", "stopped"]]);
  assert.equal(c.state().enabled, true, "Stop does not turn the switch off");
  c.setEnabled(false);
  box.release();
});

test("jobs from a poll that was out when Stop was pressed are refused, not run", async () => {
  const box = fakeBox();
  const sp = fakeSpawn(() => ({ stdout: snapEnv(NOTEPAD) }));
  const { c } = controller(box, sp);
  c.setEnabled(true);
  await until(() => box.heldCount() === 1, "poll out");
  await c.stop();
  // The held poll comes back carrying a job claimed before the box saw Stop.
  box.release([{ id: "late", op: "snapshot", app: "notepad.exe" }]);
  await until(() => box.of("_result").length === 1, "refusal sent");
  assert.equal(sp.runs.length, 0, "never ran");
  const r = JSON.parse(box.of("_result")[0].stdin);
  assert.equal(r.ok, false);
  assert.match(r.error, /stopped/);
  assert.deepEqual(box.of("_result")[0].args, ["desktop", "_result", "--id=late", "--json"]);
  c.setEnabled(false);
  box.release();
});

test("turning the switch off mid-job is a Stop", async () => {
  const box = fakeBox();
  box.pending.push([{ id: "long", op: "act", app: "notepad.exe", steps: [{ do: "wait", ms: 60000 }] }]);
  const sp = fakeSpawn(() => "hang");
  const { c } = controller(box, sp);
  c.setEnabled(true);
  await until(() => sp.runs.length === 1, "running");
  c.setEnabled(false);
  await until(() => box.of("_stopped").length === 1, "_stopped");
  assert.equal(sp.killed.length, 1);
  box.release();
});

test("a cancel from the box kills that job and reports it, without _stopped", async () => {
  const box = fakeBox();
  box.pending.push([{ id: "c1", op: "act", app: "a", steps: [{ do: "wait", ms: 60000 }] }]);
  const sp = fakeSpawn((args) => (args[0] === "wait" ? "hang" : { stdout: snapEnv(NOTEPAD) }));
  const { c } = controller(box, sp);
  c.setEnabled(true);
  await until(() => sp.runs.length === 1 && box.heldCount() === 1, "running, next poll out");
  box.release([], ["c1"]);
  await until(() => box.of("_result").length === 1, "result for the cancelled job");
  assert.equal(sp.killed.length, 1);
  assert.equal(JSON.parse(box.of("_result")[0].stdin).error, "cancelled");
  assert.equal(box.of("_stopped").length, 0);
  c.setEnabled(false);
  box.release();
});

// --- redaction ----------------------------------------------------------------------

test("the activity list keeps metadata only: typed text becomes its length", () => {
  const job = {
    id: "j",
    op: "act",
    app: "notepad.exe",
    agent: "main",
    steps: [
      { do: "type", ref: "@s1:e1", text: "my secret password", kind: "send" },
      { do: "press", keys: "return" },
    ],
  };
  const e = dc.activityEntry(job, { outcome: "ok" }, new Date("2026-11-23T10:00:00Z"));
  assert.deepEqual(e, {
    time: "2026-11-23T10:00:00.000Z",
    agent: "main",
    op: "act",
    app: "notepad.exe",
    steps: [
      { do: "type", ref: "@s1:e1", kind: "send", chars: 18 },
      { do: "press", keys: "return" },
    ],
    outcome: "ok",
  });
  assert.ok(!JSON.stringify(e).includes("secret"));
  // Only the error code is kept, never a message that could quote the screen.
  assert.equal(dc.activityEntry(job, { outcome: "failed", code: "STALE_REF" }).error, "STALE_REF");
});

test("the activity file is capped and newest first", () => {
  const file = tmp("desktop-activity.json");
  for (let i = 0; i < 5; i++) dc.appendActivity(file, { n: i }, 3);
  assert.deepEqual(dc.readActivity(file), [{ n: 4 }, { n: 3 }, { n: 2 }]);
});

// --- reaching the box -------------------------------------------------------------------

test("the relay override is loopback http only, and absent in normal use", () => {
  assert.equal(dc.relayFromEnv({}), null);
  assert.equal(dc.relayFromEnv({ FIVEDIVE_DESKTOP_RELAY: "http://127.0.0.1:47123/exec" }), "http://127.0.0.1:47123/exec");
  assert.equal(dc.relayFromEnv({ FIVEDIVE_DESKTOP_RELAY: "https://relay.example.com/exec" }), null);
  assert.equal(dc.relayFromEnv({ FIVEDIVE_DESKTOP_RELAY: "http://192.0.2.5/exec" }), null);
  assert.equal(dc.relayFromEnv({ FIVEDIVE_DESKTOP_RELAY: "not a url" }), null);
});

test("the page script posts {args, stdin} to the exec tunnel, safely quoted", () => {
  const s = dc.pageExecScript(["desktop", "_result", "--id=j1", "--json"], '{"a":"</script>\\"x"}');
  assert.match(s, /\/api\/proxy\/server\/agents\/exec/);
  assert.match(s, /C\.session\.getToken\(\)/);
  assert.match(s, /x-connectord-token/);
  // The body literal evaluates back to exactly what we sent.
  const m = s.match(/body: ("(?:[^"\\]|\\.)*")/);
  assert.deepEqual(JSON.parse(JSON.parse(m[1])), { args: ["desktop", "_result", "--id=j1", "--json"], stdin: '{"a":"</script>\\"x"}' });
  const o = dc.pageExecScript(["desktop", "_poll"], null, true);
  assert.match(o, /credentials: "same-origin"/);
  assert.doesNotMatch(o, /Clerk/);
});

test("poll answers: jobs, envelope form, signed-out and errors", () => {
  const job = { id: "a", op: "snapshot", app: "x" };
  assert.deepEqual(dc.readPoll({ kind: "exec", stdout: JSON.stringify({ jobs: [job], cancel: ["b"] }), code: 0 }), { state: "ok", jobs: [job], cancel: ["b"] });
  assert.deepEqual(dc.readPoll({ kind: "exec", stdout: JSON.stringify({ ok: true, data: { jobs: [job] } }) }), { state: "ok", jobs: [job], cancel: [] });
  assert.equal(dc.readPoll({ kind: "exec", stdout: JSON.stringify({ jobs: [{ id: "z", op: "format-disk" }] }) }).jobs.length, 0);
  assert.equal(dc.readPoll({ kind: "signed-out" }).state, "signed-out");
  assert.equal(dc.readPoll({ kind: "loading" }).state, "signed-out");
  assert.equal(dc.readPoll({ kind: "exec", stdout: "", code: 69 }).state, "error");
  assert.equal(dc.readPoll({ kind: "http", status: 502 }).state, "error");
  assert.equal(dc.readPoll(null).state, "error");
});

test("signed out or failing: the loop backs off instead of spinning", async () => {
  const sleeps = [];
  let n = 0;
  const exec = async () => (++n <= 2 ? { kind: "signed-out" } : { kind: "http", status: 502 });
  const sp = fakeSpawn(() => ({ stdout: "" }));
  const c = dc.createController({
    exec,
    spawn: sp.spawn,
    kill: sp.kill,
    binPath: () => "x",
    computer: { id: "i", name: "n" },
    sleep: (ms) => (sleeps.push(ms), pause(1)),
  });
  c.setEnabled(true);
  await until(() => sleeps.length >= 5, "five pauses");
  c.setEnabled(false);
  assert.deepEqual(sleeps.slice(0, 5), [30000, 30000, 2000, 4000, 8000]);
});
