const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { isGoogleSignIn, listen, newState, readCallback, signInPageUrl, ticketUrl } = require("../src/browser-sign-in");

const APP = "https://my.5dive.ai";
const STATE = "s".repeat(43);

function get(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}

test("only Google's sign-in host goes to the browser", () => {
  assert.equal(isGoogleSignIn("https://accounts.google.com/o/oauth2/v2/auth?client_id=x"), true);
  assert.equal(isGoogleSignIn("https://accounts.google.com/signin/v2/identifier"), true);
  assert.equal(isGoogleSignIn("https://my.5dive.ai/sign-in"), false);
  assert.equal(isGoogleSignIn("https://clerk.5dive.ai/v1/oauth_callback"), false);
  assert.equal(isGoogleSignIn("https://accounts.google.com.evil.example/"), false);
  assert.equal(isGoogleSignIn("http://accounts.google.com/"), false);
  assert.equal(isGoogleSignIn("not a url"), false);
});

test("a fresh, url-safe state every time", () => {
  const a = newState();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, newState());
});

test("the browser page gets the port and state; the window redeems the ticket on /continue", () => {
  assert.equal(signInPageUrl(APP, 51234, STATE), `${APP}/desktop-sign-in?port=51234&state=${STATE}`);
  assert.equal(ticketUrl(APP, "tkt.a_b-c"), `${APP}/continue?ticket=tkt.a_b-c`);
});

test("a callback counts only with this app's state and a ticket-shaped value", () => {
  assert.deepEqual(readCallback("GET", `/callback?state=${STATE}&ticket=eyJhbGci.x_y`, STATE), { ticket: "eyJhbGci.x_y" });
  assert.deepEqual(readCallback("GET", `/callback?state=${"t".repeat(43)}&ticket=eyJhbGci.x_y`, STATE), { status: 403 });
  assert.deepEqual(readCallback("GET", `/callback?ticket=eyJhbGci.x_y`, STATE), { status: 403 });
  assert.deepEqual(readCallback("GET", `/callback?state=${STATE}`, STATE), { status: 400 });
  assert.deepEqual(readCallback("GET", `/callback?state=${STATE}&ticket=a%20b%3Cc`, STATE), { status: 400 });
  assert.deepEqual(readCallback("POST", `/callback?state=${STATE}&ticket=eyJhbGci.x_y`, STATE), { status: 404 });
  assert.deepEqual(readCallback("GET", `/favicon.ico`, STATE), { status: 404 });
});

test("the listener: 127.0.0.1, refuses a wrong state, takes the right one once, then closes", async () => {
  const got = [];
  let closed = false;
  const l = await listen({ appUrl: APP, onTicket: (t) => got.push(t), onClose: () => (closed = true) });
  assert.ok(l.port > 0);
  assert.equal(l.url, signInPageUrl(APP, l.port, l.state));

  const wrong = await get(l.port, `/callback?state=${"x".repeat(43)}&ticket=eyJhbGci.wrong`);
  assert.equal(wrong.status, 403);
  assert.deepEqual(got, [], "a wrong state signs nothing in");

  const ok = await get(l.port, `/callback?state=${l.state}&ticket=eyJhbGci.right`);
  assert.equal(ok.status, 200);
  assert.match(ok.body, /You're signed in/);
  assert.deepEqual(got, ["eyJhbGci.right"]);

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(closed, true, "one good request, then it stops listening");
  await assert.rejects(get(l.port, `/callback?state=${l.state}&ticket=eyJhbGci.again`));
  assert.deepEqual(got, ["eyJhbGci.right"]);
});

test("the listener gives up on its own when nobody comes back", async () => {
  let closed = false;
  const l = await listen({ appUrl: APP, onTicket: () => assert.fail("no ticket"), listenMs: 30, onClose: () => (closed = true) });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(closed, true);
  await assert.rejects(get(l.port, `/callback?state=${l.state}&ticket=eyJhbGci.late`));
});
