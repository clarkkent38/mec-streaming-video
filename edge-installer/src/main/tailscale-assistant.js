'use strict';
/**
 * tailscale-assistant.js
 *
 * Handles all Tailscale CLI interactions from the main process.
 * Never hard-codes one CLI syntax — reads `tailscale funnel --help` to
 * discover the form that works on the installed version.
 *
 * Checklist steps (re-evaluated on demand and on a 3 s poll):
 *   1. Tailscale CLI found on PATH or in default install dirs
 *   2. Logged in and connected (BackendState === 'Running', own DNS name present)
 *   3. HTTPS certificates enabled + Funnel ACL approved
 *      (attempt funnel; if CLI prints an admin-console link, surface it)
 *   4. Funnel mapping active for our port
 *      (verify with `tailscale funnel status` after enabling)
 *
 * Public URL = https://<dns-name>  (no port suffix — Funnel maps 443→port)
 */

const { execFile, spawn } = require('child_process');
const path                = require('path');
const configStore         = require('./config-store');
const log                 = require('./logger');

// Well-known install locations for Tailscale on Windows
const TS_PATHS_WIN = [
  'tailscale.exe',                                    // already on PATH
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(bin, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        // Include stderr in the error message for better diagnostics
        const detail = (stderr || '').trim() || err.message;
        reject(new Error(detail));
      } else {
        resolve({ stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
      }
    });
  });
}

/** Try each candidate path; return the first that responds to `tailscale version`. */
async function findTailscaleBin() {
  for (const candidate of TS_PATHS_WIN) {
    try {
      await run(candidate, ['version'], 3000);
      return candidate;
    } catch (_) { /* try next */ }
  }
  return null;
}

// ── State ────────────────────────────────────────────────────────────────────

let _bin         = null;   // resolved path to tailscale.exe
let _publicUrl   = null;   // https://<dns-name>
let _funnelOwned = false;  // true if WE created the current funnel mapping

const _status = {
  installed:     false,
  loggedIn:      false,
  dnsName:       null,
  httpsEnabled:  null,   // null = unknown, true/false after attempt
  funnelActive:  false,
  publicUrl:     null,
  adminLink:     null,   // set if CLI prints an admin console link
  lastError:     null,
};

// Broadcast status updates to all renderer windows
function broadcastStatus() {
  try {
    const { BrowserWindow } = require('electron');
    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) w.webContents.send('tailscale:update', { ..._status });
    });
  } catch (_) {}
}

// ── Step 1: Is Tailscale installed? ─────────────────────────────────────────

async function checkInstalled() {
  _bin = await findTailscaleBin();
  _status.installed = !!_bin;
  _status.lastError = _bin ? null : (
    'Tailscale is not installed. Install it from https://tailscale.com/download/windows ' +
    'or run: winget install Tailscale.Tailscale'
  );
  return _status.installed;
}

// ── Step 2: Is Tailscale logged in and connected? ───────────────────────────

async function checkLoggedIn() {
  if (!_bin) return false;
  try {
    const { stdout } = await run(_bin, ['status', '--json'], 8000);
    const json = JSON.parse(stdout);

    // BackendState values: 'Running', 'NeedsLogin', 'Stopped', 'NoState', 'Starting'
    const running = json.BackendState === 'Running';

    // Own DNS name is in Self.DNSName (may have a trailing dot — strip it)
    const rawDns = json.Self && json.Self.DNSName ? json.Self.DNSName : null;
    const dnsName = rawDns ? rawDns.replace(/\.$/, '') : null;

    _status.loggedIn  = running && !!dnsName;
    _status.dnsName   = dnsName;
    _status.lastError = _status.loggedIn ? null : 'Not logged in or not connected to Tailscale.';
    return _status.loggedIn;
  } catch (err) {
    _status.loggedIn  = false;
    _status.dnsName   = null;
    _status.lastError = `tailscale status failed: ${err.message}`;
    return false;
  }
}

// ── Step 3 + 4: Enable Funnel (version-aware syntax) ─────────────────────────
//
// Tailscale CLI syntax has changed across versions:
//   Older: tailscale serve --bg http://127.0.0.1:<port>  +  tailscale funnel --bg on
//   Newer: tailscale funnel --bg <port>
//
// Strategy: read `tailscale funnel --help`, look for the form that contains
// the word "port" as a positional arg (newer) vs "on" (older); try both if needed.

async function discoverFunnelSyntax() {
  if (!_bin) throw new Error('Tailscale not installed.');
  try {
    const { stdout, stderr } = await run(_bin, ['funnel', '--help'], 5000);
    const helpText = (stdout + '\n' + stderr).toLowerCase();
    // Newer versions: "tailscale funnel [--bg] <port>"
    if (helpText.includes('<port>')) return 'newer';
    // Older versions: "tailscale funnel [--bg] on|off"
    if (helpText.includes('on|off') || helpText.includes('on/off')) return 'older';
    return 'newer'; // unknown — assume newer
  } catch (_) {
    return 'newer';   // assume newer if help fails
  }
}

async function enableFunnelNewer(port) {
  // tailscale funnel --bg <port>
  const { stdout, stderr } = await run(_bin, ['funnel', '--bg', String(port)], 15000);
  return { stdout, stderr };
}

