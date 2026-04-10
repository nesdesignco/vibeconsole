/**
 * Preload bridge for renderer.
 * Exposes a minimal, explicit API surface with contextIsolation enabled.
 */

const { contextBridge, ipcRenderer, clipboard } = require('electron');
const { IPC } = require('../shared/ipcChannels');

// Allowlist is derived from the single source of truth (ipcChannels.js).
const allowedChannels = new Set(Object.values(IPC));

function isAllowedChannel(channel) {
  return typeof channel === 'string' && allowedChannels.has(channel);
}

contextBridge.exposeInMainWorld('vibe', {
  ipc: {
    send: (channel, ...args) => {
      if (!isAllowedChannel(channel)) return;
      ipcRenderer.send(channel, ...args);
    },
    invoke: (channel, ...args) => {
      if (!isAllowedChannel(channel)) {
        return Promise.reject(new Error('Blocked IPC channel'));
      }
      return ipcRenderer.invoke(channel, ...args);
    },
    on: (channel, listener) => {
      if (!isAllowedChannel(channel) || typeof listener !== 'function') return () => {};
      const wrapped = (_event, ...args) => listener(...args);
      ipcRenderer.on(channel, wrapped);
      return () => {
        ipcRenderer.removeListener(channel, wrapped);
      };
    }
  },
  clipboard: {
    readText: () => clipboard.readText(),
    writeText: (text) => clipboard.writeText(text)
  }
});
