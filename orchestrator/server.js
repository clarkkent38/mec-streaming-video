/**
 * orchestrator/server.js
 *
 * Dynamic VNF Orchestrator (VNFM Concept — Paper §III)
 *
 * Features & Capabilities:
 *  1. Dynamic in-memory edge registry (POST /api/orchestrator/register)
 *  2. Heartbeat tracking & stats updates (POST /api/orchestrator/heartbeat)
 *  3. 5s background active RTT measurement probe (measuredLatencyMs timing GET <edgeUrl>/health)
 *  4. 10s background stale heartbeat sweep (marks edges >20s old as 'offline')
 *  5. Shannon entropy context-aware routing & best-edge selection (GET /api/orchestrator/best-edge)
 *  6. Full dynamic edge topology listing (GET /api/orchestrator/edges & /nodes)
 *  7. Scenario & simulation separation (simulatedDelayMs vs measuredLatencyMs)
 *  8. Full backward compatibility with existing endpoints (/health, /stats, /nodes, /best-node, /context-route, /api/mec/stats)
 */

'use strict';

const express = require('express');
const cors    = require('cors');
const http    = require('http');
const https   = require('https');

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT                  = parseInt(process.env.PORT || '5000', 10);
const RTT_PROBE_INTERVAL_MS = 5000;  // 5-second real RTT measurement cycle
const SWEEP_INTERVAL_MS     = 10000; // 10-second heartbeat expiry sweep
const HEARTBEAT_TIMEOUT_MS  = 20000; // 20-second timeout before marking offline

// ─── In-Memory Edge Registry ──────────────────────────────────────────────────
// Map: edgeId -> {
//   edgeId, id, url, label, status: 'online' | 'offline',
//   lastHeartbeat, last_seen, last_check,
//   measuredLatencyMs, simulatedDelayMs,
//   cacheHitRatio, requestsServed
// }

const registry = new Map();

// Initialize initial seed edges from environment variables if present
function seedInitialEdges() {
  const seed1Url = process.env.EDGE1_URL || 'http://localhost:4001';
  const seed2Url = process.env.EDGE2_URL || 'http://localhost:4002';

  registry.set('edge-node-1', {
    edgeId:            'edge-node-1',
    id:                'edge-node-1',
    url:               seed1Url.replace(/\/$/, ''),
    label:             'MEC Edge Node 1 (Primary)',
    status:            'online',
    lastHeartbeat:     Date.now(),
    last_seen:         new Date().toISOString(),
    last_check:        null,
    measuredLatencyMs: null,
    simulatedDelayMs:  null,
    cacheHitRatio:     0,
    requestsServed:    0,
  });

  registry.set('edge-node-2', {
    edgeId:            'edge-node-2',
    id:                'edge-node-2',
    url:               seed2Url.replace(/\/$/, ''),
    label:             'MEC Edge Node 2 (Backup)',
    status:            'online',
    lastHeartbeat:     Date.now(),
    last_seen:         new Date().toISOString(),
    last_check:        null,
    measuredLatencyMs: null,
    simulatedDelayMs:  null,
    cacheHitRatio:     0,
    requestsServed:    0,
  });
}

seedInitialEdges();

// ─── Event Logger ─────────────────────────────────────────────────────────────

const eventLog = [];
function logEvent(type, detail) {
  const entry = { ts: new Date().toISOString(), type, detail };
  eventLog.push(entry);
  if (eventLog.length > 500) eventLog.shift();
  console.log(`[${entry.ts}] [orchestrator] ${type}:`, JSON.stringify(detail));
}

// ─── HTTP Helper (Native http/https RTT timing) ───────────────────────────────

function httpGetWithTiming(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => {
        const rttMs = Date.now() - startTime;
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({ status: res.statusCode, json, rttMs });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', (e) => reject(e));
  });
}

// ─── Real RTT Measurement Probe (Requirement 3: every 5s) ────────────────────

