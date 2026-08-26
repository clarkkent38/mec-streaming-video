/**
 * lan-start.js — LAN-mode launcher for all backend services
 *
 * Detects local LAN IP, then spawns origin, edge1, edge2, orchestrator
 * all bound to 0.0.0.0 so phones on the same Wi-Fi can reach them.
 *
 * Usage:  node lan-start.js
 *
 * Do NOT use this as the default startup — it is an explicit opt-in.
 * For the safe localhost demo use the normal per-service npm scripts.
 */

'use strict';

const { spawn } = require('child_process');
const os   = require('path');
const osys = require('os');
const path = require('path');

// ── Detect LAN IP ─────────────────────────────────────────────────────────────

function getLanIp() {
  const nets = osys.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

const LAN_IP = getLanIp();
const ROOT   = path.join(__dirname);

console.log('\n╔══════════════════════════════════════════════════════════╗');
console.log('║  LAN Mode — all services bound to 0.0.0.0               ║');
console.log('╠══════════════════════════════════════════════════════════╣');
console.log(`║  Your LAN IP : ${LAN_IP.padEnd(41)}║`);
console.log('║                                                          ║');
console.log(`║  Frontend    : http://${LAN_IP}:5173               ║`);
console.log(`║  Origin      : http://${LAN_IP}:3000               ║`);
console.log(`║  Edge Node 1 : http://${LAN_IP}:4001               ║`);
console.log(`║  Edge Node 2 : http://${LAN_IP}:4002               ║`);
console.log(`║  Orchestrator: http://${LAN_IP}:5000               ║`);
console.log('╠══════════════════════════════════════════════════════════╣');
console.log('║  ⚠  Ensure Windows Firewall allows ports 3000,4001,     ║');
console.log('║     4002, 5000, 5173 for inbound connections.            ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

// ── Spawn helper ─────────────────────────────────────────────────────────────

function spawnService(label, cmd, args, cwd, env = {}) {
  const proc = spawn(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, BIND_HOST: '0.0.0.0', LAN_IP, ...env },
  });
  proc.on('exit', code => {
    if (code !== 0) console.error(`[${label}] exited with code ${code}`);
  });
  return proc;
}

// ── Start all services ────────────────────────────────────────────────────────

const procs = [
  spawnService('origin',       'node', ['server.js'], path.join(ROOT, 'origin-server'), {
    PORT: '3000', NODE_LABEL: 'origin', DELAY_MS: '0',
  }),
  spawnService('edge-node-1',  'node', ['server.js'], path.join(ROOT, 'edge-node'), {
    PORT: '4001', NODE_ID: 'edge-node-1', DELAY_MS: '5',
    ORIGIN_URL: `http://${LAN_IP}:3000`,
    AKAMAI_PROXY: 'true'
  }),
  spawnService('edge-node-2',  'node', ['server.js'], path.join(ROOT, 'edge-node'), {
    PORT: '4002', NODE_ID: 'edge-node-2', DELAY_MS: '15',
    ORIGIN_URL: `http://${LAN_IP}:3000`,
    AKAMAI_PROXY: 'true'
  }),
  spawnService('orchestrator', 'node', ['server.js'], path.join(ROOT, 'orchestrator'), {
    PORT: '5000',
    EDGE1_URL: `http://${LAN_IP}:4001`,
    EDGE2_URL: `http://${LAN_IP}:4002`,
    ORIGIN_URL: `http://${LAN_IP}:3000`,
  }),
  spawnService('frontend', 'npm', ['run', 'dev'], path.join(ROOT, 'frontend'), {
    VITE_LAN: 'true'
  }),
];

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\n[lan-start] Shutting down all services…');
  procs.forEach(p => p.kill());
  process.exit(0);
});
