/**
 * orchestrator/test-scenarios.js
 *
 * Named, reusable test harness — maps directly to paper evaluation scenarios.
 * Each function calls /set-delay / /simulate-outage / /restore on live servers.
 *
 * Usage:
 *   node test-scenarios.js                  ← runs ALL scenarios in sequence
 *   node test-scenarios.js good             ← runs scenarioGoodEdge only
 *   node test-scenarios.js degraded         ← runs scenarioDegradedEdge only
 *   node test-scenarios.js outage           ← runs scenarioEdgeOutage only
 *   node test-scenarios.js direct           ← runs scenarioDirectOnly only
 *   node test-scenarios.js restore          ← restores all nodes to clean state
 *
 * Requires: all four servers running (origin:3000, edge1:4001, edge2:4002, orch:5000)
 */

'use strict';

// ─── Endpoints ────────────────────────────────────────────────────────────────

const ORIGIN = 'http://localhost:3000';
const EDGE1  = 'http://localhost:4001';
const EDGE2  = 'http://localhost:4002';
const ORCH   = 'http://localhost:5000';

// ─── HTTP helpers (Node 18+ built-in fetch) ───────────────────────────────────

async function post(url, body = {}) {
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return res.json();
}

async function get(url) {
  const res = await fetch(url);
  return res.json();
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function separator(title) {
  const line = '═'.repeat(54);
  console.log(`\n╔${line}╗`);
  console.log(`║  ${title.padEnd(52)}║`);
  console.log(`╚${line}╝`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function printNodes(label) {
  console.log(`\n  📊 ${label}`);
  const data = await get(`${ORCH}/nodes`);
  data.nodes.forEach(n => {
    const status = n.status === 'UP' ? '✅' : n.status === 'DOWN' ? '❌' : '❓';
    console.log(`     ${status} ${n.id.padEnd(14)} delay=${String(n.delay_ms ?? '?').padStart(4)} ms   status=${n.status}`);
  });
}

async function printBestNode(label) {
  console.log(`\n  🏆 ${label}`);
  const data = await get(`${ORCH}/best-node`);
  if (data.error) {
    console.log(`     ⚠️  ${data.error}`);
    console.log(`     Fallback → ${data.fallback} (${data.origin})`);
  } else {
    console.log(`     Best node: ${data.best_node.id}  (${data.best_node.url})  delay=${data.best_node.delay_ms} ms`);
  }
  return data;
}

// ─── Scenario 1: Good Edge ────────────────────────────────────────────────────
// Paper §IV-A: normal operation — edge nodes have low latency

async function scenarioGoodEdge() {
  separator('SCENARIO 1 — Good Edge (normal operation)');
  console.log('  Paper mapping: VNFs at MEC with low RTT to UE');
  console.log('  edge-node-1 → 5 ms   edge-node-2 → 15 ms   origin → 150 ms\n');

  await post(`${ORIGIN}/set-delay`, { ms: 150 });
  await post(`${EDGE1}/set-delay`,  { ms: 5   });
  await post(`${EDGE2}/set-delay`,  { ms: 15  });
  // Ensure both nodes are up
  await post(`${EDGE1}/restore`);
  await post(`${EDGE2}/restore`);

  console.log('  ✓ Delays configured. Waiting 6 s for health-check cycle...');
  await sleep(6000);

  await printNodes('Node registry after config');
  await printBestNode('/best-node should return edge-node-1 (5 ms)');
}

// ─── Scenario 2: Degraded Edge ────────────────────────────────────────────────
// Paper §IV-B: edge node becomes congested (high delay)

async function scenarioDegradedEdge() {
  separator('SCENARIO 2 — Degraded Edge (edge-node-1 congested)');
  console.log('  Paper mapping: VNF under load → higher RTT');
  console.log('  edge-node-1 → 80 ms  edge-node-2 → 15 ms  origin → 150 ms\n');

  await post(`${ORIGIN}/set-delay`, { ms: 150 });
  await post(`${EDGE1}/set-delay`,  { ms: 80  });
  await post(`${EDGE2}/set-delay`,  { ms: 15  });
  await post(`${EDGE1}/restore`);
  await post(`${EDGE2}/restore`);

  console.log('  ✓ Delays configured. Waiting 6 s for health-check cycle...');
  await sleep(6000);

  await printNodes('Node registry after degradation');
  await printBestNode('/best-node should now return edge-node-2 (15 ms)');
}

// ─── Scenario 3: Edge Outage ──────────────────────────────────────────────────
// Paper §IV-C: VNF instance fails → orchestrator detects + reroutes

async function scenarioEdgeOutage() {
  separator('SCENARIO 3 — Edge Outage (edge-node-1 down)');
  console.log('  Paper mapping: VNF failure → VNFM detects + selects alternate VNF');
  console.log('  edge-node-1 → OUTAGE   edge-node-2 → 15 ms   origin → 150 ms\n');

  await post(`${ORIGIN}/set-delay`,      { ms: 150 });
  await post(`${EDGE1}/set-delay`,       { ms: 5   });
  await post(`${EDGE2}/set-delay`,       { ms: 15  });
  await post(`${EDGE2}/restore`);

  console.log('  ⚠️  Triggering outage on edge-node-1...');
  await post(`${EDGE1}/simulate-outage`);

  console.log('  ✓ Outage triggered. Waiting 6 s for health-check to detect...');
  await sleep(6000);

  await printNodes('Node registry — edge-node-1 should show DOWN');
  const result = await printBestNode('/best-node must fall back to edge-node-2');

  if (result?.best_node?.id === 'edge-node-2') {
    console.log('\n  ✅ PASS — Orchestrator correctly routed away from downed node!');
  } else {
    console.log('\n  ❌ FAIL — Best-node did not fall back correctly. Check health-check logs.');
  }

  // Restore node after test
  console.log('\n  🔄 Restoring edge-node-1...');
  await post(`${EDGE1}/restore`);
  await sleep(6000);
  await printNodes('Final state — all nodes should be UP again');
}

// ─── Scenario 4: Direct-to-Origin Baseline ───────────────────────────────────
// Paper §IV comparison: no edge, client hits origin directly (high latency)

async function scenarioDirectOnly() {
  separator('SCENARIO 4 — Direct Origin Baseline (no edge)');
  console.log('  Paper mapping: legacy CDN / no MEC — client hits core network');
  console.log('  origin → 150 ms (full delay, no edge node intermediary)\n');

  await post(`${ORIGIN}/set-delay`, { ms: 150 });
  // Put edge nodes at high delay or down to simulate "bypassed"
  await post(`${EDGE1}/set-delay`,  { ms: 999  });
  await post(`${EDGE2}/set-delay`,  { ms: 999  });
  await post(`${EDGE1}/restore`);
  await post(`${EDGE2}/restore`);

  console.log('  Edge nodes at 999 ms (effectively bypassed for comparison)');
  console.log(`  Direct origin URL: ${ORIGIN}/dash/manifest.mpd`);
  console.log('  ℹ️  Use this baseline latency in your report vs Scenario 1.');
}

// ─── Restore All ─────────────────────────────────────────────────────────────

async function restoreAll() {
  separator('RESTORE — Reset all nodes to clean defaults');
  await post(`${ORIGIN}/set-delay`, { ms: 0   });
  await post(`${EDGE1}/set-delay`,  { ms: 5   });
  await post(`${EDGE2}/set-delay`,  { ms: 15  });
  await post(`${EDGE1}/restore`);
  await post(`${EDGE2}/restore`);
  await sleep(6000);
  await printNodes('All nodes restored');
  console.log('\n  ✅ Clean state — ready for next scenario or demo.');
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

const SCENARIOS = {
  good:     scenarioGoodEdge,
  degraded: scenarioDegradedEdge,
  outage:   scenarioEdgeOutage,
  direct:   scenarioDirectOnly,
  restore:  restoreAll,
};

async function main() {
  const arg = process.argv[2];

  if (arg && SCENARIOS[arg]) {
    await SCENARIOS[arg]();
  } else {
    // Run all in sequence
    console.log('\n🚀 Running ALL test scenarios in sequence...');
    console.log('   Make sure origin:3000, edge1:4001, edge2:4002, orch:5000 are running.\n');

    await scenarioGoodEdge();
    await sleep(2000);
    await scenarioDegradedEdge();
    await sleep(2000);
    await scenarioEdgeOutage();
    await sleep(2000);
    await scenarioDirectOnly();
    await sleep(2000);
    await restoreAll();

    console.log('\n✅ All scenarios complete.\n');
  }
}

main().catch(err => {
  console.error('\n❌ Scenario runner error:', err.message);
  console.error('   Are all four servers running? Check with: curl http://localhost:5000/nodes\n');
  process.exit(1);
});
