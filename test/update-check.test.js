const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { LATEST_URL, parseVersion, isNewer, assetName, readRelease, checkForUpdate, readShown, writeShown, shouldPopUp } = require("../src/update-check");

const DL = "https://github.com/5dive-ai/5dive-desktop/releases/download";
const release = (tag, extra = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  assets: [
    { name: "5dive-setup.exe", browser_download_url: `${DL}/${tag}/5dive-setup.exe` },
    { name: "5dive.dmg", browser_download_url: `${DL}/${tag}/5dive.dmg` },
  ],
  ...extra,
});
const answer = (body, { ok = true } = {}) => async () => ({ ok, json: async () => body });

test("compares versions as numbers, with or without a v", () => {
  assert.equal(isNewer("0.3.1", "0.3.0"), true);
  assert.equal(isNewer("v0.4.0", "0.3.0"), true);
  assert.equal(isNewer("0.10.0", "0.9.9"), true, "10 > 9, not '1' < '9'");
  assert.equal(isNewer("1.0.0", "0.99.99"), true);
  assert.equal(isNewer("0.3.0", "0.3.0"), false);
  assert.equal(isNewer("v0.3.0", "0.3.0"), false);
  assert.equal(isNewer("0.2.9", "0.3.0"), false);
  assert.equal(isNewer("0.3.0", "0.10.0"), false);
});

test("anything that is not x.y.z is never newer", () => {
  // 192.0.2.1 stands for any four-part string.
  for (const bad of ["", "latest", "v1", "1.2", "1.2.3-beta", "192.0.2.1", "vv1.2.3", null, undefined, 4, {}]) {
    assert.equal(isNewer(bad, "0.3.0"), false, String(bad));
    assert.equal(isNewer("9.9.9", bad), false, `current ${String(bad)}`);
  }
  assert.deepEqual(parseVersion(" v0.4.0 "), [0, 4, 0]);
});

test("picks the dmg on a Mac and the installer on Windows", () => {
  assert.equal(assetName("darwin"), "5dive.dmg");
  assert.equal(assetName("win32"), "5dive-setup.exe");
  assert.equal(assetName("linux"), null);
  assert.deepEqual(readRelease(release("v0.4.0"), "0.3.0", "darwin"), { version: "0.4.0", url: `${DL}/v0.4.0/5dive.dmg` });
  assert.deepEqual(readRelease(release("v0.4.0"), "0.3.0", "win32"), { version: "0.4.0", url: `${DL}/v0.4.0/5dive-setup.exe` });
});

test("no notice for the same or an older version, a draft, a pre-release, a missing file or an odd link", () => {
  assert.equal(readRelease(release("v0.3.0"), "0.3.0", "darwin"), null);
  assert.equal(readRelease(release("v0.2.0"), "0.3.0", "darwin"), null);
  assert.equal(readRelease(release("v0.4.0", { draft: true }), "0.3.0", "darwin"), null);
  assert.equal(readRelease(release("v0.4.0", { prerelease: true }), "0.3.0", "darwin"), null);
  assert.equal(readRelease(release("v0.4.0", { assets: [] }), "0.3.0", "darwin"), null, "built but not attached yet");
  assert.equal(readRelease(release("v0.4.0", { assets: undefined }), "0.3.0", "darwin"), null);
  assert.equal(
    readRelease(release("v0.4.0", { assets: [{ name: "5dive.dmg", browser_download_url: "https://example.com/5dive.dmg" }] }), "0.3.0", "darwin"),
    null,
  );
  assert.equal(readRelease(release("v0.4.0"), "0.3.0", "linux"), null);
  assert.equal(readRelease(null, "0.3.0", "darwin"), null);
  assert.equal(readRelease("rate limited", "0.3.0", "darwin"), null);
});

test("shown: a newer release on GitHub gives the version and its download", async () => {
  let asked = null;
  const fetch = async (url, opts) => {
    asked = { url, opts };
    return { ok: true, json: async () => release("v0.4.0") };
  };
  const r = await checkForUpdate({ current: "0.3.0", platform: "darwin", fetch });
  assert.deepEqual(r, { version: "0.4.0", url: `${DL}/v0.4.0/5dive.dmg` });
  assert.equal(asked.url, LATEST_URL);
  assert.equal(asked.opts.headers["User-Agent"], "5diveDesktop/0.3.0", "GitHub refuses a call with no user agent");
  assert.ok(asked.opts.signal, "a hung call times out instead of hanging");
});

test("hidden: up to date gives nothing", async () => {
  assert.equal(await checkForUpdate({ current: "0.4.0", platform: "darwin", fetch: answer(release("v0.4.0")) }), null);
});

test("offline, rate-limited, a bad body or a hang: nothing, and it never throws", async () => {
  const offline = async () => {
    throw new TypeError("fetch failed");
  };
  const badJson = async () => ({ ok: true, json: async () => JSON.parse("<html>") });
  const timedOut = async () => {
    throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
  };
  for (const fetch of [offline, answer({ message: "API rate limit exceeded" }, { ok: false }), badJson, timedOut, answer(null), async () => undefined]) {
    assert.equal(await checkForUpdate({ current: "0.3.0", platform: "win32", fetch }), null);
  }
});

test("the pop-up shows once per version, and a restart remembers it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "5dive-update-"));
  const file = path.join(dir, "update-notice.json");
  const v4 = { version: "0.4.0", url: `${DL}/v0.4.0/5dive.dmg` };
  assert.equal(readShown(file), null, "no file yet");
  assert.equal(shouldPopUp(v4, readShown(file)), true);
  writeShown(file, "0.4.0");
  assert.equal(readShown(file), "0.4.0");
  assert.equal(shouldPopUp(v4, readShown(file)), false, "closed stays closed for 0.4.0");
  assert.equal(shouldPopUp({ version: "0.4.1", url: v4.url }, readShown(file)), true, "the next version shows again");
  assert.equal(shouldPopUp(null, null), false, "no update, no pop-up");
  fs.writeFileSync(file, "not json");
  assert.equal(readShown(file), null);
  fs.writeFileSync(file, JSON.stringify({ shown: "<script>" }));
  assert.equal(readShown(file), null);
  assert.doesNotThrow(() => writeShown(path.join(dir, "missing", "x.json"), "0.4.0"), "an unwritable folder is not an error");
  fs.rmSync(dir, { recursive: true, force: true });
});
