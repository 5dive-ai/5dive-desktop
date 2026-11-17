// Google sign-in in the default browser (DIVE-8657).
//
// Google refuses to sign in inside an embedded web view, by policy ("This
// browser or app may not be secure"), however the app's user agent reads. So
// when the page inside the app starts a Google sign-in, the app stops it and
// opens my.5dive.ai/desktop-sign-in in the user's default browser instead.
//
// The hand-back is a loopback redirect (RFC 8252 §7.3), not a custom URL
// scheme: the app listens on 127.0.0.1, on a random port, for ONE request.
// Signed in there, the browser page mints a one-shot Clerk ticket and sends it
// to http://127.0.0.1:<port>/callback?state=…&ticket=…. The app takes it only
// with its own random `state`, so another page or local process that guesses the
// port cannot sign the app in to some other account. The app then opens
// my.5dive.ai/continue?ticket=… in its own window, which redeems the ticket
// into the app's saved session.
const crypto = require("node:crypto");
const http = require("node:http");

const SIGN_IN_PATH = "/desktop-sign-in";
const CALLBACK_PATH = "/callback";
// Long enough to sign in (a new Google account, a 2FA prompt), short enough not to sit open all day.
const LISTEN_MS = 10 * 60_000;
const TICKET = /^[A-Za-z0-9._-]{8,4096}$/;

/** A Google sign-in page: these go to the browser, never into the app's window. */
function isGoogleSignIn(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "accounts.google.com";
  } catch {
    return false;
  }
}

/** 32 random bytes, url-safe: 43 characters. */
function newState() {
  return crypto.randomBytes(32).toString("base64url");
}

function signInPageUrl(appUrl, port, state) {
  return `${appUrl}${SIGN_IN_PATH}?${new URLSearchParams({ port: String(port), state }).toString()}`;
}

/** Where the app's window redeems the ticket (the web app's ticket landing; no target → Home). */
function ticketUrl(appUrl, ticket) {
  return `${appUrl}/continue?${new URLSearchParams({ ticket }).toString()}`;
}

function sameState(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Reads one request to the listener. { ticket } only for GET /callback with
 * this app's state and a ticket-shaped value; otherwise { status } to answer.
 */
function readCallback(method, reqUrl, state) {
  let u;
  try {
    u = new URL(reqUrl, "http://127.0.0.1");
  } catch {
    return { status: 400 };
  }
  if (method !== "GET" || u.pathname !== CALLBACK_PATH) return { status: 404 };
  if (!sameState(u.searchParams.get("state") || "", state)) return { status: 403 };
  const ticket = u.searchParams.get("ticket") || "";
  if (!TICKET.test(ticket)) return { status: 400 };
  return { ticket };
}

const PAGE = (title, line) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>5dive</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font:17px/1.5 -apple-system,system-ui,sans-serif;background:#f7f7f8;color:#1a1a1f;text-align:center}
@media (prefers-color-scheme:dark){body{background:#1a1a1f;color:#f2f2f3}}
h1{font-size:28px;margin:0 0 8px}p{margin:0;opacity:.75}</style></head>
<body><main><h1>${title}</h1><p>${line}</p></main></body></html>`;

const DONE_PAGE = PAGE("You're signed in", "Go back to the 5dive app. You can close this tab.");
const FAIL_PAGE = PAGE("That link didn't work", "Go back to the 5dive app and tap Continue with Google again.");

/**
 * Starts the one-request listener on 127.0.0.1 (random port). Resolves to
 * { port, state, url, close }. `onTicket(ticket)` runs once, on the first good
 * callback; then the listener closes. It also closes after `listenMs`.
 */
function listen({ appUrl, onTicket, listenMs = LISTEN_MS, onClose = () => {} }) {
  const state = newState();
  return new Promise((resolve, reject) => {
    let done = false;
    const server = http.createServer((req, res) => {
      const r = done ? { status: 410 } : readCallback(req.method, req.url, state);
      const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
      if (!r.ticket) {
        res.writeHead(r.status, headers);
        res.end(r.status === 404 ? "" : FAIL_PAGE);
        return;
      }
      done = true;
      res.writeHead(200, headers);
      res.end(DONE_PAGE, () => close());
      onTicket(r.ticket);
    });
    const timer = setTimeout(() => close(), listenMs);
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      onClose();
    }
    server.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ port, state, url: signInPageUrl(appUrl, port, state), close });
    });
  });
}

module.exports = { CALLBACK_PATH, LISTEN_MS, isGoogleSignIn, listen, newState, readCallback, signInPageUrl, ticketUrl };
