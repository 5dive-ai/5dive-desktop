// "Is an agent waiting on me?" — read from the signed-in 5dive web page.
//
// The 5dive dashboard already answers this: its Needs-you badge runs
// `5dive task inbox --json` on the user's box through the API exec tunnel and
// reads `needs_you` plus the `inbox` rows (each one a task with an open human
// gate: a decision, approval, secret or manual step).
//
// We ask the SAME question the same way, from inside the page, so the app holds
// no token of its own: the Clerk session and the box key never leave the page.

// Hosts whose page can make the call (the API allows these origins, and
// /api/proxy is same-origin there).
const APP_HOSTS = ["my.5dive.ai", "my2.5dive.ai", "5dive.ai", "www.5dive.ai"];

function canPoll(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && APP_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

// Runs in the page. Returns a plain object; never throws.
const INBOX_SCRIPT = `(async () => {
  try {
    const C = window.Clerk;
    if (!C || !C.loaded) return { kind: "loading" };
    if (!C.session) return { kind: "signed-out" };
    const token = await C.session.getToken();
    const headers = { Authorization: "Bearer " + (token || ""), "Content-Type": "application/json" };
    try {
      const s = JSON.parse(localStorage.getItem("5dive_connectord_tokens") || "null");
      const t = s && s.active && s.tokens && s.tokens[s.active];
      if (t) headers["x-connectord-token"] = t;
    } catch (e) {}
    const r = await fetch("/api/proxy/server/agents/exec", {
      method: "POST",
      headers,
      body: JSON.stringify({ args: ["task", "inbox", "--json"] }),
    });
    if (!r.ok) return { kind: "http", status: r.status };
    const j = await r.json().catch(() => null);
    return { kind: "exec", stdout: (j && j.stdout) || "" };
  } catch (e) {
    return { kind: "error", message: String(e && e.message || e) };
  }
})()`;

// The same question on an office's own server (DIVE-8808): no Clerk there. The
// HttpOnly session cookie rides every same-origin call and no bearer is sent;
// GET /api/proxy/me answers 401 when this device is signed out (DIVE-8807's contract).
const OFFICE_INBOX_SCRIPT = `(async () => {
  try {
    const me = await fetch("/api/proxy/me", { credentials: "same-origin" });
    if (me.status === 401) return { kind: "signed-out" };
    if (!me.ok) return { kind: "http", status: me.status };
    const r = await fetch("/api/proxy/server/agents/exec", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: ["task", "inbox", "--json"] }),
    });
    if (r.status === 401) return { kind: "signed-out" };
    if (!r.ok) return { kind: "http", status: r.status };
    const j = await r.json().catch(() => null);
    return { kind: "exec", stdout: (j && j.stdout) || "" };
  } catch (e) {
    return { kind: "error", message: String(e && e.message || e) };
  }
})()`;

// The box prints one JSON envelope: the whole stdout, or its last line.
function parseEnvelope(stdout) {
  const s = String(stdout || "").trim();
  const lines = s.split(/\r?\n/).filter(Boolean);
  for (const c of [s, lines[lines.length - 1]]) {
    if (!c) continue;
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object" && "ok" in v) return v;
    } catch {}
  }
  return null;
}

// -> { state: "ok"|"signed-out"|"unknown", count, items: [{ident,title,ask,agent}] }
function readInbox(result) {
  const none = (state) => ({ state, count: 0, items: [] });
  if (!result || typeof result !== "object") return none("unknown");
  if (result.kind === "signed-out") return none("signed-out");
  if (result.kind !== "exec") return none("unknown");
  const env = parseEnvelope(result.stdout);
  if (!env || !env.ok || !env.data) return none("unknown");
  const rows = Array.isArray(env.data.inbox) ? env.data.inbox : [];
  const open = rows.filter(
    (t) => t && t.need_type && !t.need_answered_at && t.status !== "done" && t.status !== "cancelled",
  );
  // Gates still inside the lead's review window are in `inbox` but are not
  // the human's yet; `needs_you` already leaves them out.
  const held = new Set((env.data.lead_hold || []).map((h) => h && h.ident));
  const mine = open.filter((t) => !held.has(t.ident));
  const count = Number.isInteger(env.data.needs_you) ? env.data.needs_you : mine.length;
  const items = mine.map((t) => ({
    ident: String(t.ident || ""),
    title: String(t.title || ""),
    ask: String(t.ask || t.title || ""),
    agent: String(t.assignee || ""),
  }));
  return { state: "ok", count, items };
}

function taskUrl(base, ident) {
  const u = new URL("/tasks", base);
  u.searchParams.set("task", ident);
  return u.toString();
}

module.exports = { APP_HOSTS, INBOX_SCRIPT, OFFICE_INBOX_SCRIPT, canPoll, parseEnvelope, readInbox, taskUrl };
