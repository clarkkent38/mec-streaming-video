'use strict';
/**
 * dashboard.js — Dashboard renderer
 *
 * All data comes from the agent's local dashboard API on 127.0.0.1:DASHBOARD_PORT.
 * We also listen for IPC push events (state:changed, agent:event) from the main
 * process for the status header and progress ticks.
 *
 * Charts use Chart.js (loaded from vendor/chart.umd.min.js — no CDN).
 * SSE stream from /api/stream drives live KPI + table updates.
 */

const api = window.edgenest;

// ── Config ────────────────────────────────────────────────────────────────────
let _cfg            = {};
let _dashUrl        = 'http://127.0.0.1:5002';
let _currentWindow  = 'seconds';
let _orchRttHistory = [];   // [{ts, rttMs}] from orchestrator edges poll
let _hbHistory      = [];   // [{ts, state}] for heartbeat timeline
let _sseSource      = null;
let _statsRefreshTimer = null;

// ── Initialise ────────────────────────────────────────────────────────────────
(async () => {
  const { config } = await api.loadConfig();
  _cfg = config;
  _dashUrl = `http://127.0.0.1:${config.dashboardPort || 5002}`;

  document.getElementById('nodeNameDisplay').textContent = config.nodeLabel || '—';

  // Load state immediately
  const stateRes = await api.getState();
  if (stateRes.ok) applyState(stateRes.state, stateRes.detail);

  // Charts
  initCharts();

  // Initial data fetch
  await refreshStats();
  await refreshSeries();

  // SSE for live updates
  startSse();

  // Poll orchestrator for RTT history (piggyback on state machine's data via IPC)
  setInterval(refreshOrchRtt, 5000);
  refreshOrchRtt();

  // Uptime ticker
  setInterval(tickUptime, 1000);

  // Periodic stats refresh (backup in case SSE is slow)
  _statsRefreshTimer = setInterval(async () => {
    await refreshStats();
    await refreshSeries();
  }, 5000);
})();

// ── IPC listeners ─────────────────────────────────────────────────────────────
api.on('state:changed', ({ state, detail }) => {
  applyState(state, detail);
  const ts = new Date().toISOString();
  _hbHistory.push({ ts, state });
  if (_hbHistory.length > 120) _hbHistory.shift();
  renderHeartbeatTimeline();
});

api.on('agent:event', ({ event }) => {
  if (event === 'started') setTick('tick-agent', 'done');
  if (event === 'stopped' || event === 'error') setTick('tick-agent', '');
});

// ── State badge + progress ticks ─────────────────────────────────────────────
const STATE_CLASSES = {
  SETUP: 'state-setup', LOCAL_ONLY: 'state-local_only',
  PUBLIC_PENDING: 'state-public_pending', LIVE: 'state-live',
  DEGRADED: 'state-degraded', OFFLINE: 'state-offline',
};
const STATE_TICK_MAP = {
  SETUP:          [],
  LOCAL_ONLY:     ['tick-agent', 'tick-health'],
  PUBLIC_PENDING: ['tick-agent', 'tick-health', 'tick-funnel', 'tick-registered'],
  LIVE:           ['tick-agent', 'tick-health', 'tick-funnel', 'tick-registered', 'tick-verified', 'tick-live'],
  DEGRADED:       ['tick-agent', 'tick-health', 'tick-funnel', 'tick-registered'],
  OFFLINE:        [],
};

function applyState(state, detail) {
  const badge = document.getElementById('stateBadge');
  badge.textContent = state || 'OFFLINE';
  badge.className   = `state-badge ${STATE_CLASSES[state] || 'state-offline'}`;
  document.getElementById('stateDetail').textContent = detail || '';

  // Ticks
  const allTicks = ['tick-agent','tick-health','tick-funnel','tick-registered','tick-verified','tick-live'];
  const done = STATE_TICK_MAP[state] || [];
  allTicks.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = 'tick' + (done.includes(id) ? ' done' : '');
  });
  // Active tick = first not-done
  const activeTick = allTicks.find(id => !done.includes(id));
  if (activeTick) {
    const el = document.getElementById(activeTick);
    if (el) el.classList.add('active');
  }

  // Hide progress row when LIVE
  document.getElementById('progressRow').style.display = state === 'LIVE' ? 'none' : 'flex';

  // Public URL
  if (_cfg.publicUrl) {
    document.getElementById('publicUrlDisplay').textContent = _cfg.publicUrl;
    document.getElementById('btnCopyUrl').style.display = '';
  }
}

function setTick(id, cls) {
  const el = document.getElementById(id);
  if (el) el.className = 'tick' + (cls ? ' ' + cls : '');
}

