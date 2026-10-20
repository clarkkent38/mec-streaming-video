'use strict';
/**
 * config-store.js
 * Persists user configuration to %APPDATA%\EdgeNest\config.json.
 * Merges saved values over defaults.json on load.
 * Never crashes on a corrupt file — falls back to defaults with a warning.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { APP_NAME } = require('../constants');

// Resolve defaults.json from both dev layout and packaged extraResources
function loadDefaults() {
  const candidates = [
    path.join(process.resourcesPath || '', 'defaults.json'),
    path.join(__dirname, '..', '..', 'defaults.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {}
    }
  }
  // Hard fallback — should never reach here in normal operation
  return {
    orchestratorUrl: 'https://orchestrator-id88.onrender.com',
    originUrl:       'https://origin-server-1ge5.onrender.com',
    agentPort:       5001,
    dashboardPort:   5002,
    delayMs:         0,
    mode:            'public',
  };
}

function getConfigDir() {
  return path.join(os.homedir(), 'AppData', 'Roaming', APP_NAME);
}

function getConfigPath() {
  return path.join(getConfigDir(), 'config.json');
}

function ensureDir() {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

let _cache = null;

function load() {
  if (_cache) return _cache;
  const defaults = loadDefaults();
  const filePath = getConfigPath();
  let saved = {};
  if (fs.existsSync(filePath)) {
    try {
      saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      console.warn(`[config-store] Corrupt config.json — using defaults. Error: ${err.message}`);
      saved = {};
    }
  }
  _cache = Object.assign({}, defaults, saved);
  return _cache;
}

function save(updates) {
  ensureDir();
  const current = load();
  _cache = Object.assign(current, updates);
  fs.writeFileSync(getConfigPath(), JSON.stringify(_cache, null, 2), 'utf8');
  return _cache;
}

function reset() {
  _cache = null;
  const filePath = getConfigPath();
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  return load();
}

function isSetupComplete(cfg) {
  cfg = cfg || load();
  return !!(cfg.nodeLabel && cfg.orchestratorUrl && cfg.originUrl && cfg.agentPort);
}

module.exports = { load, save, reset, isSetupComplete, getConfigDir, getConfigPath, loadDefaults };
