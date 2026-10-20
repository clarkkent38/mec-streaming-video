'use strict';
/**
 * tailscale.js — Tailscale Assistant renderer
 * Never spins forever. After 20 s timeout, shows plain-language manual steps
 * with browser-opening buttons for each admin console page.
 */

const api = window.edgenest;

let _pollTimer = null;
let _publicUrl = null;

// ── Step icon helper ──────────────────────────────────────────────────────────
function setStep(id, state, detail, actions = []) {
  const stepEl   = document.getElementById(`step-${id}`);
  const iconEl   = document.getElementById(`icon-${id}`);
  const detailEl = document.getElementById(`detail-${id}`);
  const actEl    = document.getElementById(`actions-${id}`);
  if (!stepEl) return;

  const icons = { ok: '✓', fail: '✗', pending: '⟳', waiting: '○' };
  stepEl.className      = `step ${state}`;
  iconEl.className      = `step-icon ${state}`;
  iconEl.textContent    = icons[state] || '○';
  detailEl.textContent  = detail;

  actEl.innerHTML = '';
  actions.forEach(({ label, cls, fn }) => {
    const btn = document.createElement('button');
    btn.className   = cls || 'btn-secondary';
    btn.textContent = label;
    btn.addEventListener('click', fn);
    actEl.appendChild(btn);
  });
}

// ── Apply status ──────────────────────────────────────────────────────────────
function applyStatus(s) {
  _publicUrl = s.publicUrl || null;

  // Step 1 — Installed
  if (!s.installed) {
    setStep('installed', 'fail', 'Tailscale is not installed.', [
      { label: '⬇ Download Tailscale', cls: 'btn-secondary',
        fn: () => api.openExternal('https://tailscale.com/download/windows') },
    ]);
    ['login','https','funnel'].forEach(id => setStep(id, 'waiting', 'Waiting for Tailscale…'));
    return;
  }
  setStep('installed', 'ok', 'Tailscale is installed.');

  // Step 2 — Logged in
  if (!s.loggedIn) {
    setStep('login', 'fail',
      'Not logged in. Click Log In — your browser will open the Tailscale sign-in page.',
      [{ label: 'Log In to Tailscale', cls: 'btn-secondary', fn: handleLogin }]
    );
    ['https','funnel'].forEach(id => setStep(id, 'waiting', 'Waiting for login…'));
    return;
  }
  setStep('login', 'ok', `Connected as ${s.dnsName}`);

  // Step 3 — HTTPS + Funnel ACL
  if (s.httpsEnabled === false || s.funnelStuck) {
    // Always show the two manual admin links — no guessing
    setStep('https', 'fail',
      'Funnel is not enabled. Follow these steps:',
      [
        {
          label: '1️⃣  Enable HTTPS Certificates (DNS page)',
          cls: 'btn-warn',
          fn: () => api.openExternal('https://login.tailscale.com/admin/dns'),
        },
        {
          label: '2️⃣  Enable Funnel (JSON editor — add nodeAttrs)',
          cls: 'btn-warn',
          fn: () => api.openExternal('https://login.tailscale.com/admin/acls/json'),
        },
        {
          label: '↺ Retry after enabling both',
          cls: 'btn-secondary',
          fn: handleEnableFunnel,
        },
      ]
    );
    showManualInstructions();
    setStep('funnel', 'waiting', 'Waiting for Funnel approval…');
    return;
  }

  if (s.httpsEnabled === null) {
    setStep('https', 'pending', 'Activating Funnel… (may take up to 20 s)');
    setStep('funnel', 'waiting', 'Waiting…');
    return;
  }

  setStep('https', 'ok', 'HTTPS Certificates and Funnel ACL are active.');

  // Step 4 — Funnel mapping active
  if (!s.funnelActive) {
    setStep('funnel', 'fail', 'Funnel mapping not confirmed.', [
      { label: '↺ Retry', cls: 'btn-secondary', fn: handleEnableFunnel },
    ]);
    return;
  }

  setStep('funnel', 'ok', `Funnel active → ${s.publicUrl}`);
  hideManualInstructions();
  showPublicUrl(s.publicUrl);
  document.getElementById('btnContinue').disabled = false;
  stopPolling();
}