async function measureEdgeRtt(edge) {
  const now = new Date().toISOString();
  edge.last_check = now;

  try {
    const { status, json, rttMs } = await httpGetWithTiming(`${edge.url}/health`, 3000);

    if (status === 200 && json && json.status === 'ok') {
      edge.measuredLatencyMs = rttMs;
      // Record simulated delay separately if node reports it
      if (json.delay_ms !== undefined) {
        edge.simulatedDelayMs = json.delay_ms;
      }
      edge.last_seen = now;

      // If node was offline but responds and heartbeat is within timeout, bring online
      const heartbeatAge = Date.now() - (edge.lastHeartbeat || 0);
      if (edge.status === 'offline' && heartbeatAge <= HEARTBEAT_TIMEOUT_MS) {
        edge.status = 'online';
        logEvent('EDGE_PROBE_ONLINE', { edgeId: edge.edgeId, measuredLatencyMs: rttMs });
      }
    } else {
      // Node is responding with error or outage status
      const prev = edge.status;
      edge.status = 'offline';
      if (prev !== 'offline') {
        logEvent('EDGE_PROBE_OFFLINE', { edgeId: edge.edgeId, reason: `HTTP ${status}` });
      }
    }
  } catch (err) {
    const prev = edge.status;
    edge.status = 'offline';
    if (prev !== 'offline') {
      logEvent('EDGE_PROBE_OFFLINE', { edgeId: edge.edgeId, reason: err.message });
    }
  }
}

async function runRttMeasurements() {
  await Promise.all([...registry.values()].map(measureEdgeRtt));
}

// Start 5s RTT measurement loop
runRttMeasurements();
const rttTimer = setInterval(runRttMeasurements, RTT_PROBE_INTERVAL_MS);
rttTimer.unref();

// ─── Heartbeat Expiry Sweep (Requirement 4: every 10s) ───────────────────────

function sweepStaleHeartbeats() {
  const now = Date.now();
  for (const edge of registry.values()) {
    const timeSinceHeartbeat = now - (edge.lastHeartbeat || 0);
    if (timeSinceHeartbeat > HEARTBEAT_TIMEOUT_MS && edge.status !== 'offline') {
      edge.status = 'offline';
      logEvent('EDGE_HEARTBEAT_EXPIRED', {
        edgeId: edge.edgeId,
        lastHeartbeatAgoSec: Math.round(timeSinceHeartbeat / 1000),
      });
    }
  }
}

const sweepTimer = setInterval(sweepStaleHeartbeats, SWEEP_INTERVAL_MS);
sweepTimer.unref();

// ─── Shannon Entropy & MEC Telemetry Engine (FMDASH+) ─────────────────────────

const telemetryHistory = [];
let currentMecStats = {
  smoothedBandwidth: 0,
  entropy:           0,
  k:                 3,
  fuzzyBw:           { low: 0, medium: 0, high: 0 },
  fuzzyBuf:          { low: 0, medium: 0, high: 0 },
  abrDecision:       null,
  utilizationPct:    0,
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
  const bwMbps = smoothedBandwidth / 1000000;
  const fuzzyBw = {
    low:    Math.max(0, Math.min(1, (4 - bwMbps) / 4)),
    medium: Math.max(0, Math.min((bwMbps - 2) / 3, (8 - bwMbps) / 3)),
    high:   Math.max(0, Math.min(1, (bwMbps - 6) / 6)),
  };

  const currentBuffer = telemetryHistory[telemetryHistory.length - 1].buffer_s || 0;
  const fuzzyBuf = {
    low:    Math.max(0, Math.min(1, (5 - currentBuffer) / 5)),
    medium: Math.max(0, Math.min((currentBuffer - 3) / 3, (9 - currentBuffer) / 3)),
    high:   Math.max(0, Math.min(1, (currentBuffer - 7) / 8)),
  };

  // 5. ABR Fuzzy Rules -> Decision (kbps)
  let weightedSum = 0;
  let totalWeight = 0;

  const rules = [
    { weight: Math.min(fuzzyBw.high,   fuzzyBuf.high),   val: 8000 },
    { weight: Math.min(fuzzyBw.high,   fuzzyBuf.medium), val: 8000 },
    { weight: Math.min(fuzzyBw.medium, fuzzyBuf.high),   val: 2500 },
    { weight: Math.min(fuzzyBw.medium, fuzzyBuf.medium), val: 2500 },
    { weight: Math.min(fuzzyBw.low,    1),               val: 700  },
    { weight: Math.min(1,              fuzzyBuf.low),    val: 700  },
  ];

  rules.forEach(r => {
    weightedSum += r.weight * r.val;
    totalWeight += r.weight;
  });

  const abrDecision = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 700;
  const utilizationPct = smoothedBandwidth > 0
    ? Math.min(100, Math.round((abrDecision * 1000 / smoothedBandwidth) * 100))
    : 0;

  currentMecStats = {
    smoothedBandwidth,
    entropy: normalizedH,
    k,
    fuzzyBw,
    fuzzyBuf,
    abrDecision,
    utilizationPct,
  };
}

