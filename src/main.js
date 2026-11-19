// 5dive for Mac and Windows: the 5dive web app in its own window, plus a menu-bar
// (Mac) or tray (Windows) icon that shows when an agent is waiting on you and
// opens that task on click. Platform differences: platform.js (DIVE-8666).
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, shell } = require("electron");
const { INBOX_SCRIPT, OFFICE_INBOX_SCRIPT, canPoll, readInbox, taskUrl } = require("./inbox");
const { isGoogleSignIn, listen, ticketUrl } = require("./browser-sign-in");
const { TRAFFIC_LIGHTS, wireHeaderInset } = require("./window-chrome");
const { APP_ID, isMac, windowChrome, trayIcon, firstMenu, appUserAgent } = require("./platform");
const { runHere, realDeps, isFiveDivePage, running, macRunReturn, signedInLanding } = require("./run-here");
const { DOCKER_DOWNLOAD, validCode } = require("./docker");
const { CHECK_EVERY_MS, checkForUpdate, readShown, writeShown, shouldPopUp } = require("./update-check");
const office = require("./server-address");

const MAC = isMac(process.platform);

const APP_URL = office.ONLINE_APP;
const POLL_MS = 60_000;
const PRELOAD = path.join(__dirname, "preload.js");
const RUN_HERE_PAGE = pathToFileURL(path.join(__dirname, "run-here.html")).href;
const SETTINGS_PRELOAD = path.join(__dirname, "settings-preload.js");
const SETTINGS_PAGE = pathToFileURL(path.join(__dirname, "server-address.html")).href;

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
// Run 5dive on this Mac (DIVE-8729): its small window, the run, and the latest code.
let runWin = null;
let run = null;
let runCode = null;
let runState = null;
let returnAfterSignIn = null; // the Run-on-this-Mac page a browser sign-in started on
let update = null; // { version, url } when a newer app is out (update-check.js, DIVE-8785)
// «Server address» (DIVE-8808): null = 5dive online; an https origin = an office's own server.
let settings = { server: null, trusted: {} };
let settingsFile = null;
let settingsWin = null;
let certAsk = null; // the open «Trust this office server?» question, shared by every request waiting on it
const certDeclined = new Set(); // "origin fingerprint" the person said Cancel to; asked again after Save
const certRefused = new Set(); // changed certificates already reported this run

function server() {
  return settings.server;
}

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
      // The «Run 5dive on this Mac» bridge (preload.js); popups do not get it.
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // Office mode: only the office server's own pages open in the app; the rest go to the browser.
    if (server()) {
      if (office.onServer(server(), url)) {
        return { action: "allow", overrideBrowserWindowOptions: { webPreferences: { partition: "persist:5dive" } } };
      }
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: "deny" };
    }
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

  win.loadURL(office.startUrl(server()));
}

// The page inside the app is about to go to Google (a link, a script, a redirect):
// stop it there and do the sign-in in the default browser instead.
// Office mode (DIVE-8808): the window never leaves the office server; a link
// elsewhere opens in the default browser, a redirect elsewhere is stopped.
function stopGoogleHere(contents, after = () => {}) {
  const guard = (redirect) => (event, legacyUrl) => {
    const url = legacyUrl || event.url;
    if (server()) {
      if (office.onServer(server(), url)) return;
      event.preventDefault();
      if (!redirect && /^https?:/.test(url)) shell.openExternal(url);
      return;
    }
    if (!isGoogleSignIn(url)) return;
    event.preventDefault();
    signInInBrowser();
    after();
  };
  contents.on("will-navigate", guard(false));
  contents.on("will-redirect", guard(true));
}

