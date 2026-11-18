// The one bridge between a page and the app (DIVE-8729), as small as it can be.
// main.js checks who is asking on every call: «run here» only from a 5dive page,
// the window's buttons only from the app's own run-here.html.
const { contextBridge, ipcRenderer } = require("electron");

// Mac only: Docker on Windows is its own row, so the page shows no button there.
if (process.platform === "darwin") {
  contextBridge.exposeInMainWorld("fiveDesktop", {
    platform: "darwin",
    // my.5dive.ai/self-host hands over the one-time code it minted for this account.
    runHere: (code) => ipcRenderer.invoke("run-here:start", String(code)),
    // The page minted a fresh code (the old one ran out): used when the box links.
    newCode: (code) => ipcRenderer.invoke("run-here:code", String(code)),
    // run-here.html: its screens and its one button.
    onRunState: (cb) => {
      ipcRenderer.on("run-here:state", (_e, s) => cb(s));
      ipcRenderer.send("run-here:ready");
    },
    openDocker: () => ipcRenderer.send("run-here:docker"),
    retry: () => ipcRenderer.send("run-here:retry"),
    finish: () => ipcRenderer.send("run-here:finish"),
  });
}
