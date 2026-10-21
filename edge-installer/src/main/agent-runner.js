'use strict';
/**
 * agent-runner.js
 *
 * Spawns pc-edge-agent/server.js using the system Node.js on PATH.
 * Works in both dev (repo layout) and packaged (extraResources) contexts.
 *
 * Key design decisions:
 *  - Uses spawn() not fork() — fork() requires matching Node version between
 *    Electron's embedded Node and the child, which fails in packaged apps.
 *  - pc-edge-agent/node_modules is bundled in extraResources (package.json
 *    no longer excludes node_modules from the copy).
 *  - If node_modules is still missing (edge case), runs npm install first.
 *  - Auto-restart on unexpected exit with exponential back-off (max 30 s).
 *  - stop() sends SIGTERM then SIGKILL after 5 s.
 */

const { spawn, execFileSync } = require('child_process');
const path                    = require('path');
const fs                      = require('fs');
const configStore             = require('./config-store');
const log                     = require('./logger');

// ── Path resolution ───────────────────────────────────────────────────────────

function resolveAgentDir() {
  const candidates = [
    // Packaged app: Electron puts extraResources next to resources/app.asar
    path.join(process.resourcesPath || '', 'pc-edge-agent'),
    // Dev: repo layout — edge-installer is a sibling of pc-edge-agent
    path.join(__dirname, '..', '..', '..', 'pc-edge-agent'),
    // Fallback: two levels up from src/main/
    path.join(__dirname, '..', '..', 'pc-edge-agent'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'server.js'))) return p;
  }
  throw new Error(
    'Cannot find pc-edge-agent/server.js.\nLooked in:\n' +
    candidates.join('\n') +
    '\n\nFix: reinstall EdgeNest. If running from source, make sure ' +
    'pc-edge-agent/ is at the repo root.'
  );
}

/**
 * Resolve a usable `node` binary.
 * Priority: system node on PATH → node.exe next to Electron exe.
 */
function resolveNodeBin() {
  // 1. System node (covers both dev and most packaged installs)
  try {
    const out = execFileSync('node', ['--version'],
      { timeout: 3000, windowsHide: true, stdio: 'pipe' });
    if (out.toString().trim().startsWith('v')) return 'node';
  } catch (_) {}

  // 2. node.exe bundled next to the Electron executable
  const nodeNext = path.join(path.dirname(process.execPath), 'node.exe');
  if (fs.existsSync(nodeNext)) return nodeNext;

  // 3. Last resort: run Electron itself as Node
  //    (set ELECTRON_RUN_AS_NODE=1 in env to enable this mode)
  return process.execPath;
}

/**
 * Install pc-edge-agent deps if node_modules is missing.
 * This should never happen in a correctly built package (node_modules is
 * bundled in extraResources), but it's a safe fallback.
 */
function ensureAgentDeps(agentDir) {
  const nmDir = path.join(agentDir, 'node_modules');
  if (fs.existsSync(path.join(nmDir, 'express'))) return; // already installed

  log.info('[agent-runner] node_modules missing — running npm install in', agentDir);
  try {
    execFileSync('npm', ['install', '--omit=dev', '--no-fund', '--no-audit'],
      { cwd: agentDir, timeout: 120000, windowsHide: true, stdio: 'pipe' });
    log.info('[agent-runner] npm install completed.');
  } catch (err) {
    throw new Error(
      `Failed to install agent dependencies: ${err.message}\n` +
      `Manual fix: open a terminal, cd "${agentDir}", run: npm install`
    );
  }
}

// ── Environment builder ───────────────────────────────────────────────────────

function buildEnv(cfg, publicUrl) {
  // Generate a stable edgeId from the node label and persist it.
  if (!cfg.edgeId) {
    const label = (cfg.nodeLabel || 'EdgeNest').toLowerCase().replace(/[^a-z0-9]/g, '-');
    const suffix = Math.random().toString(36).substring(2, 6);
    cfg.edgeId = `${label}-${suffix}`;
    configStore.save({ edgeId: cfg.edgeId });
    log.info('[agent-runner] Generated stable edgeId:', cfg.edgeId);
  }

  // Always use the saved publicUrl if available — even if _publicUrl wasn't
  // passed in (handles case where agent starts before Tailscale sets the URL)
  const effectivePublicUrl = publicUrl || cfg.publicUrl || null;

  if (effectivePublicUrl) {
    log.info('[agent-runner] Using public URL:', effectivePublicUrl);
  } else {
    log.warn('[agent-runner] No public URL set — agent will register with LAN IP');
  }

  return {
    ...process.env,
    PORT:                String(cfg.agentPort     || 5001),
    DASHBOARD_PORT:      String(cfg.dashboardPort || 5002),
    BIND_HOST:           '0.0.0.0',
    NODE_LABEL:          cfg.nodeLabel             || 'EdgeNest',
    EDGE_ID:             cfg.edgeId,
    ORCHESTRATOR_URL:    cfg.orchestratorUrl        || '',
    ORIGIN_URL:          cfg.originUrl              || '',
    DELAY_MS:            String(cfg.delayMs         ?? 0),
    AKAMAI_PROXY:        'true',
    DASHBOARD_ENABLED:   'true',
    ELECTRON_RUN_AS_NODE: '1',
    ...(effectivePublicUrl ? { TAILSCALE_FUNNEL_URL: effectivePublicUrl } : {}),
  };
}

