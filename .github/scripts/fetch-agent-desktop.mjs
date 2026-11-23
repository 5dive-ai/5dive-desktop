// Puts the pinned agent-desktop release (vercel-labs/agent-desktop, Apache-2.0)
// into third_party/agent-desktop/, where electron-builder's win.extraResources
// picks it up (→ resources/agent-desktop/agent-desktop.exe). DIVE-9063.
//
// The release archive is checked against the SHA-256 pinned here BEFORE it is
// unpacked; a different file stops the build. To move to a new release: change
// VERSION and SHA256 (from the release's checksums.txt) and the NOTICE beside it.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = "v1.3.1";
const ASSET = `agent-desktop-${VERSION}-x86_64-pc-windows-msvc.tar.gz`;
const SHA256 = "6ee4b1e078f4e78792e79f16e32e4a78b9919464aa3c55629b7e27ed53a08c13";
const URL_ = `https://github.com/vercel-labs/agent-desktop/releases/download/${VERSION}/${ASSET}`;
const DEST = path.resolve("third_party", "agent-desktop");

const res = await fetch(URL_, { redirect: "follow" });
if (!res.ok) throw new Error(`download ${URL_}: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
const got = crypto.createHash("sha256").update(buf).digest("hex");
if (got !== SHA256) throw new Error(`${ASSET}: sha256 ${got}, pinned ${SHA256} — refusing it`);
console.log(`${ASSET}: ${buf.length} bytes, sha256 ok`);

// Unpack in its own empty folder, then take only the one file we ship.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-desktop-"));
const archive = path.join(work, ASSET);
const out = path.join(work, "out");
fs.mkdirSync(out);
fs.writeFileSync(archive, buf);
execFileSync("tar", ["-xzf", archive, "-C", out], { stdio: "inherit" });
const exe = path.join(out, "agent-desktop.exe");
if (!fs.existsSync(exe)) throw new Error(`${ASSET} has no agent-desktop.exe`);
fs.mkdirSync(DEST, { recursive: true });
fs.copyFileSync(exe, path.join(DEST, "agent-desktop.exe"));
for (const f of ["LICENSE", "NOTICE"]) if (!fs.existsSync(path.join(DEST, f))) throw new Error(`third_party/agent-desktop/${f} is missing`);
console.log(`agent-desktop ${VERSION} → ${path.join(DEST, "agent-desktop.exe")} (${fs.statSync(path.join(DEST, "agent-desktop.exe")).size} bytes)`);