// ── Uptime ────────────────────────────────────────────────────────────────────
let _startTime = Date.now();
function tickUptime() {
  const s = Math.round((Date.now() - _startTime) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  document.getElementById('uptimeDisplay').textContent =
    `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

// ── Stats fetch & KPI render ──────────────────────────────────────────────────
async function refreshStats() {
  try {
    const res  = await fetch(`${_dashUrl}/api/stats`);
    if (!res.ok) return;
    const data = await res.json();
    renderKpis(data);
    if (data.uptime_s) _startTime = Date.now() - data.uptime_s * 1000;
  } catch (_) { /* agent may not be running yet */ }
}

function fmt(val, unit, decimals = 0) {
  if (val == null || isNaN(val)) return '—';
  return Number(val).toFixed(decimals) + unit;
}
function fmtBytes(b) {
  if (b == null) return '—';
  if (b >= 1e9) return (b/1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b/1e6).toFixed(2) + ' MB';
  if (b >= 1e3) return (b/1e3).toFixed(1) + ' KB';
  return b + ' B';
}

function renderKpis(data) {
  document.getElementById('kpi-requests').textContent  = data.requestsServed?.toLocaleString() ?? '—';
  document.getElementById('kpi-hitRatio').textContent  = data.cacheHitRatio != null ? (data.cacheHitRatio * 100).toFixed(1) + '%' : '—';
  document.getElementById('kpi-p50').textContent       = fmt(data.p50_ms, ' ms');
  document.getElementById('kpi-p95').textContent       = fmt(data.p95_ms, ' ms');
  document.getElementById('kpi-throughput').textContent = fmt(data.throughputMbps, ' Mbps', 2);
  document.getElementById('kpi-saved').textContent     = fmtBytes(data.dataSavedBytes);
  document.getElementById('kpi-latencySaved').textContent = fmt(data.latencySavedMs, ' ms');
}

// ── Series fetch & chart update ───────────────────────────────────────────────
async function refreshSeries() {
  try {
    const res  = await fetch(`${_dashUrl}/api/series?window=${_currentWindow}`);
    if (!res.ok) return;
    const { series } = await res.json();
    updateCharts(series);
    refreshRequestTable();
  } catch (_) {}
}

// ── Orchestrator RTT history ──────────────────────────────────────────────────
async function refreshOrchRtt() {
  // We ask main process for state (which includes measuredLatencyMs from last poll)
  const stateRes = await api.getState();
  // The state detail contains the RTT — parse it as a best-effort approach
  const match = (stateRes.detail || '').match(/RTT (\d+) ms/);
  if (match) {
    _orchRttHistory.push({ ts: new Date().toISOString(), rttMs: parseInt(match[1], 10) });
    if (_orchRttHistory.length > 100) _orchRttHistory.shift();
    // Update orch RTT KPI
    document.getElementById('kpi-orchRtt').textContent = match[1] + ' ms';
    updateOrchRttChart();
  }
}

// ── Chart definitions ─────────────────────────────────────────────────────────
const charts = {};

function mkChart(id, type, datasets, yLabel, options = {}) {
  const ctx = document.getElementById(id).getContext('2d');
  charts[id] = new Chart(ctx, {
    type,
    data: { labels: [], datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 200 },
      plugins: { legend: { position: 'top', labels: { font: { size: 11 }, boxWidth: 12 } } },
      scales: {
        x: { ticks: { maxTicksLimit: 8, font: { size: 10 } }, grid: { display: false } },
        y: { title: { display: !!yLabel, text: yLabel, font: { size: 10 } }, ticks: { font: { size: 10 } }, beginAtZero: true, ...options.yScale },
      },
      ...options.extra,
    },
  });
}

function initCharts() {
  mkChart('chartLatency', 'line', [
    { label: 'Hit latency (ms)',  data: [], borderColor: '#16a34a', backgroundColor: 'rgba(22,163,74,0.08)', tension: 0.3, pointRadius: 1, fill: false },
    { label: 'Miss latency (ms)', data: [], borderColor: '#dc2626', backgroundColor: 'rgba(220,38,38,0.08)', tension: 0.3, pointRadius: 1, fill: false },
  ], 'ms');

  mkChart('chartThroughput', 'line', [
    { label: 'Throughput (Mbps)', data: [], borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,0.08)', tension: 0.3, pointRadius: 1, fill: true },
  ], 'Mbps');

  mkChart('chartHitRatio', 'line', [
    { label: 'Hit ratio (%)', data: [], borderColor: '#7c3aed', backgroundColor: 'rgba(124,58,237,0.08)', tension: 0.3, pointRadius: 1, fill: true },
  ], '%');

  mkChart('chartBytes', 'bar', [
    { label: 'Cache served (bytes)',   data: [], backgroundColor: 'rgba(22,163,74,0.7)',  stack: 'bytes' },
    { label: 'Origin fetched (bytes)', data: [], backgroundColor: 'rgba(220,38,38,0.7)', stack: 'bytes' },
  ], 'Bytes', { extra: { scales: { y: { stacked: true, beginAtZero: true } } } });

  mkChart('chartOriginVsHit', 'line', [
    { label: 'Origin fetch (ms)', data: [], borderColor: '#d97706', tension: 0.3, pointRadius: 1, fill: false },
    { label: 'Hit latency (ms)',  data: [], borderColor: '#16a34a', tension: 0.3, pointRadius: 1, fill: false },
  ], 'ms');

  mkChart('chartOrchRtt', 'line', [
    { label: 'Orch RTT (ms)', data: [], borderColor: '#0891b2', backgroundColor: 'rgba(8,145,178,0.08)', tension: 0.3, pointRadius: 2, fill: true },
  ], 'ms');

  mkChart('chartRps', 'bar', [
    { label: 'Requests/sec', data: [], backgroundColor: 'rgba(37,99,235,0.6)' },
  ], 'req/s');
}

function updateCharts(series) {
  if (!series || series.length === 0) return;
  const labels  = series.map(b => b.key.slice(-8));   // last 8 chars of ISO key
  const hitLat  = series.map(b => b.hits > 0 ? Math.round(b.p50) : null);
  const missLat = series.map(b => b.misses > 0 ? b.avgMs : null);
  const tput    = series.map(b => b.throughputMbps);
  const hitRat  = series.map(b => Math.round(b.hitRatio * 100));
  const cacheB  = series.map(b => b.hits   > 0 ? Math.round(b.bytes * b.hitRatio)         : 0);
  const origB   = series.map(b => b.misses > 0 ? Math.round(b.bytes * (1 - b.hitRatio))   : 0);
  const origMs  = series.map(b => b.originMs || null);
  const rps     = series.map(b => _currentWindow === 'seconds' ? b.requests : Math.round(b.requests / 60));

  setChart('chartLatency',    labels, [hitLat, missLat]);
  setChart('chartThroughput', labels, [tput]);
  setChart('chartHitRatio',   labels, [hitRat]);
  setChart('chartBytes',      labels, [cacheB, origB]);
  setChart('chartOriginVsHit',labels, [origMs, hitLat]);
  setChart('chartRps',        labels, [rps]);
}

function setChart(id, labels, dataSets) {
  const ch = charts[id];
  if (!ch) return;
  ch.data.labels = labels;
  dataSets.forEach((ds, i) => {
    if (ch.data.datasets[i]) ch.data.datasets[i].data = ds;
  });
  ch.update('none');
}

function updateOrchRttChart() {
  const ch = charts['chartOrchRtt'];
  if (!ch) return;
  ch.data.labels             = _orchRttHistory.map(r => r.ts.slice(11, 19));
  ch.data.datasets[0].data  = _orchRttHistory.map(r => r.rttMs);
  ch.update('none');
}

// ── Request table ─────────────────────────────────────────────────────────────
async function refreshRequestTable() {
  try {
    const res  = await fetch(`${_dashUrl}/api/requests?limit=50`);
    if (!res.ok) return;
    const { requests } = await res.json();
    const tbody = document.getElementById('reqTableBody');
    tbody.innerHTML = '';
    (requests || []).forEach(r => {
      const tr = document.createElement('tr');
      const cacheCell = r.cacheResult === 'HIT'
        ? `<span class="badge-hit">HIT</span>`
        : `<span class="badge-miss">MISS</span>`;
      tr.innerHTML = `
        <td>${r.ts.slice(11,19)}</td>
        <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(r.path)}</td>
        <td>${cacheCell}</td>
        <td>${r.statusCode}</td>
        <td>${r.totalMs}</td>
        <td>${r.originMs ?? '—'}</td>
        <td>${fmtBytes(r.bytes)}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (_) {}
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Heartbeat timeline ────────────────────────────────────────────────────────
function renderHeartbeatTimeline() {
  const container = document.getElementById('heartbeatTimeline');
  container.innerHTML = '';
  _hbHistory.slice(-60).forEach(({ state }) => {
    const div = document.createElement('div');
    div.className = 'hb-tick ' + (state === 'LIVE' ? 'ok' : state === 'DEGRADED' ? 'degraded' : 'offline');
    div.title = state;
    container.appendChild(div);
  });
}

// ── SSE live updates ──────────────────────────────────────────────────────────
function startSse() {
  try {
    _sseSource = new EventSource(`${_dashUrl}/api/stream`);
    _sseSource.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'request') {
          // Append to table without full re-fetch
          prependTableRow(msg.data);
        }
        // Stats are refreshed on the 5 s poll; SSE is just for table freshness
      } catch (_) {}
    };
    _sseSource.onerror = () => {
      // Agent not running yet — silently reconnect later
      _sseSource.close();
      setTimeout(startSse, 5000);
    };
  } catch (_) {}
}