// ─── Express Server ───────────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] [orchestrator:${PORT}] ${req.method} ${req.path}`);
  next();
});

// ─── Requirement 1: POST /api/orchestrator/register (and /register) ───────────

function handleRegister(req, res) {
  const { edgeId, id, url, label } = req.body || {};
  const targetId = edgeId || id;

  if (!targetId || !url) {
    return res.status(400).json({
      error: 'Body must include edgeId (or id) and url: { edgeId, url, label }',
    });
  }

  const cleanUrl = url.replace(/\/$/, '');
  const existing = registry.get(targetId);

  const edgeRecord = {
    edgeId:            targetId,
    id:                targetId,
    url:               cleanUrl,
    label:             label || existing?.label || `Edge ${targetId}`,
    status:            'online',
    lastHeartbeat:     Date.now(),
    last_seen:         new Date().toISOString(),
    last_check:        existing?.last_check || null,
    measuredLatencyMs: existing?.measuredLatencyMs ?? null,
    simulatedDelayMs:  existing?.simulatedDelayMs ?? null,
    cacheHitRatio:     existing?.cacheHitRatio ?? 0,
    requestsServed:    existing?.requestsServed ?? 0,
  };

  registry.set(targetId, edgeRecord);
  logEvent('EDGE_REGISTERED', { edgeId: targetId, url: cleanUrl, label: edgeRecord.label });

  // Trigger immediate RTT probe for the newly registered edge
  measureEdgeRtt(edgeRecord);

  res.status(201).json({
    status:     'registered',
    edge:       edgeRecord,
    timestamp:  new Date().toISOString(),
  });
}

app.post('/api/orchestrator/register', handleRegister);
app.post('/register',                  handleRegister);

// ─── Requirement 2: POST /api/orchestrator/heartbeat (and /heartbeat) ─────────

function handleHeartbeat(req, res) {
  const { edgeId, id, cacheHitRatio, requestsServed } = req.body || {};
  const targetId = edgeId || id;

  if (!targetId) {
    return res.status(400).json({ error: 'Body must include edgeId' });
  }

  const edge = registry.get(targetId);
  if (!edge) {
    return res.status(404).json({
      error: `Edge "${targetId}" is not registered. Call /api/orchestrator/register first.`,
    });
  }

  edge.lastHeartbeat = Date.now();
  edge.last_seen     = new Date().toISOString();

  if (cacheHitRatio !== undefined && !isNaN(Number(cacheHitRatio))) {
    edge.cacheHitRatio = Number(cacheHitRatio);
  }
  if (requestsServed !== undefined && !isNaN(Number(requestsServed))) {
    edge.requestsServed = Number(requestsServed);
  }

  // Restore status to online if it was offline
  if (edge.status === 'offline') {
    edge.status = 'online';
    logEvent('EDGE_HEARTBEAT_RECOVERED', { edgeId: targetId });
  }

  res.json({
    status:        'ok',
    edgeId:        targetId,
    lastHeartbeat: edge.lastHeartbeat,
    edgeStatus:    edge.status,
    timestamp:     new Date().toISOString(),
  });
}

app.post('/api/orchestrator/heartbeat', handleHeartbeat);
app.post('/heartbeat',                  handleHeartbeat);

// ─── Requirement 5: GET /api/orchestrator/best-edge (and /best-node) ──────────

