'use strict';

// ── One-line rename: change APP_NAME here and it propagates everywhere ──────
const APP_NAME = 'EdgeNest';

const APP_VERSION    = '1.0.0';
const APP_ID         = 'com.edgenest.app';

// Ports (user-visible defaults; overridable in config)
const DEFAULT_AGENT_PORT     = 5001;
const DEFAULT_DASHBOARD_PORT = 5002;

// Orchestrator polling interval (ms)
const ORCHESTRATOR_POLL_MS = 5000;

// Tailscale checklist re-check interval (ms)
const TS_CHECK_INTERVAL_MS = 3000;

// How long to wait for Render free-tier wake-up (ms)
const RENDER_WAKE_TIMEOUT_MS = 90000;

// State machine states
const STATES = Object.freeze({
  SETUP:          'SETUP',
  LOCAL_ONLY:     'LOCAL_ONLY',
  PUBLIC_PENDING: 'PUBLIC_PENDING',
  LIVE:           'LIVE',
  DEGRADED:       'DEGRADED',
  OFFLINE:        'OFFLINE',
});

module.exports = {
  APP_NAME,
  APP_VERSION,
  APP_ID,
  DEFAULT_AGENT_PORT,
  DEFAULT_DASHBOARD_PORT,
  ORCHESTRATOR_POLL_MS,
  TS_CHECK_INTERVAL_MS,
  RENDER_WAKE_TIMEOUT_MS,
  STATES,
};
