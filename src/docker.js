// Run 5dive on this Mac (DIVE-8729): the Docker side, as pure functions so the
// tests check every answer from any machine. run-here.js drives them.
//
// The container is the one docker/README.md in 5dive-ai/5dive describes, word for
// word: the same name, the five named volumes that keep the agents, --privileged
// (systemd runs each agent) and --restart unless-stopped. Docker is never bundled
// or installed from here: a Mac without it gets one screen with Docker's own link.
// Mac paths whatever the OS running the code (the Windows CI job included).
const path = require("node:path").posix;

const IMAGE = "ghcr.io/5dive-ai/5dive";
const TAG = "latest";
const NAME = "5dive";
const DOCKER_DOWNLOAD = "https://www.docker.com/products/docker-desktop/";

// All five, or the agents are gone when the container is replaced (README).
const VOLUMES = [
  ["5dive-etc", "/etc"],
  ["5dive-home", "/home"],
  ["5dive-root", "/root"],
  ["5dive-state", "/var/lib/5dive"],
  ["5dive-cron", "/var/spool/cron"],
];

// An app opened from Finder gets PATH=/usr/bin:/bin:/usr/sbin:/sbin, which has no
// docker. These are where Docker Desktop and Homebrew put it.
function dockerCandidates(home) {
  return [
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    path.join(home || "", ".docker", "bin", "docker"),
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ];
}

/** The PATH docker runs with: its own folder first (its credential helper sits beside it). */
function dockerPath(dockerBin, current) {
  const dirs = [path.dirname(dockerBin), "/Applications/Docker.app/Contents/Resources/bin", "/usr/local/bin", "/opt/homebrew/bin"];
  for (const d of (current || "").split(":")) if (d && !dirs.includes(d)) dirs.push(d);
  return dirs.join(":");
}

/** docker's platform for this Mac: arm64 on Apple silicon, amd64 on Intel. */
function platformOf(arch) {
  return arch === "arm64" ? "linux/arm64" : "linux/amd64";
}

/** The `docker run` arguments (after `docker`), exactly the README's line. */
function runArgs(arch) {
  const args = ["run", "-d", "--name", NAME, "--hostname", NAME, "--privileged", "--restart", "unless-stopped", "--platform", platformOf(arch)];
  for (const [vol, at] of VOLUMES) args.push("-v", `${vol}:${at}`);
  args.push(`${IMAGE}:${TAG}`);
  return args;
}

/**
 * Where Docker is, from `docker version --format {{.Server.Version}}`:
 * no docker binary → "missing"; a binary whose daemon does not answer → "stopped"
 * (Docker Desktop is installed but not open yet); a server version → "ready".
 */
function dockerState(found, versionResult) {
  if (!found) return "missing";
  if (!versionResult || versionResult.code !== 0) return "stopped";
  return /\d/.test(String(versionResult.stdout || "")) ? "ready" : "stopped";
}

/**
 * The container, from `docker inspect --format {{.State.Status}} 5dive`:
 * none (no such container), running, or stopped (created, exited, paused…).
 */
function containerState(inspectResult) {
  if (!inspectResult || inspectResult.code !== 0) return "none";
  const s = String(inspectResult.stdout || "").trim();
  if (s === "running") return "running";
  return s ? "stopped" : "none";
}

/**
 * What to do with the container: start one that is not there, start one that is
 * stopped, leave a running one alone. Never a second container, never `rm`, and
 * the volumes are never named in any of it.
 */
function containerPlan(state, arch) {
  if (state === "running") return [];
  if (state === "stopped") return [["start", NAME]];
  return [runArgs(arch)];
}

/** The pull's share done, 0..1, from Docker's pull events (the Engine API's JSON lines). */
function pullProgress(events) {
  const layers = new Map();
  for (const e of events) {
    if (!e || !e.id || typeof e.status !== "string") continue;
    const l = layers.get(e.id) || { current: 0, total: 0, done: false };
    const d = e.progressDetail || {};
    if (/^(Pull complete|Already exists|Download complete)/.test(e.status)) l.done = true;
    else if (e.status === "Downloading" && d.total > 0) {
      l.total = d.total;
      l.current = Math.min(d.current || 0, d.total);
    } else if (e.status === "Pulling fs layer" || e.status === "Waiting") {
      // A layer we know of, nothing downloaded yet.
    } else continue;
    layers.set(e.id, l);
  }
  if (!layers.size) return 0;
  // A layer whose size is not known yet counts as the average of the known ones,
  // so the bar does not jump back when a big layer starts.
  const known = [...layers.values()].filter((l) => l.total > 0);
  const avg = known.length ? known.reduce((s, l) => s + l.total, 0) / known.length : 1;
  let total = 0;
  let done = 0;
  for (const l of layers.values()) {
    const size = l.total || avg;
    total += size;
    done += l.done ? size : l.current;
  }
  return total > 0 ? Math.min(1, done / total) : 0;
}

/** One pull error from the events, or null. */
function pullError(events) {
  for (const e of events) if (e && (e.error || (e.errorDetail && e.errorDetail.message))) return String(e.error || e.errorDetail.message);
  return null;
}

/** Docker's socket from `docker context inspect --format {{.Endpoints.docker.Host}}`, or null. */
function socketOf(host) {
  const m = /^unix:\/\/(\/\S+)$/.exec(String(host || "").trim());
  return m ? m[1] : null;
}

// The one-time code my.5dive.ai/self-host mints (the link script's own check).
const CODE = /^[A-Za-z0-9-]{8,12}$/;

function validCode(code) {
  return typeof code === "string" && CODE.test(code);
}

/**
 * The `docker exec` arguments that link the box to the signed-in account: the
 * same line the self-host page shows (root in the container, so no sudo). The
 * code is checked first, so nothing else can ride into the shell.
 */
function linkArgs(code) {
  if (!validCode(code)) throw new Error("not a code from 5dive");
  return ["exec", NAME, "bash", "-c", `curl -fsSL https://install.5dive.ai/link | bash -s ${code}`];
}

/** `docker exec` that answers once systemd inside has booted (the link starts services). */
function bootedArgs() {
  return ["exec", NAME, "systemctl", "is-system-running"];
}

function booted(result) {
  const s = String((result && result.stdout) || "").trim();
  return s === "running" || s === "degraded";
}

module.exports = {
  IMAGE,
  TAG,
  NAME,
  VOLUMES,
  DOCKER_DOWNLOAD,
  dockerCandidates,
  dockerPath,
  platformOf,
  runArgs,
  dockerState,
  containerState,
  containerPlan,
  pullProgress,
  pullError,
  socketOf,
  validCode,
  linkArgs,
  bootedArgs,
  booted,
};
