/**
 * orchestrator/server.js
 *
 * VNF Orchestrator (VNFM concept from the paper §III)
 *
 * Responsibilities:
 *  - Maintains a registry of edge nodes (static config, structured for future self-registration)
 *  - Periodically health-checks each node (every 5 s) → marks UP / DOWN
 *  - GET  /nodes      → live status + delay of every registered node
 *  - GET  /best-node  → returns the UP node with lowest configured delay
 *  - POST /register   → allows a node to self-register (future extensibility)
 *
 * Health-check interval: 5 seconds
 *   Why 5 s? Fast enough to detect an outage within one demo "beat",
 *   light enough that 4 Node processes on one laptop don't spin the CPU.
 *
 * Start: node server.js   (default port 5000)
 */

'use strict';

const express = require('express');
const cors    = require('cors');
const http    = require('http');
const https   = require('https');
const os      = require('os');

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT               = parseInt(process.env.PORT || '5000', 10);
const HEALTH_INTERVAL_MS = 5000; // 5-second poll cycle

// ─── Node Registry ────────────────────────────────────────────────────────────
// Structured so nodes can self-register later (POST /register).
// Each entry shape:
//   { id, url, status: 'UP'|'DOWN'|'UNKNOWN', delay_ms, last_check, last_seen }

const registry = new Map([
  ['edge-node-1', {
    id:         'edge-node-1',
    url:        process.env.EDGE1_URL || 'http://localhost:4001',
    status:     'UNKNOWN',
    delay_ms:   null,
    last_check: null,
    last_seen:  null,
  }],
  ['edge-node-2', {
    id:         'edge-node-2',
    url:        process.env.EDGE2_URL || 'http://localhost:4002',
    status:     'UNKNOWN',
    delay_ms:   null,
    last_check: null,
    last_seen:  null,
  }],
]);

// ─── Orchestrator event log ───────────────────────────────────────────────────

const eventLog = [];
function logEvent(type, detail) {
  const entry = { ts: new Date().toISOString(), type, detail };
  eventLog.push(entry);
  if (eventLog.length > 500) eventLog.shift();
  console.log(`[${entry.ts}] [orchestrator] ${type}:`, JSON.stringify(detail));
}

// ─── HTTP GET helper (no external deps — uses built-in http/https) ────────────

function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, json: null }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error',   (e) => reject(e));
  });
}

// ─── Health-check loop ────────────────────────────────────────────────────────

async function checkNode(node) {
  const now = new Date().toISOString();
  node.last_check = now;

  try {
    const { status, json } = await httpGet(`${node.url}/health`, 3000);

    if (status === 200 && json && json.status === 'ok') {
      const prevStatus = node.status;
      node.status   = 'UP';
      node.delay_ms = json.delay_ms ?? node.delay_ms;
      node.last_seen = now;

      if (prevStatus !== 'UP') {
        logEvent('NODE_UP', { id: node.id, delay_ms: node.delay_ms });
      }
    } else {
      // Node responded but reports outage/non-200
      const prevStatus = node.status;
      node.status = 'DOWN';
      if (prevStatus !== 'DOWN') {
        logEvent('NODE_DOWN', { id: node.id, reason: `HTTP ${status} / status=${json?.status}` });
      }
    }
  } catch (err) {
    const prevStatus = node.status;
    node.status = 'DOWN';
    if (prevStatus !== 'DOWN') {
      logEvent('NODE_DOWN', { id: node.id, reason: err.message });
    }
  }
}

async function runHealthChecks() {
  await Promise.all([...registry.values()].map(checkNode));
}

// Initial check immediately, then on interval
runHealthChecks();
const healthTimer = setInterval(runHealthChecks, HEALTH_INTERVAL_MS);
healthTimer.unref(); // don't prevent process exit in tests

// ─── App ─────────────────────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] [orchestrator:${PORT}] ${req.method} ${req.path}`);
  next();
});

// ─── GET /nodes ───────────────────────────────────────────────────────────────

app.get('/nodes', (_req, res) => {
  const nodes = [...registry.values()].map(n => ({ ...n }));
  const upCount   = nodes.filter(n => n.status === 'UP').length;
  const downCount = nodes.filter(n => n.status === 'DOWN').length;

  res.json({
    health_interval_ms: HEALTH_INTERVAL_MS,
    total: nodes.length,
    up:    upCount,
    down:  downCount,
    nodes,
    timestamp: new Date().toISOString(),
  });
});

// ─── GET /best-node ───────────────────────────────────────────────────────────
// Paper §III: VNFM selects the VNF instance with best network conditions.
// Here: UP node with lowest configured delay_ms.

