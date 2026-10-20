'use strict';
/**
 * state-machine.js
 *
 * Manages the 6 application states and drives the orchestrator polling loop.
 *
 * States:
 *   SETUP          — config incomplete; show setup window
 *   LOCAL_ONLY     — agent running, Funnel not verified; graphs work, not a public edge
 *   PUBLIC_PENDING — Funnel active, agent started, registration in progress
 *   LIVE           — orchestrator lists our edgeId as online AND measuredLatencyMs !== null
 *   DEGRADED       — heartbeat failures, very high RTT, or orchestrator unreachable
 *   OFFLINE        — agent stopped or registration permanently lost
 *
 * Transition triggers:
 *   - Config completeness (from config-store)
 *   - Agent events (started / stopped / error)
 *   - Tailscale public URL set / cleared
 *   - Orchestrator poll result (GET /api/orchestrator/edges every 5 s)
 *
 * LIVE detection: find our edgeId in the edges[] array, verify
 *   edgeStatus === 'online' OR status === 'UP', AND measuredLatencyMs !== null
 *
 * Auto-recovery: on DEGRADED/OFFLINE, retries with back-off; handles
 *   sleep/resume via visibility-change equivalent (setInterval drift detection).
 */

const EventEmitter = require('events');
const http         = require('http');
const https        = require('https');
const configStore  = require('./config-store');
const log          = require('./logger');
const { STATES, ORCHESTRATOR_POLL_MS } = require('../constants');

