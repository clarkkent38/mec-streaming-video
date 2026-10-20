'use strict';
/**
 * self-test.js
 * Runs all self-checks and returns pass/fail results for each.
 * Tests: config validity, port availability, orchestrator reachable,
 * origin reachable, Tailscale installed (if mode=public), agent health,
 * dashboard API reachable, orchestrator sees our edge.
 *
 * Also provides collectDiagnostics() for the "Copy Diagnostics" button.
 */

const os          = require('os');
const configStore = require('./config-store');
const log         = require('./logger');

async function run() {
  const tests = [];
  const cfg   = configStore.load();

  // ── Test 1: Config completeness ───────────────────────────────────────────
  tests.push({
    name: 'Configuration is complete',
    pass: configStore.isSetupComplete(cfg),
    detail: configStore.isSetupComplete(cfg)
      ? `Node label: ${cfg.nodeLabel}, Mode: ${cfg.mode}`
      : 'Run Setup to configure orchestrator, origin, and node label.',
  });

  // ── Test 2: Orchestrator reachable ─────────────────────────────────────────
  try {
    const { reachable, latencyMs } = await testUrl(`${cfg.orchestratorUrl}/health`);
    tests.push({
      name: 'Orchestrator is reachable',
      pass: reachable,
      detail: reachable
        ? `Responded in ${latencyMs} ms`
        : `Could not reach ${cfg.orchestratorUrl}. Check URL and network.`,
    });
  } catch (err) {
    tests.push({ name: 'Orchestrator is reachable', pass: false, detail: err.message });
  }

  // ── Test 3: Origin reachable ───────────────────────────────────────────────
  try {
    const { reachable, latencyMs } = await testUrl(`${cfg.originUrl}/health`);
    tests.push({
      name: 'Origin server is reachable',
      pass: reachable,
      detail: reachable
        ? `Responded in ${latencyMs} ms`
        : `Could not reach ${cfg.originUrl}. Check URL and network.`,
    });
  } catch (err) {
    tests.push({ name: 'Origin server is reachable', pass: false, detail: err.message });
  }

  // ── Test 4: Agent is running ───────────────────────────────────────────────
  const agentRunner = require('./agent-runner');
  const agentStatus = agentRunner.getStatus();
  tests.push({
    name: 'Edge agent is running',
    pass: agentStatus.running,
    detail: agentStatus.running
      ? `PID ${agentStatus.pid}, port ${cfg.agentPort}`
      : 'Agent is stopped. Click "Start Edge" in the tray menu.',
  });

  // ── Test 5: Agent /health endpoint responds ────────────────────────────────
  if (agentStatus.running) {
    try {
      const { reachable } = await testUrl(`http://localhost:${cfg.agentPort}/health`, 5000);
      tests.push({
        name: 'Agent /health endpoint responds',
        pass: reachable,
        detail: reachable ? `Port ${cfg.agentPort} is serving` : 'Agent started but /health does not respond.',
      });
    } catch (err) {
      tests.push({ name: 'Agent /health endpoint responds', pass: false, detail: err.message });
    }
  }

  // ── Test 6: Dashboard API is accessible ────────────────────────────────────
  if (agentStatus.running) {
    try {
      const { reachable } = await testUrl(`http://127.0.0.1:${cfg.dashboardPort}/api/stats`, 5000);
      tests.push({
        name: 'Dashboard API is accessible',
        pass: reachable,
        detail: reachable
          ? `Dashboard on port ${cfg.dashboardPort} is serving`
          : `Dashboard API (port ${cfg.dashboardPort}) not reachable.`,
      });
    } catch (err) {
      tests.push({ name: 'Dashboard API is accessible', pass: false, detail: err.message });
    }
  }

  // ── Test 7: Tailscale installed (if mode=public) ───────────────────────────
  if (cfg.mode === 'public') {
    try {
      const tsAssistant = require('./tailscale-assistant');
      const { installed } = await tsAssistant.checkAll();
      tests.push({
        name: 'Tailscale is installed (Public mode)',
        pass: installed,
        detail: installed
          ? 'Tailscale CLI found.'
          : 'Tailscale is not installed. Download from https://tailscale.com/download/windows',
      });
    } catch (err) {
      tests.push({ name: 'Tailscale is installed (Public mode)', pass: false, detail: err.message });
    }
  }

  // ── Test 8: Orchestrator sees our edge ─────────────────────────────────────
  if (agentStatus.running && cfg.orchestratorUrl) {
    try {
      const edges = await fetchEdges(cfg.orchestratorUrl);
      const found = edges.find(e =>
        (e.edgeId && (e.edgeId === cfg.edgeId || e.edgeId.startsWith((cfg.nodeLabel || '').toLowerCase().replace(/[^a-z0-9]/g, '-')))) ||
        (e.label === cfg.nodeLabel)
      );
      tests.push({
        name: 'Orchestrator sees this edge',
        pass: !!found,
        detail: found
          ? `Listed as ${found.edgeId || found.id}, status ${found.edgeStatus || found.status}`
          : 'Edge is not listed in the orchestrator registry. Wait a few seconds and retry.',
      });
    } catch (err) {
      tests.push({ name: 'Orchestrator sees this edge', pass: false, detail: err.message });
    }
  }

  log.info('[self-test] Completed:', tests.filter(t => t.pass).length, '/', tests.length, 'passed');
  return tests;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function testUrl(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const lib   = url.startsWith('https') ? require('https') : require('http');
    const start = Date.now();
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        const latencyMs = Date.now() - start;
        if (res.statusCode >= 200 && res.statusCode < 400) {
          resolve({ reachable: true, latencyMs, statusCode: res.statusCode });
        } else {
          resolve({ reachable: false, latencyMs, statusCode: res.statusCode });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ reachable: false, error: 'Timeout' }); });
    req.on('error', (err) => resolve({ reachable: false, error: err.message }));
  });
}

