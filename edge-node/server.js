/**
 * edge-node/server.js
 *
 * MEC Edge Node — sits between client and origin.
 * Paper mapping: This IS the VNF (Virtual Network Function) the paper describes.
 *
 * Features:
 *  - Proxies /dash/* requests to origin, applying its own simulated delay first
 *  - Runtime delay change:   POST /set-delay    { "ms": 50 }
 *  - Outage simulation:      POST /simulate-outage
 *  - Restore from outage:    POST /restore
 *  - Health + stats:         GET  /health  |  GET /edge-stats
 *  - Timestamped event log for report/demo audit trail
 *
 * Start:
 *   PORT=4001 NODE_ID=edge-node-1 ORIGIN_URL=http://localhost:3000 DELAY_MS=5  node server.js
 *   PORT=4002 NODE_ID=edge-node-2 ORIGIN_URL=http://localhost:3000 DELAY_MS=15 node server.js
 */

'use strict';

const express = require('express');
const cors    = require('cors');
const http    = require('http');
const https   = require('https');
const os      = require('os');

// ─── Config (env → runtime-mutable state) ────────────────────────────────────

const PORT       = parseInt(process.env.PORT       || '4001', 10);
const NODE_ID    = process.env.NODE_ID             || 'edge-node-1';
const BIND_HOST  = process.env.BIND_HOST           || '0.0.0.0';
const ORIGIN_URL = (process.env.ORIGIN_URL         || 'http://localhost:3000').replace(/\/$/, '');
const AKAMAI_PROXY = process.env.AKAMAI_PROXY === 'true';

// In-memory state — all mutable at runtime via endpoints
let currentDelayMs = parseInt(process.env.DELAY_MS || '5', 10);
let isOutage       = false;

// Timestamped event log (kept in memory, shown in /edge-stats)
const eventLog = [];

function logEvent(type, detail) {
  const entry = { ts: new Date().toISOString(), type, detail };
  eventLog.push(entry);
  if (eventLog.length > 200) eventLog.shift(); // cap size
  console.log(`[${entry.ts}] [${NODE_ID}] ${type}: ${JSON.stringify(detail)}`);
}

logEvent('START', { port: PORT, originUrl: ORIGIN_URL, initialDelayMs: currentDelayMs });

// ─── App ─────────────────────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'HEAD', 'POST', 'OPTIONS'] }));
app.use(express.json());

// ─── Outage gate — checked before anything else ───────────────────────────────

app.use((req, res, next) => {
  // Always allow control endpoints even during outage
  const controlPaths = ['/health', '/edge-stats', '/set-delay', '/simulate-outage', '/restore'];
  if (isOutage && !controlPaths.includes(req.path)) {
    return res.status(503).json({ error: 'Node in simulated outage', node: NODE_ID });
  }
  next();
});

// ─── Request logger ───────────────────────────────────────────────────────────

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] [${NODE_ID}:${PORT}] ${req.method} ${req.path}`);
  next();
});

// ─── Runtime delay config ─────────────────────────────────────────────────────

app.post('/set-delay', (req, res) => {
  const ms = parseInt(req.body?.ms, 10);
  if (isNaN(ms) || ms < 0) {
    return res.status(400).json({ error: 'Body must be { "ms": <non-negative integer> }' });
  }
  const prev = currentDelayMs;
  currentDelayMs = ms;
  logEvent('SET_DELAY', { from: prev, to: ms });
  res.json({ node: NODE_ID, delay_ms: currentDelayMs, previous_ms: prev, timestamp: new Date().toISOString() });
});

// ─── Outage simulation ────────────────────────────────────────────────────────

app.post('/simulate-outage', (_req, res) => {
  isOutage = true;
  logEvent('OUTAGE_START', { node: NODE_ID });
  res.json({ node: NODE_ID, status: 'outage', timestamp: new Date().toISOString() });
});

app.post('/restore', (_req, res) => {
  isOutage = false;
  logEvent('OUTAGE_END', { node: NODE_ID });
  res.json({ node: NODE_ID, status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Health endpoint (what the orchestrator polls) ────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status:    isOutage ? 'outage' : 'ok',
    node:      NODE_ID,
    port:      PORT,
    delay_ms:  currentDelayMs,
    uptime_s:  Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ─── Stats endpoint ───────────────────────────────────────────────────────────

app.get('/edge-stats', (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    node:      NODE_ID,
    port:      PORT,
    status:    isOutage ? 'outage' : 'ok',
    delay_ms:  currentDelayMs,
    origin:    ORIGIN_URL,
    uptime_s:  Math.round(process.uptime()),
    memory: {
      rss_mb:        (mem.rss       / 1024 / 1024).toFixed(1),
      heap_used_mb:  (mem.heapUsed  / 1024 / 1024).toFixed(1),
    },
    system: {
      cpus:     os.cpus().length,
      platform: os.platform(),
    },
    event_log: eventLog.slice(-20), // last 20 events
    timestamp: new Date().toISOString(),
  });
});

// ─── DASH Proxy (core MEC behaviour) ─────────────────────────────────────────
//
// Edge node applies its own simulated delay, then forwards the request
// to the origin server and streams the response back.
// This is the VNF "interception" point the paper describes.

app.use('/dash', (req, res) => {
  let targetUrl;
  if (AKAMAI_PROXY) {
    const targetPath = req.path === '/manifest.mpd' ? '/bbb_30fps.mpd' : req.path;
    targetUrl = `https://dash.akamaized.net/akamai/bbb_30fps${targetPath}`;
  } else {
    targetUrl = `${ORIGIN_URL}/dash${req.path}`;
  }

  const delay = currentDelayMs;
  setTimeout(() => {
    const lib = targetUrl.startsWith('https') ? https : http;

    const proxyReq = lib.get(targetUrl, (proxyRes) => {
      // Forward status + headers
      res.status(proxyRes.statusCode);

      // Forward relevant headers
      const passHeaders = ['content-type', 'content-length', 'cache-control', 'accept-ranges'];
      passHeaders.forEach(h => {
        if (proxyRes.headers[h]) res.setHeader(h, proxyRes.headers[h]);
      });

      // CORS always open (frontend on different port)
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Edge-Node', NODE_ID);
      res.setHeader('X-Edge-Delay-Ms', String(delay));

      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      logEvent('PROXY_ERROR', { url: targetUrl, error: err.message });
      if (!res.headersSent) {
        res.status(502).json({ error: 'Origin unreachable', detail: err.message, node: NODE_ID });
      }
    });

  }, delay);
});

// ─── 404 ─────────────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path, node: NODE_ID });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, BIND_HOST, () => {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log(`║  MEC Edge Node — ${NODE_ID.padEnd(34)}║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Listening   : http://localhost:${PORT}               ║`);
  console.log(`║  Origin URL  : ${ORIGIN_URL.padEnd(38)}║`);
  console.log(`║  Init delay  : ${String(currentDelayMs + ' ms').padEnd(38)}║`);
  console.log(`║  Health      : http://localhost:${PORT}/health         ║`);
  console.log(`║  Stats       : http://localhost:${PORT}/edge-stats     ║`);
  console.log(`║  Set delay   : POST http://localhost:${PORT}/set-delay  ║`);
  console.log(`║  Outage      : POST http://localhost:${PORT}/simulate-outage ║`);
  console.log('╚══════════════════════════════════════════════════════╝\n');
});
