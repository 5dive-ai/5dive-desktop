// Office «Server address» smoke (DIVE-8808), run by build.yml on the Windows runner
// after win-smoke.mjs. Drives the INSTALLED app against a real https server on this
// runner with a fresh self-signed certificate, the way an office server looks:
//
//  1. first connect: the app asks «Trust this office server?» and loads NOTHING
//     from the server until the answer; Alt+T (Trust) loads it and the remembered
//     fingerprint is that certificate's;
//  2. a second launch trusts it without asking;
//  3. the window stays on the office server: a link, a redirect and a popup to
//     anywhere else do not leave it; the tray inbox asks /api/proxy/me with no
//     Authorization header;
//  4. a CHANGED certificate (the remembered fingerprint is not this one) is
//     refused: the server sees not one request, and the «Certificate changed»
//     warning is up in front of the window.
//
// Writes shots/office-*.png and shots/office-result.json; exits non-zero on any failed check.
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

const EXE = path.join(process.env.LOCALAPPDATA, "Programs", "5dive", "5dive.exe");
const SETTINGS = path.join(process.env.APPDATA, "5dive", "server-address.json");
const SHOTS = path.resolve("shots");
const DEBUG_PORT = 9223;
const OFFICE_PORT = 8443;
const OFFICE = `https://127.0.0.1:${OFFICE_PORT}`;
const TITLE = "5dive office smoke";
fs.mkdirSync(SHOTS, { recursive: true });

