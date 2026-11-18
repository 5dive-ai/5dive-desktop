const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../src/docker");

test("run arguments are the README's line: name, privileged, restart, all five volumes, the image", () => {
  const a = D.runArgs("arm64");
  assert.deepEqual(a, [
    "run", "-d", "--name", "5dive", "--hostname", "5dive", "--privileged", "--restart", "unless-stopped", "--platform", "linux/arm64",
    "-v", "5dive-etc:/etc", "-v", "5dive-home:/home", "-v", "5dive-root:/root",
    "-v", "5dive-state:/var/lib/5dive", "-v", "5dive-cron:/var/spool/cron",
    "ghcr.io/5dive-ai/5dive:latest",
  ]);
  assert.equal(a.filter((x) => x === "-v").length, 5);
});

test("Apple silicon pulls arm64, an Intel Mac amd64", () => {
  assert.equal(D.platformOf("arm64"), "linux/arm64");
  assert.equal(D.platformOf("x64"), "linux/amd64");
  assert.ok(D.runArgs("x64").includes("linux/amd64"));
});

test("Docker detection: no binary is missing, a silent daemon is stopped, a version is ready", () => {
  assert.equal(D.dockerState(null, null), "missing");
  assert.equal(D.dockerState("/usr/local/bin/docker", { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }), "stopped");
  assert.equal(D.dockerState("/usr/local/bin/docker", { code: 0, stdout: "\n" }), "stopped");
  assert.equal(D.dockerState("/usr/local/bin/docker", { code: 0, stdout: "28.5.1\n" }), "ready");
});

test("docker is looked for where Docker Desktop and Homebrew put it, not on Finder's bare PATH", () => {
  const c = D.dockerCandidates("/Users/ana");
  assert.ok(c.includes("/usr/local/bin/docker"));
  assert.ok(c.includes("/opt/homebrew/bin/docker"));
  assert.ok(c.includes("/Users/ana/.docker/bin/docker"));
  assert.ok(c.includes("/Applications/Docker.app/Contents/Resources/bin/docker"));
  // Its credential helper must be findable too, or a pull fails on a Finder-opened app.
  const p = D.dockerPath("/Users/ana/.docker/bin/docker", "/usr/bin:/bin").split(":");
  assert.equal(p[0], "/Users/ana/.docker/bin");
  assert.ok(p.includes("/Applications/Docker.app/Contents/Resources/bin"));
  assert.ok(p.includes("/usr/bin"));
});

test("already there: a running box is left alone, a stopped one only started, never a second or an rm", () => {
  assert.equal(D.containerState({ code: 1, stderr: "No such object: 5dive" }), "none");
  assert.equal(D.containerState({ code: 0, stdout: "running\n" }), "running");
  assert.equal(D.containerState({ code: 0, stdout: "exited\n" }), "stopped");
  assert.equal(D.containerState({ code: 0, stdout: "created\n" }), "stopped");
  assert.deepEqual(D.containerPlan("running", "arm64"), []);
  assert.deepEqual(D.containerPlan("stopped", "arm64"), [["start", "5dive"]]);
  assert.deepEqual(D.containerPlan("none", "arm64"), [D.runArgs("arm64")]);
  for (const s of ["running", "stopped", "none"]) {
    for (const args of D.containerPlan(s, "arm64")) {
      assert.ok(!args.includes("rm") && !args.includes("volume"), `${s}: ${args.join(" ")}`);
    }
  }
});

test("pull progress: bytes of each layer, finished layers full, never above 100%", () => {
  assert.equal(D.pullProgress([]), 0);
  const ev = [
    { status: "Pulling from 5dive-ai/5dive", id: "latest" },
    { status: "Pulling fs layer", id: "a" },
    { status: "Pulling fs layer", id: "b" },
    { status: "Downloading", id: "a", progressDetail: { current: 50, total: 100 } },
    { status: "Downloading", id: "b", progressDetail: { current: 0, total: 300 } },
  ];
  assert.equal(D.pullProgress(ev), 50 / 400);
  ev.push({ status: "Download complete", id: "a" });
  assert.equal(D.pullProgress(ev), 100 / 400);
  ev.push({ status: "Downloading", id: "b", progressDetail: { current: 300, total: 300 } }, { status: "Pull complete", id: "b" });
  assert.equal(D.pullProgress(ev), 1);
  // A cached layer counts as done.
  assert.equal(D.pullProgress([{ status: "Already exists", id: "c" }]), 1);
});

test("a pull error is read out of the events", () => {
  assert.equal(D.pullError([{ status: "x", id: "a" }]), null);
  assert.equal(D.pullError([{ errorDetail: { message: "no space left on device" }, error: "no space left on device" }]), "no space left on device");
});

test("Docker's socket comes from its context", () => {
  assert.equal(D.socketOf("unix:///Users/ana/.docker/run/docker.sock\n"), "/Users/ana/.docker/run/docker.sock");
  assert.equal(D.socketOf("tcp://192.0.2.10:2375"), null);
  assert.equal(D.socketOf(""), null);
});

test("the link line is the self-host page's, and only a real code reaches the shell", () => {
  assert.deepEqual(D.linkArgs("K7PM-4QXR"), ["exec", "5dive", "bash", "-c", "curl -fsSL https://install.5dive.ai/link | bash -s K7PM-4QXR"]);
  for (const bad of ["", "short", "K7PM-4QXR; rm -rf /", "$(id)abcdef", "a b c d e f g", "x".repeat(13), null, 12345678]) {
    assert.equal(D.validCode(bad), false, String(bad));
    assert.throws(() => D.linkArgs(bad));
  }
});

test("the box counts as booted once systemd inside says running or degraded", () => {
  assert.equal(D.booted({ code: 0, stdout: "running\n" }), true);
  assert.equal(D.booted({ code: 1, stdout: "degraded\n" }), true);
  assert.equal(D.booted({ code: 1, stdout: "starting\n" }), false);
  assert.equal(D.booted({ code: 1, stdout: "" }), false);
});