function getBestEdgeHandler(_req, res) {
  const allEdges = [...registry.values()];
  const onlineEdges = allEdges.filter(e => e.status === 'online' || e.status === 'UP');

  if (onlineEdges.length === 0) {
    return res.status(503).json({
      error:     'No edge nodes are currently online',
      fallback:  'Use origin server directly',
      origin:    process.env.ORIGIN_URL || 'http://localhost:3000',
      timestamp: new Date().toISOString(),
    });
  }

  // Shannon entropy stability weight:
  // normalized entropy H (0.0 to 1.0) acts as an uncertainty multiplier on measuredLatencyMs
  const entropy = currentMecStats.entropy || 0;
  const stabilityMultiplier = 1 + (entropy * 0.4); // e.g. 1.0 to 1.4x weight

  const rankedEdges = onlineEdges.map(edge => {
    // Use real measuredLatencyMs if available; fallback to 50ms default if still warming up
    const rawLatency = (edge.measuredLatencyMs !== null && edge.measuredLatencyMs !== undefined)
      ? edge.measuredLatencyMs
      : 50;

    // Combined routing score = measured RTT * entropy stability weight
    const score = parseFloat((rawLatency * stabilityMultiplier).toFixed(2));

    return {
      edgeId:            edge.edgeId,
      id:                edge.id,
      url:               edge.url,
      label:             edge.label,
      status:            edge.status,
      measuredLatencyMs: edge.measuredLatencyMs,
      simulatedDelayMs:  edge.simulatedDelayMs,
      delay_ms:          edge.measuredLatencyMs ?? edge.simulatedDelayMs ?? 10,
      cacheHitRatio:     edge.cacheHitRatio,
      requestsServed:    edge.requestsServed,
      stabilityWeight:   parseFloat(stabilityMultiplier.toFixed(3)),
      score,
    };
  }).sort((a, b) => a.score - b.score);

  const best = rankedEdges[0];

  logEvent('BEST_EDGE_SELECTED', {
    edgeId:            best.edgeId,
    measuredLatencyMs: best.measuredLatencyMs,
    score:             best.score,
    entropy:           parseFloat(entropy.toFixed(3)),
  });

  res.json({
    best_edge:        best,
    best_node:        best, // backward compatibility
    online_edges:     rankedEdges,
    all_up_nodes:     rankedEdges.map(n => ({ id: n.id, delay_ms: n.delay_ms })),
    entropy:          parseFloat(entropy.toFixed(3)),
    stability_weight: parseFloat(stabilityMultiplier.toFixed(3)),
    timestamp:        new Date().toISOString(),
  });
}

app.get('/api/orchestrator/best-edge', getBestEdgeHandler);
app.get('/best-node',                  getBestEdgeHandler);

// ─── Requirement 6: GET /api/orchestrator/edges (and /nodes, /routes) ─────────

function getEdgesHandler(_req, res) {
  const edges = [...registry.values()].map(e => ({
    edgeId:            e.edgeId,
    id:                e.id,
    url:               e.url,
    label:             e.label,
    status:            e.status === 'online' ? 'UP' : 'DOWN',
    edgeStatus:        e.status,
    measuredLatencyMs: e.measuredLatencyMs,
    simulatedDelayMs:  e.simulatedDelayMs,
    delay_ms:          e.measuredLatencyMs ?? e.simulatedDelayMs ?? null,
    cacheHitRatio:     e.cacheHitRatio,
    requestsServed:    e.requestsServed,
    lastHeartbeat:     e.lastHeartbeat,
    last_check:        e.last_check,
    last_seen:         e.last_seen,
  }));

  const onlineCount  = edges.filter(e => e.edgeStatus === 'online' || e.status === 'UP').length;
  const offlineCount = edges.filter(e => e.edgeStatus === 'offline' || e.status === 'DOWN').length;

  res.json({
    health_interval_ms: RTT_PROBE_INTERVAL_MS,
    sweep_interval_ms:  SWEEP_INTERVAL_MS,
    heartbeat_timeout_ms: HEARTBEAT_TIMEOUT_MS,
    total:              edges.length,
    online:             onlineCount,
    offline:            offlineCount,
    up:                 onlineCount,
    down:               offlineCount,
    edges,
    nodes:              edges, // backward compatibility with NetworkTopology.jsx
    routes:             edges,
    timestamp:          new Date().toISOString(),
  });
}

app.get('/api/orchestrator/edges',  getEdgesHandler);
app.get('/api/orchestrator/routes', getEdgesHandler);
app.get('/nodes',                   getEdgesHandler);

// ─── Context-Aware Route Selection (POST /context-route) ───────────────────────

