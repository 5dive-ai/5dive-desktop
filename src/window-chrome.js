// The Mac window has no title bar (titleBarStyle "hiddenInset"), so the red, yellow
// and green window buttons sit on the page itself. Without room left for them they
// cover the "5dive" name at the top left of the web header (DIVE-8664).
//
// Two parts, both only in this app (the browser and the phone never load this file):
// - the buttons move down to the middle of the web header's 56px bar;
// - the header gets a left inset, so the name starts to the right of them.

// Top-left corner of the three buttons (each ~14px tall, ~52px as a group).
// y 21 puts their middle on the bar's middle (56 / 2 = 28).
const TRAFFIC_LIGHTS = { x: 18, y: 21 };

// Two web headers carry the name at the top left; both get room for the buttons,
// whose right edge is at 18 + 52 = 70px.
// - Signed in (simple-frame.tsx, data-testid="simple-top-bar"): the inset is on the
//   bar, not its inner row, so the row keeps its own padding and the name lands at
//   64 + 16..24px.
// - Signed out: start, sign-up and pay pages (sign-up-chrome.tsx, the "5" mark
//   data-testid="mark-home"): its header's own padding is 24..56px, so it becomes 84px.
const HEADER_INSET_PX = 64;
const MARK_HEADER_PADDING_PX = 84;
const HEADER_INSET_CSS = [
  `[data-testid="simple-top-bar"] { padding-left: ${HEADER_INSET_PX}px !important; }`,
  `header:has(> [data-testid="mark-home"]) { padding-left: ${MARK_HEADER_PADDING_PX}px !important; }`,
].join("\n");

// Full screen hides the buttons, so the inset comes off there.
function wireHeaderInset(win) {
  const contents = win.webContents;
  let key = null;
  const add = async () => {
    if (win.isFullScreen()) return;
    key = await contents.insertCSS(HEADER_INSET_CSS).catch(() => null);
  };
  const remove = () => {
    if (key) contents.removeInsertedCSS(key).catch(() => {});
    key = null;
  };
  // A full page load drops inserted CSS; in-page (client-side) navigation keeps it.
  contents.on("dom-ready", () => {
    key = null;
    add();
  });
  win.on("enter-full-screen", remove);
  win.on("leave-full-screen", () => {
    if (!key) add();
  });
}

module.exports = { TRAFFIC_LIGHTS, HEADER_INSET_PX, MARK_HEADER_PADDING_PX, HEADER_INSET_CSS, wireHeaderInset };