function fetchEdges(orchUrl) {
  return new Promise((resolve, reject) => {
    const url = orchUrl.replace(/\/$/, '') + '/api/orchestrator/edges';
    const lib = url.startsWith('https') ? require('https') : require('http');
    const req = lib.get(url, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        try {
          const json = JSON.parse(body);
          const arr = Array.isArray(json) ? json : (json.edges || json.nodes || []);
          resolve(arr);
        } catch (e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

async function collectDiagnostics() {
  const cfg = configStore.load();
  const { APP_VERSION } = require('../constants');
  const logLines = log.getBuffer();
  const agentRunner = require('./agent-runner');
  const agentStatus = agentRunner.getStatus();

  // Tailscale status
  let tsStatus = 'Not applicable (LAN mode)';
  if (cfg.mode === 'public') {
    try {
      const tsAssistant = require('./tailscale-assistant');
      const { installed, loggedIn, dnsName, funnelActive, publicUrl } = await tsAssistant.checkAll();
      tsStatus = `Installed: ${installed}, LoggedIn: ${loggedIn}, DNS: ${dnsName || 'none'}, Funnel: ${funnelActive}, Public URL: ${publicUrl || 'none'}`;
    } catch (err) {
      tsStatus = `Error: ${err.message}`;
    }
  }

  const lines = [
    '═'.repeat(70),
    '  EdgeNest Diagnostics',
    '═'.repeat(70),
    '',
    `Version:        ${APP_VERSION}`,
    `Platform:       ${os.platform()} ${os.release()} (${os.arch()})`,
    `Node.js:        ${process.version}`,
    `Electron:       ${process.versions.electron}`,
    '',
    '─── Configuration ─────────────────────────────────────────────────────',
    `Node Label:     ${cfg.nodeLabel || '(not set)'}`,
    `Mode:           ${cfg.mode || 'public'}`,
    `Orchestrator:   ${cfg.orchestratorUrl || '(not set)'}`,
    `Origin:         ${cfg.originUrl || '(not set)'}`,
    `Agent Port:     ${cfg.agentPort || 5001}`,
    `Dashboard Port: ${cfg.dashboardPort || 5002}`,
    `Public URL:     ${cfg.publicUrl || '(not set)'}`,
    `Edge ID:        ${cfg.edgeId || '(auto-generated)'}`,
    '',
    '─── Agent Status ──────────────────────────────────────────────────────',
    `Running:        ${agentStatus.running}`,
    `PID:            ${agentStatus.pid || 'N/A'}`,
    '',
    '─── Tailscale Status ──────────────────────────────────────────────────',
    tsStatus,
    '',
    '─── Last 50 Log Lines ─────────────────────────────────────────────────',
    ...logLines.slice(-50),
    '',
    '═'.repeat(70),
  ];

  return lines.join('\n');
}

module.exports = { run, collectDiagnostics };