app.post('/context-route', (req, res) => {
  const { device, network, location } = req.body || {};
  const onlineEdges = [...registry.values()].filter(e => e.status === 'online' || e.status === 'UP');

  if (onlineEdges.length === 0) {
    return res.status(503).json({
      error:     'No edge nodes are currently online',
      fallback:  'Use origin server directly',
      origin:    process.env.ORIGIN_URL || 'http://localhost:3000',
      timestamp: new Date().toISOString(),
    });
  }

  let best = onlineEdges[0];
  let bestScore = -Infinity;

  for (const node of onlineEdges) {
    const effectiveLatency = node.measuredLatencyMs ?? node.simulatedDelayMs ?? 50;
    let score = 100 - effectiveLatency;

    if (network === '4G' || network === '5G') {
      score += (100 - effectiveLatency) * 1.5;
    }
    if (device === 'mobile' && node.edgeId === 'edge-node-1') {
      score += 20;
    }
    if (location === 'US-East' && node.edgeId === 'edge-node-1') score += 50;
    if (location === 'US-West' && node.edgeId === 'edge-node-2') score += 50;

    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  }

  logEvent('CONTEXT_ROUTE_SELECTED', {
    id: best.edgeId,
    context: { device, network, location },
    score: bestScore,
  });

  res.json({
    best_edge: {
      edgeId:            best.edgeId,
      id:                best.id,
      url:               best.url,
      label:             best.label,
      measuredLatencyMs: best.measuredLatencyMs,
      simulatedDelayMs:  best.simulatedDelayMs,
      delay_ms:          best.measuredLatencyMs ?? best.simulatedDelayMs,
      status:            best.status,
    },
    best_node: {
      id:       best.id,
      url:      best.url,
      delay_ms: best.measuredLatencyMs ?? best.simulatedDelayMs,
      status:   best.status,
    },
    context_applied: { device, network, location, score: bestScore },
    all_up_nodes: onlineEdges.map(n => ({ id: n.id, delay_ms: n.measuredLatencyMs ?? n.simulatedDelayMs })),
    timestamp: new Date().toISOString(),
  });
});

// ─── POST /telemetry (Player Telemetry Ingestion) ─────────────────────────────

app.post('/telemetry', (req, res) => {
  const { bandwidth_bps, buffer_s, latency_ms } = req.body || {};
  if (bandwidth_bps !== undefined) {
    telemetryHistory.push({ bandwidth_bps, buffer_s, latency_ms, ts: Date.now() });
    if (telemetryHistory.length > 60) telemetryHistory.shift();
    calculateMecStats();
  }
  res.json({ status: 'ok' });
});

// ─── GET /api/mec/stats (and /mec-stats) ───────────────────────────────────────

function getMecStatsHandler(_req, res) {
  res.json(currentMecStats);
}

app.get('/api/mec/stats', getMecStatsHandler);
app.get('/mec-stats',     getMecStatsHandler);

// ─── GET /health ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    service:   'orchestrator',
    port:      PORT,
    uptime_s:  Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ─── GET /stats ───────────────────────────────────────────────────────────────

app.get('/stats', (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    service:              'orchestrator',
    port:                 PORT,
    uptime_s:             Math.round(process.uptime()),
    rtt_probe_interval_ms: RTT_PROBE_INTERVAL_MS,
    sweep_interval_ms:    SWEEP_INTERVAL_MS,
    registry_size:        registry.size,
    memory: {
      rss_mb:       (mem.rss      / 1024 / 1024).toFixed(1),
      heap_used_mb: (mem.heapUsed / 1024 / 1024).toFixed(1),
    },
    event_log: eventLog.slice(-30),
    timestamp: new Date().toISOString(),
  });
});

// ─── Deregister Endpoint (POST /api/orchestrator/deregister & /deregister) ────

function handleDeregister(req, res) {
  const { edgeId, id } = req.body || {};
  const targetId = edgeId || id;
  if (!targetId || !registry.has(targetId)) {
    return res.status(404).json({ error: `Edge "${targetId}" not found in registry` });
  }
  registry.delete(targetId);
  logEvent('EDGE_DEREGISTERED', { edgeId: targetId });
  res.json({ deregistered: targetId });
}

app.post('/api/orchestrator/deregister', handleDeregister);
app.post('/deregister',                  handleDeregister);

// ─── 404 Handler ─────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// ─── Start Server ────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  Dynamic VNF Orchestrator (VNFM Engine — Paper §III)    ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Listening           : http://localhost:${PORT}               ║`);
  console.log(`║  Dynamic Registry    : http://localhost:${PORT}/api/orchestrator/edges ║`);
  console.log(`║  Best Edge Selection : http://localhost:${PORT}/api/orchestrator/best-edge ║`);
  console.log(`║  RTT Probe Interval  : ${RTT_PROBE_INTERVAL_MS} ms                              ║`);
  console.log(`║  Sweep Interval      : ${SWEEP_INTERVAL_MS} ms                             ║`);
  console.log(`║  Registered Edges    : ${registry.size}                                    ║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');
});