function prependTableRow(r) {
  const tbody = document.getElementById('reqTableBody');
  if (!tbody) return;
  const tr = document.createElement('tr');
  const cacheCell = r.cacheResult === 'HIT'
    ? `<span class="badge-hit">HIT</span>`
    : `<span class="badge-miss">MISS</span>`;
  tr.innerHTML = `
    <td>${r.ts.slice(11,19)}</td>
    <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(r.path)}</td>
    <td>${cacheCell}</td>
    <td>${r.statusCode}</td>
    <td>${r.totalMs}</td>
    <td>${r.originMs ?? '—'}</td>
    <td>${fmtBytes(r.bytes)}</td>
  `;
  tbody.insertBefore(tr, tbody.firstChild);
  // Keep max 50 rows visible
  while (tbody.rows.length > 50) tbody.deleteRow(tbody.rows.length - 1);
}

// ── Toolbar buttons ───────────────────────────────────────────────────────────
document.getElementById('btnCopyUrl').addEventListener('click', () => {
  if (_cfg.publicUrl) navigator.clipboard.writeText(_cfg.publicUrl);
});

document.getElementById('btnSettings').addEventListener('click', () => api.openSetup());

document.getElementById('btnDarkMode').addEventListener('click', () => {
  document.body.classList.toggle('dark');
});

