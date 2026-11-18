const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { runHere, lastLine, isFiveDivePage, running } = require("../src/run-here");
const D = require("../src/docker");

const BIN = "/usr/local/bin/docker";

// A fake Mac: which docker exists, whether its daemon answers, the container's state.
function fakeMac({ docker = true, daemon = true, container = "none", pullEvents = null, link = 0, socket = true, bootAfter = 0 } = {}) {
  const calls = [];
  let t = 0;
  let boots = 0;
  const m = {
    calls,
    daemon,
    docker,
    deps: {
      home: "/Users/ana",
      arch: "arm64",
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      exists: async (p) => m.docker && p === BIN,
      run: async (bin, args) => {
        calls.push(args.join(" "));
        const a = args.join(" ");
        if (a.startsWith("version")) return m.daemon ? { code: 0, stdout: "28.5.1\n" } : { code: 1, stdout: "", stderr: "Cannot connect" };
        if (a.startsWith("context inspect")) return socket ? { code: 0, stdout: "unix:///Users/ana/.docker/run/docker.sock\n" } : { code: 1, stdout: "" };
        if (a.startsWith("inspect")) return container === "none" ? { code: 1, stderr: "No such object" } : { code: 0, stdout: container + "\n" };
        if (a.includes("is-system-running")) return boots++ >= bootAfter ? { code: 0, stdout: "running\n" } : { code: 1, stdout: "starting\n" };
        if (a.startsWith("exec 5dive bash")) return link === 0 ? { code: 0, stdout: "Linked.\n" } : { code: 1, stderr: "error: that code ran out. Get a new line.\n" };
        return { code: 0, stdout: "" };
      },
      enginePull: async (socketPath, image, tag, platform, onEvent) => {
        calls.push(`enginePull ${socketPath} ${image}:${tag} ${platform}`);
        for (const e of pullEvents || [
          { status: "Pulling fs layer", id: "a" },
          { status: "Downloading", id: "a", progressDetail: { current: 150, total: 300 } },
          { status: "Pull complete", id: "a" },
        ])
          onEvent(e);
      },
    },
  };
  return m;
}

async function go(m, code = "K7PM-4QXR") {
  const states = [];
  const r = runHere({ code, deps: m.deps, onState: (s) => states.push(s) });
  await r.done;
  return states;
}

test("a Mac with no 5dive yet: pull with a bar, the README's run, boot, the link line, done", async () => {
  const m = fakeMac();
  const states = await go(m);
  assert.deepEqual(
    states.map((s) => s.step),
    ["checking", "pulling", "pulling", "pulling", "pulling", "starting", "booting", "linking", "done"],
  );
  assert.deepEqual(states.filter((s) => s.step === "pulling").map((s) => s.progress), [0, 0, 0.5, 1]);
  assert.ok(m.calls.includes("enginePull /Users/ana/.docker/run/docker.sock ghcr.io/5dive-ai/5dive:latest linux/arm64"));
  assert.ok(m.calls.includes(D.runArgs("arm64").join(" ")));
  assert.ok(m.calls.includes(D.linkArgs("K7PM-4QXR").join(" ")));
});

test("re-click with the box already running: no pull, no run, no start, only the link", async () => {
  const m = fakeMac({ container: "running" });
  const states = await go(m);
  assert.deepEqual(states.map((s) => s.step), ["checking", "starting", "booting", "linking", "done"]);
  assert.ok(!m.calls.some((c) => c.startsWith("run ") || c.startsWith("start ") || c.startsWith("enginePull") || c.startsWith("pull")));
  assert.ok(!m.calls.some((c) => / rm |volume/.test(` ${c} `)));
});

test("re-click with the box stopped: `docker start 5dive`, never a second container", async () => {
  const m = fakeMac({ container: "exited" });
  await go(m);
  assert.ok(m.calls.includes("start 5dive"));
  assert.ok(!m.calls.some((c) => c.startsWith("run ")));
});

