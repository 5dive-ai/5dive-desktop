// Windows smoke (DIVE-8666), run by build.yml on a real Windows runner after the
// silent install. Drives the INSTALLED app from outside; the app has no test hook.
//
//  1. launch 5dive.exe (with a Chromium debug port, a command-line switch only),
//     shoot the screen on the sign-in page;
//  2. send the page to accounts.google.com: the app must stop it and open
//     my.5dive.ai/desktop-sign-in?port&state in the default browser instead
//     (read from that browser's command line);
//  3. play the browser page's last step: a wrong state gets 403; the right
//     state with a dry ticket gets "You're signed in", and the app's window goes
//     to my.5dive.ai/continue?ticket=…; the one-shot listener then closes;
//  4. open the app a second time: it must exit and leave the one window running.
//
// Writes shots/*.png and shots/result.json; exits non-zero on any failed check.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EXE = path.join(process.env.LOCALAPPDATA, "Programs", "5dive", "5dive.exe");
const SHOTS = path.resolve("shots");
const PORT = 9222;
const TICKET = "dry-ticket-dive-8666";
fs.mkdirSync(SHOTS, { recursive: true });

const result = { checks: [] };
let failed = false;
function check(name, ok, detail = "") {
  result.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + String(detail).slice(0, 300) : ""}`);
  if (!ok) failed = true;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ps(script) {
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim();
}

// The whole screen, after maximizing 5dive's window (the runner's screen is
// smaller than the 1200x820 window). Not focus-stealing: shows what a user sees.
function shootScreen(name) {
  try {
    shootScreenOrThrow(name);
  } catch (e) {
    check(`screenshot ${name}`, false, e.message);
  }
}
function shootScreenOrThrow(name) {
  ps(`
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);'
Get-Process 5dive -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [W.U]::ShowWindow($_.MainWindowHandle, 3) | Out-Null }
Start-Sleep -Milliseconds 800
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save('${path.join(SHOTS, name)}')`);
  console.log(`shot ${name}`);
}

// --- CDP: the app window's page --------------------------------------------
async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && !t.url.startsWith("devtools:"));
      if (page) return page;
    } catch {}
    await sleep(1000);
  }
  throw new Error("no page on the debug port after 60s");
}

function session(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const waiting = new Map();
  const navigated = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    } else if (msg.method === "Page.frameNavigated" && !msg.params.frame.parentId) {
      navigated.push(msg.params.frame.url);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const open = new Promise((r) => (ws.onopen = r));
  return { open, send, navigated, close: () => ws.close() };
}

async function evaluate(s, expression) {
  const r = await s.send("Runtime.evaluate", { expression, returnByValue: true });
  return r.result?.result?.value;
}

// --- the browser the app opened ---------------------------------------------
function openedSignInUrl() {
  const out = ps(
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*desktop-sign-in*' } | Select-Object -First 1 -ExpandProperty CommandLine`,
  );
  const m = out.match(/https:\/\/my\.5dive\.ai\/desktop-sign-in\?[^\s"]+/);
  return m ? { url: m[0], cmd: out } : null;
}

async function get(url) {
  try {
    const r = await fetch(url);
    return { status: r.status, body: await r.text() };
  } catch (e) {
    return { status: 0, body: String(e.cause?.code || e.message) };
  }
}

async function main() {
  check("installed by the silent installer", fs.existsSync(EXE), EXE);
  const shortcut = path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "5dive.lnk");
  check("Start-menu shortcut", fs.existsSync(shortcut), shortcut);

  const app = spawn(EXE, [`--remote-debugging-port=${PORT}`], { detached: true, stdio: "ignore" });
  app.unref();

  const target = await pageTarget();
  const s = session(target.webSocketDebuggerUrl);
  await s.open;
  await s.send("Page.enable");
  // Let 5dive.app finish its redirects to the sign-in page.
  let url = "";
  for (let i = 0; i < 30; i++) {
    url = (await evaluate(s, "location.href")) || "";
    if (/^https:\/\/my\.5dive\.ai\//.test(url) && (await evaluate(s, "document.readyState")) === "complete") break;
    await sleep(1000);
  }
  await sleep(3000);
  const title = await evaluate(s, "document.title");
  check("window shows my.5dive.ai", /^https:\/\/my\.5dive\.ai\//.test(url), `${url} — ${title}`);
  result.firstPage = url;
  shootScreen("1-window.png");
  const page1 = await s.send("Page.captureScreenshot", { format: "png" });
  if (page1.result?.data) fs.writeFileSync(path.join(SHOTS, "1-page.png"), Buffer.from(page1.result.data, "base64"));

  // Google: stopped in the app, opened in the browser.
  await evaluate(s, `location.href = "https://accounts.google.com/o/oauth2/v2/auth?client_id=dive-8666-smoke"; true`);
  let opened = null;
  for (let i = 0; i < 30 && !opened; i++) {
    await sleep(1000);
    opened = openedSignInUrl();
  }
  check("Google sign-in opened in the default browser", !!opened, opened?.cmd);
  const stillHere = (await evaluate(s, "location.href")) || "";
  check("the app's window did not go to Google", !/accounts\.google\.com/.test(stillHere), stillHere);
  if (!opened) return;
  const u = new URL(opened.url);
  const port = u.searchParams.get("port");
  const state = u.searchParams.get("state");
  check("browser page carries a port and a 43-char state", /^\d+$/.test(port) && /^[A-Za-z0-9_-]{43}$/.test(state), `port ${port}, state ${state?.length} chars`);
  result.browserPage = `${u.origin}${u.pathname}?port=${port}&state=<${state?.length} chars>`;
  shootScreen("2-browser-opened.png");

  // The browser page's last step, played with fetch.
  const base = `http://127.0.0.1:${port}/callback`;
  const wrong = await get(`${base}?${new URLSearchParams({ state: "x".repeat(43), ticket: TICKET })}`);
  check("wrong state is refused (403)", wrong.status === 403, wrong.status);
  const good = await get(`${base}?${new URLSearchParams({ state, ticket: TICKET })}`);
  check("right state + ticket: 200 \"You're signed in\"", good.status === 200 && good.body.includes("You're signed in"), good.status);
  let landed = "";
  for (let i = 0; i < 20 && !landed; i++) {
    await sleep(500);
    landed = s.navigated.find((n) => n.startsWith(`https://my.5dive.ai/continue?ticket=${TICKET}`)) || "";
  }
  check("app window went to my.5dive.ai/continue?ticket=…", !!landed, landed || s.navigated.join(" , "));
  const after = await get(`${base}?${new URLSearchParams({ state, ticket: TICKET })}`);
  check("listener closed after one hand-back", after.status === 0, `${after.status} ${after.body}`);
  await sleep(4000);
  result.afterHandBack = (await evaluate(s, "location.href")) || "";
  shootScreen("3-after-hand-back.png");

  // Second launch: single instance.
  const second = spawn(EXE, [], { stdio: "ignore" });
  const code = await Promise.race([new Promise((r) => second.on("exit", (c) => r(c))), sleep(20000).then(() => "still running")]);
  check("a second launch exits and leaves one app", code !== "still running", `exit ${code}`);
  const alive = (await evaluate(s, "1 + 1")) === 2;
  check("the first app is still running", alive);
  s.close();
}

main()
  .catch((e) => check("smoke ran to the end", false, e.stack || e))
  .finally(() => {
    fs.writeFileSync(path.join(SHOTS, "result.json"), JSON.stringify(result, null, 2));
    process.exit(failed ? 1 : 0);
  });
