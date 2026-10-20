'use strict';
/**
 * setup.js — Setup window renderer
 * Talks to main process only through window.edgenest (contextBridge).
 * Validates every field inline; persists on Save.
 */

const api = window.edgenest;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const form           = document.getElementById('setupForm');
const nodeLabelEl    = document.getElementById('nodeLabel');
const orchUrlEl      = document.getElementById('orchestratorUrl');
const originUrlEl    = document.getElementById('originUrl');
const agentPortEl    = document.getElementById('agentPort');
const dashPortEl     = document.getElementById('dashboardPort');
const delayMsEl      = document.getElementById('delayMs');
const startWithWinEl = document.getElementById('startWithWindows');
const statusBar      = document.getElementById('statusBar');

// ── Load saved config ─────────────────────────────────────────────────────────
async function initForm() {
  const { config }   = await api.loadConfig();
  const { enabled }  = await api.getAutostart();
  const hostname     = window.navigator.platform.includes('Win')
    ? (navigator.userAgent.match(/Windows NT/) ? (await getHostname()) : 'PC')
    : 'PC';

  nodeLabelEl.value    = config.nodeLabel        || `${hostname}-Edge`;
  orchUrlEl.value      = config.orchestratorUrl  || '';
  originUrlEl.value    = config.originUrl        || '';
  agentPortEl.value    = config.agentPort        || 5001;
  dashPortEl.value     = config.dashboardPort    || 5002;
  delayMsEl.value      = config.delayMs          != null ? config.delayMs : 0;
  startWithWinEl.checked = enabled;

  // Set the mode radio
  const modeRadios = form.querySelectorAll('input[name="mode"]');
  modeRadios.forEach(r => { r.checked = r.value === (config.mode || 'public'); });

  setStatus('Config loaded.');
}

async function getHostname() {
  // Render process cannot call os.hostname() — use a safe fallback
  try { return 'PC'; } catch (_) { return 'PC'; }
}

// ── Inline validation ─────────────────────────────────────────────────────────
const validators = {
  nodeLabel: (v) => {
    if (!v) return 'Node name is required.';
    if (!/^[a-zA-Z0-9-]{1,40}$/.test(v)) return 'Only letters, digits and dashes (max 40 chars).';
    return null;
  },
  orchestratorUrl: (v) => {
    if (!v) return 'Orchestrator URL is required.';
    try { new URL(v); return null; } catch (_) { return 'Enter a valid URL (e.g. https://…).'; }
  },
  originUrl: (v) => {
    if (!v) return 'Origin URL is required.';
    try { new URL(v); return null; } catch (_) { return 'Enter a valid URL (e.g. https://…).'; }
  },
  agentPort: (v) => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 1024 || n > 65535) return 'Port must be between 1024 and 65535.';
    return null;
  },
  dashboardPort: (v) => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 1024 || n > 65535) return 'Port must be between 1024 and 65535.';
    return null;
  },
};

function showError(id, msg) {
  const el = document.getElementById(`err-${id}`);
  const input = document.getElementById(id);
  if (el) el.textContent = msg || '';
  if (input) {
    if (msg) { input.classList.add('invalid'); input.classList.remove('valid'); }
    else      { input.classList.remove('invalid'); input.classList.add('valid'); }
  }
}

function validateField(id, value) {
  const fn = validators[id];
  if (!fn) return null;
  const err = fn(value);
  showError(id, err);
  return err;
}

// Attach live validation to all text/url inputs
['nodeLabel', 'orchestratorUrl', 'originUrl', 'agentPort', 'dashboardPort'].forEach(id => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('input', () => validateField(id, el.value.trim()));
    el.addEventListener('blur',  () => validateField(id, el.value.trim()));
  }
});

function validateAll() {
  const errors = [];
  ['nodeLabel', 'orchestratorUrl', 'originUrl', 'agentPort', 'dashboardPort'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      const err = validateField(id, el.value.trim());
      if (err) errors.push(err);
    }
  });
  // Port conflict check
  const ap = parseInt(agentPortEl.value, 10);
  const dp = parseInt(dashPortEl.value, 10);
  if (!isNaN(ap) && !isNaN(dp) && ap === dp) {
    showError('dashboardPort', 'Dashboard port must differ from agent port.');
    errors.push('Port conflict.');
  }
  return errors;
}