app.get('/best-node', (_req, res) => {
  const upNodes = [...registry.values()].filter(n => n.status === 'UP');

  if (upNodes.length === 0) {
    return res.status(503).json({
      error:     'No edge nodes are currently UP',
      fallback:  'Use origin server directly',
      origin:    process.env.ORIGIN_URL || 'http://localhost:3000',
      timestamp: new Date().toISOString(),
    });
  }

  // Sort by delay ascending; pick lowest
  upNodes.sort((a, b) => (a.delay_ms ?? Infinity) - (b.delay_ms ?? Infinity));
  const best = upNodes[0];

  logEvent('BEST_NODE_SELECTED', { id: best.id, delay_ms: best.delay_ms });

  res.json({
    best_node: {
      id:       best.id,
      url:      best.url,
      delay_ms: best.delay_ms,
      status:   best.status,
    },
    all_up_nodes: upNodes.map(n => ({ id: n.id, delay_ms: n.delay_ms })),
    timestamp: new Date().toISOString(),
  });
});

// ─── POST /context-route ──────────────────────────────────────────────────────
// Multi-factor Context-Aware Routing (Device, Network, Location)

app.post('/context-route', (req, res) => {
  const { device, network, location } = req.body;
  const upNodes = [...registry.values()].filter(n => n.status === 'UP');

  if (upNodes.length === 0) {
    return res.status(503).json({
      error:     'No edge nodes are currently UP',
      fallback:  'Use origin server directly',
      origin:    process.env.ORIGIN_URL || 'http://localhost:3000',
      timestamp: new Date().toISOString(),
    });
  }

  // Apply context logic. In a real system, nodes have geographic locations and 
  // bandwidth profiles. Here we simulate scoring based on context.
  
  let best = upNodes[0];
  let bestScore = -Infinity;

  for (const node of upNodes) {
    let score = 100 - (node.delay_ms || 50); // Base score from network latency

    // Context adjustments
    if (network === '4G' || network === '5G') {
      // Cellular prefers closer edge aggressively
      score += (100 - (node.delay_ms || 50)) * 1.5; 
    }

    if (device === 'mobile') {
      // Mobile devices might prefer edge-1 (simulate specific edge optimization)
      if (node.id === 'edge-node-1') score += 20;
    }

    if (location) {
      // Simulate geolocation preference. 
      // E.g., if client is US-East, edge-node-1 gets a boost.
      if (location === 'US-East' && node.id === 'edge-node-1') score += 50;
      if (location === 'US-West' && node.id === 'edge-node-2') score += 50;
    }

    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  }

  logEvent('CONTEXT_ROUTE_SELECTED', { 
    id: best.id, 
    context: { device, network, location },
    score: bestScore
  });

  res.json({
    best_node: {
      id:       best.id,
      url:      best.url,
      delay_ms: best.delay_ms,
      status:   best.status,
    },
    context_applied: { device, network, location, score: bestScore },
    all_up_nodes: upNodes.map(n => ({ id: n.id, delay_ms: n.delay_ms })),
    timestamp: new Date().toISOString(),
  });
});

// ─── POST /register ───────────────────────────────────────────────────────────
// Allows future dynamic node self-registration (NFV paper extensibility)

app.post('/register', (req, res) => {
  const { id, url } = req.body || {};
  if (!id || !url) {
    return res.status(400).json({ error: 'Body must include { id, url }' });
  }
  if (registry.has(id)) {
    return res.status(409).json({ error: `Node "${id}" already registered` });
  }
  registry.set(id, { id, url, status: 'UNKNOWN', delay_ms: null, last_check: null, last_seen: null });
  logEvent('NODE_REGISTERED', { id, url });
  // Immediately health-check the new node
  checkNode(registry.get(id));
  res.status(201).json({ registered: id, url });
});

// ─── POST /deregister ────────────────────────────────────────────────────────

app.post('/deregister', (req, res) => {
  const { id } = req.body || {};
  if (!id || !registry.has(id)) {
    return res.status(404).json({ error: `Node "${id}" not found` });
  }
  registry.delete(id);
  logEvent('NODE_DEREGISTERED', { id });
  res.json({ deregistered: id });
});

// ─── MEC Algorithm State & Logic (FMDASH+) ────────────────────────────────────

const telemetryHistory = [];
let currentMecStats = {
  smoothedBandwidth: 0,
  entropy: 0,
  k: 3,
  fuzzyBw: { low: 0, medium: 0, high: 0 },
  fuzzyBuf: { low: 0, medium: 0, high: 0 },
  abrDecision: null, // kbps
  utilizationPct: 0
};