async function signInInBrowser() {
  // DIVE-8729: a sign-in started on «Run 5dive on this Mac»'s page comes back to that page, so it carries on.
  if (win && !win.isDestroyed()) returnAfterSignIn = macRunReturn(win.webContents.getURL());
  // A second tap while one is under way re-opens the same page (same port, same state).
  if (browserSignIn) return shell.openExternal(browserSignIn.url);
  try {
    browserSignIn = await listen({
      appUrl: APP_URL,
      onTicket: (ticket) => {
        show(ticketUrl(APP_URL, ticket));
        backAfterTicket();
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

// ---------------------------------------------------------------------------
// Run 5dive on this Mac (DIVE-8729). my.5dive.ai/self-host mints the account's
// one-time code and hands it over (preload.js runHere); the app starts the README's
// container in Docker and runs the page's own link line inside it, while a small
// window shows each step. The page sees the box link and moves on by itself.
// ---------------------------------------------------------------------------

function sendRunState(s) {
  runState = s;
  if (runWin && !runWin.isDestroyed()) runWin.webContents.send("run-here:state", s);
}

function startRun() {
  if (run) run.stop();
  sendRunState({ step: "checking" });
  run = runHere({
    code: () => runCode,
    deps: realDeps({ home: app.getPath("home"), arch: process.arch, env: process.env }),
    onState: sendRunState,
  });
}

function openRunWindow() {
  if (runWin && !runWin.isDestroyed()) {
    runWin.show();
    runWin.focus();
    return;
  }
  runWin = new BrowserWindow({
    width: 460,
    height: 380,
    resizable: false,
    minimizable: false,
    fullscreenable: false,
    title: "Run 5dive on this Mac",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#1a1a1f",
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  runWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  runWin.webContents.on("will-navigate", (e) => e.preventDefault());
  runWin.once("ready-to-show", () => runWin.show());
  // Closing it does not stop the run: a tap on the page brings it back where it is.
  runWin.on("closed", () => {
    runWin = null;
  });
  runWin.loadURL(RUN_HERE_PAGE);
}

function fromRunWin(e) {
  return !!runWin && !runWin.isDestroyed() && e.sender === runWin.webContents;
}

function wireRunHere() {
  // From the page: a tap (show the window, start if nothing is under way) or a fresh code.
  ipcMain.handle("run-here:start", (e, code) => {
    if (!MAC || !isFiveDivePage(e.senderFrame && e.senderFrame.url) || !validCode(code)) return { ok: false };
    runCode = code;
    if (!running(runState)) startRun();
    openRunWindow();
    return { ok: true };
  });
  ipcMain.handle("run-here:code", (e, code) => {
    if (!MAC || !isFiveDivePage(e.senderFrame && e.senderFrame.url) || !validCode(code)) return { ok: false };
    runCode = code;
    return { ok: true };
  });
  // From the window's own page.
  ipcMain.on("run-here:ready", (e) => fromRunWin(e) && e.sender.send("run-here:state", runState || { step: "checking" }));
  ipcMain.on("run-here:docker", (e) => fromRunWin(e) && shell.openExternal(DOCKER_DOWNLOAD));
  ipcMain.on("run-here:retry", (e) => fromRunWin(e) && runCode && startRun());
  ipcMain.on("run-here:finish", (e) => {
    if (!fromRunWin(e)) return;
    runWin.close();
    show(APP_URL);
  });
}

// The ticket page signs the window in and moves on to Home; once it has left /continue, go back to the page.
function backAfterTicket() {
  const back = returnAfterSignIn;
  returnAfterSignIn = null;
  if (!back || !win) return;
  const contents = win.webContents;
  const done = () => {
    contents.removeListener("did-navigate", check);
    contents.removeListener("did-navigate-in-page", check);
  };
  const check = (_e, url) => {
    if (!signedInLanding(url)) return;
    done();
    win.loadURL(back);
  };
  contents.on("did-navigate", check);
  contents.on("did-navigate-in-page", check);
  setTimeout(done, 60_000);
}

// «New version of 5dive · Download» (DIVE-8785): a pop-up once per version, and a
// line at the top of the menu-bar or tray menu until the update. Tapping either
// opens that version's download in the default browser; nothing installs by itself.
async function checkUpdate() {
  const next = await checkForUpdate({ current: app.getVersion(), platform: process.platform });
  const changed = (next && next.url) !== (update && update.url);
  update = next;
  if (changed && tray) tray.setContextMenu(buildMenu());
  const file = path.join(app.getPath("userData"), "update-notice.json");
  if (!shouldPopUp(update, readShown(file)) || !Notification.isSupported()) return;
  writeShown(file, update.version);
  const { url } = update;
  const n = new Notification({ title: "New version of 5dive", body: `Version ${update.version} is out. Click to download.` });
  n.on("click", () => shell.openExternal(url));
  n.show();
}

// ---------------------------------------------------------------------------
// «Server address» (DIVE-8808): the settings window, switching servers, and the
// office certificate (trust once for that address, refuse a changed one).
// ---------------------------------------------------------------------------

function saveSettings(next) {
  settings = next;
  try {
    office.writeSettings(settingsFile, settings);
  } catch {
    // A read-only data folder: the choice still holds until the app quits.
  }
}

function settingsView() {
  const s = server();
  return { server: s, certificate: !!(s && settings.trusted[s]) };
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 460,
    height: 400,
    resizable: false,
    minimizable: false,
    fullscreenable: false,
    title: "Server address",
    backgroundColor: "#1a1a1f",
    show: false,
    webPreferences: { preload: SETTINGS_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  settingsWin.webContents.on("will-navigate", (e) => e.preventDefault());
  settingsWin.once("ready-to-show", () => settingsWin.show());
  settingsWin.on("closed", () => {
    settingsWin = null;
  });
  settingsWin.loadURL(SETTINGS_PAGE);
}

function fromSettingsWin(e) {
  return !!settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents;
}

// Save (a new address, or the same one again to retry): forget what the tray showed
// for the old one, let a Cancelled certificate be asked about again, open the start page.
function switchServer(origin) {
  certDeclined.clear();
  saveSettings({ ...settings, server: origin });
  inbox = { state: "unknown", count: 0, items: [] };
  seen = new Set();
  if (tray) render(inbox);
  show(office.startUrl(origin));
}

function wireSettings() {
  ipcMain.handle("server:get", (e) => (fromSettingsWin(e) ? settingsView() : null));
  ipcMain.handle("server:save", (e, address) => {
    if (!fromSettingsWin(e)) return { ok: false, error: "" };
    const n = office.normalizeAddress(address);
    if (!n.ok) return n;
    switchServer(n.origin);
    settingsWin.close();
    return { ok: true };
  });
  ipcMain.handle("server:forget", (e) => {
    if (!fromSettingsWin(e) || !server()) return settingsView();
    saveSettings(office.forget(settings, server()));
    return settingsView();
  });
}

function onCertificateError(event, _contents, url, _error, certificate, callback) {
  const fingerprint = certificate && certificate.fingerprint;
  const decision = office.certDecision({ server: server(), trusted: settings.trusted, url, fingerprint });
  if (decision === "refuse") {
    callback(false);
    const known = server() && settings.trusted[server()];
    if (known && fingerprint && office.originOf(url) === server()) reportChangedCertificate(fingerprint);
    return;
  }
  if (decision === "ask" && certDeclined.has(`${server()} ${fingerprint}`)) return callback(false);
  event.preventDefault();
  if (decision === "trust") return callback(true);
  askTrust(server(), fingerprint).then(callback, () => callback(false));
}

// One question at a time: the page's many requests all wait on the same answer.
function askTrust(origin, fingerprint) {
  if (certAsk && certAsk.origin === origin && certAsk.fingerprint === fingerprint) return certAsk.answer;
  const opts = {
    type: "question",
    // & marks the keyboard key (Alt+T on Windows); normalizeAccessKeys drops it on the Mac.
    buttons: ["&Trust", "&Cancel"],
    normalizeAccessKeys: true,
    noLink: true,
    defaultId: 1,
    cancelId: 1,
    title: "Office server",
    message: "Trust this office server?",
    detail:
      `${origin}\n\nIts certificate (SHA-256):\n${office.readableFingerprint(fingerprint)}\n\n` +
      "Ask your IT that it matches the office server. 5dive remembers it for this address only.",
  };
  const parent = win && !win.isDestroyed() && win.isVisible() ? win : null;
  const answer = (parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts)).then(({ response }) => {
    certAsk = null;
    if (response !== 0) {
      certDeclined.add(`${origin} ${fingerprint}`);
      return false;
    }
    // The address changed while the question was open: do not remember it for the new one.
    if (server() !== origin) return false;
    saveSettings(office.trust(settings, origin, fingerprint));
    return true;
  });
  certAsk = { origin, fingerprint, answer };
  return answer;
}

function reportChangedCertificate(fingerprint) {
  if (certRefused.has(fingerprint)) return;
  certRefused.add(fingerprint);
  const opts = {
    type: "warning",
    // Its own title, so it is not mistaken for the trust question (and the CI smoke can find it).
    title: "Certificate changed",
    message: "This office server's certificate changed",
    detail:
      "5dive did not connect, to keep your messages safe. Tell your IT.\n\n" +
      "If IT replaced the certificate: open Server address… and choose Forget saved certificate.",
  };
  // On top of the 5dive window, like the trust question. The refused page never gets ready to
  // show, so show the window first; without a parent Windows puts the warning behind it.
  if (win && !win.isDestroyed()) {
    if (!win.isVisible()) win.show();
    win.focus();
    dialog.showMessageBox(win, opts);
  } else {
    dialog.showMessageBox(opts);
  }
}

function show(url) {
  if (!win) createWindow();
  if (url) win.loadURL(url);
  win.show();
  win.focus();
}

function baseUrl() {
  if (server()) return server();
  const cur = win && win.webContents.getURL();
  return cur && canPoll(cur) ? new URL(cur).origin : APP_URL;
}

async function poll() {
  if (!win || win.isDestroyed()) return;
  const url = win.webContents.getURL();
  const onOffice = office.onServer(server(), url);
  if (!onOffice && (server() || !canPoll(url))) return render({ state: "unknown", count: 0, items: [] });
  let result = null;
  try {
    result = await win.webContents.executeJavaScript(onOffice ? OFFICE_INBOX_SCRIPT : INBOX_SCRIPT, true);
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
  if (update) {
    const { url } = update;
    items.push({ label: "New version of 5dive · Download", click: () => shell.openExternal(url) }, { type: "separator" });
  }
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
  } else if (!server()) {
    items.push({ label: "Checking…", enabled: false });
  }
  if (server()) items.push({ label: `Office server: ${new URL(server()).host}`, enabled: false });
  items.push(
    { type: "separator" },
    { label: "Open 5dive", click: () => show() },
    { label: "Check now", click: () => poll() },
    { label: "Server address…", click: () => openSettings() },
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
      firstMenu(process.platform, [{ label: "Server address…", accelerator: "CmdOrCtrl+,", click: () => openSettings() }]),
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { label: "Home", accelerator: "CmdOrCtrl+Shift+H", click: () => show(office.startUrl(server())) },
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

  // A certificate Chromium refused: only the office address's remembered one is let
  // through, a first connect asks, everything else stays refused (server-address.js).
  app.on("certificate-error", onCertificateError);

  app.whenReady().then(() => {
    settingsFile = path.join(app.getPath("userData"), "server-address.json");
    settings = office.readSettings(settingsFile);
    appMenu();
    wireRunHere();
    wireSettings();
    tray = new Tray(nativeImage.createFromPath(asset(trayIcon(process.platform, false))));
    // A Windows tray icon opens the window on a click; its menu is on right-click.
    if (!MAC) tray.on("click", () => show());
    render(inbox);
    createWindow();
    setInterval(poll, POLL_MS);
    // Off the startup path: the first check waits for the window, then every 6 h.
    setTimeout(checkUpdate, 15_000);
    setInterval(checkUpdate, CHECK_EVERY_MS);
  });
}
