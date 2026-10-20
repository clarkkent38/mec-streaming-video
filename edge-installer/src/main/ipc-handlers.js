'use strict';
/**
 * ipc-handlers.js
 * Registers all main-process IPC handlers.
 * Renderers call ipcRenderer.invoke(channel, ...args) and get a Promise back.
 * All handlers return { ok: true, ... } or { ok: false, error: '...' }.
 */

const { ipcMain, shell, clipboard } = require('electron');
const configStore = require('./config-store');
const log         = require('./logger');

// These are set by app.js after the modules are created
let _stateMachine = null;
let _agentRunner  = null;
let _tsAssistant  = null;
let _selfTest     = null;
let _windows      = null;

function init({ stateMachine, agentRunner, tsAssistant, selfTest, windows }) {
  _stateMachine = stateMachine;
  _agentRunner  = agentRunner;
  _tsAssistant  = tsAssistant;
  _selfTest     = selfTest;
  _windows      = windows;
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const result = await fn(event, ...args);
      return { ok: true, ...(result || {}) };
    } catch (err) {
      log.error(`[ipc] ${channel} error:`, err.message);
      return { ok: false, error: err.message };
    }
  });
}

function register() {
  // ── Config ───────────────────────────────────────────────────────────────
  handle('config:load',  () => ({ config: configStore.load() }));
  handle('config:save',  (_e, updates) => ({ config: configStore.save(updates) }));
  handle('config:reset', () => ({ config: configStore.reset() }));
  handle('config:defaults', () => ({ defaults: configStore.loadDefaults() }));

  // ── Agent ────────────────────────────────────────────────────────────────
  handle('agent:start', async () => {
    await _agentRunner.start();
    return {};
  });
  handle('agent:stop', async () => {
    await _agentRunner.stop();
    return {};
  });
  handle('agent:status', () => ({ status: _agentRunner.getStatus() }));

  // ── State machine ────────────────────────────────────────────────────────
  handle('state:get', () => ({ state: _stateMachine.getState(), detail: _stateMachine.getDetail() }));

  // ── Tailscale ────────────────────────────────────────────────────────────
  handle('tailscale:check', async () => {
    const result = await _tsAssistant.checkAll();
    return result;
  });
  handle('tailscale:login', async () => {
    await _tsAssistant.login();
    return {};
  });
  handle('tailscale:enableFunnel', async () => {
    const result = await _tsAssistant.enableFunnel();
    return result;
  });
  handle('tailscale:stopFunnel', async () => {
    await _tsAssistant.stopFunnel();
    return {};
  });
  handle('tailscale:getPublicUrl', () => ({ url: _tsAssistant.getPublicUrl() }));

  // ── Connection tests ─────────────────────────────────────────────────────
  handle('test:orchestrator', async (_e, url) => {
    const result = await testEndpoint(url || configStore.load().orchestratorUrl, '/health', 90000);
    return result;
  });
  handle('test:origin', async (_e, url) => {
    const result = await testEndpoint(url || configStore.load().originUrl, '/health', 15000);
    return result;
  });
  handle('test:port', async (_e, port) => {
    const { isPortFree, findFreePort } = require('./port-utils');
    const free = await isPortFree(port);
    const suggestion = free ? port : await findFreePort(port + 1);
    return { free, suggestion };
  });

  // ── Self-test ────────────────────────────────────────────────────────────
  handle('selftest:run', async () => {
    const results = await _selfTest.run();
    return { results };
  });

  // ── Diagnostics ──────────────────────────────────────────────────────────
  handle('diagnostics:collect', async () => {
    const diag = await _selfTest.collectDiagnostics();
    return { text: diag };
  });
  handle('diagnostics:copyToClipboard', async () => {
    const diag = await _selfTest.collectDiagnostics();
    clipboard.writeText(diag);
    return {};
  });

  // ── Window navigation ────────────────────────────────────────────────────
  handle('window:openDashboard',  () => { _windows.openDashboard();  return {}; });
  handle('window:openSetup',      () => { _windows.openSetup();      return {}; });
  handle('window:openTailscale',  () => { _windows.openTailscale();  return {}; });

  // ── Misc ─────────────────────────────────────────────────────────────────
  handle('shell:openExternal', (_e, url) => { shell.openExternal(url); return {}; });
  handle('log:getBuffer', () => ({ lines: log.getBuffer() }));

  // ── Autostart ────────────────────────────────────────────────────────────
  handle('autostart:set', (_e, enable) => {
    const { app } = require('electron');
    app.setLoginItemSettings({ openAtLogin: enable, name: 'EdgeNest' });
    return { enabled: enable };
  });
  handle('autostart:get', () => {
    const { app } = require('electron');
    const s = app.getLoginItemSettings({ name: 'EdgeNest' });
    return { enabled: s.openAtLogin };
  });
}

// ── Reachability helper ───────────────────────────────────────────────────────
// Uses Node's built-in http/https — no extra deps.
// Shows "Waking up server…" for Render free-tier cold starts (retries up to timeoutMs).
function testEndpoint(baseUrl, path, timeoutMs) {
  return new Promise((resolve) => {
    const url = baseUrl.replace(/\/$/, '') + path;
    const start = Date.now();
    const http  = require(url.startsWith('https') ? 'https' : 'http');

    function attempt() {
      const elapsed = Date.now() - start;
      if (elapsed > timeoutMs) {
        resolve({ reachable: false, latencyMs: null, error: 'Timeout — server did not respond in time.' });
        return;
      }

      const attemptStart = Date.now();
      const req = http.get(url, { timeout: 5000 }, (res) => {
        let body = '';
        res.on('data', c => (body += c));
        res.on('end', () => {
          const latencyMs = Date.now() - attemptStart;
          if (res.statusCode === 200) {
            resolve({ reachable: true, latencyMs, statusCode: res.statusCode });
          } else {
            resolve({ reachable: false, latencyMs, statusCode: res.statusCode, error: `HTTP ${res.statusCode}` });
          }
        });
      });
      req.on('timeout', () => { req.destroy(); });
      req.on('error', (err) => {
        const elapsed2 = Date.now() - start;
        if (elapsed2 < timeoutMs - 3000) {
          // Still within budget — Render free-tier may be waking up; retry after 3 s
          log.info(`[test] ${url} not yet reachable (${err.message}), retrying…`);
          setTimeout(attempt, 3000);
        } else {
          resolve({ reachable: false, latencyMs: null, error: err.message });
        }
      });
    }

    attempt();
  });
}

module.exports = { init, register };