class StateMachine extends EventEmitter {
  constructor() {
    super();
    this._state       = STATES.SETUP;
    this._detail      = 'Initialising…';
    this._pollTimer   = null;
    this._agentEdgeId = null;   // our edgeId, learned from agent stdout or config
    this._lastPollMs  = 0;      // for sleep/resume detection
    this._degradedCount = 0;    // consecutive degraded polls before OFFLINE
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  start() {
    // Wire up agent events
    const agentRunner = require('./agent-runner');
    agentRunner.onEvent((event, data) => this._onAgentEvent(event, data));

    // Determine initial state
    this._evaluate();

    // Start orchestrator polling loop
    this._startPoll();

    // Sleep/resume detection: if the interval fires >2× late, assume a resume
    this._lastPollMs = Date.now();
    log.info('[state-machine] Started. Initial state:', this._state);
  }

  getState()  { return this._state; }
  getDetail() { return this._detail; }

  // ── State transition ───────────────────────────────────────────────────────

  _setState(newState, detail) {
    if (this._state === newState && this._detail === detail) return;
    const prev = this._state;
    this._state  = newState;
    this._detail = detail;
    log.info(`[state-machine] ${prev} → ${newState}: ${detail}`);
    this.emit('stateChanged', { state: newState, detail, prev });
    this._broadcastToRenderers();
  }

  _broadcastToRenderers() {
    try {
      const { BrowserWindow } = require('electron');
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) {
          w.webContents.send('state:changed', {
            state:  this._state,
            detail: this._detail,
          });
        }
      });
    } catch (_) {}
  }

  // ── Evaluate state synchronously from current conditions ──────────────────

  _evaluate() {
    const cfg      = configStore.load();
    const agentRunner = require('./agent-runner');
    const tsAssistant = require('./tailscale-assistant');

    if (!configStore.isSetupComplete(cfg)) {
      this._setState(STATES.SETUP, 'Configuration incomplete — open Setup to continue.');
      return;
    }

    const agentStatus = agentRunner.getStatus();
    const publicUrl   = tsAssistant.getPublicUrl();

    if (!agentStatus.running) {
      this._setState(STATES.OFFLINE, 'Edge agent is not running.');
      return;
    }

    if (cfg.mode === 'public' && !publicUrl) {
      this._setState(STATES.LOCAL_ONLY,
        'Agent is running on LAN only. Funnel is not active — the Vercel frontend cannot reach this node.');
      return;
    }

    // Agent is running; we stay in PUBLIC_PENDING until the poll confirms LIVE
    if (this._state !== STATES.LIVE && this._state !== STATES.DEGRADED) {
      this._setState(STATES.PUBLIC_PENDING, 'Registering with orchestrator…');
    }
  }

  // ── Agent event handler ───────────────────────────────────────────────────

  _onAgentEvent(event, data) {
    log.info('[state-machine] agent event:', event, data);
    if (event === 'started') {
      this._degradedCount = 0;
      this._evaluate();
    } else if (event === 'stopped') {
      // Only go OFFLINE if we're not about to restart (restarting event comes first)
      // Use a small delay to let the 'restarting' event cancel the OFFLINE transition
      setTimeout(() => {
        const agentRunner = require('./agent-runner');
        if (!agentRunner.getStatus().running) {
          // Check if a restart is queued — if _backoffMs was reset, a restart is pending
          this._setState(STATES.OFFLINE, `Agent stopped (code=${data?.code ?? '?'}).`);
        }
      }, 500);
    } else if (event === 'restarting') {
      this._setState(STATES.DEGRADED, `Agent restarting in ${data?.inMs ?? '?'} ms…`);
    } else if (event === 'error') {
      this._setState(STATES.DEGRADED, `Agent error: ${data?.message || 'unknown'}. Fix: ${data?.fix || ''}`);
    }
  }

  // ── Orchestrator polling ──────────────────────────────────────────────────

  _startPoll() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this._poll(), ORCHESTRATOR_POLL_MS);
    // Immediate first poll
    setTimeout(() => this._poll(), 1000);
  }

  async _poll() {
    // Sleep/resume detection: if we missed a cycle by >3×, re-evaluate everything
    const now = Date.now();
    if (this._lastPollMs && now - this._lastPollMs > ORCHESTRATOR_POLL_MS * 3) {
      log.info('[state-machine] Detected sleep/resume — re-evaluating.');
      this._evaluate();
    }
    this._lastPollMs = now;

    // Skip poll if not past setup
    if (this._state === STATES.SETUP) return;

    const cfg = configStore.load();
    if (!cfg.orchestratorUrl) return;

    const edgeId = this._getOurEdgeId();
    if (!edgeId) return;

    try {
      const edges = await this._fetchEdges(cfg.orchestratorUrl);
      this._processPollResult(edges, edgeId, cfg);
    } catch (err) {
      log.warn('[state-machine] Orchestrator poll failed:', err.message);
      this._onPollError(err);
    }
  }

  _getOurEdgeId() {
    // Try config first (persisted after first registration), then derive from label
    const cfg = configStore.load();
    if (cfg.edgeId) return cfg.edgeId;
    // The agent generates: <label-lowercased-dashes>-<4chars>, but we don't know the
    // random suffix until the agent tells us.  Match by label prefix in the edges list.
    return null;  // will fall back to label-match in _processPollResult
  }

  _processPollResult(edges, edgeId, cfg) {
    const agentRunner = require('./agent-runner');
    if (!agentRunner.getStatus().running) return; // agent stopped mid-poll

    // Try exact edgeId match first, then label prefix match
    let found = edgeId ? edges.find(e => e.edgeId === edgeId || e.id === edgeId) : null;
    if (!found && cfg.nodeLabel) {
      const labelLower = cfg.nodeLabel.toLowerCase().replace(/[^a-z0-9]/g, '-');
      found = edges.find(e =>
        (e.edgeId || '').startsWith(labelLower) || (e.label || '') === cfg.nodeLabel
      );
      // Persist the discovered edgeId so future polls use exact match
      if (found && found.edgeId) configStore.save({ edgeId: found.edgeId });
    }

    if (!found) {
      this._degradedCount++;
      if (this._degradedCount >= 3) {
        this._setState(STATES.DEGRADED, 'Edge not found in orchestrator registry after 3 polls. Re-registering…');
      }
      return;
    }

    // LIVE detection: edgeStatus === 'online' OR status === 'UP', AND measuredLatencyMs !== null
    const isOnline = found.edgeStatus === 'online' || found.status === 'UP';
    const hasRtt   = found.measuredLatencyMs !== null && found.measuredLatencyMs !== undefined;

    if (isOnline && hasRtt) {
      this._degradedCount = 0;
      this._setState(STATES.LIVE,
        `Live — RTT ${found.measuredLatencyMs} ms | Cache hit ${(found.cacheHitRatio * 100).toFixed(1)}% | ${found.requestsServed} requests served`
      );
      return;
    }

    if (isOnline && !hasRtt) {
      // Registered but orchestrator hasn't measured RTT yet (first few seconds)
      this._setState(STATES.PUBLIC_PENDING, 'Registered — waiting for orchestrator RTT measurement…');
      return;
    }

    // Marked offline by orchestrator
    this._degradedCount++;
    const reason = `Orchestrator reports edge as ${found.edgeStatus || found.status}.`;
    if (this._degradedCount >= 2) {
      this._setState(STATES.DEGRADED, reason + ' Heartbeat may have lapsed.');
    }
  }

  _onPollError(err) {
    this._degradedCount++;
    if (this._degradedCount >= 3) {
      const isRunning = (() => {
        try { return require('./agent-runner').getStatus().running; } catch (_) { return false; }
      })();
      if (!isRunning) {
        this._setState(STATES.OFFLINE, 'Agent stopped and orchestrator is unreachable.');
      } else {
        this._setState(STATES.DEGRADED,
          `Orchestrator unreachable (${err.message}). ` +
          'Render free-tier may be sleeping. Retrying…'
        );
      }
    }
  }

  // ── HTTP helper: GET /api/orchestrator/edges ──────────────────────────────

  _fetchEdges(orchestratorUrl) {
    return new Promise((resolve, reject) => {
      const url = orchestratorUrl.replace(/\/$/, '') + '/api/orchestrator/edges';
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(url, { timeout: 8000 }, (res) => {
        let body = '';
        res.on('data', c => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try {
            const json = JSON.parse(body);
            // Tolerate both { edges: [...] } and bare array
            const arr = Array.isArray(json) ? json : (json.edges || json.nodes || json.routes || []);
            resolve(arr);
          } catch (e) {
            reject(new Error('Invalid JSON from orchestrator: ' + e.message));
          }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
    });
  }
}

// Singleton
module.exports = new StateMachine();
