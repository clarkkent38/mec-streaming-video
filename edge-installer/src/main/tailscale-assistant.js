'use strict';
/**
 * tailscale-assistant.js
 * Handles Tailscale CLI interactions. Designed to never spin forever —
 * after 20 s of CLI silence, it surfaces the manual admin console links.
 */

const { execFile, spawn } = require('child_process');
const configStore         = require('./config-store');
const log                 = require('./logger');

const TS_PATHS_WIN = [
  'tailscale.exe',
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
];

// ── Admin console links (always known, no need to parse CLI output) ──────────
const ADMIN_HTTPS_LINK  = 'https://login.tailscale.com/admin/dns';
const ADMIN_FUNNEL_LINK = 'https://login.tailscale.com/admin/acls/json';
const ADMIN_MACHINES    = 'https://login.tailscale.com/admin/machines';

// ── CLI runner ────────────────────────────────────────────────────────────────
function run(bin, args, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(((stderr || '').trim() || err.message)));
      } else {
        resolve({ stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
      }
    });
  });
}

async function findTailscaleBin() {
  for (const candidate of TS_PATHS_WIN) {
    try {
      await run(candidate, ['version'], 3000);
      return candidate;
    } catch (_) {}
  }
  return null;
}

// ── State ─────────────────────────────────────────────────────────────────────
let _bin         = null;
let _publicUrl   = null;
let _funnelOwned = false;

const _status = {
  installed:    false,
  loggedIn:     false,
  dnsName:      null,
  httpsEnabled: null,
  funnelActive: false,
  publicUrl:    null,
  adminLink:    null,
  adminLinkHttps:  ADMIN_HTTPS_LINK,
  adminLinkFunnel: ADMIN_FUNNEL_LINK,
  lastError:    null,
  funnelStuck:  false,   // true when CLI timed out — show manual steps
};

function broadcastStatus() {
  try {
    const { BrowserWindow } = require('electron');
    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) w.webContents.send('tailscale:update', { ..._status });
    });
  } catch (_) {}
}

// ── Step 1 ────────────────────────────────────────────────────────────────────
async function checkInstalled() {
  _bin = await findTailscaleBin();
  _status.installed = !!_bin;
  _status.lastError = _bin ? null : 'Tailscale is not installed.';
  return _status.installed;
}

// ── Step 2 ────────────────────────────────────────────────────────────────────
async function checkLoggedIn() {
  if (!_bin) return false;
  try {
    const { stdout } = await run(_bin, ['status', '--json'], 8000);
    const json     = JSON.parse(stdout);
    const running  = json.BackendState === 'Running';
    const rawDns   = json.Self && json.Self.DNSName ? json.Self.DNSName : null;
    const dnsName  = rawDns ? rawDns.replace(/\.$/, '') : null;
    _status.loggedIn  = running && !!dnsName;
    _status.dnsName   = dnsName;
    _status.lastError = _status.loggedIn ? null : 'Not connected. Run tailscale up.';
    return _status.loggedIn;
  } catch (err) {
    _status.loggedIn = false;
    _status.dnsName  = null;
    _status.lastError = `tailscale status failed: ${err.message}`;
    return false;
  }
}

// ── Funnel syntax detection ────────────────────────────────────────────────────
async function discoverFunnelSyntax() {
  if (!_bin) return 'newer';
  try {
    const { stdout, stderr } = await run(_bin, ['funnel', '--help'], 5000);
    const h = (stdout + '\n' + stderr).toLowerCase();
    if (h.includes('<port>')) return 'newer';
    if (h.includes('on|off') || h.includes('on/off')) return 'older';
    return 'newer';
  } catch (_) { return 'newer'; }
}

// ── Step 3+4: Enable Funnel with 20 s overall timeout ────────────────────────
async function enableFunnel() {
  if (!_bin)            throw new Error('Tailscale not installed.');
  if (!_status.dnsName) throw new Error('Tailscale not connected.');

  const cfg  = configStore.load();
  const port = cfg.agentPort || 5001;
  log.info('[tailscale] Attempting Funnel on port', port);

  // Reset stuck flag on each attempt
  _status.funnelStuck  = false;
  _status.httpsEnabled = null;
  _status.adminLink    = null;
  broadcastStatus();

  // ── Wrap entire funnel attempt in a 20 s timeout ──
  const result = await Promise.race([
    _attemptFunnel(port),
    new Promise(resolve =>
      setTimeout(() => resolve({ timedOut: true }), 20000)
    ),
  ]);

  if (result.timedOut) {
    // CLI hung or permission check failed silently — show manual steps
    _status.httpsEnabled = false;
    _status.funnelStuck  = true;
    _status.lastError    = (
      'Funnel activation timed out. This usually means HTTPS Certificates or ' +
      'Funnel is not enabled on your Tailscale account. ' +
      'Follow the steps below to enable them manually, then click Retry.'
    );
    broadcastStatus();
    return { ok: false, stuck: true, error: _status.lastError };
  }

  return result;
}

