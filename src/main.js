// 5dive for Mac and Windows: the 5dive web app in its own window, plus a menu-bar
// (Mac) or tray (Windows) icon that shows when an agent is waiting on you and
// opens that task on click. Platform differences: platform.js (DIVE-8666).
const path = require("node:path");
const { app, BrowserWindow, Menu, Notification, Tray, nativeImage, shell } = require("electron");
const { INBOX_SCRIPT, canPoll, readInbox, taskUrl } = require("./inbox");
const { isGoogleSignIn, listen, ticketUrl } = require("./browser-sign-in");
const { TRAFFIC_LIGHTS, wireHeaderInset } = require("./window-chrome");
const { APP_ID, isMac, windowChrome, trayIcon, firstMenu, appUserAgent } = require("./platform");

const MAC = isMac(process.platform);

const START_URL = "https://5dive.app";
const APP_URL = "https://my.5dive.ai";
const POLL_MS = 60_000;

// Sign-in and payment pages may open in a popup; let those stay in the app.
// Anything else a page opens in a new window goes to the default browser.
// Google's sign-in is neither: it refuses to run inside the app, so it starts
// over in the browser and comes back signed in (browser-sign-in.js, DIVE-8657).
const IN_APP_HOSTS = [
  /(^|\.)5dive\.(ai|app|com)$/,
  /(^|\.)clerk\.(com|accounts\.dev)$/,
  /^appleid\.apple\.com$/,
  /(^|\.)stripe\.com$/,
];

let win = null;
let tray = null;
let inbox = { state: "unknown", count: 0, items: [] };
let seen = new Set();
let quitting = false;
let browserSignIn = null; // the open 127.0.0.1 listener while a browser sign-in is under way

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
    ...windowChrome(process.platform, TRAFFIC_LIGHTS),
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
    if (isGoogleSignIn(url)) {
      signInInBrowser();
      return { action: "deny" };
    }
    // Sign-in popups share the window's saved session, so the sign-in sticks.
    if (isInApp(url)) {
      return { action: "allow", overrideBrowserWindowOptions: { webPreferences: { partition: "persist:5dive" } } };
    }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  stopGoogleHere(win.webContents);
  // A sign-in popup that goes on to Google closes, and the sign-in starts in the browser.
  win.webContents.on("did-create-window", (child) => stopGoogleHere(child.webContents, () => child.close()));

  // Only the Mac window puts its buttons on the page; Windows keeps its title bar.
  if (MAC) wireHeaderInset(win);
  win.once("ready-to-show", () => win.show());
  win.webContents.on("did-finish-load", () => setTimeout(poll, 3000));

  // Closing the window keeps the app (and the menu-bar or tray icon) running, so it
  // can still tell you when an agent needs you. Quit from the icon's menu.
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });

  win.loadURL(START_URL);
}

// The page inside the app is about to go to Google (a link, a script, a redirect):
// stop it there and do the sign-in in the default browser instead.
function stopGoogleHere(contents, after = () => {}) {
  const guard = (event, legacyUrl) => {
    const url = legacyUrl || event.url;
    if (!isGoogleSignIn(url)) return;
    event.preventDefault();
    signInInBrowser();
    after();
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
}

async function signInInBrowser() {
  // A second tap while one is under way re-opens the same page (same port, same state).
  if (browserSignIn) return shell.openExternal(browserSignIn.url);
  try {
    browserSignIn = await listen({
      appUrl: APP_URL,
      onTicket: (ticket) => {
        show(ticketUrl(APP_URL, ticket));
        app.focus({ steal: true });
      },
      onClose: () => {
        browserSignIn = null;
      },
    });
  } catch {
    browserSignIn = null;
    return;
  }
  shell.openExternal(browserSignIn.url);
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
}

function notifyNew(next) {
  if (next.state !== "ok") return;
  const fresh = next.items.filter((t) => !seen.has(t.ident));
  seen = new Set(next.items.map((t) => t.ident));
  if (inbox.state !== "ok" || !fresh.length || !Notification.isSupported()) return;
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
  tray.setImage(nativeImage.createFromPath(asset(trayIcon(process.platform, waiting))));
  if (MAC) tray.setTitle(waiting ? ` ${next.count}` : "");
  tray.setToolTip(
    waiting
      ? `${next.count} ${next.count === 1 ? "agent needs" : "agents need"} you`
      : next.state === "signed-out"
        ? "5dive: sign in to see who needs you"
        : "5dive",
  );
  if (MAC) app.setBadgeCount(waiting ? next.count : 0);
  // Windows has no Dock number: a red dot on the taskbar button instead.
  else if (win && !win.isDestroyed()) win.setOverlayIcon(waiting ? nativeImage.createFromPath(asset("badgeWin.png")) : null, waiting ? `${next.count} waiting on you` : "");
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
  // Without an Edit menu, copy and paste do not work in a Mac app. On Windows the
  // menu bar stays hidden until Alt (autoHideMenuBar); its shortcuts still work.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      firstMenu(process.platform),
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
  // Opening the app again (Start menu, a second double-click) brings back the one
  // window. No link arrives this way: Google sign-in comes back over 127.0.0.1
  // (browser-sign-in.js), the same on Windows as on the Mac, so argv is not read.
  app.on("second-instance", () => show());
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("activate", () => show());

  // No "Electron/" (Google refuses it), plus a "5diveDesktop/<v>" marker the page reads
  // to stop offering browser push, which Electron cannot deliver (platform.js, DIVE-8708).
  app.userAgentFallback = appUserAgent(app.userAgentFallback, app.getVersion());
  // Windows shows notifications only for the id on the installer's shortcut.
  if (process.platform === "win32") app.setAppUserModelId(APP_ID);

  app.whenReady().then(() => {
    appMenu();
    tray = new Tray(nativeImage.createFromPath(asset(trayIcon(process.platform, false))));
    // A Windows tray icon opens the window on a click; its menu is on right-click.
    if (!MAC) tray.on("click", () => show());
    render(inbox);
    createWindow();
    setInterval(poll, POLL_MS);
  });
}
