const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { APP_ID, windowChrome, trayIcon, firstMenu } = require("../src/platform");

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
  // The .ico starts with the ICO header (reserved 0, type 1).
  const head = fs.readFileSync(path.join(ROOT, pkg.build.win.icon)).subarray(0, 4);
  assert.deepEqual([...head], [0, 0, 1, 0]);
});