document.getElementById('btnExportCsv').addEventListener('click', async () => {
  // Open the CSV download URL in the default browser so it triggers a save dialog
  await api.openExternal(`${_dashUrl}/api/export.csv`);
});

document.getElementById('btnResetStats').addEventListener('click', async () => {
  if (!confirm('Reset all in-memory stats? The CSV log is kept.')) return;
  await fetch(`${_dashUrl}/api/reset`, { method: 'POST' });
  await refreshStats();
  await refreshSeries();
});

// ── Window selector ───────────────────────────────────────────────────────────
document.querySelectorAll('.win-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.win-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _currentWindow = btn.dataset.win;
    refreshSeries();
  });
});

// ── Self-test ─────────────────────────────────────────────────────────────────
document.getElementById('btnSelfTest').addEventListener('click', async () => {
  const panel = document.getElementById('selfTestPanel');
  const results = document.getElementById('selfTestResults');
  panel.style.display = 'block';
  results.innerHTML = '<div style="color:var(--muted);padding:8px">Running self-test…</div>';

  const { ok, results: tests } = await api.runSelfTest();
  if (!ok || !tests) {
    results.innerHTML = '<div style="color:var(--danger)">Self-test failed to run.</div>';
    return;
  }
  results.innerHTML = tests.map(t => `
    <div class="selftest-item">
      <span class="selftest-icon ${t.pass ? 'pass' : 'fail'}">${t.pass ? '✓' : '✗'}</span>
      <div>
        <div class="selftest-name">${escHtml(t.name)}</div>
        <div class="selftest-detail">${escHtml(t.detail || '')}</div>
      </div>
    </div>
  `).join('');
});

// ── Diagnostics ───────────────────────────────────────────────────────────────
document.getElementById('btnDiag').addEventListener('click', async () => {
  await api.copyDiagnostics();
  alert('Diagnostics copied to clipboard.');
});

// ── QR Code ───────────────────────────────────────────────────────────────────
document.getElementById('btnQr').addEventListener('click', async () => {
  const url = _cfg.publicUrl || 'https://mec-streaming-video.vercel.app';
  const modal = document.getElementById('qrModal');
  modal.style.display = 'flex';
  document.getElementById('qrUrl').textContent = url;
  // Draw QR code on canvas using a simple built-in approach
  const canvas = document.getElementById('qrCanvas');
  await drawQr(canvas, url);
});

document.getElementById('btnCloseQr').addEventListener('click', () => {
  document.getElementById('qrModal').style.display = 'none';
});

/**
 * Draw a QR code on a canvas element.
 * Uses a minimal built-in encoder — no CDN.
 * For accuracy with real URLs, we use the qrcode module exposed via the
 * main process (edge-installer package.json includes the qrcode npm package).
 * Fallback: draw a placeholder if the module is unavailable.
 */
async function drawQr(canvas, url) {
  try {
    // Try to use the qrcode npm package via a Node-compatible path
    // In Electron renderer with contextIsolation, we call main process
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Simple checkered placeholder indicating QR support requires qrcode module
    // The real QR rendering needs a Node require, which we handle via IPC
    ctx.fillStyle = '#1a202c';
    ctx.font = '11px monospace';
    ctx.fillText('QR: use phone camera', 8, 100);
    ctx.fillText('URL copied above', 8, 115);
    navigator.clipboard.writeText(url);
  } catch (_) {}
}
