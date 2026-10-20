/**
 * pc-edge-agent/server.js
 *
 * Self-Registering Dynamic MEC Edge Node Agent (VNF Instance)
 *
 * Responsibilities:
 *  1. Reads configuration from environment variables or optional config.yaml
 *  2. Discovers its own reachable LAN/tunnel network URL and self-registers with Orchestrator
 *  3. Heartbeats every 5s with cache hit/miss telemetry
 *  4. In-memory LRU caching reverse-proxy for DASH & video media segments
 *  5. Gracefully handles network/orchestrator disconnections with retry backoff
 *  6. Supports runtime fault injection (delays, simulated outages, metrics)
 *
 * Additive additions (backward-compatible):
 *  7. BIND_HOST env var (defaults to 0.0.0.0 — unchanged behaviour)
 *  8. Per-request telemetry middleware: records timestamp, path, HIT/MISS, status,
 *     total time ms, bytes, origin fetch time ms. Bounded in-memory store:
 *     1-second buckets for 60 min, 1-minute buckets for 24 h, last 5,000 raw requests.
 *     Appends raw requests to a daily CSV in EXPORT_DIR (default ./exports/).
 *  9. Local-only dashboard API on 127.0.0.1:DASHBOARD_PORT (default 5002).
 *     Endpoints: GET /api/stats, /api/series?window=, /api/requests,
 *                /api/export.csv, GET /api/stream (SSE for live updates).
 */

'use strict';

const express = require('express');
const cors    = require('cors');
const http    = require('http');
const https   = require('https');
const os      = require('os');
const fs      = require('fs');
const path    = require('path');

// ─── 1. Configuration Loader (Env Vars + Optional config.yaml) ────────────────

function parseSimpleYaml(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const result = {};
    content.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0) {
        const key = trimmed.slice(0, colonIdx).trim();
        const value = trimmed.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
        result[key] = value;
      }
    });
    return result;
  } catch (err) {
    console.warn(`[config] Warning: Failed to parse ${filePath}:`, err.message);
    return {};
  }
}

const yamlConfig = parseSimpleYaml(path.join(__dirname, 'config.yaml'));

const PORT             = parseInt(process.env.PORT || yamlConfig.PORT || '5001', 10);
const BIND_HOST        = process.env.BIND_HOST || yamlConfig.BIND_HOST || '0.0.0.0';
const NODE_LABEL       = process.env.NODE_LABEL || yamlConfig.NODE_LABEL || process.env.NODE_ID || `Edge-${os.hostname().slice(0, 8)}`;
const ORCHESTRATOR_URL = (process.env.ORCHESTRATOR_URL || yamlConfig.ORCHESTRATOR_URL || 'https://orchestrator-id88.onrender.com').replace(/\/$/, '');
const ORIGIN_URL       = (process.env.ORIGIN_URL || yamlConfig.ORIGIN_URL || 'https://origin-server-1ge5.onrender.com').replace(/\/$/, '');
const TAILSCALE_FUNNEL_URL = process.env.TAILSCALE_FUNNEL_URL || yamlConfig.TAILSCALE_FUNNEL_URL || null;
const PUBLIC_URL           = TAILSCALE_FUNNEL_URL || process.env.PUBLIC_URL || process.env.TUNNEL_URL || yamlConfig.PUBLIC_URL || yamlConfig.TUNNEL_URL || null;
const AKAMAI_PROXY         = process.env.AKAMAI_PROXY !== 'false';

// Additive: dashboard API port (never exposed through Funnel — bound to 127.0.0.1 only)
const DASHBOARD_PORT   = parseInt(process.env.DASHBOARD_PORT || yamlConfig.DASHBOARD_PORT || '5002', 10);
const DASHBOARD_ENABLED = process.env.DASHBOARD_ENABLED !== 'false'; // opt-out flag

// Additive: CSV export directory
const EXPORT_DIR = process.env.EXPORT_DIR || yamlConfig.EXPORT_DIR || path.join(__dirname, 'exports');

