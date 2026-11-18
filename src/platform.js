// What differs between the Mac and the Windows app (DIVE-8666). Pure functions of
// `platform` (process.platform), so the tests can check both from any machine.
//
// - Mac: no title bar, the window buttons sit on the page (window-chrome.js);
//   black "Template" menu-bar icons that macOS recolours for light and dark.
// - Windows: the normal title bar, the menu bar hidden until Alt; a coloured
//   tray icon (a black glyph vanishes on the dark taskbar), and a red dot on the
//   taskbar button stands in for the Dock number, which Windows does not have.

// Must equal build.appId in package.json: Windows shows notifications only for an
// app whose id matches the one the installer gave its Start-menu shortcut.
const APP_ID = "ai.5dive.mac";

function isMac(platform) {
  return platform === "darwin";
}

/** The window options that depend on the platform. */
function windowChrome(platform, trafficLights) {
  if (isMac(platform)) return { titleBarStyle: "hiddenInset", trafficLightPosition: trafficLights };
  return { autoHideMenuBar: true };
}

/** File name in assets/ of the tray / menu-bar icon. */
function trayIcon(platform, waiting) {
  if (isMac(platform)) return waiting ? "trayWaitingTemplate.png" : "trayTemplate.png";
  return waiting ? "trayWinWaiting.png" : "trayWin.png";
}

/** Top-level menu roles: the Mac app menu, or the File menu (Close, Quit) elsewhere. */
function firstMenu(platform) {
  return isMac(platform) ? { role: "appMenu" } : { role: "fileMenu" };
}

// The app's user agent (DIVE-8708). Google refuses sign-in from a browser that
// announces itself as Electron (and its sign-in now runs in the default browser
// anyway, browser-sign-in.js), so "Electron/<v>" and Electron's "5dive/<v>" app
// token are removed. In their place one "5diveDesktop/<v>" marker, which the strip
// pattern does not match, lets my.5dive.ai tell it is inside the app: Electron has
// no push service, so the page must not offer browser notifications here.
const UA_STRIP = /\s(Electron|5dive)\/\S+/g;
const DESKTOP_MARKER = "5diveDesktop";

function appUserAgent(fallback, version) {
  return `${fallback.replace(UA_STRIP, "")} ${DESKTOP_MARKER}/${version}`;
}

module.exports = { APP_ID, isMac, windowChrome, trayIcon, firstMenu, UA_STRIP, DESKTOP_MARKER, appUserAgent };
