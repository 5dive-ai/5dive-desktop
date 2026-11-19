const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ONLINE_START,
  ONLINE_APP,
  normalizeAddress,
  readSettings,
  writeSettings,
  startUrl,
  appUrl,
  onServer,
  certDecision,
  trust,
  forget,
  readableFingerprint,
} = require("../src/server-address");

const OFFICE = "https://192.0.2.20:8443";
const NAMED = "https://team.example.com";
const FP = "sha256/q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=";
const OTHER_FP = "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "5dive-srv-")), "server-address.json");

test("an empty address is the online app, as before", () => {
  for (const s of ["", "   ", null, undefined]) assert.deepEqual(normalizeAddress(s), { ok: true, origin: null });
  assert.equal(startUrl(null), ONLINE_START);
  assert.equal(startUrl(null), "https://5dive.app");
  assert.equal(appUrl(null), ONLINE_APP);
  assert.equal(appUrl(null), "https://my.5dive.ai");
});

test("an office address becomes its https origin", () => {
  assert.equal(normalizeAddress("https://192.0.2.20:8443").origin, OFFICE);
  assert.equal(normalizeAddress("192.0.2.20:8443").origin, OFFICE, "https:// is added");
  assert.equal(normalizeAddress("  https://team.example.com/tg/chat?x=1#y ").origin, NAMED, "path, query and # dropped");
  assert.equal(normalizeAddress("HTTPS://Team.Example.com:443").origin, NAMED, "default port and case normalised");
  assert.equal(startUrl(OFFICE), `${OFFICE}/`);
  assert.equal(appUrl(OFFICE), OFFICE);
});

test("refuses http, other schemes, a login in the address, and junk", () => {
  const login = ["https://user", "pw"].join(":") + "@example.com";
  for (const s of ["http://192.0.2.20:8443", "ftp://team.example.com", "file:///etc/passwd", login, "https://", "not an address at all"]) {
    const r = normalizeAddress(s);
    assert.equal(r.ok, false, s);
    assert.ok(r.error.length > 10, s);
  }
});

test("the setting survives a restart; a missing or broken file is the online app", () => {
  const file = tmp();
  assert.deepEqual(readSettings(file), { server: null, trusted: {} });
  writeSettings(file, { server: OFFICE, trusted: { [OFFICE]: FP } });
  assert.deepEqual(readSettings(file), { server: OFFICE, trusted: { [OFFICE]: FP } });
  fs.writeFileSync(file, "{nope");
  assert.deepEqual(readSettings(file), { server: null, trusted: {} });
  fs.writeFileSync(file, JSON.stringify({ server: "http://evil.example", trusted: { "http://x.example": FP, [OFFICE]: 7, [NAMED]: FP } }));
  assert.deepEqual(readSettings(file), { server: null, trusted: { [NAMED]: FP } }, "a hand-edited http address or odd entry is dropped");
  writeSettings(file, { server: null, trusted: { [OFFICE]: FP } });
  assert.deepEqual(readSettings(file), { server: null, trusted: { [OFFICE]: FP } }, "back to online keeps the remembered certificate");
});

test("office mode: pages stay on the office server, everything else leaves the window", () => {
  assert.equal(onServer(OFFICE, `${OFFICE}/`), true);
  assert.equal(onServer(OFFICE, `${OFFICE}/tg/chat/marcus?x=1`), true);
  assert.equal(onServer(OFFICE, "https://my.5dive.ai/tasks"), false);
  assert.equal(onServer(OFFICE, "https://5dive.app"), false);
  assert.equal(onServer(OFFICE, "https://192.0.2.20:9443/"), false, "same host, other port");
  assert.equal(onServer(OFFICE, "http://192.0.2.20:8443/"), false, "same host, plain http");
  assert.equal(onServer(OFFICE, "https://192.0.2.20.evil.example:8443/"), false, "look-alike host");
  assert.equal(onServer(OFFICE, "https://accounts.google.com/"), false);
  assert.equal(onServer(OFFICE, "javascript:alert(1)"), false);
  assert.equal(onServer(null, `${OFFICE}/`), false, "online mode never treats an office address as home");
});

test("certificate: ask on first connect, then trust once remembered", () => {
  let settings = { server: OFFICE, trusted: {} };
  const ask = { server: OFFICE, url: `${OFFICE}/`, fingerprint: FP };
  assert.equal(certDecision({ ...ask, trusted: settings.trusted }), "ask");
  settings = trust(settings, OFFICE, FP);
  assert.equal(certDecision({ ...ask, trusted: settings.trusted }), "trust");
  assert.equal(certDecision({ ...ask, url: `${OFFICE}/api/proxy/me`, trusted: settings.trusted }), "trust", "every path on that server");
});

test("certificate: a changed certificate on the same address is refused", () => {
  const trusted = { [OFFICE]: FP };
  assert.equal(certDecision({ server: OFFICE, trusted, url: `${OFFICE}/`, fingerprint: OTHER_FP }), "refuse");
});

test("certificate: a different host is never trusted, not even with the remembered certificate", () => {
  const trusted = { [OFFICE]: FP };
  for (const url of ["https://192.0.2.21:8443/", "https://192.0.2.20:9443/", "https://evil.example/", "https://192.0.2.20.evil.example:8443/"]) {
    assert.equal(certDecision({ server: OFFICE, trusted, url, fingerprint: FP }), "refuse", url);
  }
  // A certificate remembered for an address the app no longer opens is not used either.
  assert.equal(certDecision({ server: NAMED, trusted, url: `${OFFICE}/`, fingerprint: FP }), "refuse");
});

test("certificate: online mode refuses every bad certificate, as Chromium does by default", () => {
  assert.equal(certDecision({ server: null, trusted: { [OFFICE]: FP }, url: "https://my.5dive.ai/", fingerprint: FP }), "refuse");
  assert.equal(certDecision({ server: null, trusted: { [OFFICE]: FP }, url: `${OFFICE}/`, fingerprint: FP }), "refuse");
  assert.equal(certDecision({ server: OFFICE, trusted: {}, url: `${OFFICE}/`, fingerprint: "" }), "refuse", "no fingerprint, nothing to remember");
});

test("certificate: forget lets IT's new certificate be asked about again, for that address only", () => {
  let settings = { server: OFFICE, trusted: { [OFFICE]: FP, [NAMED]: OTHER_FP } };
  settings = forget(settings, OFFICE);
  assert.deepEqual(settings.trusted, { [NAMED]: OTHER_FP });
  assert.equal(certDecision({ server: OFFICE, trusted: settings.trusted, url: `${OFFICE}/`, fingerprint: OTHER_FP }), "ask");
});

test("the fingerprint reads as hex pairs, 16 a line, the way a certificate viewer shows it", () => {
  const r = readableFingerprint(FP);
  assert.match(r, /^([0-9A-F]{2}:){15}[0-9A-F]{2}\n([0-9A-F]{2}:){15}[0-9A-F]{2}$/);
  assert.equal(r.replace("\n", ":").split(":").length, 32, "all 32 bytes, none cut");
  assert.equal(r.slice(0, 11), "AB:CD:EF:12");
  assert.equal(readableFingerprint("weird"), "weird");
});