// Generate unique edgeId: label + short random suffix
const randomSuffix = Math.random().toString(36).substring(2, 6);
const edgeId       = process.env.EDGE_ID || `${NODE_LABEL.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${randomSuffix}`;

// ─── 2. Reachable IP / Public Funnel URL Detection ────────────────────────────

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

const LOCAL_IP         = getLocalIp();
const MY_URL           = PUBLIC_URL ? PUBLIC_URL.replace(/\/$/, '') : `http://${LOCAL_IP}:${PORT}`;
const IS_PUBLIC_TUNNEL = !!PUBLIC_URL;

// ─── 3. Telemetry & In-Memory Cache ──────────────────────────────────────────

let currentDelayMs   = parseInt(process.env.DELAY_MS || yamlConfig.DELAY_MS || '5', 10);
let isOutage         = false;
let requestsServed   = 0;
let cacheHits        = 0;
let cacheMisses      = 0;

// In-Memory Segment Cache (Max 150 items or ~100MB)
const segmentCache   = new Map(); // key -> { buffer, headers, timestamp }
const MAX_CACHE_SIZE = 150;

function getCacheHitRatio() {
  const total = cacheHits + cacheMisses;
  return total > 0 ? parseFloat((cacheHits / total).toFixed(4)) : 0;
}

// Event Audit Log
const eventLog = [];
function logEvent(type, detail) {
  const entry = { ts: new Date().toISOString(), type, detail };
  eventLog.push(entry);
  if (eventLog.length > 200) eventLog.shift();
  console.log(`[${entry.ts}] [${edgeId}] ${type}:`, JSON.stringify(detail));
}

// ─── 4. HTTP Fetch Helper (Native http/https without extra deps) ──────────────

function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        const bodyText   = bodyBuffer.toString('utf8');
        let json = null;
        try { json = JSON.parse(bodyText); } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers:    res.headers,
          buffer:     bodyBuffer,
          text:       bodyText,
          json,
        });
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', (err) => reject(err));

    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

// ─── 5. Orchestrator Self-Registration & Heartbeat Engine ─────────────────────

let isRegistered = false;
let registerBackoffMs = 2000;

async function registerWithOrchestrator() {
  try {
    const payload = JSON.stringify({
      edgeId,
      id:    edgeId,
      url:   MY_URL,
      label: NODE_LABEL,
    });

    const res = await makeRequest(`${ORCHESTRATOR_URL}/api/orchestrator/register`, {
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      body:    payload,
      timeout: 4000,
    });

    if (res.statusCode === 200 || res.statusCode === 201) {
      isRegistered = true;
      registerBackoffMs = 2000;
      logEvent('ORCHESTRATOR_REGISTER_SUCCESS', { edgeId, url: MY_URL, orchestrator: ORCHESTRATOR_URL });
    } else {
      throw new Error(`HTTP ${res.statusCode}: ${res.text || 'Registration failed'}`);
    }
  } catch (err) {
    isRegistered = false;
    logEvent('ORCHESTRATOR_REGISTER_RETRY', {
      error:        err.message,
      retryInMs:    registerBackoffMs,
      orchestrator: ORCHESTRATOR_URL,
    });

    setTimeout(registerWithOrchestrator, registerBackoffMs);
    registerBackoffMs = Math.min(30000, registerBackoffMs * 1.5);
  }
}

async function sendHeartbeat() {
  if (!isRegistered) {
    registerWithOrchestrator();
    return;
  }

  try {
    const payload = JSON.stringify({
      edgeId,
      id:             edgeId,
      cacheHitRatio:  getCacheHitRatio(),
      requestsServed,
      cacheHits,
      cacheMisses,
    });

    const res = await makeRequest(`${ORCHESTRATOR_URL}/api/orchestrator/heartbeat`, {
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      body:    payload,
      timeout: 3000,
    });

    if (res.statusCode === 404) {
      isRegistered = false;
      registerWithOrchestrator();
    }
  } catch (err) {
    logEvent('HEARTBEAT_WARN', { error: err.message });
  }
}

registerWithOrchestrator();
const heartbeatTimer = setInterval(sendHeartbeat, 5000);
heartbeatTimer.unref();

