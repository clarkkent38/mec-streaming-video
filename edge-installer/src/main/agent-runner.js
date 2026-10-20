'use strict';
/**
 * agent-runner.js
 * Forks pc-edge-agent/server.js as a child process with the correct env vars
 * built from config-store. The agent process is completely separate from the
 * Electron main process — it is the same server.js that the terminal scripts run.
 *
 * The agent port (5001) is bound to 0.0.0.0 (reachable via Funnel / LAN).
 * The dashboard port (5002) is bound to 127.0.0.1 (local only, never tunnelled).
 *
 * Auto-restart: if the child exits unexpectedly (non-zero code, not a deliberate
 * stop()), it is restarted with exponential back-off up to 30 s.
 */

const { fork }      = require('child_process');
const path          = require('path');
const { app }       = require('electron');
const configStore   = require('./config-store');
const log           = require('./logger');

// Resolve pc-edge-agent/server.js from packaged extraResources or dev layout
function resolveAgentPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'pc-edge-agent', 'server.js'),
    path.join(__dirname, '..', '..', '..', 'pc-edge-agent', 'server.js'),
  ];
  for (const p of candidates) {
    try {
      require('fs').accessSync(p);
      return p;
    } catch (_) {}
  }
  throw new Error(
    'Cannot locate pc-edge-agent/server.js.\n' +
    'Looked in:\n' + candidates.join('\n')
  );
}

// Build the process env for the agent child process
function buildEnv(cfg, publicUrl) {
  return {
    ...process.env,                           // inherit PATH etc.
    PORT:               String(cfg.agentPort        || 5001),
    DASHBOARD_PORT:     String(cfg.dashboardPort    || 5002),
    BIND_HOST:          '0.0.0.0',            // agent is publicly reachable (Funnel or LAN)
    NODE_LABEL:         cfg.nodeLabel          || 'EdgeNest',
    ORCHESTRATOR_URL:   cfg.orchestratorUrl    || '',
    ORIGIN_URL:         cfg.originUrl          || '',
    DELAY_MS:           String(cfg.delayMs     ?? 0),
    AKAMAI_PROXY:       'true',
    DASHBOARD_ENABLED:  'true',
    // TAILSCALE_FUNNEL_URL is set when publicUrl is known (Mode B)
    ...(publicUrl ? { TAILSCALE_FUNNEL_URL: publicUrl } : {}),
    // Suppress Electron's own NODE_APP_INSTANCE leaking into the child
    ELECTRON_RUN_AS_NODE: '1',
  };
}

// ── State ────────────────────────────────────────────────────────────────────

let _child         = null;
let _stopping      = false;
let _backoffMs     = 2000;
let _restartTimer  = null;
let _publicUrl     = null;   // set externally by Tailscale assistant

const listeners = new Set();

function emit(event, data) {
  const { ipcMain } = require('electron');
  // Broadcast to all renderer windows
  try {
    const { BrowserWindow } = require('electron');
    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) w.webContents.send('agent:event', { event, data });
    });
  } catch (_) {}
  listeners.forEach(fn => { try { fn(event, data); } catch (_) {} });
}

// ── Public API ───────────────────────────────────────────────────────────────

function setPublicUrl(url) {
  _publicUrl = url;
  // If agent is already running, restart it so it registers with the new URL
  if (_child) {
    log.info('[agent-runner] Public URL set — restarting agent to re-register:', url);
    _stopping = false;
    _child.kill('SIGTERM');
    // The exit handler will restart it
  }
}

async function start() {
  if (_child) {
    log.warn('[agent-runner] start() called but agent is already running (pid:', _child.pid, ')');
    return;
  }

  _stopping = false;

  let agentPath;
  try {
    agentPath = resolveAgentPath();
  } catch (err) {
    log.error('[agent-runner] Cannot start:', err.message);
    emit('error', { message: err.message, fix: 'Reinstall EdgeNest — the bundled agent files may be missing.' });
    throw err;
  }

  const cfg = configStore.load();
  const env = buildEnv(cfg, _publicUrl);

  log.info('[agent-runner] Starting agent:', agentPath);
  log.info('[agent-runner] PORT=' + env.PORT + ' BIND_HOST=' + env.BIND_HOST +
           ' ORCHESTRATOR=' + env.ORCHESTRATOR_URL + ' LABEL=' + env.NODE_LABEL);

  _child = fork(agentPath, [], {
    env,
    silent: true,          // capture stdout/stderr
    detached: false,
  });

  _child.stdout.on('data', chunk => {
    String(chunk).split('\n').filter(Boolean).forEach(line => {
      log.info('[agent]', line);
    });
  });

  _child.stderr.on('data', chunk => {
    String(chunk).split('\n').filter(Boolean).forEach(line => {
      log.error('[agent:stderr]', line);
    });
  });

  _child.on('error', (err) => {
    log.error('[agent-runner] Child process error:', err.message);
    emit('error', { message: err.message, fix: 'Check that Node.js is available and the agent files are intact.' });
  });

  _child.on('exit', (code, signal) => {
    log.info(`[agent-runner] Agent exited (code=${code} signal=${signal})`);
    _child = null;
    emit('stopped', { code, signal });

    if (!_stopping && code !== 0) {
      // Unexpected exit — schedule restart with back-off
      log.warn(`[agent-runner] Unexpected exit — restarting in ${_backoffMs} ms`);
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

  if (_restartTimer) {
    clearTimeout(_restartTimer);
    _restartTimer = null;
  }

  if (!_child) {
    log.info('[agent-runner] stop() called but no agent running.');
    return;
  }

  log.info('[agent-runner] Stopping agent pid:', _child.pid);

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (_child) {
        log.warn('[agent-runner] Agent did not exit in 5 s — sending SIGKILL');
        _child.kill('SIGKILL');
      }
      resolve();
    }, 5000);

    _child.once('exit', () => {
      clearTimeout(timeout);
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
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = { start, stop, getStatus, setPublicUrl, onEvent };
