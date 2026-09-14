/**
 * origin-server/server.js  (Phase 4a update)
 *
 * Added vs original:
 *  - currentDelayMs is now a mutable in-memory variable (not a const)
 *  - POST /set-delay { ms }  — change delay at runtime, no restart needed
 *  - POST /simulate-outage   — makes health endpoint return 'outage'
 *  - POST /restore           — restores normal operation
 *  - Timestamped event log   — visible at /stats
 *
 * All original features preserved.
 */

'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT       = parseInt(process.env.PORT      || '3000', 10);
const NODE_LABEL = process.env.NODE_LABEL         || 'origin';
const BIND_HOST  = process.env.BIND_HOST          || '0.0.0.0';
const AKAMAI_PROXY = process.env.AKAMAI_PROXY !== 'false';

const DASH_DIR   = path.join(__dirname, 'dash-output');
const MEDIA_DIR  = path.join(__dirname, 'media');

// ─── Mutable runtime state (Phase 4a: no longer a const) ─────────────────────

let currentDelayMs = parseInt(process.env.DELAY_MS || '0', 10);
let isOutage       = false;

const eventLog = [];
function logEvent(type, detail) {
  const entry = { ts: new Date().toISOString(), type, detail };
  eventLog.push(entry);
  if (eventLog.length > 200) eventLog.shift();
  console.log(`[${entry.ts}] [${NODE_LABEL}] ${type}: ${JSON.stringify(detail)}`);
}

logEvent('START', { port: PORT, initialDelayMs: currentDelayMs });

// ─── App setup ────────────────────────────────────────────────────────────────

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
  allowedHeaders: ['Range', 'Content-Type'],
  exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges'],
}));
app.use(express.json());

// ─── Custom MIME types ────────────────────────────────────────────────────────

express.static.mime.define({
  'application/dash+xml': ['mpd'],
  'video/mp4':            ['mp4', 'm4s'],
  'video/iso.segment':    ['m4s'],
});

// ─── Delay middleware (uses mutable currentDelayMs) ───────────────────────────

function delayMiddleware(req, res, next) {
  const delay = currentDelayMs;
  if (delay <= 0) return next();
  if (req.path.startsWith('/dash/') || req.path.startsWith('/media/')) {
    setTimeout(next, delay);
  } else {
    next();
  }
}
app.use(delayMiddleware);