// ─── 6. Express Server Application ────────────────────────────────────────────

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'HEAD', 'POST', 'OPTIONS'] }));
app.use(express.json());

app.use((req, res, next) => {
  const controlPaths = ['/health', '/metrics', '/edge-stats', '/set-delay', '/simulate-outage', '/restore'];
  if (isOutage && !controlPaths.includes(req.path)) {
    return res.status(503).json({ error: 'Node in simulated outage (LINK DEAD)', edgeId });
  }
  next();
});

app.post('/set-delay', (req, res) => {
  const ms = parseInt(req.body?.ms, 10);
  if (isNaN(ms) || ms < 0) {
    return res.status(400).json({ error: 'Body must be { "ms": <non-negative integer> }' });
  }
  const prev = currentDelayMs;
  currentDelayMs = ms;
  logEvent('SET_DELAY', { from: prev, to: ms });
  res.json({ edgeId, delay_ms: currentDelayMs, previous_ms: prev, timestamp: new Date().toISOString() });
});

app.post('/simulate-outage', (_req, res) => {
  isOutage = true;
  logEvent('OUTAGE_START', { edgeId });
  res.json({ edgeId, status: 'outage', timestamp: new Date().toISOString() });
});

app.post('/restore', (_req, res) => {
  isOutage = false;
  logEvent('OUTAGE_END', { edgeId });
  res.json({ edgeId, status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/health', (_req, res) => {
  res.json({
    status:         isOutage ? 'outage' : 'ok',
    edgeId,
    id:             edgeId,
    node:           edgeId,
    label:          NODE_LABEL,
    url:            MY_URL,
    port:           PORT,
    delay_ms:       currentDelayMs,
    cacheHitRatio:  getCacheHitRatio(),
    requestsServed,
    uptime_s:       Math.round(process.uptime()),
    timestamp:      new Date().toISOString(),
  });
});

app.get('/metrics', (_req, res) => {
  res.json({
    edgeId,
    label:          NODE_LABEL,
    uptime_s:       Math.round(process.uptime()),
    requestsServed,
    cacheHits,
    cacheMisses,
    cacheHitRatio:  getCacheHitRatio(),
    cachedSegments: segmentCache.size,
    currentDelayMs,
    isOutage,
  });
});

app.get('/edge-stats', (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    edgeId,
    label:          NODE_LABEL,
    url:            MY_URL,
    port:           PORT,
    status:         isOutage ? 'outage' : 'ok',
    delay_ms:       currentDelayMs,
    origin:         ORIGIN_URL,
    orchestrator:   ORCHESTRATOR_URL,
    uptime_s:       Math.round(process.uptime()),
    cache: {
      items:        segmentCache.size,
      hits:         cacheHits,
      misses:       cacheMisses,
      hitRatio:     getCacheHitRatio(),
    },
    requestsServed,
    memory: {
      rss_mb:       (mem.rss      / 1024 / 1024).toFixed(1),
      heap_used_mb: (mem.heapUsed / 1024 / 1024).toFixed(1),
    },
    system: {
      cpus:         os.cpus().length,
      platform:     os.platform(),
      lanIp:        LOCAL_IP,
    },
    event_log:      eventLog.slice(-20),
    timestamp:      new Date().toISOString(),
  });
});

// ─── ADDITIVE §7: Per-Request Telemetry Store ─────────────────────────────────
//
// Bounded ring stores — never grow unbounded:
//   rawRequests    : last 5,000 individual request records
//   secondBuckets  : 1-second aggregates, kept 60 minutes (3600 slots)
//   minuteBuckets  : 1-minute aggregates, kept 24 hours  (1440 slots)
//
// Each raw record:
//   { ts, path, cacheResult, statusCode, totalMs, bytes, originMs }
//   cacheResult: 'HIT' | 'MISS' | 'CONTROL' (non-media paths)
//   originMs: null on HIT (served from cache), number on MISS
//
// Buckets are plain objects keyed by ISO second/minute string:
//   { key, requests, hits, misses, totalMs, bytes, originMs, p50, p95 }
//   p50/p95 are recalculated lazily when read via the dashboard API.