// ── Connection test buttons ───────────────────────────────────────────────────
function setTestResult(elId, state, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.className   = `test-result ${state}`;
}

document.getElementById('testOrch').addEventListener('click', async () => {
  const url = orchUrlEl.value.trim();
  if (validateField('orchestratorUrl', url)) return;
  const btn = document.getElementById('testOrch');
  btn.disabled = true;
  setTestResult('res-orch', 'pending', '⏳ Testing… (may take up to 90 s to wake)');
  const { ok, reachable, latencyMs, error } = await api.testOrchestrator(url);
  btn.disabled = false;
  if (ok && reachable) {
    setTestResult('res-orch', 'ok', `✓ Reachable — ${latencyMs} ms`);
  } else {
    setTestResult('res-orch', 'fail', `✗ ${error || 'Unreachable'} — Check the URL and try again.`);
  }
});

document.getElementById('testOrigin').addEventListener('click', async () => {
  const url = originUrlEl.value.trim();
  if (validateField('originUrl', url)) return;
  const btn = document.getElementById('testOrigin');
  btn.disabled = true;
  setTestResult('res-origin', 'pending', '⏳ Testing…');
  const { ok, reachable, latencyMs, error } = await api.testOrigin(url);
  btn.disabled = false;
  if (ok && reachable) {
    setTestResult('res-origin', 'ok', `✓ Reachable — ${latencyMs} ms`);
  } else {
    setTestResult('res-origin', 'fail', `✗ ${error || 'Unreachable'} — Check the URL and try again.`);
  }
});

document.getElementById('checkPort').addEventListener('click', async () => {
  const port = parseInt(agentPortEl.value, 10);
  if (validateField('agentPort', String(port))) return;
  const btn = document.getElementById('checkPort');
  btn.disabled = true;
  setTestResult('res-port', 'pending', '⏳ Checking…');
  const { ok, free, suggestion } = await api.testPort(port);
  btn.disabled = false;
  if (ok && free) {
    setTestResult('res-port', 'ok', `✓ Port ${port} is free.`);
  } else {
    setTestResult('res-port', 'fail', `✗ Port ${port} is in use. Try ${suggestion}.`);
    agentPortEl.value = suggestion;
    validateField('agentPort', String(suggestion));
    setTestResult('res-port', 'ok', `Port changed to ${suggestion}.`);
  }
});

// ── Restore defaults ──────────────────────────────────────────────────────────
document.getElementById('btnRestoreDefaults').addEventListener('click', async () => {
  const { defaults } = await api.loadDefaults();
  orchUrlEl.value  = defaults.orchestratorUrl;
  originUrlEl.value = defaults.originUrl;
  agentPortEl.value = defaults.agentPort;
  dashPortEl.value  = defaults.dashboardPort;
  delayMsEl.value   = defaults.delayMs;
  // Reset validation state
  ['orchestratorUrl', 'originUrl', 'agentPort', 'dashboardPort'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.classList.remove('invalid', 'valid'); }
    showError(id, '');
  });
  setStatus('Defaults restored. Click Save to apply.');
});

// ── Save ──────────────────────────────────────────────────────────────────────
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errors = validateAll();
  if (errors.length) {
    setStatus('Please fix the errors above before saving.');
    return;
  }

  const mode = form.querySelector('input[name="mode"]:checked')?.value || 'public';
  const updates = {
    nodeLabel:       nodeLabelEl.value.trim(),
    orchestratorUrl: orchUrlEl.value.trim(),
    originUrl:       originUrlEl.value.trim(),
    agentPort:       parseInt(agentPortEl.value, 10),
    dashboardPort:   parseInt(dashPortEl.value, 10),
    delayMs:         parseInt(delayMsEl.value, 10) || 0,
    mode,
  };

  const { ok, error } = await api.saveConfig(updates);
  if (!ok) { setStatus(`Save failed: ${error}`); return; }

  await api.setAutostart(startWithWinEl.checked);

  setStatus('✓ Saved.');

  // Navigate: if public mode, open Tailscale assistant; else open dashboard
  if (mode === 'public') {
    await api.openTailscale();
  } else {
    await api.openDashboard();
  }
});

// ── Status bar helper ─────────────────────────────────────────────────────────
function setStatus(msg) {
  statusBar.textContent = msg;
}

// ── Init ──────────────────────────────────────────────────────────────────────
initForm();
