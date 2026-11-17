// 5dive for Mac: the 5dive web app in its own window, plus a menu-bar icon that
// shows when an agent is waiting on you and opens that task on click.
const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, Menu, Notification, Tray, nativeImage, screen, shell } = require("electron");
const { INBOX_SCRIPT, canPoll, readInbox, taskUrl } = require("./inbox");

const START_URL = "https://5dive.app";
const APP_URL = "https://my.5dive.ai";
// CAPTURE-ONLY (DIVE-8583, never merged): FIVEDIVE_CAPTURE=<dir> lets the CI
// shot job drive the real app: a debug port for the sign-in, a fast poll, the
// window parked beside the menu-bar icon, and trigger files that open the
// icon's own menu or fire the real notification, as a click or a new task would.
const CAPTURE = process.env.FIVEDIVE_CAPTURE || "";
if (CAPTURE) app.commandLine.appendSwitch("remote-debugging-port", "9222");
const POLL_MS = CAPTURE ? 5_000 : 60_000;

// Sign-in and payment pages may open in a popup; let those stay in the app.
// Anything else a page opens in a new window goes to the default browser.
const IN_APP_HOSTS = [
  /(^|\.)5dive\.(ai|app|com)$/,
  /(^|\.)clerk\.(com|accounts\.dev)$/,
  /^accounts\.google\.com$/,
  /^appleid\.apple\.com$/,
  /(^|\.)stripe\.com$/,
];

let win = null;
let tray = null;
let inbox = { state: "unknown", count: 0, items: [] };
let seen = new Set();
let quitting = false;

function isInApp(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && IN_APP_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

function asset(name) {
  return path.join(__dirname, "..", "assets", name);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 380,
    minHeight: 520,
    title: "5dive",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#1a1a1f",
    show: false,
    webPreferences: {
      // A named persistent session keeps you signed in between launches.
      partition: "persist:5dive",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // Sign-in popups share the window's saved session, so the sign-in sticks.
    if (isInApp(url)) {
      return { action: "allow", overrideBrowserWindowOptions: { webPreferences: { partition: "persist:5dive" } } };
    }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  if (CAPTURE) {
    const { workArea } = screen.getPrimaryDisplay();
    win.setPosition(workArea.x + workArea.width - 1200 - 24, workArea.y + 36);
  }
  win.once("ready-to-show", () => win.show());
  win.webContents.on("did-finish-load", () => setTimeout(poll, 3000));

  // Closing the window keeps the app (and the menu-bar icon) running, the Mac way.
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });

  win.loadURL(START_URL);
}

function show(url) {
  if (!win) createWindow();
  if (url) win.loadURL(url);
  win.show();
  win.focus();
}

function baseUrl() {
  const cur = win && win.webContents.getURL();
  return cur && canPoll(cur) ? new URL(cur).origin : APP_URL;
}

async function poll() {
  if (!win || win.isDestroyed()) return;
  const url = win.webContents.getURL();
  if (!canPoll(url)) return render({ state: "unknown", count: 0, items: [] });
  let result = null;
  try {
    result = await win.webContents.executeJavaScript(INBOX_SCRIPT, true);
  } catch {
    result = null;
  }
  const next = readInbox(result);
  // A loading page or a dropped call keeps the last good answer on screen.
  if (next.state === "unknown" && inbox.state === "ok") return;
  notifyNew(next);
  render(next);
  if (CAPTURE) captureState();
}

function captureState() {
  try {
    fs.writeFileSync(
      path.join(CAPTURE, "state.json"),
      JSON.stringify({ state: inbox.state, count: inbox.count, items: inbox.items.length, url: win.webContents.getURL().split("?")[0] }),
    );
  } catch {}
}

function captureTriggers() {
  const take = (name) => {
    const f = path.join(CAPTURE, name);
    if (!fs.existsSync(f)) return false;
    fs.rmSync(f, { force: true });
    return true;
  };
  if (take("notify")) notify(inbox.items);
  if (take("menu")) tray.popUpContextMenu();
  const z = path.join(CAPTURE, "zoom");
  if (fs.existsSync(z)) {
    const f = Number(fs.readFileSync(z, "utf8"));
    fs.rmSync(z, { force: true });
    if (f > 0.5 && f <= 1) win.webContents.setZoomFactor(f);
  }
}

function notifyNew(next) {
  if (next.state !== "ok") return;
  const fresh = next.items.filter((t) => !seen.has(t.ident));
  seen = new Set(next.items.map((t) => t.ident));
  if (inbox.state !== "ok") return;
  notify(fresh);
}

function notify(fresh) {
  if (!fresh.length || !Notification.isSupported()) return;
  const t = fresh[0];
  const n = new Notification({
    title: `${t.agent || "An agent"} needs you`,
    body: fresh.length > 1 ? `${t.ask} (+${fresh.length - 1} more)` : t.ask,
  });
  n.on("click", () => show(taskUrl(baseUrl(), t.ident)));
  n.show();
}

function clip(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function render(next) {
  inbox = next;
  const waiting = next.state === "ok" && next.count > 0;
  tray.setImage(nativeImage.createFromPath(asset(waiting ? "trayWaitingTemplate.png" : "trayTemplate.png")));
  tray.setTitle(waiting ? ` ${next.count}` : "");
  tray.setToolTip(
    waiting
      ? `${next.count} ${next.count === 1 ? "agent needs" : "agents need"} you`
      : next.state === "signed-out"
        ? "5dive: sign in to see who needs you"
        : "5dive",
  );
  app.setBadgeCount(waiting ? next.count : 0);
  tray.setContextMenu(buildMenu());
}

function buildMenu() {
  const items = [];
  if (inbox.state === "ok" && inbox.items.length) {
    items.push({ label: `${inbox.count} waiting on you`, enabled: false });
    for (const t of inbox.items.slice(0, 10)) {
      items.push({
        label: clip(`${t.agent ? t.agent + ": " : ""}${t.ask}`, 60),
        click: () => show(taskUrl(baseUrl(), t.ident)),
      });
    }
  } else if (inbox.state === "ok") {
    items.push({ label: "Nobody is waiting on you", enabled: false });
  } else if (inbox.state === "signed-out") {
    items.push({ label: "Sign in to see who needs you", click: () => show() });
  } else {
    items.push({ label: "Checking…", enabled: false });
  }
  items.push(
    { type: "separator" },
    { label: "Open 5dive", click: () => show() },
    { label: "Check now", click: () => poll() },
    { type: "separator" },
    { label: "Quit 5dive", role: "quit" },
  );
  return Menu.buildFromTemplate(items);
}

function appMenu() {
  // Without an Edit menu, copy and paste do not work in a Mac app.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { label: "Home", accelerator: "CmdOrCtrl+Shift+H", click: () => show(START_URL) },
          { role: "reload" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
    ]),
  );
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => show());
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("activate", () => show());

  // Google refuses sign-in from browsers that announce themselves as Electron.
  app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|5dive)\/\S+/g, "");

  app.whenReady().then(() => {
    appMenu();
    tray = new Tray(nativeImage.createFromPath(asset("trayTemplate.png")));
    render(inbox);
    createWindow();
    setInterval(poll, POLL_MS);
    if (CAPTURE) setInterval(captureTriggers, 500);
  });
}
