'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('get-state'),
  act: (name, ...args) => ipcRenderer.invoke('action', name, args),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
});