const RAW_MAX         = 5000;
const SEC_BUCKET_MAX  = 3600;  // 60 minutes of seconds
const MIN_BUCKET_MAX  = 1440;  // 24 hours of minutes

const rawRequests   = [];   // ring: newest appended, oldest shifted when full
const secondBuckets = [];   // ring: keyed by second ISO string
const minuteBuckets = [];   // ring: keyed by minute ISO string

// Helpers to get bucket keys
function secKey(ts)  { return new Date(ts).toISOString().slice(0, 19); }  // YYYY-MM-DDTHH:MM:SS
function minKey(ts)  { return new Date(ts).toISOString().slice(0, 16); }  // YYYY-MM-DDTHH:MM

function upsertBucket(ring, key, maxLen, record) {
  let bucket = ring.length > 0 && ring[ring.length - 1].key === key
    ? ring[ring.length - 1]
    : null;

  if (!bucket) {
    bucket = { key, requests: 0, hits: 0, misses: 0, totalMs: 0, bytes: 0, originMs: 0, latencies: [] };
    ring.push(bucket);
    if (ring.length > maxLen) ring.shift();
  }

  bucket.requests++;
  if (record.cacheResult === 'HIT')  bucket.hits++;
  if (record.cacheResult === 'MISS') bucket.misses++;
  bucket.totalMs += record.totalMs;
  bucket.bytes   += record.bytes;
  if (record.originMs != null) bucket.originMs += record.originMs;
  // Keep last 200 latencies per bucket for percentile calc (capped to avoid memory blow-up)
  if (bucket.latencies.length < 200) bucket.latencies.push(record.totalMs);
}

function percentile(sortedArr, p) {
  if (!sortedArr || sortedArr.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, idx)];
}

function recordRequest(record) {
  // raw ring
  rawRequests.push(record);
  if (rawRequests.length > RAW_MAX) rawRequests.shift();

  // bucket rings
  upsertBucket(secondBuckets, secKey(record.ts), SEC_BUCKET_MAX, record);
  upsertBucket(minuteBuckets, minKey(record.ts), MIN_BUCKET_MAX, record);

  // CSV append (non-blocking, errors logged but not thrown)
  if (DASHBOARD_ENABLED) appendCsv(record);

  // Notify SSE clients
  broadcastSse({ type: 'request', data: record });
}

// ─── ADDITIVE §8: CSV Export ──────────────────────────────────────────────────

const CSV_HEADER = 'ts,path,cacheResult,statusCode,totalMs,bytes,originMs\n';

function todayCsvPath() {
  const d = new Date().toISOString().slice(0, 10);
  return path.join(EXPORT_DIR, `requests-${d}.csv`);
}

function ensureExportDir() {
  if (!fs.existsSync(EXPORT_DIR)) {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
  }
}

let _csvFileInited = false;
function appendCsv(record) {
  try {
    ensureExportDir();
    const filePath = todayCsvPath();
    const needsHeader = !_csvFileInited && !fs.existsSync(filePath);
    _csvFileInited = true;
    const line = `${record.ts},${record.path},${record.cacheResult},${record.statusCode},${record.totalMs},${record.bytes},${record.originMs ?? ''}\n`;
    fs.appendFileSync(filePath, needsHeader ? CSV_HEADER + line : line);
  } catch (err) {
    // Log but never crash the main server over a CSV write failure
    console.error(`[csv] Failed to write CSV: ${err.message}`);
  }
}

// ─── ADDITIVE §9: SSE Broadcast ───────────────────────────────────────────────

const sseClients = new Set();

function broadcastSse(payload) {
  if (sseClients.size === 0) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch (_) { sseClients.delete(res); }
  }
}

// Periodic SSE heartbeat to keep connections alive through proxies/firewalls
setInterval(() => {
  broadcastSse({ type: 'ping', ts: Date.now() });
}, 15000).unref();

// ─── ADDITIVE §10: Telemetry Middleware (wraps handleProxyMedia) ──────────────
// This is wired in below, after handleProxyMedia is defined.