async function _attemptFunnel(port) {
  const syntax = await discoverFunnelSyntax();
  let stdout = '', stderr = '';

  try {
    if (syntax === 'newer') {
      // Modern: tailscale funnel --bg <port>
      ({ stdout, stderr } = await run(_bin, ['funnel', '--bg', String(port)], 15000));
    } else {
      // Legacy: tailscale serve then funnel on
      await run(_bin, ['serve', '--bg', `http://127.0.0.1:${port}`], 15000);
      ({ stdout, stderr } = await run(_bin, ['funnel', '--bg', 'on'], 10000));
    }
  } catch (err) {
    const combined = err.message + '\n' + (stderr || '');
    const link = extractAdminLink(combined);
    _status.httpsEnabled = false;
    _status.adminLink    = link || ADMIN_FUNNEL_LINK;
    _status.lastError    = 'Funnel not enabled on your account. See steps below.';
    broadcastStatus();
    return { ok: false, adminLink: _status.adminLink, error: _status.lastError };
  }

  const combined = stdout + '\n' + stderr;
  const adminLink = extractAdminLink(combined);
  if (adminLink) {
    _status.httpsEnabled = false;
    _status.adminLink    = adminLink;
    _status.lastError    = 'Admin approval needed. See steps below.';
    broadcastStatus();
    return { ok: false, adminLink, error: _status.lastError };
  }

  // Verify
  const verified = await verifyFunnelStatus(port);
  if (!verified) {
    _status.httpsEnabled = false;
    _status.funnelStuck  = true;
    _status.lastError    = 'Funnel command ran but port mapping not confirmed. Try Retry.';
    broadcastStatus();
    return { ok: false, error: _status.lastError };
  }

  _publicUrl           = `https://${_status.dnsName}`;
  _funnelOwned         = true;
  _status.funnelActive = true;
  _status.httpsEnabled = true;
  _status.publicUrl    = _publicUrl;
  _status.adminLink    = null;
  _status.funnelStuck  = false;
  _status.lastError    = null;

  configStore.save({ publicUrl: _publicUrl });
  try { require('./agent-runner').setPublicUrl(_publicUrl); } catch (_) {}

  log.info('[tailscale] Funnel active:', _publicUrl);
  broadcastStatus();
  return { ok: true, publicUrl: _publicUrl };
}

async function verifyFunnelStatus(port) {
  try {
    const { stdout } = await run(_bin, ['funnel', 'status'], 8000);
    return stdout.includes(String(port));
  } catch (err) {
    // If status command itself fails, also try checking serve status
    try {
      const { stdout } = await run(_bin, ['serve', 'status'], 8000);
      return stdout.includes(String(port));
    } catch (_) { return false; }
  }
}

function extractAdminLink(text) {
  const match = (text || '').match(/https:\/\/login\.tailscale\.com\/admin[^\s]*/);
  return match ? match[0] : null;
}

async function login() {
  if (!_bin) throw new Error('Tailscale not installed.');
  return new Promise((resolve, reject) => {
    const child = spawn(_bin, ['up'], { windowsHide: false, detached: false });
    child.on('error', reject);
    setTimeout(resolve, 1500);
  });
}

async function stopFunnel() {
  if (!_bin || !_funnelOwned) return;
  const cfg  = configStore.load();
  const port = cfg.agentPort || 5001;
  try {
    const syntax = await discoverFunnelSyntax();
    if (syntax === 'newer') {
      await run(_bin, ['funnel', '--bg', String(port), 'off'], 10000);
    } else {
      await run(_bin, ['funnel', '--bg', 'off'], 10000);
    }
    _funnelOwned         = false;
    _status.funnelActive = false;
    _status.publicUrl    = null;
    _publicUrl           = null;
    broadcastStatus();
  } catch (err) {
    log.warn('[tailscale] stopFunnel (non-fatal):', err.message);
  }
}

async function checkAll() {
  await checkInstalled();
  if (_status.installed) await checkLoggedIn();
  broadcastStatus();
  return { ..._status };
}

function getPublicUrl() { return _publicUrl; }

module.exports = { checkAll, login, enableFunnel, stopFunnel, getPublicUrl };