const result = { checks: [] };
let failed = false;
function check(name, ok, detail = "") {
  result.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + String(detail).slice(0, 300) : ""}`);
  if (!ok) failed = true;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ps(script) {
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim();
}
function shoot(name) {
  try {
    ps(`
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save('${path.join(SHOTS, name)}')`);
  } catch (e) {
    console.log(`no shot ${name}: ${e.message}`);
  }
}

// --- a self-signed office certificate, made here ----------------------------
function openssl() {
  for (const c of ["openssl", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe", "C:\\Program Files\\OpenSSL\\bin\\openssl.exe"]) {
    try {
      execFileSync(c, ["version"], { stdio: "ignore" });
      return c;
    } catch {}
  }
  throw new Error("no openssl on this runner");
}
function makeCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "office-cert-"));
  const cnf = path.join(dir, "cert.cnf");
  fs.writeFileSync(
    cnf,
    ["[req]", "prompt = no", "distinguished_name = dn", "x509_extensions = ext", "[dn]", "CN = 5dive office smoke", "[ext]", "subjectAltName = IP:127.0.0.1"].join("\n"),
  );
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync(openssl(), ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-keyout", key, "-out", cert, "-config", cnf]);
  const pem = fs.readFileSync(cert);
  // Electron's certificate.fingerprint: "sha256/" + base64 of the certificate's SHA-256.
  const fingerprint = "sha256/" + crypto.createHash("sha256").update(new crypto.X509Certificate(pem).raw).digest("base64");
  return { key: fs.readFileSync(key), cert: pem, fingerprint };
}

// --- the office server ------------------------------------------------------
const seen = []; // { path, auth }
function startOffice({ key, cert }) {
  const page = `<!doctype html><title>${TITLE}</title><h1>Office server</h1><a id="out" href="https://example.com/">out</a>`;
  const server = https.createServer({ key, cert }, (req, res) => {
    seen.push({ path: req.url, auth: req.headers.authorization || null });
    if (req.url === "/api/proxy/me") {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end('{"error":"signed out"}');
    }
    if (req.url === "/go-away") {
      res.writeHead(302, { Location: "https://example.com/" });
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(page);
  });
  return new Promise((r) => server.listen(OFFICE_PORT, "127.0.0.1", () => r(server)));
}

// --- the app ----------------------------------------------------------------
function kill() {
  try {
    execFileSync("taskkill", ["/F", "/T", "/IM", "5dive.exe"], { stdio: "ignore" });
  } catch {}
}
function writeSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(s));
}
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  } catch {
    return null;
  }
}
async function launch() {
  kill();
  await sleep(2000);
  spawn(EXE, [`--remote-debugging-port=${DEBUG_PORT}`], { detached: true, stdio: "ignore" }).unref();
}
async function pages() {
  try {
    return (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()).filter((t) => t.type === "page");
  } catch {
    return [];
  }
}
async function mainPage() {
  for (let i = 0; i < 60; i++) {
    const p = (await pages()).find((t) => !t.url.startsWith("devtools:"));
    if (p) return p;
    await sleep(1000);
  }
  throw new Error("no page on the debug port after 60s");
}
async function evaluate(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  const reply = new Promise((r) => (ws.onmessage = (m) => r(JSON.parse(m.data))));
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  const msg = await Promise.race([reply, sleep(10000).then(() => ({}))]);
  ws.close();
  return msg.result?.result?.value;
}
async function officeLoaded(target, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const v = await evaluate(target, "location.origin + ' ' + document.title").catch(() => "");
    if (v === `${OFFICE} ${TITLE}`) return v;
    await sleep(1000);
  }
  return (await evaluate(target, "location.href + ' ' + document.title").catch(() => "")) || "";
}

async function main() {
  const tls = makeCert();
  result.fingerprint = tls.fingerprint;
  const server = await startOffice(tls);

  // 1. First connect: asks, loads nothing until Trust.
  writeSettings({ server: OFFICE, trusted: {} });
  await launch();
  await mainPage();
  await sleep(8000);
  check("first connect: nothing loads from the office before the answer", seen.length === 0, `${seen.length} requests`);
  shoot("office-1-trust-question.png");
  const activated = ps(`$w = New-Object -ComObject WScript.Shell; if ($w.AppActivate('Office server')) { Start-Sleep -Milliseconds 600; $w.SendKeys('%t'); 'yes' } else { 'no' }`);
  check("the «Trust this office server?» window is up", activated === "yes", activated);
  let target = await mainPage();
  const loaded = await officeLoaded(target);
  check("after Trust the office page loads", loaded === `${OFFICE} ${TITLE}`, loaded);
  const saved = readSettings();
  check("the remembered fingerprint is this certificate's, for this address only", saved?.trusted && Object.keys(saved.trusted).join() === OFFICE && saved.trusted[OFFICE] === tls.fingerprint, JSON.stringify(saved));
  shoot("office-2-loaded.png");

  // 2. Second launch: trusted without asking.
  seen.length = 0;
  await launch();
  target = await mainPage();
  const again = await officeLoaded(target, 20);
  check("a second launch loads the office without asking", again === `${OFFICE} ${TITLE}`, again);

  // 3. Stays on the office server.
  await evaluate(target, `document.getElementById("out").click(); true`);
  await sleep(4000);
  let here = await evaluate(target, "location.origin");
  check("a link elsewhere does not leave the office server", here === OFFICE, here);
  await evaluate(target, `location.href = "${OFFICE}/go-away"; true`);
  await sleep(4000);
  here = await evaluate(target, "location.origin");
  check("a redirect elsewhere does not leave the office server", here === OFFICE, here);
  await evaluate(target, `window.open("https://example.com/"); true`);
  await sleep(4000);
  const foreign = (await pages()).filter((t) => /example\.com/.test(t.url));
  check("a popup elsewhere does not open in the app", foreign.length === 0, foreign.map((t) => t.url).join(" "));
  // The tray inbox polls 3 s after a page load and every 60 s.
  for (let i = 0; i < 20 && !seen.some((r) => r.path === "/api/proxy/me"); i++) await sleep(1000);
  const me = seen.filter((r) => r.path === "/api/proxy/me");
  check("the tray inbox asks /api/proxy/me with no Authorization header", me.length > 0 && me.every((r) => !r.auth), JSON.stringify(me.slice(0, 3)));

  // 4. A changed certificate is refused.
  writeSettings({ server: OFFICE, trusted: { [OFFICE]: "sha256/" + Buffer.alloc(32, 7).toString("base64") } });
  seen.length = 0;
  await launch();
  target = await mainPage();
  await sleep(12000);
  const refused = (await evaluate(target, "location.href + ' ' + document.title").catch(() => "")) || "";
  check("a changed certificate is refused: the office sees no request", seen.length === 0 && !refused.includes(TITLE), `${seen.length} requests; ${refused}`);
  const warned = ps(`$w = New-Object -ComObject WScript.Shell; if ($w.AppActivate('Certificate changed')) { Start-Sleep -Milliseconds 600; 'yes' } else { 'no' }`);
  check("the «certificate changed» warning is up, in front", warned === "yes", warned);
  shoot("office-3-changed-certificate.png");

  kill();
  server.close();
  // Leave the runner as the online app.
  fs.rmSync(SETTINGS, { force: true });
}

main()
  .catch((e) => check("office smoke ran to the end", false, e.stack || e))
  .finally(() => {
    kill();
    fs.writeFileSync(path.join(SHOTS, "office-result.json"), JSON.stringify(result, null, 2));
    process.exit(failed ? 1 : 0);
  });