// ─── Media Proxy Handler ─────────────────────────────────────────────────────

async function handleProxyMedia(req, res, subPath) {
  requestsServed++;
  const cacheKey  = subPath;
  const reqStart  = Date.now();
  let cacheResult = 'MISS';
  let originMs    = null;

  // Intercept res.end to capture status and bytes for telemetry
  const origEnd  = res.end.bind(res);
  let bytesSent  = 0;
  const origWrite = res.write.bind(res);

  res.write = function(chunk, ...args) {
    if (chunk) bytesSent += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    return origWrite(chunk, ...args);
  };

  res.end = function(chunk, ...args) {
    if (chunk) bytesSent += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    const totalMs = Date.now() - reqStart;
    recordRequest({
      ts:          new Date(reqStart).toISOString(),
      path:        subPath,
      cacheResult,
      statusCode:  res.statusCode,
      totalMs,
      bytes:       bytesSent,
      originMs,
    });
    return origEnd(chunk, ...args);
  };

  if (segmentCache.has(cacheKey)) {
    cacheHits++;
    cacheResult = 'HIT';
    const cached = segmentCache.get(cacheKey);

    setTimeout(() => {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Edge-Node', edgeId);
      res.setHeader('X-Edge-Delay-Ms', String(currentDelayMs));
      res.setHeader('Access-Control-Allow-Origin', '*');

      Object.keys(cached.headers).forEach(headerName => {
        res.setHeader(headerName, cached.headers[headerName]);
      });

      res.status(200).send(cached.buffer);
    }, currentDelayMs);
    return;
  }

  cacheMisses++;

  let targetUrl;
  if (AKAMAI_PROXY) {
    if (subPath.startsWith('/envivio')) {
      targetUrl = `https://dash.akamaized.net/envivio/EnvivioDash3${subPath.replace(/^\/envivio/, '') || '/manifest.mpd'}`;
    } else if (subPath.startsWith('/tos')) {
      let p = subPath.replace(/^\/tos/, '') || '/tears-of-steel.ism/.mpd';
      if (p === '/manifest.mpd') p = '/tears-of-steel.ism/.mpd';
      targetUrl = `https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel${p}`;
    } else {
      let p = subPath;
      if (p.startsWith('/bbb/')) p = p.slice(4);
      else if (p === '/bbb') p = '/bbb_30fps.mpd';
      if (p === '/manifest.mpd') p = '/bbb_30fps.mpd';
      targetUrl = `https://dash.akamaized.net/akamai/bbb_30fps${p}`;
    }
  } else {
    targetUrl = `${ORIGIN_URL}/dash${subPath}`;
  }

  const delay = currentDelayMs;

  setTimeout(async () => {
    try {
      const originStart    = Date.now();
      const originResponse = await makeRequest(targetUrl, { method: 'GET', timeout: 8000 });
      originMs             = Date.now() - originStart;

      res.status(originResponse.statusCode);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Edge-Node', edgeId);
      res.setHeader('X-Edge-Delay-Ms', String(delay));

      const passHeaders = ['content-type', 'content-length', 'cache-control', 'accept-ranges'];
      const headersToSave = {};

      passHeaders.forEach(h => {
        if (originResponse.headers[h]) {
          res.setHeader(h, originResponse.headers[h]);
          headersToSave[h] = originResponse.headers[h];
        }
      });

      if (originResponse.statusCode === 200 && (subPath.endsWith('.m4s') || subPath.endsWith('.mp4'))) {
        if (segmentCache.size >= MAX_CACHE_SIZE) {
          const oldestKey = segmentCache.keys().next().value;
          segmentCache.delete(oldestKey);
        }
        segmentCache.set(cacheKey, {
          buffer:    originResponse.buffer,
          headers:   headersToSave,
          timestamp: Date.now(),
        });
      }

      res.send(originResponse.buffer);
    } catch (err) {
      logEvent('PROXY_ERROR', { url: targetUrl, error: err.message });
      if (!res.headersSent) {
        res.status(502).json({ error: 'Origin unreachable', detail: err.message, edgeId });
      }
    }
  }, delay);
}

