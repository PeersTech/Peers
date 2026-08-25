"use strict";

// src/preload.ts
var import_electron = require("electron");
var EVENT_NAMES = [
  "presence://peer-connected",
  "presence://peer-disconnected",
  "node://message",
  "net://hole-punch",
  "code://resolved",
  "friend://request",
  "blob://parked",
  "blob://fetched",
  "blob://failed",
  "server://list",
  "server://message",
  "server://error",
  "server://join-request",
  "plaza://message",
  "plaza://profile"
];
import_electron.contextBridge.exposeInMainWorld("peers", {
  request: (cmd, args) => import_electron.ipcRenderer.invoke("peers:request", cmd, args),
  on: (event, cb) => {
    if (!EVENT_NAMES.includes(event)) throw new Error(`unknown event: ${event}`);
    const channel = `peers:event:${event}`;
    const listener = (_e, payload) => cb(payload);
    import_electron.ipcRenderer.on(channel, listener);
    return () => {
      import_electron.ipcRenderer.removeListener(channel, listener);
    };
  }
});
import_electron.ipcRenderer.send("peers:subscribe-events");
