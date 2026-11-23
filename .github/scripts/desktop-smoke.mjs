// «Let my agent use this computer» e2e (DIVE-9063), run by build.yml on a real
// Windows runner after the silent install. Drives the INSTALLED app.
//
// A small local http server stands in for the box: it answers the app's exec
// calls (_poll / _result / _stopped) and queues the jobs an agent would. The app
// is pointed at it with FIVEDIVE_DESKTOP_RELAY (loopback only, test-only); the
// switch is turned on through its real window over CDP.
//
//  1. the bundled agent-desktop is installed with its LICENSE and NOTICE;
//  2. the switch is OFF on a fresh install and no poll goes out; one click on it
//     and the app polls with its computer id and name;
//  3. snapshot Notepad → type "hello from 5dive" into its edit control by ref →
//     the fresh snapshot reads the text back;
//  4. a long step: the indicator shows; Stop on it kills agent-desktop and
//     _stopped reaches the box within 2 s; no result is sent for that job;
//  5. the activity list shows the steps, the typed text only as its length;
//  6. switched off: no more polls.
//
// Writes shots/desktop-*.png and shots/desktop-result.json; exits non-zero on any failed check.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const INSTALL = path.join(process.env.LOCALAPPDATA, "Programs", "5dive");
const EXE = path.join(INSTALL, "5dive.exe");
const AD_DIR = path.join(INSTALL, "resources", "agent-desktop");
const AD = path.join(AD_DIR, "agent-desktop.exe");
const USERDATA = path.join(process.env.APPDATA, "5dive");
const SWITCH = path.join(USERDATA, "desktop-control.json");
const ACTIVITY = path.join(USERDATA, "desktop-activity.json");
const SHOTS = path.resolve("shots");
const DEBUG_PORT = 9224;
const RELAY_PORT = 47231;
const TEXT = "hello from 5dive";
fs.mkdirSync(SHOTS, { recursive: true });