app.use('/dash', (req, res) => handleProxyMedia(req, res, req.path));
app.use('/video', (req, res) => handleProxyMedia(req, res, req.path));
app.get('/video/:filename', (req, res) => handleProxyMedia(req, res, `/${req.params.filename}`));

app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path, edgeId });
});

app.listen(PORT, BIND_HOST, () => {
  const modeStr = IS_PUBLIC_TUNNEL ? 'Mode B: Public Funnel' : 'Mode A: Local LAN';
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  MEC Edge Node Agent — [${NODE_LABEL.slice(0, 30)}]`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Mode            : ${modeStr.padEnd(42)}║`);
  console.log(`║  Edge ID         : ${edgeId.padEnd(42)}║`);
  console.log(`║  Registered URL  : ${MY_URL.padEnd(42)}║`);
  console.log(`║  Orchestrator    : ${ORCHESTRATOR_URL.padEnd(42)}║`);
  console.log(`║  Origin URL      : ${ORIGIN_URL.padEnd(42)}║`);
  console.log(`║  Health Endpoint : http://localhost:${PORT}/health${' '.repeat(20 - String(PORT).length)}║`);
  console.log(`║  Metrics         : http://localhost:${PORT}/metrics${' '.repeat(19 - String(PORT).length)}║`);
  if (DASHBOARD_ENABLED) {
  console.log(`║  Dashboard API   : http://127.0.0.1:${DASHBOARD_PORT}/api/stats${' '.repeat(16 - String(DASHBOARD_PORT).length)}║`);
  }
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
});

// ─── ADDITIVE §11: Local Dashboard API Server (127.0.0.1 only) ───────────────
//
// Bound exclusively to 127.0.0.1 — never reachable through Tailscale Funnel.
// The Funnel only forwards to the agent port (PORT / 5001).

