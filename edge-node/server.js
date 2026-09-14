/**
 * edge-node/server.js
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
const ORCHESTRATOR_URL = (process.env.ORCHESTRATOR_URL || yamlConfig.ORCHESTRATOR_URL || 'http://localhost:5000').replace(/\/$/, '');
const ORIGIN_URL       = (process.env.ORIGIN_URL || yamlConfig.ORIGIN_URL || 'http://localhost:3000').replace(/\/$/, '');
const TAILSCALE_FUNNEL_URL = process.env.TAILSCALE_FUNNEL_URL || yamlConfig.TAILSCALE_FUNNEL_URL || null;
const PUBLIC_URL           = TAILSCALE_FUNNEL_URL || process.env.PUBLIC_URL || process.env.TUNNEL_URL || yamlConfig.PUBLIC_URL || yamlConfig.TUNNEL_URL || null;
const AKAMAI_PROXY         = process.env.AKAMAI_PROXY !== 'false';

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
      error:      err.message,
      retryInMs:  registerBackoffMs,
      orchestrator: ORCHESTRATOR_URL,
    });

    // Exponential backoff capped at 30 seconds
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
      // Orchestrator restarted or lost in-memory state; re-register immediately
      isRegistered = false;
      registerWithOrchestrator();
    }
  } catch (err) {
    logEvent('HEARTBEAT_WARN', { error: err.message });
  }
}

// Start registration and 5s heartbeat interval
registerWithOrchestrator();
const heartbeatTimer = setInterval(sendHeartbeat, 5000);
heartbeatTimer.unref();

// ─── 6. Express Server Application ────────────────────────────────────────────

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'HEAD', 'POST', 'OPTIONS'] }));
app.use(express.json());

// ─── Outage Gatekeeper ────────────────────────────────────────────────────────

app.use((req, res, next) => {
  const controlPaths = ['/health', '/metrics', '/edge-stats', '/set-delay', '/simulate-outage', '/restore'];
  if (isOutage && !controlPaths.includes(req.path)) {
    return res.status(503).json({ error: 'Node in simulated outage (LINK DEAD)', edgeId });
  }
  next();
});

// ─── Runtime Delay & Outage Controls ──────────────────────────────────────────

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

// ─── Health & Telemetry Endpoints ─────────────────────────────────────────────

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

// ─── 7. DASH & Video Caching Proxy Engine ─────────────────────────────────────

async function handleProxyMedia(req, res, subPath) {
  requestsServed++;
  const cacheKey = subPath;

  // 1. Check in-memory cache
  if (segmentCache.has(cacheKey)) {
    cacheHits++;
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

  // 2. Cache Miss — Fetch from Origin / Akamai fallback
  cacheMisses++;

  let targetUrl;
  if (AKAMAI_PROXY) {
    const akamaiPath = subPath === '/manifest.mpd' ? '/bbb_30fps.mpd' : subPath;
    targetUrl = `https://dash.akamaized.net/akamai/bbb_30fps${akamaiPath}`;
  } else {
    targetUrl = `${ORIGIN_URL}/dash${subPath}`;
  }

  const delay = currentDelayMs;

  setTimeout(async () => {
    try {
      const originResponse = await makeRequest(targetUrl, { method: 'GET', timeout: 8000 });

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

      // Cache segment if valid response and not manifest (.m4s, .mp4 chunks)
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

// Proxy routes for DASH and video requests
app.use('/dash', (req, res) => handleProxyMedia(req, res, req.path));
app.use('/video', (req, res) => handleProxyMedia(req, res, req.path));
app.get('/video/:filename', (req, res) => handleProxyMedia(req, res, `/${req.params.filename}`));

// ─── 404 Handler ─────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path, edgeId });
});

// ─── Start Server ────────────────────────────────────────────────────────────

app.listen(PORT, BIND_HOST, () => {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  MEC Edge Node Agent — [${NODE_LABEL}]`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Edge ID         : ${edgeId.padEnd(42)}║`);
  console.log(`║  Reachable URL   : ${MY_URL.padEnd(42)}║`);
  console.log(`║  Orchestrator    : ${ORCHESTRATOR_URL.padEnd(42)}║`);
  console.log(`║  Origin URL      : ${ORIGIN_URL.padEnd(42)}║`);
  console.log(`║  Initial Delay   : ${String(currentDelayMs + ' ms').padEnd(42)}║`);
  console.log(`║  Health Endpoint : http://localhost:${PORT}/health${' '.repeat(20 - String(PORT).length)}║`);
  console.log(`║  Metrics         : http://localhost:${PORT}/metrics${' '.repeat(19 - String(PORT).length)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
});