function calculateMecStats() {
  if (telemetryHistory.length === 0) return;
  
  // 1. Shannon Entropy (H) based on last 10 samples
  const windowForEntropy = telemetryHistory.slice(-10);
  const minBw = Math.min(...windowForEntropy.map(s => s.bandwidth_bps));
  const maxBw = Math.max(...windowForEntropy.map(s => s.bandwidth_bps));
  const bins = new Array(10).fill(0);
  
  if (maxBw > minBw) {
    windowForEntropy.forEach(s => {
      const idx = Math.min(9, Math.floor(((s.bandwidth_bps - minBw) / (maxBw - minBw)) * 10));
      bins[idx]++;
    });
  } else {
    bins[0] = windowForEntropy.length;
  }
  
  let H = 0;
  bins.forEach(count => {
    if (count > 0) {
      const p = count / windowForEntropy.length;
      H -= p * Math.log2(p);
    }
  });
  const normalizedH = H / Math.log2(10) || 0;
  
  // 2. Dynamic Traceback (k)
  const k = Math.min(10, Math.max(3, Math.round(3 + normalizedH * 7)));
  
  // 3. Moving Average Bandwidth
  const kSamples = telemetryHistory.slice(-k);
  const smoothedBandwidth = kSamples.reduce((sum, s) => sum + s.bandwidth_bps, 0) / kSamples.length;
  
  // 4. Fuzzy Membership 
  // BW limits: Low [0,4], Med [2,8], High [6,12] in Mbps
  const bwMbps = smoothedBandwidth / 1000000;
  const fuzzyBw = {
    low: Math.max(0, Math.min(1, (4 - bwMbps) / 4)),
    medium: Math.max(0, Math.min((bwMbps - 2) / 3, (8 - bwMbps) / 3)),
    high: Math.max(0, Math.min(1, (bwMbps - 6) / 6))
  };
  
  // Buffer limits: Low [0,5], Med [3,9], High [7,15] in s
  const currentBuffer = telemetryHistory[telemetryHistory.length - 1].buffer_s || 0;
  const fuzzyBuf = {
    low: Math.max(0, Math.min(1, (5 - currentBuffer) / 5)),
    medium: Math.max(0, Math.min((currentBuffer - 3) / 3, (9 - currentBuffer) / 3)),
    high: Math.max(0, Math.min(1, (currentBuffer - 7) / 8))
  };
  
  // 5. ABR Fuzzy Rules -> Decision (kbps)
  let weightedSum = 0;
  let totalWeight = 0;
  
  const rules = [
    { weight: Math.min(fuzzyBw.high, fuzzyBuf.high), val: 8000 },
    { weight: Math.min(fuzzyBw.high, fuzzyBuf.medium), val: 8000 },
    { weight: Math.min(fuzzyBw.medium, fuzzyBuf.high), val: 2500 },
    { weight: Math.min(fuzzyBw.medium, fuzzyBuf.medium), val: 2500 },
    { weight: Math.min(fuzzyBw.low, 1), val: 700 }, 
    { weight: Math.min(1, fuzzyBuf.low), val: 700 }
  ];
  
  rules.forEach(r => {
    weightedSum += r.weight * r.val;
    totalWeight += r.weight;
  });
  
  let abrDecision = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 700;
  
  // 6. Bandwidth Utilization Efficiency %
  const utilizationPct = smoothedBandwidth > 0 ? Math.min(100, Math.round((abrDecision * 1000 / smoothedBandwidth) * 100)) : 0;
  
  currentMecStats = {
    smoothedBandwidth,
    entropy: normalizedH,
    k,
    fuzzyBw,
    fuzzyBuf,
    abrDecision,
    utilizationPct
  };
}

// ─── POST /telemetry ──────────────────────────────────────────────────────────

app.post('/telemetry', (req, res) => {
  const { bandwidth_bps, buffer_s, latency_ms } = req.body;
  if (bandwidth_bps !== undefined) {
    telemetryHistory.push({ bandwidth_bps, buffer_s, latency_ms, ts: Date.now() });
    if (telemetryHistory.length > 60) telemetryHistory.shift();
    calculateMecStats();
  }
  res.json({ status: 'ok' });
});

// ─── GET /mec-stats ───────────────────────────────────────────────────────────

app.get('/mec-stats', (_req, res) => {
  res.json(currentMecStats);
});

// ─── GET /health ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'orchestrator', port: PORT, uptime_s: Math.round(process.uptime()), timestamp: new Date().toISOString() });
});

// ─── GET /stats ───────────────────────────────────────────────────────────────

app.get('/stats', (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    service: 'orchestrator',
    port: PORT,
    uptime_s: Math.round(process.uptime()),
    health_interval_ms: HEALTH_INTERVAL_MS,
    registry_size: registry.size,
    memory: {
      rss_mb:       (mem.rss      / 1024 / 1024).toFixed(1),
      heap_used_mb: (mem.heapUsed / 1024 / 1024).toFixed(1),
    },
    event_log: eventLog.slice(-30),
    timestamp: new Date().toISOString(),
  });
});

// ─── 404 ─────────────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  VNF Orchestrator (VNFM — paper §III)               ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Listening        : http://localhost:${PORT}             ║`);
  console.log(`║  Node list        : http://localhost:${PORT}/nodes       ║`);
  console.log(`║  Best node        : http://localhost:${PORT}/best-node   ║`);
  console.log(`║  Health interval  : ${HEALTH_INTERVAL_MS} ms                         ║`);
  console.log(`║  Registered nodes : ${registry.size}                                ║`);
  console.log('╚══════════════════════════════════════════════════════╝\n');
});
