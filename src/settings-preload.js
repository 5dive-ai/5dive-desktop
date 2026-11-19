// The «Server address» window's bridge (DIVE-8808). Only server-address.html gets
// this preload, and main.js answers only that window's calls.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fiveSettings", {
  get: () => ipcRenderer.invoke("server:get"),
  save: (address) => ipcRenderer.invoke("server:save", String(address)),
  forget: () => ipcRenderer.invoke("server:forget"),
});