async function enableServeThenFunnel(port) {
  // Step A: serve local port over HTTPS
  await run(_bin, ['serve', '--bg', `http://127.0.0.1:${port}`], 15000);
  // Step B: expose to internet
  const { stdout, stderr } = await run(_bin, ['funnel', '--bg', 'on'], 10000);
  return { stdout, stderr };
}

/**
 * Try to enable Funnel. Returns { ok, publicUrl, adminLink, error }.
 * If CLI prints a Tailscale admin console URL, it means HTTPS certs or ACL
 * is not yet enabled — we surface that link to the user.
 */
async function enableFunnel() {
  if (!_bin)            throw new Error('Tailscale is not installed.');
  if (!_status.dnsName) throw new Error('Tailscale is not connected. Complete step 2 first.');

  const cfg  = configStore.load();
  const port = cfg.agentPort || 5001;

  log.info('[tailscale] Enabling Funnel on port', port);

  const syntax = await discoverFunnelSyntax();
  let stdout = '', stderr = '';

  try {
    if (syntax === 'newer') {
      ({ stdout, stderr } = await enableFunnelNewer(port));
    } else {
      ({ stdout, stderr } = await enableServeThenFunnel(port));
    }
  } catch (err) {
    const combined = err.message + '\n' + stderr;
    const adminLink = extractAdminLink(combined);
    if (adminLink) {
      _status.adminLink = adminLink;
      _status.httpsEnabled = false;
      _status.lastError = (
        'HTTPS Certificates or Funnel is not enabled on your Tailscale account.\n' +
        'Open the admin console link, enable both settings, then click Retry.'
      );
      broadcastStatus();
      return { ok: false, adminLink, error: _status.lastError };
    }
    _status.lastError = `Funnel activation failed: ${err.message}`;
    broadcastStatus();
    return { ok: false, error: _status.lastError };
  }

  const combined = stdout + '\n' + stderr;
  const adminLink = extractAdminLink(combined);
  if (adminLink) {
    _status.adminLink = adminLink;
    _status.httpsEnabled = false;
    _status.lastError = (
      'HTTPS Certificates or Funnel ACL is not yet enabled.\n' +
      'Open the admin console link, enable the settings, then click Retry.'
    );
    broadcastStatus();
    return { ok: false, adminLink, error: _status.lastError };
  }

  // Verify with `tailscale funnel status`
  const verified = await verifyFunnelStatus(port);
  if (!verified) {
    _status.lastError = (
      'Funnel was not confirmed active by `tailscale funnel status`.\n' +
      'Wait a few seconds and click Retry, or restart Tailscale.'
    );
    broadcastStatus();
    return { ok: false, error: _status.lastError };
  }

  _publicUrl             = `https://${_status.dnsName}`;
  _funnelOwned           = true;
  _status.funnelActive   = true;
  _status.httpsEnabled   = true;
  _status.publicUrl      = _publicUrl;
  _status.adminLink      = null;
  _status.lastError      = null;

  // Persist and notify agent runner
  configStore.save({ publicUrl: _publicUrl });
  try {
    const agentRunner = require('./agent-runner');
    agentRunner.setPublicUrl(_publicUrl);
  } catch (_) {}

  log.info('[tailscale] Funnel active. Public URL:', _publicUrl);
  broadcastStatus();
  return { ok: true, publicUrl: _publicUrl };
}

/** Returns true if `tailscale funnel status` shows our port mapping. */
async function verifyFunnelStatus(port) {
  try {
    const { stdout } = await run(_bin, ['funnel', 'status'], 8000);
    // The output contains lines like:
    //   https://<name> (Funnel on)
    //     |-- / proxy http://127.0.0.1:5001
    // We just need to see the port number mentioned
    return stdout.includes(String(port));
  } catch (err) {
    log.warn('[tailscale] funnel status check failed:', err.message);
    return false;
  }
}

/** Extract an admin console link from CLI output if present. */
function extractAdminLink(text) {
  const match = text.match(/https:\/\/login\.tailscale\.com\/admin[^\s]*/);
  return match ? match[0] : null;
}

// ── Step 2b: Login ──────────────────────────────────────────────────────────

async function login() {
  if (!_bin) throw new Error('Tailscale is not installed.');
  // `tailscale up` opens the browser for auth; we fire-and-forget
  // (the poll loop will detect when it succeeds)
  return new Promise((resolve, reject) => {
    const child = spawn(_bin, ['up'], { windowsHide: true, detached: false });
    child.on('error', reject);
    // Give it a moment to launch the browser
    setTimeout(resolve, 1500);
  });
}

// ── Stop Funnel (only the mapping WE created) ────────────────────────────────

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
    log.info('[tailscale] Funnel stopped.');
    broadcastStatus();
  } catch (err) {
    log.warn('[tailscale] stopFunnel error (non-fatal):', err.message);
  }
}

// ── Full checklist ───────────────────────────────────────────────────────────

async function checkAll() {
  await checkInstalled();
  if (_status.installed) await checkLoggedIn();
  broadcastStatus();
  return { ..._status };
}

function getPublicUrl() {
  return _publicUrl;
}

module.exports = { checkAll, login, enableFunnel, stopFunnel, getPublicUrl };