test("no Docker: one screen with Docker's link, checked again until it answers, then it moves on by itself", async () => {
  const m = fakeMac({ docker: false });
  let checks = 0;
  const exists = m.deps.exists;
  m.deps.exists = async (p) => {
    if (p === BIN && ++checks === 3) m.docker = true; // Docker Desktop got installed
    return exists(p);
  };
  const states = await go(m);
  const docker = states.filter((s) => s.step === "docker");
  assert.ok(docker.length >= 1);
  assert.equal(docker[0].state, "missing");
  assert.equal(docker[0].link, "https://www.docker.com/products/docker-desktop/");
  assert.equal(states.at(-1).step, "done");
});

test("Docker installed but not open: the 'open Docker' screen until the daemon answers", async () => {
  const m = fakeMac({ daemon: false });
  let n = 0;
  const run = m.deps.run;
  m.deps.run = async (bin, args) => {
    if (args[0] === "version" && ++n === 2) m.daemon = true;
    return run(bin, args);
  };
  const states = await go(m);
  assert.equal(states.find((s) => s.step === "docker").state, "stopped");
  assert.equal(states.at(-1).step, "done");
});

test("no socket: the docker command pulls instead, with a bar that cannot count", async () => {
  const m = fakeMac({ socket: false });
  const states = await go(m);
  assert.ok(m.calls.includes("pull --platform linux/arm64 ghcr.io/5dive-ai/5dive:latest"));
  assert.ok(states.some((s) => s.step === "pulling" && s.progress === null));
  assert.equal(states.at(-1).step, "done");
});

test("a failed link says what the server said, and a pull error stops before any run", async () => {
  const bad = await go(fakeMac({ link: 1 }));
  assert.deepEqual(bad.at(-1), { step: "failed", message: "error: that code ran out. Get a new line." });
  const m = fakeMac({ pullEvents: [{ error: "no space left on device", errorDetail: { message: "no space left on device" } }] });
  const s = await go(m);
  assert.deepEqual(s.at(-1), { step: "failed", message: "no space left on device" });
  assert.ok(!m.calls.some((c) => c.startsWith("run ")));
});

test("the latest code is the one that links (the page re-mints after 10 minutes)", async () => {
  const m = fakeMac();
  let code = "OLDC-0DE1";
  const r = runHere({ code: () => code, deps: m.deps, onState: () => {} });
  code = "NEWC-0DE2";
  await r.done;
  assert.ok(m.calls.includes(D.linkArgs("NEWC-0DE2").join(" ")));
  assert.ok(!m.calls.some((c) => c.includes("OLDC-0DE1")));
});

test("a code that is not a 5dive code never reaches Docker", async () => {
  const m = fakeMac();
  const states = await go(m, "x; rm -rf ~");
  assert.equal(states.at(-1).step, "failed");
  assert.equal(m.calls.length, 0);
});

test("a box that never boots fails with a plain line instead of waiting for ever", async () => {
  const states = await go(fakeMac({ bootAfter: 1e9 }));
  assert.equal(states.at(-1).step, "failed");
  assert.match(states.at(-1).message, /did not finish starting/);
});

test("only a 5dive page may start it", () => {
  for (const ok of ["https://my.5dive.ai/self-host", "https://5dive.app/", "https://5dive.ai/self-host?from=hire"]) assert.equal(isFiveDivePage(ok), true, ok);
  for (const no of ["http://my.5dive.ai/", "https://evil.example.com/", "https://5dive.ai.example.com/", "file:///x", "", undefined]) assert.equal(isFiveDivePage(no), false, String(no));
  assert.equal(running(null), false);
  assert.equal(running({ step: "pulling" }), true);
  assert.equal(running({ step: "done" }), false);
  assert.equal(running({ step: "failed" }), false);
  assert.equal(lastLine({ stderr: "a\nb\n\n" }), "b");
});

test("the window has a screen for every step, and the preload gives the page the bridge on a Mac only", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "run-here.html"), "utf8");
  for (const step of ["checking", "docker", "pulling", "starting", "booting", "linking", "done", "failed"]) assert.match(html, new RegExp(`\\b${step}:`), step);
  assert.match(html, /Install Docker Desktop first/);
  const preload = fs.readFileSync(path.join(__dirname, "..", "src", "preload.js"), "utf8");
  assert.match(preload, /process\.platform === "darwin"/);
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  // Every page-side call checks who is asking.
  assert.equal((main.match(/isFiveDivePage\(e\.senderFrame/g) || []).length, 2);
});