const result = { checks: [], box: [] };
let failed = false;
function check(name, ok, detail = "") {
  result.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 600) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + String(detail).slice(0, 600) : ""}`);
  if (!ok) failed = true;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ps(script) {
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim();
}
function shoot(name) {
  try {
    ps(`
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save('${path.join(SHOTS, name)}')`);
    console.log(`shot ${name}`);
  } catch (e) {
    check(`screenshot ${name}`, false, e.message);
  }
}
function adCount() {
  return Number(ps(`@(Get-Process agent-desktop -ErrorAction SilentlyContinue).Count`) || 0);
}
async function until(fn, ms, every = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  return null;
}

// --- the stand-in box ------------------------------------------------------------
const box = { calls: [], queue: [], waiters: [], results: new Map() };
const optOf = (args, name) => (args.find((a) => a.startsWith(`--${name}=`)) || "").slice(name.length + 3);
function flushWaiters() {
  const w = box.waiters.splice(0);
  for (const f of w) f();
}
function startBox() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      let j = {};
      try {
        j = JSON.parse(body);
      } catch {}
      const args = Array.isArray(j.args) ? j.args : [];
      const op = args[1];
      const call = { t: Date.now(), op, args, stdinBytes: j.stdin == null ? 0 : Buffer.byteLength(j.stdin) };
      box.calls.push(call);
      result.box.push({ t: call.t, op, args: args.slice(1), stdinBytes: call.stdinBytes });
      const reply = (out) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ stdout: JSON.stringify(out), code: 0 }));
      };
      if (args[0] !== "desktop") return reply({ ok: false });
      if (op === "_poll") {
        if (!box.queue.length) await new Promise((r) => (box.waiters.push(r), setTimeout(r, 5000)));
        return reply({ jobs: box.queue.splice(0), cancel: [] });
      }
      if (op === "_result") {
        let r = null;
        try {
          r = JSON.parse(j.stdin);
        } catch {}
        box.results.set(optOf(args, "id"), { t: Date.now(), r, bytes: call.stdinBytes });
        return reply({ ok: true });
      }
      if (op === "_stopped") return reply({ ok: true, stopped: true });
      return reply({ ok: false });
    });
  });
  return new Promise((r) => server.listen(RELAY_PORT, "127.0.0.1", () => r(server)));
}
function queue(job) {
  box.queue.push(job);
  flushWaiters();
}
async function resultOf(id, ms) {
  return until(() => box.results.get(id), ms, 200);
}
const polls = () => box.calls.filter((c) => c.op === "_poll");

// --- CDP ------------------------------------------------------------------------
async function targets() {
  try {
    return (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()).filter((t) => t.type === "page");
  } catch {
    return [];
  }
}
async function target(part, ms) {
  return until(async () => (await targets()).find((t) => t.url.includes(part)), ms, 250);
}
async function cdp(t, method, params = {}) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const out = await new Promise((resolve) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id === 1) resolve(msg);
    };
    ws.send(JSON.stringify({ id: 1, method, params }));
  });
  ws.close();
  return out;
}
async function evaluate(t, expression) {
  const r = await cdp(t, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
}
async function pageShot(t, name) {
  try {
    const r = await cdp(t, "Page.captureScreenshot", { format: "png" });
    if (r.result?.data) fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.result.data, "base64"));
  } catch (e) {
    console.log(`page shot ${name}: ${e.message}`);
  }
}

// --- the snapshot ------------------------------------------------------------------
function walk(node, fn, depth = 0) {
  if (!node || typeof node !== "object") return;
  fn(node, depth);
  for (const c of node.children || []) walk(c, fn, depth + 1);
}
function editRef(snapshot) {
  const found = [];
  walk(snapshot && snapshot.tree, (n) => {
    if (n.ref_id && /edit|text|document/i.test(n.role || "") && !/menu|bar|button/i.test(n.role || "")) found.push(n);
  });
  return found[0] || null;
}
function roles(snapshot) {
  const seen = new Map();
  walk(snapshot && snapshot.tree, (n) => seen.set(`${n.role}${n.ref_id ? "*" : ""}`, (seen.get(`${n.role}${n.ref_id ? "*" : ""}`) || 0) + 1));
  return [...seen].map(([k, v]) => `${k}:${v}`).join(" ");
}

function kill() {
  for (const im of ["5dive.exe", "agent-desktop.exe"]) {
    try {
      execFileSync("taskkill", ["/F", "/T", "/IM", im], { stdio: "ignore" });
    } catch {}
  }
}

async function main() {
  // 1. bundled
  check("agent-desktop is installed with the app", fs.existsSync(AD), AD);
  check("its Apache-2.0 LICENSE and NOTICE ship beside it", fs.existsSync(path.join(AD_DIR, "LICENSE")) && fs.existsSync(path.join(AD_DIR, "NOTICE")));
  try {
    result.agentDesktopVersion = execFileSync(AD, ["version"], { encoding: "utf8", timeout: 30000 }).trim();
    console.log(`agent-desktop version: ${result.agentDesktopVersion}`);
  } catch (e) {
    check("agent-desktop runs", false, e.message);
  }

  kill();
  await sleep(1500);
  fs.rmSync(SWITCH, { force: true });
  fs.rmSync(ACTIVITY, { force: true });
  const server = await startBox();

  const notepad = spawn("notepad.exe", [], { detached: true, stdio: "ignore" });
  notepad.unref();
  await sleep(2500);

  spawn(EXE, [`--remote-debugging-port=${DEBUG_PORT}`, "--desktop-control"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, FIVEDIVE_DESKTOP_RELAY: `http://127.0.0.1:${RELAY_PORT}/exec` },
  }).unref();

  // 2. the switch
  let panel = await target("desktop-control.html", 60000);
  check("«Let my agent use this computer» window opens", !!panel);
  if (!panel) return;
  await sleep(6000);
  const offState = await evaluate(panel, `document.getElementById("switch").getAttribute("aria-checked")`);
  check("the switch is OFF on a fresh install", offState === "false", offState);
  check("switch OFF: not one poll in 6 s", polls().length === 0, `${polls().length} polls`);
  shoot("desktop-0-switch-off.png");

  await evaluate(panel, `document.getElementById("switch").click(); true`);
  const first = await until(() => polls()[0], 10000);
  check("switch ON: the app polls", !!first);
  if (!first) return;
  const computer = optOf(first.args, "computer");
  check("the poll carries a computer id and this PC's name", /^[0-9a-f-]{36}$/.test(computer) && optOf(first.args, "name") === os.hostname(), first.args.join(" "));
  check("the poll asks the box to wait 20 s", first.args.includes("--wait=20") && first.args.includes("--json"), first.args.join(" "));
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(SWITCH, "utf8"));
  } catch {}
  check("the switch is saved on this computer", saved && saved.enabled === true && saved.computerId === computer, JSON.stringify(saved));
  await sleep(500);
  shoot("desktop-1-switch-on.png");
  await pageShot(panel, "desktop-1-switch-window.png");

  // 3. snapshot → type by ref → read back
  let app = null;
  let snap = null;
  for (const name of ["notepad.exe", "Notepad", "notepad"]) {
    const id = `snap-${name}`;
    queue({ id, op: "snapshot", app: name, agent: "ci" });
    const r = await resultOf(id, 60000);
    console.log(`snapshot ${name}: ${r ? (r.r.ok ? "ok" : r.r.error) : "no result"}`);
    if (r && r.r && r.r.ok) {
      app = name;
      snap = r.r;
      break;
    }
  }
  check("snapshot of Notepad came back", !!snap, app);
  if (!snap) return;
  const edit = editRef(snap.snapshot);
  check("the snapshot has Notepad's edit control with a ref", !!edit, edit ? `${edit.role} ${edit.ref_id}` : roles(snap.snapshot));
  if (!edit) return;

  queue({ id: "act-type", op: "act", app, agent: "ci", steps: [{ do: "type", ref: edit.ref_id, text: TEXT, kind: "send" }] });
  const typed = await resultOf("act-type", 90000);
  const typedOk = typed && typed.r && typed.r.ok;
  check("act: type into the edit control by ref", typedOk, typed ? JSON.stringify(typed.r.steps) + " " + (typed.r.error || "") : "no result");
  const readBack = typed && typed.r && JSON.stringify(typed.r.snapshot || "").includes(TEXT);
  check(`the fresh snapshot reads back "${TEXT}"`, readBack, typed && typed.r.snapshot ? roles(typed.r.snapshot) : typed && typed.r.snapshot_error);
  check("every _result fits 64 KB", [...box.results.values()].every((r) => r.bytes <= 65536), [...box.results.values()].map((r) => r.bytes).join(","));
  if (!typedOk || !readBack) {
    // Diagnostics for the next round: does the headless value write work here?
    queue({ id: "act-set", op: "act", app, agent: "ci", steps: [{ do: "set", ref: edit.ref_id, text: TEXT }] });
    const set = await resultOf("act-set", 60000);
    console.log(`diagnostic set-value: ${set ? JSON.stringify(set.r.steps) + " readback=" + JSON.stringify(set.r.snapshot || "").includes(TEXT) : "no result"}`);
  }
  shoot("desktop-2-typed.png");

  // 4. a long step, and Stop on the indicator
  queue({ id: "long", op: "act", app, agent: "ci", steps: [{ do: "wait", ms: 60000 }] });
  const indicator = await target("desktop-indicator.html", 20000);
  check("the indicator «Agent is using your computer» shows while a job runs", !!indicator);
  const running = await until(() => adCount() > 0, 10000, 300);
  check("agent-desktop is running the long step", !!running);
  if (!indicator) return;
  await sleep(800);
  shoot("desktop-3-indicator.png");
  await pageShot(indicator, "desktop-3-indicator-window.png");
  const stoppedBefore = box.calls.filter((c) => c.op === "_stopped").length;
  const t0 = Date.now();
  await evaluate(indicator, `document.getElementById("stop").click(); true`);
  const stopped = await until(() => box.calls.filter((c) => c.op === "_stopped").length > stoppedBefore && box.calls.filter((c) => c.op === "_stopped").pop(), 5000, 20);
  const stoppedMs = stopped ? stopped.t - t0 : null;
  result.stoppedMs = stoppedMs;
  check("Stop: _stopped reaches the box within 2 s", stopped && stoppedMs <= 2000, `${stoppedMs} ms`);
  check("_stopped names this computer", stopped && optOf(stopped.args, "computer") === computer, stopped && stopped.args.join(" "));
  const dead = await until(() => adCount() === 0, 4000, 100);
  result.killedMs = dead ? Date.now() - t0 : null;
  check("Stop: agent-desktop is killed", !!dead, `${result.killedMs} ms`);
  await sleep(1500);
  shoot("desktop-4-stopped.png");
  check("no result is sent for the stopped job", !box.results.has("long"));
  const gone = await until(async () => !(await targets()).some((t) => t.url.includes("desktop-indicator.html")), 5000, 250);
  check("the indicator goes away after Stop", !!gone);

  // 5. activity list
  panel = (await target("desktop-control.html", 5000)) || panel;
  const list = (await evaluate(panel, `document.getElementById("list").innerText`)) || "";
  console.log(`activity list:\n${list}`);
  check("the activity list shows the typing step, as a length", list.includes("type") && list.includes(`${TEXT.length} characters`), list.slice(0, 300));
  check("the activity list shows the stopped job", /stopped/.test(list));
  let file = "";
  try {
    file = fs.readFileSync(ACTIVITY, "utf8");
  } catch {}
  check("the typed text is in neither the activity list nor its file", !list.includes(TEXT) && !!file && !file.includes(TEXT));
  check("no snapshot content in the activity file", !file.includes('"tree"') && !file.includes("Untitled"));
  await pageShot(panel, "desktop-5-activity.png");

  // 6. off again
  await evaluate(panel, `document.getElementById("switch").click(); true`);
  await sleep(6000); // the poll out at that moment is held up to 5 s by this stand-in
  const n = polls().length;
  await sleep(8000);
  check("switch OFF again: no more polls", polls().length === n, `${polls().length - n} new polls`);

  server.close();
}

main()
  .catch((e) => check("desktop smoke ran to the end", false, e.stack || e))
  .finally(() => {
    kill();
    try {
      execFileSync("taskkill", ["/F", "/IM", "notepad.exe"], { stdio: "ignore" });
    } catch {}
    fs.writeFileSync(path.join(SHOTS, "desktop-result.json"), JSON.stringify(result, null, 2));
    process.exit(failed ? 1 : 0);
  });
