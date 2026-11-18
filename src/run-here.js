// Run 5dive on this Mac (DIVE-8729): the steps, from a tap on my.5dive.ai/self-host
// to a box linked to the signed-in account. Docker check → pull (with a progress
// bar) → start → wait for the box to boot → the self-host page's link line inside
// it. Every outside call comes in through `deps`, so the tests drive the whole
// thing with fakes; main.js passes the real ones (realDeps below).
//
// States sent to onState, in order (the window draws one screen per step):
//   checking · docker (missing | stopped; checked again every few seconds) ·
//   pulling (progress 0..1, or null when Docker gives no numbers) · starting ·
//   booting · linking · done · failed (message)
const fs = require("node:fs");
const http = require("node:http");
const { execFile } = require("node:child_process");
const D = require("./docker");

const DOCKER_POLL_MS = 3000;
const BOOT_POLL_MS = 2000;
const BOOT_TIMEOUT_MS = 180_000;

function runHere({ code, deps, onState }) {
  // The page mints a fresh code when one runs out (10 minutes), and a first pull can
  // take longer than that: `code` may be a function that gives the latest one.
  const codeNow = typeof code === "function" ? code : () => code;
  let stopped = false;
  const say = (s) => {
    if (!stopped) onState(s);
  };
  const stop = () => {
    stopped = true;
  };

  async function findDocker() {
    for (const p of D.dockerCandidates(deps.home)) if (await deps.exists(p)) return p;
    return null;
  }

  async function waitForDocker() {
    for (;;) {
      const bin = await findDocker();
      const version = bin ? await deps.run(bin, ["version", "--format", "{{.Server.Version}}"]) : null;
      const state = D.dockerState(bin, version);
      if (state === "ready") return bin;
      say({ step: "docker", state, link: D.DOCKER_DOWNLOAD });
      await deps.sleep(DOCKER_POLL_MS);
      if (stopped) return null;
    }
  }

  async function pull(bin) {
    say({ step: "pulling", progress: 0 });
    const ctx = await deps.run(bin, ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
    const socket = ctx && ctx.code === 0 ? D.socketOf(ctx.stdout) : null;
    if (socket) {
      const events = [];
      const ok = await deps
        .enginePull(socket, D.IMAGE, D.TAG, D.platformOf(deps.arch), (e) => {
          events.push(e);
          say({ step: "pulling", progress: D.pullProgress(events) });
        })
        .then(
          () => true,
          () => false,
        );
      const err = D.pullError(events);
      if (ok && !err) return null;
      if (err) return err;
      // The socket did not answer as expected: the docker command does the same pull.
    }
    say({ step: "pulling", progress: null });
    const r = await deps.run(bin, ["pull", "--platform", D.platformOf(deps.arch), `${D.IMAGE}:${D.TAG}`]);
    return r.code === 0 ? null : lastLine(r) || "Could not download 5dive.";
  }

  async function waitBooted(bin) {
    const until = deps.now() + BOOT_TIMEOUT_MS;
    while (deps.now() < until) {
      if (stopped) return false;
      if (D.booted(await deps.run(bin, D.bootedArgs()))) return true;
      await deps.sleep(BOOT_POLL_MS);
    }
    return false;
  }

  const done = (async () => {
    try {
      if (!D.validCode(codeNow())) return say({ step: "failed", message: "This link code is not from 5dive. Open the self-host page again." });
      say({ step: "checking" });
      const bin = await waitForDocker();
      if (!bin) return;
      const state = D.containerState(await deps.run(bin, ["inspect", "--format", "{{.State.Status}}", D.NAME]));
      // A container that is there already is only started: its image is already here.
      if (state === "none") {
        const err = await pull(bin);
        if (stopped) return;
        if (err) return say({ step: "failed", message: err });
      }
      say({ step: "starting" });
      for (const args of D.containerPlan(state, deps.arch)) {
        const r = await deps.run(bin, args);
        if (r.code !== 0) return say({ step: "failed", message: lastLine(r) || "Docker could not start 5dive." });
      }
      say({ step: "booting" });
      if (!(await waitBooted(bin))) return stopped ? undefined : say({ step: "failed", message: "5dive did not finish starting in Docker. Try again." });
      say({ step: "linking" });
      const r = await deps.run(bin, D.linkArgs(codeNow()));
      if (r.code !== 0) return say({ step: "failed", message: lastLine(r) || "Could not connect this Mac to your account." });
      say({ step: "done" });
    } catch (e) {
      say({ step: "failed", message: (e && e.message) || "Something went wrong." });
    }
  })();

  return { stop, done };
}

/** The last thing a failed command said: what the window shows. */
function lastLine(r) {
  const lines = String((r && (r.stderr || r.stdout)) || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 300) : "";
}

// The Engine API's pull: the same as `docker pull`, but it says how many bytes of
// each layer are in, so the window can draw a real bar (~313 MB on Apple silicon).
function enginePull(socketPath, image, tag, platform, onEvent) {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({ fromImage: image, tag, platform });
    const req = http.request({ socketPath, path: `/images/create?${q}`, method: "POST" }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`docker said ${res.statusCode}`));
      }
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try {
            onEvent(JSON.parse(line));
          } catch {
            /* not a JSON line: skip it */
          }
        }
      });
      res.on("end", resolve);
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

function realDeps({ home, arch, env }) {
  return {
    home,
    arch,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    exists: (p) => fs.promises.access(p, fs.constants.X_OK).then(
      () => true,
      () => false,
    ),
    run: (bin, args) =>
      new Promise((resolve) => {
        execFile(bin, args, { env: { ...env, PATH: D.dockerPath(bin, env.PATH) }, maxBuffer: 8 * 1024 * 1024, timeout: 15 * 60_000 }, (err, stdout, stderr) => {
          resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
        });
      }),
    enginePull,
  };
}

/** Only a 5dive page may start it (https, a 5dive host): never another site in a popup. */
function isFiveDivePage(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)5dive\.(ai|app|com)$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** Whether a run is still going (a tap then shows its window instead of starting over). */
function running(state) {
  return !!state && state.step !== "done" && state.step !== "failed";
}

/**
 * A browser sign-in that starts on the self-host page opened from the Mac app's door (from=mac) comes back
 * there, so the run starts once signed in: the page to go back to, or null for any other page.
 */
function macRunReturn(url) {
  if (!isFiveDivePage(url)) return null;
  const u = new URL(url);
  return u.pathname === "/self-host" && u.searchParams.get("from") === "mac" ? `${u.origin}/self-host?from=mac` : null;
}

/** The window has redeemed its ticket: it is on a 5dive page that is not the ticket page. */
function signedInLanding(url) {
  return isFiveDivePage(url) && new URL(url).pathname !== "/continue";
}

module.exports = { runHere, realDeps, lastLine, isFiveDivePage, running, macRunReturn, signedInLanding, DOCKER_POLL_MS };
