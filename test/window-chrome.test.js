const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { TRAFFIC_LIGHTS, HEADER_INSET_PX, HEADER_INSET_CSS, wireHeaderInset } = require("../src/window-chrome");

const BUTTONS_WIDTH = 52; // three 12px buttons, 8px apart, plus their outer edge
const HEADER_HEIGHT = 56; // simple-frame.tsx: h-14
const ROW_PADDING_MIN = 16; // simple-frame.tsx: px-4 (sm:px-6 is 24)

function fakeWindow() {
  const win = new EventEmitter();
  const contents = new EventEmitter();
  let n = 0;
  contents.sheets = new Map();
  contents.insertCSS = async (css) => {
    const key = `k${++n}`;
    contents.sheets.set(key, css);
    return key;
  };
  contents.removeInsertedCSS = async (key) => void contents.sheets.delete(key);
  win.webContents = contents;
  win.fullScreen = false;
  win.isFullScreen = () => win.fullScreen;
  return win;
}
const tick = () => new Promise((r) => setImmediate(r));

test("the window buttons sit in the middle of the web header", () => {
  const middle = TRAFFIC_LIGHTS.y + 7; // the buttons are ~14px tall
  assert.ok(Math.abs(middle - HEADER_HEIGHT / 2) <= 1, `buttons' middle at ${middle}px`);
});

test("the 5dive name starts to the right of the window buttons", () => {
  const buttonsRight = TRAFFIC_LIGHTS.x + BUTTONS_WIDTH;
  const nameLeft = HEADER_INSET_PX + ROW_PADDING_MIN;
  assert.ok(nameLeft >= buttonsRight + 8, `name at ${nameLeft}px, buttons end at ${buttonsRight}px`);
  assert.match(HEADER_INSET_CSS, /^\[data-testid="simple-top-bar"\] \{ padding-left: \d+px !important; \}$/);
});

test("every page load gets the inset", async () => {
  const win = fakeWindow();
  wireHeaderInset(win);
  win.webContents.emit("dom-ready");
  await tick();
  assert.deepEqual([...win.webContents.sheets.values()], [HEADER_INSET_CSS]);
  win.webContents.sheets.clear(); // a full navigation drops inserted CSS
  win.webContents.emit("dom-ready");
  await tick();
  assert.deepEqual([...win.webContents.sheets.values()], [HEADER_INSET_CSS]);
});

test("full screen hides the buttons, so the inset comes off and back on", async () => {
  const win = fakeWindow();
  wireHeaderInset(win);
  win.webContents.emit("dom-ready");
  await tick();
  win.fullScreen = true;
  win.emit("enter-full-screen");
  await tick();
  assert.equal(win.webContents.sheets.size, 0);
  win.webContents.emit("dom-ready"); // a page loaded while full screen: no inset
  await tick();
  assert.equal(win.webContents.sheets.size, 0);
  win.fullScreen = false;
  win.emit("leave-full-screen");
  await tick();
  assert.deepEqual([...win.webContents.sheets.values()], [HEADER_INSET_CSS]);
  win.emit("leave-full-screen"); // a second event does not stack a second copy
  await tick();
  assert.equal(win.webContents.sheets.size, 1);
});
