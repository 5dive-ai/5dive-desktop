// «New version of 5dive · Download» (DIVE-8785). The app is ad-hoc signed, and a Mac
// app updates itself only with a paid Apple Developer ID, so it does not install
// anything: it asks GitHub for the latest release, and when that is newer than this
// copy it says so once and opens the download in the default browser.
//
// The download is the release's own file (assets[].browser_download_url), not the
// README's 5dive-ai/5dive link: that mirror trails a new release by hours, and in
// that window it would hand out the version the user already has.
// Anything wrong (offline, rate-limited, a draft, an odd answer) means no notice.

const fs = require("node:fs");

const LATEST_URL = "https://api.github.com/repos/5dive-ai/5dive-desktop/releases/latest";
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** [major, minor, patch] of "1.2.3" or "v1.2.3"; null for anything else. */
function parseVersion(s) {
  const m = typeof s === "string" && SEMVER.exec(s.trim());
  return m ? m.slice(1, 4).map(Number) : null;
}

/** True only when both parse and `latest` is strictly newer than `current`. */
function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The release file for this platform; null where there is no build. */
function assetName(platform) {
  if (platform === "darwin") return "5dive.dmg";
  if (platform === "win32") return "5dive-setup.exe";
  return null;
}

/** { version, url } when `release` (GitHub's JSON) is a newer published build for this platform, else null. */
function readRelease(release, current, platform) {
  if (!release || typeof release !== "object" || release.draft || release.prerelease) return null;
  if (!isNewer(release.tag_name, current)) return null;
  const name = assetName(platform);
  const asset = Array.isArray(release.assets) && release.assets.find((a) => a && a.name === name);
  const url = asset && asset.browser_download_url;
  if (typeof url !== "string" || !url.startsWith("https://github.com/")) return null;
  return { version: parseVersion(release.tag_name).join("."), url };
}

/** Asks GitHub; resolves { version, url } or null and never rejects. */
async function checkForUpdate({ current, platform, fetch = globalThis.fetch }) {
  try {
    const res = await fetch(LATEST_URL, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `5diveDesktop/${current}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res || !res.ok) return null;
    return readRelease(await res.json(), current, platform);
  } catch {
    return null;
  }
}

// The pop-up shows once per version: the version it last showed is kept in a small
// file in the app's data folder, so a restart does not bring it back. The menu-bar
// or tray menu keeps a «New version of 5dive · Download» line until the update.

/** The version the pop-up last showed, or null (no file, unreadable, odd content). */
function readShown(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")).shown;
    return parseVersion(v) ? v : null;
  } catch {
    return null;
  }
}

function writeShown(file, version) {
  try {
    fs.writeFileSync(file, JSON.stringify({ shown: version }));
  } catch {
    // A read-only data folder only means the pop-up may show again next launch.
  }
}

/** Show the pop-up for `update` (from checkForUpdate) unless it already showed for that version. */
function shouldPopUp(update, shown) {
  return !!update && update.version !== shown;
}

module.exports = {
  LATEST_URL,
  CHECK_EVERY_MS,
  parseVersion,
  isNewer,
  assetName,
  readRelease,
  checkForUpdate,
  readShown,
  writeShown,
  shouldPopUp,
};