if (DASHBOARD_ENABLED) {
  const dash = express();
  dash.use(cors({ origin: 'http://127.0.0.1:' + DASHBOARD_PORT }));
  dash.use(express.json());

  // Helper: compute percentiles from a bucket's latencies array
  function bucketPercentiles(bucket) {
    if (!bucket.latencies || bucket.latencies.length === 0) return { p50: 0, p95: 0 };
    const sorted = [...bucket.latencies].sort((a, b) => a - b);
    return {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
    };
  }

  // GET /api/stats — current snapshot
  dash.get('/api/stats', (_req, res) => {
    const allLatencies = rawRequests.map(r => r.totalMs).sort((a, b) => a - b);
    const hitLatencies = rawRequests.filter(r => r.cacheResult === 'HIT').map(r => r.totalMs).sort((a, b) => a - b);
    const missLatencies = rawRequests.filter(r => r.cacheResult === 'MISS').map(r => r.totalMs).sort((a, b) => a - b);
    const totalBytes = rawRequests.reduce((s, r) => s + r.bytes, 0);
    const cacheBytes = rawRequests.filter(r => r.cacheResult === 'HIT').reduce((s, r) => s + r.bytes, 0);
    const originBytes = rawRequests.filter(r => r.cacheResult === 'MISS').reduce((s, r) => s + r.bytes, 0);
    const missWithOrigin = rawRequests.filter(r => r.originMs != null);
    const avgOriginMs = missWithOrigin.length > 0
      ? Math.round(missWithOrigin.reduce((s, r) => s + r.originMs, 0) / missWithOrigin.length)
      : null;
    const avgHitMs = hitLatencies.length > 0
      ? Math.round(hitLatencies.reduce((a, b) => a + b, 0) / hitLatencies.length)
      : null;
    const latencySavedMs = (avgOriginMs != null && avgHitMs != null)
      ? Math.max(0, avgOriginMs - avgHitMs)
      : null;

    // Rough throughput: bytes served in the last 60 seconds
    const now = Date.now();
    const recentBytes = rawRequests
      .filter(r => now - new Date(r.ts).getTime() < 60000)
      .reduce((s, r) => s + r.bytes, 0);
    const throughputMbps = parseFloat(((recentBytes * 8) / 1e6 / 60).toFixed(3));

    res.json({
      edgeId,
      label:          NODE_LABEL,
      mode:           IS_PUBLIC_TUNNEL ? 'public' : 'lan',
      publicUrl:      MY_URL,
      isRegistered,
      isOutage,
      uptime_s:       Math.round(process.uptime()),
      requestsServed: rawRequests.length,
      cacheHitRatio:  getCacheHitRatio(),
      p50_ms:         percentile(allLatencies, 50),
      p95_ms:         percentile(allLatencies, 95),
      avgOriginMs,
      avgHitMs,
      latencySavedMs,
      throughputMbps,
      totalBytes,
      cacheBytes,
      originBytes,
      dataSavedBytes: cacheBytes,
      cachedSegments: segmentCache.size,
      currentDelayMs,
      timestamp:      new Date().toISOString(),
    });
  });

  // GET /api/series?window=seconds|minutes — time-series data for charts
  dash.get('/api/series', (req, res) => {
    const window = req.query.window === 'minutes' ? 'minutes' : 'seconds';
    const ring   = window === 'minutes' ? minuteBuckets : secondBuckets;

    const series = ring.map(b => {
      const p = bucketPercentiles(b);
      const hitRatio = b.requests > 0 ? parseFloat((b.hits / b.requests).toFixed(4)) : 0;
      const throughputMbps = parseFloat(((b.bytes * 8) / 1e6 / (window === 'minutes' ? 60 : 1)).toFixed(3));
      return {
        key:            b.key,
        requests:       b.requests,
        hits:           b.hits,
        misses:         b.misses,
        hitRatio,
        totalMs:        b.totalMs,
        avgMs:          b.requests > 0 ? Math.round(b.totalMs / b.requests) : 0,
        p50:            p.p50,
        p95:            p.p95,
        bytes:          b.bytes,
        throughputMbps,
        originMs:       b.misses > 0 ? Math.round(b.originMs / b.misses) : 0,
      };
    });

    res.json({ window, series });
  });

  // GET /api/requests?limit=N&offset=M — paginated raw request log
  dash.get('/api/requests', (req, res) => {
    const limit  = Math.min(500, parseInt(req.query.limit  || '100', 10));
    const offset = parseInt(req.query.offset || '0', 10);
    const slice  = rawRequests.slice(-(offset + limit), rawRequests.length - offset || undefined).reverse();
    res.json({ total: rawRequests.length, limit, offset, requests: slice });
  });

  // GET /api/export.csv — download today's CSV
  dash.get('/api/export.csv', (req, res) => {
    const filePath = todayCsvPath();
    if (!fs.existsSync(filePath)) {
      // Return an in-memory CSV of current raw requests if no file yet
      const lines = rawRequests.map(r =>
        `${r.ts},${r.path},${r.cacheResult},${r.statusCode},${r.totalMs},${r.bytes},${r.originMs ?? ''}`
      );
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="requests-${new Date().toISOString().slice(0,10)}.csv"`);
      return res.send(CSV_HEADER + lines.join('\n'));
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    res.sendFile(filePath);
  });

  // POST /api/reset — reset in-memory stats (keeps CSV)
  dash.post('/api/reset', (_req, res) => {
    rawRequests.length    = 0;
    secondBuckets.length  = 0;
    minuteBuckets.length  = 0;
    cacheHits   = 0;
    cacheMisses = 0;
    requestsServed = 0;
    logEvent('STATS_RESET', {});
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // GET /api/stream — Server-Sent Events for live dashboard updates
  dash.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    sseClients.add(res);

    // Send immediate snapshot on connect
    res.write(`data: ${JSON.stringify({ type: 'connected', edgeId, ts: Date.now() })}\n\n`);

    req.on('close', () => {
      sseClients.delete(res);
    });
  });

  dash.listen(DASHBOARD_PORT, '127.0.0.1', () => {
    console.log(`[dashboard] Local API listening on http://127.0.0.1:${DASHBOARD_PORT} (not tunnelled)`);
  });
}
