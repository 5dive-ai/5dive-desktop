const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { APP_ID, windowChrome, trayIcon, firstMenu, UA_STRIP, appUserAgent } = require("../src/platform");

const ROOT = path.join(__dirname, "..");
const pkg = require("../package.json");
const LIGHTS = { x: 18, y: 21 };

test("Mac window keeps its hidden title bar and moved buttons", () => {
  assert.deepEqual(windowChrome("darwin", LIGHTS), { titleBarStyle: "hiddenInset", trafficLightPosition: LIGHTS });
});

test("Windows window keeps its title bar and hides the menu bar until Alt", () => {
  const o = windowChrome("win32", LIGHTS);
  assert.equal(o.titleBarStyle, undefined);
  assert.equal(o.trafficLightPosition, undefined);
  assert.equal(o.autoHideMenuBar, true);
});

test("tray icons: Mac templates, Windows coloured; every one exists with its @2x", () => {
  assert.equal(trayIcon("darwin", false), "trayTemplate.png");
  assert.equal(trayIcon("darwin", true), "trayWaitingTemplate.png");
  assert.equal(trayIcon("win32", false), "trayWin.png");
  assert.equal(trayIcon("win32", true), "trayWinWaiting.png");
  for (const p of ["darwin", "win32"]) {
    for (const w of [false, true]) {
      const f = trayIcon(p, w);
      assert.ok(fs.existsSync(path.join(ROOT, "assets", f)), f);
      assert.ok(fs.existsSync(path.join(ROOT, "assets", f.replace(".png", "@2x.png"))), f);
    }
  }
  assert.ok(fs.existsSync(path.join(ROOT, "assets", "badgeWin.png")));
});

test("first menu: the Mac app menu, File elsewhere", () => {
  assert.deepEqual(firstMenu("darwin"), { role: "appMenu" });
  assert.deepEqual(firstMenu("win32"), { role: "fileMenu" });
});

test("notification id matches the installer's app id", () => {
  assert.equal(APP_ID, pkg.build.appId);
});

test("Windows build: x64 NSIS installer named 5dive-setup.exe with an .ico", () => {
  assert.equal(pkg.build.win.icon, "build/icon.ico");
  assert.ok(fs.existsSync(path.join(ROOT, pkg.build.win.icon)));
  assert.equal(pkg.build.nsis.artifactName, "5dive-setup.${ext}");
  assert.match(pkg.scripts["dist:win"], /--win nsis --x64/);
  // A one-click per-user install goes to %LOCALAPPDATA%\Programs\<package name>.
  assert.equal(pkg.name, "5dive");
  // The .ico starts with the ICO header (reserved 0, type 1).
  const head = fs.readFileSync(path.join(ROOT, pkg.build.win.icon)).subarray(0, 4);
  assert.deepEqual([...head], [0, 0, 1, 0]);
});

// DIVE-8708: Electron's own default user agent for this app, as the app receives it.
const ELECTRON_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) 5dive/0.2.0 Chrome/146.0.7680.188 Electron/44.11.3 Safari/537.36";
const ELECTRON_WIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) 5dive/0.2.0 Chrome/146.0.7680.188 Electron/44.11.3 Safari/537.36";

test("user agent: no Electron or 5dive/ token, but a 5diveDesktop marker the page can read", () => {
  for (const ua of [ELECTRON_MAC_UA, ELECTRON_WIN_UA]) {
    const out = appUserAgent(ua, pkg.version);
    assert.doesNotMatch(out, /Electron\//);
    assert.doesNotMatch(out, /\s5dive\//);
    assert.match(out, /Chrome\/146\.0\.7680\.188 Safari\/537\.36 5diveDesktop\/0\.2\.0$/);
    // The marker survives the strip pattern itself.
    assert.equal(out.replace(UA_STRIP, ""), out);
  }
});
