'use strict';
/**
 * tailscale.js — Tailscale Assistant renderer
 * Drives the 4-step checklist, retries on a 3 s interval, surfaces admin
 * console links as buttons when HTTPS/Funnel permissions are missing.
 */

const api = window.edgenest;
const { TS_CHECK_INTERVAL_MS = 3000 } = {};

let _pollTimer  = null;
let _adminLink  = null;
let _publicUrl  = null;

// ── Icon helpers ─────────────────────────────────────────────────────────────
function setStep(id, state, detail, actions = []) {
  const stepEl   = document.getElementById(`step-${id}`);
  const iconEl   = document.getElementById(`icon-${id}`);
  const detailEl = document.getElementById(`detail-${id}`);
  const actEl    = document.getElementById(`actions-${id}`);

  const icons = { ok: '✓', fail: '✗', pending: '⟳', waiting: '○' };
  stepEl.className  = `step ${state}`;
  iconEl.className  = `step-icon ${state}`;
  iconEl.textContent = icons[state] || '○';
  detailEl.textContent = detail;

  actEl.innerHTML = '';
  actions.forEach(({ label, cls, fn }) => {
    const btn = document.createElement('button');
    btn.className   = cls || 'btn-secondary';
    btn.textContent = label;
    btn.addEventListener('click', fn);
    actEl.appendChild(btn);
  });
}

// ── Apply status from main process ───────────────────────────────────────────
function applyStatus(s) {
  _adminLink = s.adminLink || null;
  _publicUrl = s.publicUrl || null;

  // Step 1 — Installed
  if (!s.installed) {
    setStep('installed', 'fail',
      'Tailscale is not installed. Install it to continue.',
      [
        { label: 'Download Tailscale', cls: 'btn-secondary', fn: () => api.openExternal('https://tailscale.com/download/windows') },
        { label: 'Install via winget', cls: 'btn-ghost',    fn: () => api.openExternal('https://tailscale.com/download/windows') },
      ]
    );
    setStep('login',   'waiting', 'Waiting for Tailscale…');
    setStep('https',   'waiting', 'Waiting for Tailscale…');
    setStep('funnel',  'waiting', 'Waiting for Tailscale…');
    return;
  }
  setStep('installed', 'ok', 'Tailscale is installed.');

  // Step 2 — Logged in
  if (!s.loggedIn) {
    setStep('login', 'fail',
      'Not logged in or not connected. Click Log In to open the Tailscale browser page.',
      [{ label: 'Log In to Tailscale', cls: 'btn-secondary', fn: handleLogin }]
    );
    setStep('https',  'waiting', 'Waiting for login…');
    setStep('funnel', 'waiting', 'Waiting for login…');
    return;
  }
  setStep('login', 'ok', `Connected as ${s.dnsName}`);

  // Step 3 — HTTPS + Funnel ACL
  if (s.httpsEnabled === false) {
    const actions = [{ label: 'Retry', cls: 'btn-secondary', fn: handleEnableFunnel }];
    if (_adminLink) {
      actions.unshift({
        label: 'Open Tailscale Admin Console',
        cls: 'btn-warn',
        fn: () => api.openExternal(_adminLink),
      });
    }
    setStep('https', 'fail',
      _adminLink
        ? 'HTTPS Certificates or Funnel ACL is not enabled.\n1. Click "Open Tailscale Admin Console".\n2. Enable HTTPS Certificates under DNS settings.\n3. Enable Funnel under Access Controls or Feature Previews.\n4. Click Retry.'
        : (s.lastError || 'Could not activate Funnel.'),
      actions
    );
    setStep('funnel', 'waiting', 'Waiting for HTTPS/Funnel approval…');
    return;
  }

  if (s.httpsEnabled === null) {
    setStep('https', 'pending', 'Activating Funnel…');
    setStep('funnel', 'waiting', 'Waiting…');
    return;
  }

  setStep('https', 'ok', 'HTTPS Certificates and Funnel ACL are active.');

  // Step 4 — Funnel mapping
  if (!s.funnelActive) {
    setStep('funnel', 'fail',
      'Funnel mapping could not be verified. Try clicking Retry.',
      [{ label: 'Retry', cls: 'btn-secondary', fn: handleEnableFunnel }]
    );
    return;
  }

  setStep('funnel', 'ok', `Funnel is active → ${s.publicUrl}`);

  // Show URL box
  showPublicUrl(s.publicUrl);

  // Enable Continue
  document.getElementById('btnContinue').disabled = false;
  stopPolling();
}

function showPublicUrl(url) {
  _publicUrl = url;
  const box = document.getElementById('urlBox');
  box.style.display = 'block';
  document.getElementById('publicUrlText').textContent = url || '';
  document.getElementById('healthUrl').textContent = (url || '') + '/health';
}

// ── Action handlers ──────────────────────────────────────────────────────────
async function handleLogin() {
  setStep('login', 'pending', 'Opening Tailscale login page…');
  await api.tailscaleLogin();
  // Poll will pick up the result
  startPolling();
}

async function handleEnableFunnel() {
  setStep('https', 'pending', 'Enabling Funnel…');
  setStep('funnel', 'pending', 'Enabling Funnel…');
  const result = await api.tailscaleEnableFunnel();
  if (result.ok && result.adminLink) {
    // Redundant — covered by next check() poll, but update immediately
    _adminLink = result.adminLink;
  }
  await runCheck();
}

// ── Polling ──────────────────────────────────────────────────────────────────
async function runCheck() {
  const result = await api.tailscaleCheck();
  if (result.ok) applyStatus(result);
}

function startPolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(runCheck, 3000);
}

function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

// ── Listen for push updates from main process ─────────────────────────────────
api.on('tailscale:update', (status) => {
  applyStatus(status);
});

// ── Buttons ──────────────────────────────────────────────────────────────────
document.getElementById('btnRetry').addEventListener('click', async () => {
  // Re-attempt funnel activation if we're past the login step
  const { ok, loggedIn } = await api.tailscaleCheck();
  if (ok && loggedIn) {
    await handleEnableFunnel();
  } else {
    await runCheck();
  }
});

document.getElementById('btnCopyUrl').addEventListener('click', () => {
  if (_publicUrl) navigator.clipboard.writeText(_publicUrl);
});

document.getElementById('btnBack').addEventListener('click', () => {
  api.openSetup();
});

document.getElementById('btnContinue').addEventListener('click', async () => {
  await api.startAgent();
  await api.openDashboard();
});

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  // Initial state: all steps pending
  ['installed', 'login', 'https', 'funnel'].forEach(id =>
    setStep(id, 'pending', 'Checking…')
  );

  await runCheck();

  // Auto-trigger funnel activation once logged in
  const status = await api.tailscaleCheck();
  if (status.ok && status.loggedIn && !status.funnelActive) {
    await handleEnableFunnel();
  }

  startPolling();
})();