// ── Manual instructions block (shown when stuck) ──────────────────────────────
function showManualInstructions() {
  let el = document.getElementById('manualBlock');
  if (el) { el.style.display = 'block'; return; }

  el = document.createElement('div');
  el.id = 'manualBlock';
  el.style.cssText = 'background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:16px;margin:12px 0;font-size:13px;line-height:1.7';
  el.innerHTML = `
    <strong style="color:#b45309">📋 How to enable Tailscale Funnel (one-time setup):</strong>
    <ol style="margin:8px 0 0 18px;color:#1a202c">
      <li>Click <strong>"1️⃣ Enable HTTPS Certificates"</strong> above → it opens your Tailscale DNS admin page.</li>
      <li>On that page, find <strong>"HTTPS Certificates"</strong> and toggle it <strong>ON</strong>. Save.</li>
      <li>Click <strong>"2️⃣ Enable Funnel"</strong> above → it opens your Tailscale ACL admin page.</li>
      <li>On that page, find <strong>"Funnel"</strong> under <em>Access Controls</em> or
          <em>Feature Previews</em> and enable it. Save.</li>
      <li>Come back here and click <strong>"↺ Retry"</strong>.</li>
    </ol>
    <div style="margin-top:10px;color:#6b7280;font-size:12px">
      Your machine: <strong id="machineNameInBlock"></strong><br>
      On the JSON editor page, add this block inside the root JSON object (keep your existing "acls"):
      <pre style="background:#f3f4f6;padding:8px;border-radius:4px;margin-top:6px;font-size:11px;overflow-x:auto">"nodeAttrs": [
  {
    "target": ["autogroup:member"],
    "attr":   ["funnel"]
  }
]</pre>
      Then also go to the <a href="#" id="dnsLink" style="color:#2563eb">DNS settings page</a>
      and toggle <strong>HTTPS Certificates</strong> ON.
    </div>
  `;
  document.getElementById('checklist').after(el);

  // Fill machine name once available
  api.tailscaleCheck().then(s => {
    const nameEl = document.getElementById('machineNameInBlock');
    if (nameEl && s.dnsName) nameEl.textContent = s.dnsName;
  });

  const ml = document.getElementById('dnsLink');
  if (ml) ml.addEventListener('click', e => {
    e.preventDefault();
    api.openExternal('https://login.tailscale.com/admin/dns');
  });
}

function hideManualInstructions() {
  const el = document.getElementById('manualBlock');
  if (el) el.style.display = 'none';
}

// ── Public URL display ────────────────────────────────────────────────────────
function showPublicUrl(url) {
  const box = document.getElementById('urlBox');
  if (!box) return;
  box.style.display = 'block';
  document.getElementById('publicUrlText').textContent = url || '';
  document.getElementById('healthUrl').textContent = (url || '') + '/health';
}

// ── Action handlers ───────────────────────────────────────────────────────────
async function handleLogin() {
  setStep('login', 'pending', 'Opening Tailscale login page in your browser…');
  await api.tailscaleLogin();
  startPolling();
}

async function handleEnableFunnel() {
  setStep('https',  'pending', 'Activating Funnel… (up to 20 s)');
  setStep('funnel', 'pending', 'Waiting…');
  await api.tailscaleEnableFunnel();
  await runCheck();
}

// ── Polling ───────────────────────────────────────────────────────────────────
async function runCheck() {
  const result = await api.tailscaleCheck();
  if (result.ok !== false) applyStatus(result);
}

function startPolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(runCheck, 3000);
}

function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

api.on('tailscale:update', applyStatus);

// ── Buttons ───────────────────────────────────────────────────────────────────
document.getElementById('btnRetry').addEventListener('click', async () => {
  const { loggedIn } = await api.tailscaleCheck();
  if (loggedIn) await handleEnableFunnel();
  else await runCheck();
});

document.getElementById('btnCopyUrl').addEventListener('click', () => {
  if (_publicUrl) navigator.clipboard.writeText(_publicUrl);
});

document.getElementById('btnBack').addEventListener('click', () => api.openSetup());

document.getElementById('btnContinue').addEventListener('click', async () => {
  await api.startAgent();
  await api.openDashboard();
});

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  ['installed','login','https','funnel'].forEach(id => setStep(id, 'pending', 'Checking…'));
  await runCheck();
  const status = await api.tailscaleCheck();
  if (status.loggedIn && !status.funnelActive) await handleEnableFunnel();
  startPolling();
})();
