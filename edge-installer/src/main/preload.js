'use strict';
/**
 * preload.js
 * Exposes a narrow, typed API to renderer processes via contextBridge.
 * Renderers never get access to Node or Electron internals directly.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('edgenest', {
  // Config
  loadConfig:     ()        => ipcRenderer.invoke('config:load'),
  saveConfig:     (updates) => ipcRenderer.invoke('config:save', updates),
  resetConfig:    ()        => ipcRenderer.invoke('config:reset'),
  loadDefaults:   ()        => ipcRenderer.invoke('config:defaults'),

  // Agent
  startAgent:     ()        => ipcRenderer.invoke('agent:start'),
  stopAgent:      ()        => ipcRenderer.invoke('agent:stop'),
  agentStatus:    ()        => ipcRenderer.invoke('agent:status'),

  // State
  getState:       ()        => ipcRenderer.invoke('state:get'),

  // Tailscale
  tailscaleCheck:       ()    => ipcRenderer.invoke('tailscale:check'),
  tailscaleLogin:       ()    => ipcRenderer.invoke('tailscale:login'),
  tailscaleEnableFunnel: ()   => ipcRenderer.invoke('tailscale:enableFunnel'),
  tailscaleStopFunnel:  ()    => ipcRenderer.invoke('tailscale:stopFunnel'),
  tailscaleGetUrl:      ()    => ipcRenderer.invoke('tailscale:getPublicUrl'),

  // Connection tests
  testOrchestrator: (url) => ipcRenderer.invoke('test:orchestrator', url),
  testOrigin:       (url) => ipcRenderer.invoke('test:origin', url),
  testPort:         (p)   => ipcRenderer.invoke('test:port', p),

  // Self-test & Diagnostics
  runSelfTest:        ()  => ipcRenderer.invoke('selftest:run'),
  collectDiagnostics: ()  => ipcRenderer.invoke('diagnostics:collect'),
  copyDiagnostics:    ()  => ipcRenderer.invoke('diagnostics:copyToClipboard'),

  // Windows
  openDashboard:  ()        => ipcRenderer.invoke('window:openDashboard'),
  openSetup:      ()        => ipcRenderer.invoke('window:openSetup'),
  openTailscale:  ()        => ipcRenderer.invoke('window:openTailscale'),

  // Shell
  openExternal:   (url)     => ipcRenderer.invoke('shell:openExternal', url),

  // Logging
  getLogs:        ()        => ipcRenderer.invoke('log:getBuffer'),

  // Autostart
  setAutostart:   (on)      => ipcRenderer.invoke('autostart:set', on),
  getAutostart:   ()        => ipcRenderer.invoke('autostart:get'),

  // Event listeners pushed from main process
  on: (channel, fn) => {
    const allowed = ['state:changed', 'agent:event', 'tailscale:update'];
    if (!allowed.includes(channel)) throw new Error(`Channel not allowed: ${channel}`);
    ipcRenderer.on(channel, (_e, ...args) => fn(...args));
  },
  off: (channel, fn) => {
    ipcRenderer.removeListener(channel, fn);
  },
});