// ── State ─────────────────────────────────────────────────────────────────────

let _child        = null;
let _stopping     = false;
let _backoffMs    = 2000;
let _restartTimer = null;
let _publicUrl    = null;

const _listeners  = new Set();

function emit(event, data) {
  // Push to all open renderer windows
  try {
    const { BrowserWindow } = require('electron');
    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) w.webContents.send('agent:event', { event, data });
    });
  } catch (_) {}
  _listeners.forEach(fn => { try { fn(event, data); } catch (_) {} });
}

// ── Public API ────────────────────────────────────────────────────────────────

function setPublicUrl(url) {
  _publicUrl = url;
  // If the agent is already running, restart it so it re-registers with the
  // new public URL as TAILSCALE_FUNNEL_URL.
  if (_child) {
    log.info('[agent-runner] Public URL changed — restarting to re-register:', url);
    // Use a controlled restart: kill current, let exit handler restart cleanly
    // Mark as intentional so backoff doesn't accumulate
    _backoffMs = 500;    // restart quickly — this is a deliberate URL update
    _stopping  = false;  // allow auto-restart after the kill
    _child.kill('SIGTERM');
  }
}

async function start() {
  if (_child) {
    log.warn('[agent-runner] Already running (pid:', _child.pid, ')');
    return;
  }
  _stopping = false;

  // 1. Locate agent
  let agentDir;
  try {
    agentDir = resolveAgentDir();
  } catch (err) {
    log.error('[agent-runner] Cannot locate agent:', err.message);
    emit('error', {
      message: err.message,
      fix: 'Reinstall EdgeNest. The bundled agent files appear to be missing.',
    });
    throw err;
  }

  // 2. Find Node binary
  const nodeBin = resolveNodeBin();
  log.info('[agent-runner] Node binary:', nodeBin);

  // 3. Install deps if missing
  try {
    ensureAgentDeps(agentDir);
  } catch (err) {
    log.error('[agent-runner] Dep install failed:', err.message);
    emit('error', { message: err.message, fix: err.message });
    throw err;
  }

  // 4. Build env and spawn
  const cfg        = configStore.load();
  const env        = buildEnv(cfg, _publicUrl);
  const serverPath = path.join(agentDir, 'server.js');

  log.info('[agent-runner] Spawning:', nodeBin, serverPath);
  log.info(`[agent-runner] PORT=${env.PORT} ORCH=${env.ORCHESTRATOR_URL} LABEL=${env.NODE_LABEL}`);

  _child = spawn(nodeBin, [serverPath], {
    env,
    cwd:      agentDir,      // server.js does __dirname-relative lookups (config.yaml etc.)
    detached: false,
    stdio:    ['ignore', 'pipe', 'pipe'],
  });

  _child.stdout.on('data', chunk => {
    String(chunk).split('\n').filter(Boolean).forEach(l => log.info('[agent]', l));
  });
  _child.stderr.on('data', chunk => {
    String(chunk).split('\n').filter(Boolean).forEach(l => log.error('[agent:err]', l));
  });

  _child.on('error', err => {
    log.error('[agent-runner] Spawn error:', err.message);
    emit('error', {
      message: err.message,
      fix: nodeBin === process.execPath
        ? 'Node.js was not found on PATH. Install Node.js LTS from https://nodejs.org and restart EdgeNest.'
        : `Unexpected spawn error: ${err.message}`,
    });
  });

  _child.on('exit', (code, signal) => {
    log.info(`[agent-runner] Agent exited — code=${code} signal=${signal}`);
    _child = null;
    emit('stopped', { code, signal });

    if (!_stopping) {
      log.warn(`[agent-runner] Unexpected exit — retrying in ${_backoffMs} ms`);
      emit('restarting', { inMs: _backoffMs });
      _restartTimer = setTimeout(() => {
        _restartTimer = null;
        start().catch(err => log.error('[agent-runner] Restart failed:', err.message));
      }, _backoffMs);
      _backoffMs = Math.min(30000, _backoffMs * 1.5);
    } else {
      _backoffMs = 2000; // reset on clean stop
    }
  });

  emit('started', { pid: _child.pid, port: env.PORT });
  log.info('[agent-runner] Agent started, pid:', _child.pid);
}

async function stop() {
  _stopping = true;
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  if (!_child) { log.info('[agent-runner] stop() — nothing running.'); return; }

  log.info('[agent-runner] Stopping pid:', _child.pid);
  return new Promise(resolve => {
    const killTimer = setTimeout(() => {
      if (_child) {
        log.warn('[agent-runner] Timeout — sending SIGKILL');
        _child.kill('SIGKILL');
      }
      resolve();
    }, 5000);

    _child.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });

    _child.kill('SIGTERM');
  });
}

function getStatus() {
  return {
    running:   !!_child,
    pid:       _child ? _child.pid : null,
    publicUrl: _publicUrl,
  };
}

function onEvent(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

module.exports = { start, stop, getStatus, setPublicUrl, onEvent };
