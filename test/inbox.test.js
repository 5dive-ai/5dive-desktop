const test = require("node:test");
const assert = require("node:assert/strict");
const { canPoll, parseEnvelope, readInbox, taskUrl, INBOX_SCRIPT } = require("../src/inbox");

const env = (data) => ({ kind: "exec", stdout: JSON.stringify({ ok: true, data }) });
const gate = (ident, extra = {}) => ({
  ident, title: `title ${ident}`, ask: `ask ${ident}?`, assignee: "olivia",
  need_type: "decision", need_answered_at: null, status: "blocked", ...extra,
});

test("polls only on the signed-in app hosts, over https", () => {
  assert.equal(canPoll("https://my.5dive.ai/chat"), true);
  assert.equal(canPoll("https://5dive.ai/dashboard"), true);
  assert.equal(canPoll("https://5dive.app/"), false);
  assert.equal(canPoll("http://my.5dive.ai/"), false);
  assert.equal(canPoll("https://accounts.google.com/"), false);
  assert.equal(canPoll("not a url"), false);
});

test("counts open gates and lists them", () => {
  const r = readInbox(env({ inbox: [gate("DIVE-1"), gate("DIVE-2")], needs_you: 2 }));
  assert.equal(r.state, "ok");
  assert.equal(r.count, 2);
  assert.deepEqual(r.items[0], { ident: "DIVE-1", title: "title DIVE-1", ask: "ask DIVE-1?", agent: "olivia" });
});

test("skips answered, closed and lead-held gates", () => {
  const r = readInbox(env({
    inbox: [
      gate("A", { need_answered_at: "2026-11-16T00:00:00Z" }),
      gate("B", { status: "done" }),
      gate("C"),
      gate("D"),
      { ident: "E", status: "todo" },
    ],
    lead_hold: [{ ident: "D", lead: "main", until: "x" }],
  }));
  assert.deepEqual(r.items.map((t) => t.ident), ["C"]);
  assert.equal(r.count, 1, "falls back to the list length when needs_you is absent");
});

test("needs_you from the box wins over our own count", () => {
  assert.equal(readInbox(env({ inbox: [gate("A")], needs_you: 3 })).count, 3);
});

test("empty inbox is ok with zero", () => {
  assert.deepEqual(readInbox(env({ inbox: [], needs_you: 0 })), { state: "ok", count: 0, items: [] });
});

test("signed-out, errors and junk never show a count", () => {
  assert.equal(readInbox({ kind: "signed-out" }).state, "signed-out");
  for (const bad of [null, undefined, "x", { kind: "http", status: 401 }, { kind: "loading" },
    { kind: "exec", stdout: "" }, { kind: "exec", stdout: "not json" },
    { kind: "exec", stdout: JSON.stringify({ ok: false, error: { code: 1 } }) }]) {
    const r = readInbox(bad);
    assert.equal(r.state, "unknown");
    assert.equal(r.count, 0);
  }
});

test("envelope may be the last line after log noise", () => {
  const out = "warming up\n" + JSON.stringify({ ok: true, data: { inbox: [] } });
  assert.equal(parseEnvelope(out).ok, true);
});

test("task link opens the task on the app host", () => {
  assert.equal(taskUrl("https://my.5dive.ai", "DIVE-7"), "https://my.5dive.ai/tasks?task=DIVE-7");
});

test("page script is one expression that never sends the token anywhere but our API", () => {
  assert.match(INBOX_SCRIPT, /^\(async \(\) => \{/);
  assert.match(INBOX_SCRIPT, /fetch\("\/api\/proxy\/server\/agents\/exec"/);
  assert.equal((INBOX_SCRIPT.match(/fetch\(/g) || []).length, 1);
  new Function(`return ${INBOX_SCRIPT}`); // parses
});
