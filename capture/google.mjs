// CAPTURE-ONLY (DIVE-8657, never merged). On a real Mac (the CI runner), a
// fresh install of the app, signed out:
//  1. opens my.5dive.ai's sign-in in the app's window and taps its OWN Google
//     button (the real Clerk flow, which heads for accounts.google.com);
//  2. checks the app stopped that hop and opened my.5dive.ai/desktop-sign-in in
//     the default browser, with a port and a state (shot: the browser page);
//  3. plays the browser page's last step, the hand-back to 127.0.0.1: a wrong
//     state must be refused (403) and sign nothing in; then the right state with
//     the ticket (SIGNIN_TICKET; "dry" sends a dummy one);
//  4. checks the window went to /continue and, with a real ticket, that the
//     app is signed in and its menu-bar inbox answers (shots: window, menu).
// Logs carry states and counts only, never page text or the ticket.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DIR = process.env.FIVEDIVE_CAPTURE;
const TICKET = process.env.SIGNIN_TICKET || "dry";
const DRY = TICKET === "dry";
const OUT = process.env.SHOT_OUT || "shots";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (ev, d = {}) => console.log(JSON.stringify({ ev, t: new Date().toISOString().slice(11, 19), ...d }));
const fail = (why, d = {}) => {
  log("FAIL", { why, ...d });
  shot("x-fail");
  process.exit(2);
};
fs.mkdirSync(OUT, { recursive: true });

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
      const p = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl && !t.url.startsWith("devtools"));
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(1000);
  }
  throw new Error("no debug target");
}

function cdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const j = JSON.parse(m.data);
    if (j.id && waiting.has(j.id)) {
      waiting.get(j.id)(j);
      waiting.delete(j.id);
    }
  };
  const open = new Promise((r) => (ws.onopen = r));
  const send = async (method, params = {}) => {
    await open;
    const n = ++id;
    ws.send(JSON.stringify({ id: n, method, params }));
    return new Promise((r) => waiting.set(n, r));
  };
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

function shot(name) {
  try {
    execFileSync("screencapture", ["-x", path.join(OUT, `${name}.png`)]);
    log("shot", { name });
  } catch {
    log("shot-failed", { name });
  }
}
const state = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, "state.json"), "utf8"));
  } catch {
    return {};
  }
};
async function until(pred, ms) {
  for (let t = 0; t < ms; t += 1000) {
    const s = state();
    if (pred(s)) return s;
    await sleep(1000);
  }
  return state();
}

const HIDE = `(() => { const css = 'span.min-w-0.flex-col:has(> strong.truncate + small.truncate), img[src*="clerk.com"], img[src*="img.clerk"], [class*="cl-userButton"] { visibility: hidden !important; }';
  const add = () => { if (document.getElementById('cap-hide')) return; const s = document.createElement('style'); s.id = 'cap-hide'; s.textContent = css; (document.head || document.documentElement).appendChild(s); };
  add(); document.addEventListener('DOMContentLoaded', add); })()`;

const c = cdp(await target());
await c.send("Page.addScriptToEvaluateOnNewDocument", { source: HIDE });

// 1. The app's own sign-in page, its own Google button.
await c.send("Page.navigate", { url: "https://my.5dive.ai/sign-in" });
const tapped = await c.evaluate(`(async () => {
  const sel = '.cl-socialButtonsBlockButton__google, .cl-socialButtonsIconButton__google, [data-testid="pill-google"]';
  for (let i = 0; i < 60; i++) {
    const b = document.querySelector(sel);
    if (b && window.Clerk && window.Clerk.loaded) { b.click(); return b.matches('[data-testid="pill-google"]') ? "pill" : "clerk"; }
    await new Promise(r => setTimeout(r, 500));
  }
  return "no-button";
})()`);
log("tap-google", { tapped });
if (tapped === "no-button") fail("no Google button on the app's sign-in page");

// 2. The app opened the browser page, and its window never went to Google.
const s2 = await until((s) => s.browser, 30000);
let opened;
try {
  opened = new URL(s2.browser);
} catch {
  fail("the app did not open a browser sign-in", { page: s2.page });
}
const port = opened.searchParams.get("port");
const st = opened.searchParams.get("state");
log("browser-opened", { host: opened.host, path: opened.pathname, port, stateLen: st?.length, windowPage: s2.page });
if (opened.origin !== "https://my.5dive.ai" || opened.pathname !== "/desktop-sign-in" || !port || !st) fail("wrong browser page");
if (/accounts\.google\.com/.test(s2.page || "")) fail("the window went to Google");
await sleep(12000); // let the browser draw its page
shot("1-browser-sign-in");

// 3. The hand-back: a wrong state first, then the app's own.
const wrong = await fetch(`http://127.0.0.1:${port}/callback?state=${"x".repeat(43)}&ticket=wrong.state.ticket`);
log("wrong-state", { status: wrong.status });
if (wrong.status !== 403) fail("a wrong state was not refused");
const ticket = DRY ? "dry.capture.ticket" : TICKET;
const right = await fetch(`http://127.0.0.1:${port}/callback?${new URLSearchParams({ state: st, ticket })}`);
log("hand-back", { status: right.status });
if (right.status !== 200) fail("the app's own state was refused");
const again = await fetch(`http://127.0.0.1:${port}/callback?${new URLSearchParams({ state: st, ticket })}`).then((r) => r.status, () => "closed");
log("second-hand-back", { status: again });
if (again === 200) fail("the listener took a second ticket");
await sleep(4000);
shot("2-browser-done");

// 4. The window redeems it.
const s4 = await until((s) => (DRY ? /continue/.test(s.page || "") : s.state === "ok"), DRY ? 20000 : 90000);
log("window", { page: s4.page, inbox: s4.state, items: s4.items });
if (DRY) {
  if (!/\/continue$/.test(s4.page || "")) fail("the window did not open /continue");
  await sleep(6000);
  shot("3-window-dry");
  log("PASS", { mode: "dry" });
  process.exit(0);
}
if (s4.state !== "ok") fail("not signed in, or the inbox did not answer");
await c.send("Page.navigate", { url: "https://my.5dive.ai/tasks" });
await sleep(15000);
shot("3-window-signed-in");
log("PASS", { mode: "ticket", inbox: state().state, items: state().items });
c.close();
process.exit(0);
