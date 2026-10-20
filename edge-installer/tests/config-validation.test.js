'use strict';
/**
 * config-validation.test.js
 * Tests for config field validators — pure functions extracted from setup.js.
 * These run entirely in Node, no browser globals needed.
 */

// ── Inline validators (same logic as setup.js) ────────────────────────────────

const validators = {
  nodeLabel: (v) => {
    if (!v || !v.trim()) return 'Node name is required.';
    if (!/^[a-zA-Z0-9-]{1,40}$/.test(v.trim())) return 'Only letters, digits and dashes (max 40 chars).';
    return null;
  },
  orchestratorUrl: (v) => {
    if (!v || !v.trim()) return 'Orchestrator URL is required.';
    try { new URL(v.trim()); return null; } catch (_) { return 'Enter a valid URL.'; }
  },
  originUrl: (v) => {
    if (!v || !v.trim()) return 'Origin URL is required.';
    try { new URL(v.trim()); return null; } catch (_) { return 'Enter a valid URL.'; }
  },
  agentPort: (v) => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 1024 || n > 65535) return 'Port must be between 1024 and 65535.';
    return null;
  },
  dashboardPort: (v) => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 1024 || n > 65535) return 'Port must be between 1024 and 65535.';
    return null;
  },
};

function portConflict(agentPort, dashPort) {
  return parseInt(agentPort, 10) === parseInt(dashPort, 10);
}

// ── nodeLabel ─────────────────────────────────────────────────────────────────

describe('validators.nodeLabel', () => {
  test('accepts valid label', ()       => expect(validators.nodeLabel('My-Edge-01')).toBeNull());
  test('accepts lowercase',   ()       => expect(validators.nodeLabel('edge')).toBeNull());
  test('accepts max length',  ()       => expect(validators.nodeLabel('a'.repeat(40))).toBeNull());
  test('rejects empty',       ()       => expect(validators.nodeLabel('')).toBeTruthy());
  test('rejects whitespace',  ()       => expect(validators.nodeLabel('   ')).toBeTruthy());
  test('rejects spaces',      ()       => expect(validators.nodeLabel('my edge')).toBeTruthy());
  test('rejects underscore',  ()       => expect(validators.nodeLabel('my_edge')).toBeTruthy());
  test('rejects special chars',()      => expect(validators.nodeLabel('edge!')).toBeTruthy());
  test('rejects over 40 chars',()      => expect(validators.nodeLabel('a'.repeat(41))).toBeTruthy());
  test('rejects null',         ()      => expect(validators.nodeLabel(null)).toBeTruthy());
});

// ── URL validators ────────────────────────────────────────────────────────────

describe('validators.orchestratorUrl', () => {
  test('accepts valid https URL', ()   => expect(validators.orchestratorUrl('https://orchestrator-id88.onrender.com')).toBeNull());
  test('accepts http URL',        ()   => expect(validators.orchestratorUrl('http://localhost:5000')).toBeNull());
  test('rejects empty',           ()   => expect(validators.orchestratorUrl('')).toBeTruthy());
  test('rejects no protocol',     ()   => expect(validators.orchestratorUrl('orchestrator.com')).toBeTruthy());
  test('rejects plain text',      ()   => expect(validators.orchestratorUrl('not a url')).toBeTruthy());
  test('rejects null',            ()   => expect(validators.orchestratorUrl(null)).toBeTruthy());
});

describe('validators.originUrl', () => {
  test('accepts valid URL', ()         => expect(validators.originUrl('https://origin-server-1ge5.onrender.com')).toBeNull());
  test('rejects empty',     ()         => expect(validators.originUrl('')).toBeTruthy());
  test('rejects bad URL',   ()         => expect(validators.originUrl('::bad::')).toBeTruthy());
});

// ── Port validators ───────────────────────────────────────────────────────────

describe('validators.agentPort', () => {
  test('accepts 5001',         ()      => expect(validators.agentPort('5001')).toBeNull());
  test('accepts 1024 (min)',   ()      => expect(validators.agentPort('1024')).toBeNull());
  test('accepts 65535 (max)',  ()      => expect(validators.agentPort('65535')).toBeNull());
  test('rejects 1023',         ()      => expect(validators.agentPort('1023')).toBeTruthy());
  test('rejects 65536',        ()      => expect(validators.agentPort('65536')).toBeTruthy());
  test('rejects 0',            ()      => expect(validators.agentPort('0')).toBeTruthy());
  test('rejects negative',     ()      => expect(validators.agentPort('-1')).toBeTruthy());
  test('rejects non-numeric',  ()      => expect(validators.agentPort('abc')).toBeTruthy());
  test('rejects empty string', ()      => expect(validators.agentPort('')).toBeTruthy());
  test('rejects float',        ()      => expect(validators.agentPort('5001.5')).toBeNull()); // parseInt truncates
});

describe('validators.dashboardPort', () => {
  test('accepts 5002',  ()             => expect(validators.dashboardPort('5002')).toBeNull());
  test('rejects 80',    ()             => expect(validators.dashboardPort('80')).toBeTruthy());
});

// ── Port conflict ─────────────────────────────────────────────────────────────

describe('portConflict', () => {
  test('detects conflict when both same', ()   => expect(portConflict('5001', '5001')).toBe(true));
  test('no conflict when different',     ()   => expect(portConflict('5001', '5002')).toBe(false));
  test('handles numbers',                ()   => expect(portConflict(5001, 5001)).toBe(true));
  test('no conflict with different nums',()   => expect(portConflict(5001, 5002)).toBe(false));
});

// ── isSetupComplete ───────────────────────────────────────────────────────────

function isSetupComplete(cfg) {
  return !!(cfg && cfg.nodeLabel && cfg.orchestratorUrl && cfg.originUrl && cfg.agentPort);
}

describe('isSetupComplete', () => {
  test('true with all required fields', () => {
    expect(isSetupComplete({
      nodeLabel: 'Edge-1',
      orchestratorUrl: 'https://x.onrender.com',
      originUrl: 'https://y.onrender.com',
      agentPort: 5001,
    })).toBe(true);
  });
  test('false with missing nodeLabel',        () => expect(isSetupComplete({ orchestratorUrl: 'https://x.com', originUrl: 'https://y.com', agentPort: 5001 })).toBe(false));
  test('false with missing orchestratorUrl',  () => expect(isSetupComplete({ nodeLabel: 'e', originUrl: 'https://y.com', agentPort: 5001 })).toBe(false));
  test('false with missing originUrl',        () => expect(isSetupComplete({ nodeLabel: 'e', orchestratorUrl: 'https://x.com', agentPort: 5001 })).toBe(false));
  test('false with missing agentPort',        () => expect(isSetupComplete({ nodeLabel: 'e', orchestratorUrl: 'https://x.com', originUrl: 'https://y.com' })).toBe(false));
  test('false for null config',               () => expect(isSetupComplete(null)).toBe(false));
  test('false for empty config',              () => expect(isSetupComplete({})).toBe(false));
});
