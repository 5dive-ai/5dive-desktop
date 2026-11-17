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

// The web header (simple-frame.tsx, data-testid="simple-top-bar"). The inset is on
// the bar, not its inner row, so the row keeps its own padding: the name lands at
// 64 + 16..24px, clear of the buttons' right edge (18 + 52 = 70px).
const HEADER_INSET_PX = 64;
const HEADER_INSET_CSS = `[data-testid="simple-top-bar"] { padding-left: ${HEADER_INSET_PX}px !important; }`;

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

module.exports = { TRAFFIC_LIGHTS, HEADER_INSET_PX, HEADER_INSET_CSS, wireHeaderInset };
