// CAPTURE-ONLY (DIVE-8583, DIVE-8659; never merged). Signs the running app in with a
// one-time Clerk ticket over its debug port, opens the team page, waits until
// the menu-bar icon has the waiting tasks, then shoots: window, notification,
// and the icon's menu open. Logs carry counts only, never page text.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DIR = process.env.FIVEDIVE_CAPTURE;
const TICKET = process.env.SIGNIN_TICKET;
const PAGE = process.env.SHOT_PATH || "/";
const OUT = process.env.SHOT_OUT || "shots";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (ev, d = {}) => console.log(JSON.stringify({ ev, t: new Date().toISOString().slice(11, 19), ...d }));
fs.mkdirSync(OUT, { recursive: true });

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
      const p = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
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

const shot = (name) => {
  execFileSync("screencapture", ["-x", path.join(OUT, `${name}.png`)]);
  log("shot", { name });
};
const state = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, "state.json"), "utf8"));
  } catch {
    return null;
  }
};

const DRY = TICKET === "dry"; // plumbing check: no sign-in, shoot the signed-out menu
const c = cdp(await target());
if (DRY) {
  await sleep(20000);
  shot("0-dry-window");
  fs.writeFileSync(path.join(DIR, "menu"), "");
  await sleep(3000);
  shot("0-dry-menu");
  log("dry", state() || {});
  log("width", JSON.parse(await c.evaluate(`JSON.stringify({ w: innerWidth, wide: matchMedia("(min-width: 64rem)").matches })`)));
  process.exit(0);
}
await c.send("Page.navigate", { url: "https://my.5dive.ai/sign-in" });
await sleep(4000);
const signed = await c.evaluate(`(async () => {
  for (let i = 0; i < 60 && !(window.Clerk && window.Clerk.loaded); i++) await new Promise(r => setTimeout(r, 500));
  if (!window.Clerk || !window.Clerk.loaded) return "no-clerk";
  if (window.Clerk.session) return "already";
  try {
    const r = await window.Clerk.client.signIn.create({ strategy: "ticket", ticket: ${JSON.stringify(TICKET || "")} });
    await window.Clerk.setActive({ session: r.createdSessionId });
    return r.status;
  } catch (e) { return "error: " + String(e && e.message || e).slice(0, 120); }
})()`);
log("signin", { result: signed });
if (!/complete|already/.test(String(signed))) {
  shot("0-signin-failed");
  process.exit(2);
}

// The demo account's name and email are a real company address: hide the
// account chip and avatar on every page load (the only pixels changed).
const HIDE = `(() => { const css = 'span.min-w-0.flex-col:has(> strong.truncate + small.truncate), img[src*="clerk.com"], img[src*="img.clerk"], [class*="cl-userButton"] { visibility: hidden !important; }';
  const add = () => { if (document.getElementById('cap-hide')) return; const s = document.createElement('style'); s.id = 'cap-hide'; s.textContent = css; (document.head || document.documentElement).appendChild(s); };
  add(); document.addEventListener('DOMContentLoaded', add); })()`;
await c.send("Page.addScriptToEvaluateOnNewDocument", { source: HIDE });
await c.evaluate(HIDE);
// DIVE-8659: the README shot must not show Team's "turn on notifications" card.
// Waving it away is what "Not now" does: the same localStorage key (simple-notify.tsx).
await c.evaluate(`localStorage.setItem("5dive.push-card.dismissed", "1")`);
await c.send("Page.navigate", { url: new URL(PAGE, "https://my.5dive.ai").toString() });
let s = null;
for (let i = 0; i < 48; i++) {
  await sleep(5000);
  s = state();
  if (s && s.state === "ok" && s.items > 0) break;
}
log("inbox", s || {});
// The chat opens beside the list only at 64rem (1024 css px) and up. The runner's
// screen is 1024 wide, so the window can land a few px short: zoom out just enough,
// as Cmd-minus would, and reload so the layout re-reads the width.
const wide = () => c.evaluate(`JSON.stringify({ w: innerWidth, wide: matchMedia("(min-width: 64rem)").matches })`).then(JSON.parse);
let w = await wide();
log("width", w);
if (!w.wide) {
  fs.writeFileSync(path.join(DIR, "zoom"), String(Math.max(0.67, Math.floor((w.w / 1120) * 100) / 100)));
  await sleep(1500);
  await c.send("Page.reload");
  await sleep(10000);
  w = await wide();
  log("width", { ...w, zoomed: true });
}
await sleep(8000); // let the page finish drawing
log("checks", JSON.parse(await c.evaluate(`JSON.stringify({
  chips: document.querySelectorAll('span.min-w-0.flex-col:has(> strong.truncate + small.truncate), [class*="cl-userButton"]').length,
  pushCard: document.querySelectorAll('[data-push-card]').length,
  path: location.pathname.split('/').length - 1,
})`)));
shot("1-window");
fs.writeFileSync(path.join(DIR, "menu"), "");
await sleep(3000);
shot("3-menu");
c.close();
process.exit(s && s.state === "ok" && s.items > 0 && w.wide ? 0 : 3);
