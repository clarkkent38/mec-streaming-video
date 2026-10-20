'use strict';
/**
 * app.js — Electron main process
 * Single-instance lock, tray menu, window managers, IPC, state machine, agent runner.
 */

const { app, Menu, Tray, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const { APP_NAME } = require('../constants');

// Singleton modules
const log            = require('./logger');
const configStore    = require('./config-store');
const ipcHandlers    = require('./ipc-handlers');
const agentRunner    = require('./agent-runner');
const stateMachine   = require('./state-machine');
const tsAssistant    = require('./tailscale-assistant');
const selfTest       = require('./self-test');

// Window managers (created inline below)
let tray = null;
let setupWin = null;
let tailscaleWin = null;
let dashboardWin = null;

// Single-instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  log.info('[app] Second instance blocked — focusing existing window');
  if (dashboardWin && !dashboardWin.isDestroyed()) {
    if (dashboardWin.isMinimized()) dashboardWin.restore();
    dashboardWin.focus();
  } else if (setupWin && !setupWin.isDestroyed()) {
    if (setupWin.isMinimized()) setupWin.restore();
    setupWin.focus();
  }
});

app.whenReady().then(() => {
  log.info(`[app] ${APP_NAME} starting…`);

  // Wire up IPC
  const windows = {
    openSetup,
    openTailscale,
    openDashboard,
  };
  ipcHandlers.init({ stateMachine, agentRunner, tsAssistant, selfTest, windows });
  ipcHandlers.register();

  // Create tray icon
  createTray();

  // State machine auto-start
  stateMachine.start();

  // Window routing: if config incomplete, open setup; otherwise open dashboard
  if (configStore.isSetupComplete()) {
    openDashboard();
  } else {
    openSetup();
  }

  log.info('[app] Ready.');
});

app.on('window-all-closed', () => {
  // Keep running in tray — don't quit on window close
});

app.on('before-quit', async () => {
  log.info('[app] Exiting — stopping agent and cleaning up Tailscale Funnel…');
  await agentRunner.stop();
  await tsAssistant.stopFunnel();
  log.info('[app] Goodbye.');
});

// ─── Tray Icon & Menu ─────────────────────────────────────────────────────────

function createTray() {
  // Use a built-in placeholder image (in production, load from assets/icons/)
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  updateTrayMenu();

  // State machine events update the tray
  stateMachine.on('stateChanged', updateTrayMenu);
}

function updateTrayMenu() {
  const state = stateMachine.getState();
  const agentStatus = agentRunner.getStatus();
  const cfg = configStore.load();

  const statusLabel = `Status: ${state}`;
  const agentLabel  = agentStatus.running ? '■ Stop Edge' : '▶ Start Edge';

  const template = [
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    { label: 'Open Dashboard', click: openDashboard },
    { label: 'Setup / Settings', click: openSetup },
    { type: 'separator' },
    { label: agentLabel, click: toggleAgent },
    { label: 'Copy Public URL', click: copyPublicUrl, enabled: !!cfg.publicUrl },
    { label: 'Run Self-Test', click: runSelfTest },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ];

  const menu = Menu.buildFromTemplate(template);
  tray.setContextMenu(menu);
}

async function toggleAgent() {
  const status = agentRunner.getStatus();
  if (status.running) await agentRunner.stop();
  else await agentRunner.start();
  updateTrayMenu();
}

function copyPublicUrl() {
  const cfg = configStore.load();
  const { clipboard } = require('electron');
  if (cfg.publicUrl) {
    clipboard.writeText(cfg.publicUrl);
    log.info('[tray] Public URL copied to clipboard');
  }
}

function runSelfTest() {
  selfTest.run().then((results) => {
    const passed = results.filter(r => r.pass).length;
    log.info(`[self-test] ${passed}/${results.length} checks passed`);
    openDashboard(); // show results in dashboard or a dedicated window
  });
}

// ─── Window Managers ──────────────────────────────────────────────────────────

function openSetup() {
  if (setupWin && !setupWin.isDestroyed()) {
    setupWin.focus();
    return;
  }
  setupWin = new BrowserWindow({
    width: 700,
    height: 600,
    title: `${APP_NAME} — Setup`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setupWin.loadFile(path.join(__dirname, '..', 'renderer', 'setup', 'setup.html'));
  setupWin.on('closed', () => { setupWin = null; });
}

function openTailscale() {
  if (tailscaleWin && !tailscaleWin.isDestroyed()) {
    tailscaleWin.focus();
    return;
  }
  tailscaleWin = new BrowserWindow({
    width: 600,
    height: 700,
    title: `${APP_NAME} — Tailscale Assistant`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  tailscaleWin.loadFile(path.join(__dirname, '..', 'renderer', 'tailscale', 'tailscale.html'));
  tailscaleWin.on('closed', () => { tailscaleWin = null; });
}

function openDashboard() {
  if (dashboardWin && !dashboardWin.isDestroyed()) {
    dashboardWin.focus();
    return;
  }
  dashboardWin = new BrowserWindow({
    width: 1200,
    height: 800,
    title: `${APP_NAME} — Dashboard`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  dashboardWin.loadFile(path.join(__dirname, '..', 'renderer', 'dashboard', 'dashboard.html'));
  dashboardWin.on('closed', () => { dashboardWin = null; });
}

module.exports = { openSetup, openTailscale, openDashboard };
