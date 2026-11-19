// «Server address» (DIVE-8808): the app can open an office's own 5dive server
// instead of our online app. Pure functions plus a small JSON file, so the tests
// can check every rule from any machine.
//
// - Empty address = the online app, exactly as before (5dive.app → my.5dive.ai).
// - An office address (https://192.168.1.20:8443, https://team.firm.com) = the
//   window opens that server, and every page it shows stays on it: a link to
//   anywhere else opens in the default browser.
// - A self-signed office certificate: on first connect the app shows its
//   fingerprint once («Trust this office server?») and remembers it for that
//   address only. A different certificate later is refused, and so is any other
//   host. Certificate checks are never turned off as a whole: this answers only
//   Chromium's per-request certificate-error for the office address.

const fs = require("node:fs");

const ONLINE_START = "https://5dive.app";
const ONLINE_APP = "https://my.5dive.ai";

/**
 * What the person typed → { ok: true, origin } (origin null = the online app) or
 * { ok: false, error } with a sentence the settings window shows as is.
 * "192.168.1.20:8443" and "team.firm.com" get https:// in front; a path, query or
 * #part is dropped (the app always starts at the server's own /).
 */
function normalizeAddress(input) {
  const s = String(input == null ? "" : input).trim();
  if (!s) return { ok: true, origin: null };
  if (/^http:\/\//i.test(s)) return { ok: false, error: "Use https:// — the office server only answers over a secure connection." };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return { ok: false, error: "That is not an address. Example: https://192.168.1.20:8443" };
  }
  if (u.protocol !== "https:") return { ok: false, error: "Use an https:// address." };
  if (!u.hostname || u.username || u.password) return { ok: false, error: "That is not an address. Example: https://192.168.1.20:8443" };
  return { ok: true, origin: u.origin };
}

/** The settings file → { server: origin|null, trusted: { origin: fingerprint } }. Anything odd reads as the online app. */
function readSettings(file) {
  const none = { server: null, trusted: {} };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return none;
  }
  if (!raw || typeof raw !== "object") return none;
  const n = normalizeAddress(raw.server);
  const trusted = {};
  if (raw.trusted && typeof raw.trusted === "object") {
    for (const [origin, fp] of Object.entries(raw.trusted)) {
      const o = normalizeAddress(origin);
      if (o.ok && o.origin === origin && typeof fp === "string" && fp) trusted[origin] = fp;
    }
  }
  return { server: n.ok ? n.origin : null, trusted };
}

function writeSettings(file, settings) {
  fs.writeFileSync(file, JSON.stringify({ server: settings.server || null, trusted: settings.trusted || {} }, null, 2));
}

/** Where the window starts. */
function startUrl(server) {
  return server ? `${server}/` : ONLINE_START;
}

/** The app's own base address (tasks, the sign-in hand-back). */
function appUrl(server) {
  return server || ONLINE_APP;
}

function originOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** Office mode: may the window (or a popup) show `url`? Only the office server's own pages. */
function onServer(server, url) {
  return !!server && originOf(url) === server;
}

/**
 * Chromium refused a certificate. What to do with it:
 * "trust" (the one remembered for this office address), "ask" (first connect to
 * the office address), or "refuse" (no office address, another host, or the
 * office address now shows a different certificate).
 */
function certDecision({ server, trusted, url, fingerprint }) {
  if (!server || !fingerprint || originOf(url) !== server) return "refuse";
  const known = trusted && trusted[server];
  if (!known) return "ask";
  return known === fingerprint ? "trust" : "refuse";
}

/** The settings after the person said yes to `fingerprint` for `server`. */
function trust(settings, server, fingerprint) {
  return { ...settings, trusted: { ...settings.trusted, [server]: fingerprint } };
}

/** The settings after the person forgot `server`'s certificate (IT replaced it). */
function forget(settings, server) {
  const trusted = { ...settings.trusted };
  delete trusted[server];
  return { ...settings, trusted };
}

/**
 * "sha256/AbC…=" (Electron's certificate.fingerprint) → "AB:CD:…" in hex pairs,
 * the way a browser's certificate viewer and `openssl x509 -fingerprint` show it,
 * so IT can read it out and the person can compare.
 */
function readableFingerprint(fp) {
  const m = /^sha256\/(.+)$/.exec(String(fp || ""));
  if (!m) return String(fp || "");
  const hex = Buffer.from(m[1], "base64").toString("hex").toUpperCase();
  // 16 pairs a line, so a narrow dialog never cuts the middle off.
  const pairs = hex.match(/.{2}/g);
  const lines = [];
  for (let i = 0; i < pairs.length; i += 16) lines.push(pairs.slice(i, i + 16).join(":"));
  return lines.join("\n");
}

module.exports = {
  ONLINE_START,
  ONLINE_APP,
  normalizeAddress,
  readSettings,
  writeSettings,
  startUrl,
  appUrl,
  originOf,
  onServer,
  certDecision,
  trust,
  forget,
  readableFingerprint,
};
