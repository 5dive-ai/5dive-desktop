// The bridge for «Let my agent use this computer» (DIVE-9063): its settings window
// and the always-on-top «Agent is using your computer» indicator. Only those two
// pages get this preload, and main.js answers only their calls; the 5dive web page
// has no way to reach the switch.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fiveDesktop", {
  get: () => ipcRenderer.invoke("desktop:get"),
  setEnabled: (on) => ipcRenderer.invoke("desktop:set", on === true),
  stop: () => ipcRenderer.invoke("desktop:stop"),
  onUpdate: (fn) => ipcRenderer.on("desktop:update", (_e, view) => fn(view)),
});