// ─── Request logger ───────────────────────────────────────────────────────────

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] [${NODE_LABEL}:${PORT}] ${req.method} ${req.path}`);
  next();
});

// ─── Runtime delay config (Phase 4a new endpoint) ────────────────────────────

app.post('/set-delay', (req, res) => {
  const ms = parseInt(req.body?.ms, 10);
  if (isNaN(ms) || ms < 0) {
    return res.status(400).json({ error: 'Body must be { "ms": <non-negative integer> }' });
  }
  const prev     = currentDelayMs;
  currentDelayMs = ms;
  logEvent('SET_DELAY', { from: prev, to: ms });
  res.json({ node: NODE_LABEL, delay_ms: currentDelayMs, previous_ms: prev, timestamp: new Date().toISOString() });
});

// ─── Outage simulation (Phase 4a — keeps origin consistent with edge nodes) ───

app.post('/simulate-outage', (_req, res) => {
  isOutage = true;
  logEvent('OUTAGE_START', { node: NODE_LABEL });
  res.json({ node: NODE_LABEL, status: 'outage', timestamp: new Date().toISOString() });
});

app.post('/restore', (_req, res) => {
  isOutage = false;
  logEvent('OUTAGE_END', { node: NODE_LABEL });
  res.json({ node: NODE_LABEL, status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Static routes ────────────────────────────────────────────────────────────

app.use('/dash', (req, res, next) => {
  if (AKAMAI_PROXY) {
    let targetBaseUrl = 'https://dash.akamaized.net/akamai/bbb_30fps';
    let targetHost    = 'dash.akamaized.net';
    let targetPath    = req.url;

    if (req.url.startsWith('/envivio')) {
      targetBaseUrl = 'https://dash.akamaized.net/envivio/EnvivioDash3';
      targetHost    = 'dash.akamaized.net';
      targetPath    = req.url.replace(/^\/envivio/, '') || '/manifest.mpd';
    } else if (req.url.startsWith('/tos')) {
      targetBaseUrl = 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel';
      targetHost    = 'demo.unified-streaming.com';
      targetPath    = req.url.replace(/^\/tos/, '') || '/tears-of-steel.ism/.mpd';
      if (targetPath === '/manifest.mpd') {
        targetPath = '/tears-of-steel.ism/.mpd';
      }
    } else {
      // Default / BBB stream
      if (targetPath === '/manifest.mpd' || targetPath === '/bbb/manifest.mpd') {
        targetPath = '/bbb_30fps.mpd';
      }
      targetPath = targetPath.replace(/^\/bbb/, '');
    }

    const targetUrl = targetBaseUrl + targetPath;

    const proxyReq = require('https').request(targetUrl, {
      method: req.method,
      headers: {
        ...req.headers,
        host: targetHost,
      }
    }, (proxyRes) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error(`[PROXY ERROR] Origin: ${err.message}`);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Proxy fetch failed', message: err.message });
      }
    });

    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
    return;
  }

  const safePath = path.normalize(req.path).replace(/^(\.\.([\/\\]|$))+/, '');
  const fullPath = path.join(DASH_DIR, safePath);

  if (!fs.existsSync(fullPath)) {
    return next();
  }

  if (fullPath.endsWith('.mpd')) {
    res.setHeader('Content-Type', 'application/dash+xml');
  } else if (fullPath.endsWith('.m4s')) {
    res.setHeader('Content-Type', 'video/iso.segment');
  } else if (fullPath.endsWith('.mp4')) {
    res.setHeader('Content-Type', 'video/mp4');
  }

  res.setHeader('Cache-Control', 'public, max-age=5');
  res.sendFile(fullPath);
});

app.use('/media', express.static(MEDIA_DIR, { index: false }));

// ─── Health endpoint ──────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status:    isOutage ? 'outage' : 'ok',
    node:      NODE_LABEL,
    port:      PORT,
    delay_ms:  currentDelayMs,
    uptime_s:  Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ─── Stats endpoint ───────────────────────────────────────────────────────────

app.get('/stats', (_req, res) => {
  const mem = process.memoryUsage();
  const totalDashFiles = fs.existsSync(DASH_DIR) ? fs.readdirSync(DASH_DIR).length : 0;

  let dashBytes = 0;
  if (fs.existsSync(DASH_DIR)) {
    fs.readdirSync(DASH_DIR).forEach(f => {
      try { dashBytes += fs.statSync(path.join(DASH_DIR, f)).size; } catch (_) {}
    });
  }

  res.json({
    node:            NODE_LABEL,
    port:            PORT,
    status:          isOutage ? 'outage' : 'ok',
    delay_ms:        currentDelayMs,
    uptime_s:        Math.round(process.uptime()),
    memory: {
      rss_mb:        (mem.rss        / 1024 / 1024).toFixed(1),
      heap_used_mb:  (mem.heapUsed   / 1024 / 1024).toFixed(1),
      heap_total_mb: (mem.heapTotal  / 1024 / 1024).toFixed(1),
    },
    system: {
      total_ram_gb:  (os.totalmem()  / 1024 / 1024 / 1024).toFixed(1),
      free_ram_gb:   (os.freemem()   / 1024 / 1024 / 1024).toFixed(1),
      cpus:          os.cpus().length,
      platform:      os.platform(),
    },
    dash_output: {
      files:         totalDashFiles,
      total_mb:      (dashBytes / 1024 / 1024).toFixed(2),
    },
    event_log:       eventLog.slice(-20),
    timestamp:       new Date().toISOString(),
  });
});

// ─── Manifest shortcut ────────────────────────────────────────────────────────

app.get('/manifest', (_req, res) => {
  res.redirect('/dash/manifest.mpd');
});

// ─── 404 handler ─────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path:  req.path,
    hint:  'DASH content is served under /dash/  e.g. /dash/manifest.mpd',
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, BIND_HOST, () => {
  const manifestExists = fs.existsSync(path.join(DASH_DIR, 'manifest.mpd'));
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log(`║  Origin Server — ${NODE_LABEL.padEnd(30)} ║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Listening on  : http://localhost:${PORT}            ║`);
  console.log(`║  DASH manifest : http://localhost:${PORT}/dash/manifest.mpd ║`);
  console.log(`║  Health check  : http://localhost:${PORT}/health       ║`);
  console.log(`║  Stats         : http://localhost:${PORT}/stats        ║`);
  console.log(`║  Set delay     : POST http://localhost:${PORT}/set-delay  ║`);
  console.log(`║  Latency delay : ${String(currentDelayMs + ' ms').padEnd(31)} ║`);
  console.log(`║  Manifest ready: ${manifestExists ? '✅ YES' : '❌ NO (run: npm run encode first)'}   ║`);
  console.log('╚══════════════════════════════════════════════════╝\n');

  if (!manifestExists) {
    console.warn('⚠️  dash-output/manifest.mpd not found.');
    console.warn('   Run:  npm run encode  (in origin-server/)');
    console.warn('   Then restart this server.\n');
  }
});
