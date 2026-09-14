/**
 * src/ScenarioPanel.jsx
 *
 * Collapsible demo-control panel — calls orchestrator/edge-node endpoints
 * dynamically discovered at runtime.
 */

import { useState, useCallback } from 'react';
import { ORCHESTRATOR_URL, ORIGIN_URL } from './config';

// Helper to send JSON POST request
async function post(url, body = {}) {
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    return await res.json();
  } catch (err) {
    return { error: err.message };
  }
}

// Helper to get registered edges from orchestrator
async function getRegisteredEdges() {
  try {
    let res = await fetch(`${ORCHESTRATOR_URL}/api/orchestrator/edges`);
    if (!res.ok) res = await fetch(`${ORCHESTRATOR_URL}/nodes`);
    const data = await res.json();
    return data.edges || data.nodes || [];
  } catch (_) {
    return [];
  }
}

// ── Scenario definitions ───────────────────────────────────────────────────────
const SCENARIOS = [
  {
    id:    'good',
    label: '✅ Good Edge',
    color: 'emerald',
    desc:  'Edge=5ms · Origin=150ms · Baseline',
    run:   async () => {
      const edges = await getRegisteredEdges();
      await post(`${ORIGIN_URL}/set-delay`, { ms: 150 });
      for (const edge of edges) {
        if (edge.url) {
          await post(`${edge.url}/set-delay`, { ms: 5 });
          await post(`${edge.url}/restore`);
        }
      }
    },
  },
  {
    id:    'degraded',
    label: '🟡 Degraded Edge',
    color: 'amber',
    desc:  'Primary Edge=80ms congestion · Origin=150ms',
    run:   async () => {
      const edges = await getRegisteredEdges();
      await post(`${ORIGIN_URL}/set-delay`, { ms: 150 });
      if (edges.length > 0 && edges[0].url) {
        await post(`${edges[0].url}/set-delay`, { ms: 80 });
        await post(`${edges[0].url}/restore`);
      }
      if (edges.length > 1 && edges[1].url) {
        await post(`${edges[1].url}/set-delay`, { ms: 15 });
        await post(`${edges[1].url}/restore`);
      }
    },
  },
  {
    id:    'outage',
    label: '🔴 Edge Outage',
    color: 'rose',
    desc:  'Primary Edge=LINK DEAD · Trigger Failover',
    run:   async () => {
      const edges = await getRegisteredEdges();
      await post(`${ORIGIN_URL}/set-delay`, { ms: 150 });
      if (edges.length > 0 && edges[0].url) {
        await post(`${edges[0].url}/simulate-outage`);
      }
      if (edges.length > 1 && edges[1].url) {
        await post(`${edges[1].url}/set-delay`, { ms: 15 });
        await post(`${edges[1].url}/restore`);
      }
    },
  },
  {
    id:    'direct',
    label: '🔵 Direct Only',
    color: 'blue',
    desc:  'Origin=150ms · Edges bypassed (999ms)',
    run:   async () => {
      const edges = await getRegisteredEdges();
      await post(`${ORIGIN_URL}/set-delay`, { ms: 150 });
      for (const edge of edges) {
        if (edge.url) {
          await post(`${edge.url}/set-delay`, { ms: 999 });
          await post(`${edge.url}/restore`);
        }
      }
    },
  },
  {
    id:    'restore',
    label: '🔄 Restore All',
    color: 'slate',
    desc:  'Origin=0ms · All Edges=5ms · Reset',
    run:   async () => {
      const edges = await getRegisteredEdges();
      await post(`${ORIGIN_URL}/set-delay`, { ms: 0 });
      for (let i = 0; i < edges.length; i++) {
        const edge = edges[i];
        if (edge.url) {
          await post(`${edge.url}/set-delay`, { ms: i === 0 ? 5 : 15 });
          await post(`${edge.url}/restore`);
        }
      }
    },
  },
];

const COLOR_MAP = {
  emerald: { btn: 'text-zinc-100', badge: 'bg-zinc-900 text-zinc-400' },
  amber:   { btn: 'text-zinc-100', badge: 'bg-zinc-900 text-zinc-400' },
  rose:    { btn: 'text-zinc-100', badge: 'bg-zinc-900 text-zinc-400' },
  blue:    { btn: 'text-zinc-100', badge: 'bg-zinc-900 text-zinc-400' },
  slate:   { btn: 'text-zinc-100', badge: 'bg-zinc-900 text-zinc-400' },
};

export default function ScenarioPanel({ onScenarioRun }) {
  const [isOpen,       setIsOpen]       = useState(false);
  const [runningId,    setRunningId]    = useState(null);
  const [lastScenario, setLastScenario] = useState(null);
  const [statusMsg,    setStatusMsg]    = useState(null);

  const handleRun = useCallback(async (scenario) => {
    setRunningId(scenario.id);
    setStatusMsg(`Running ${scenario.label}…`);
    try {
      await scenario.run();
      setLastScenario(scenario.id);
      setStatusMsg(`Applied: ${scenario.label} (${scenario.desc})`);
      if (onScenarioRun) onScenarioRun(scenario.id);
    } catch (err) {
      setStatusMsg(`Error: ${err.message}`);
    } finally {
      setRunningId(null);
    }
  }, [onScenarioRun]);

  return (
    <div className="card p-3 rounded-xl border border-zinc-800 bg-zinc-900/90 shadow-md">
      {/* Header with expand toggle */}
      <div 
        className="flex items-center justify-between cursor-pointer select-none"
        onClick={() => setIsOpen(o => !o)}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm">⚡</span>
          <span className="text-xs font-bold font-mono tracking-wider text-zinc-200 uppercase">
            Fault-Injection Scenario Panel
          </span>
          {lastScenario && (
            <span className="text-[10px] font-mono text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-700">
              Active: {lastScenario}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-500 font-mono">
            {isOpen ? 'Collapse ▲' : 'Expand ▼'}
          </span>
        </div>
      </div>

      {/* Collapsible content */}
      {isOpen && (
        <div className="mt-3 pt-3 border-t border-zinc-800 flex flex-col gap-2">
          <p className="text-[11px] text-zinc-400 font-mono">
            Trigger live MEC & VNF network failure scenarios across registered nodes:
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
            {SCENARIOS.map(sc => {
              const isRunning = runningId === sc.id;
              const isCurrent = lastScenario === sc.id;
              const theme = COLOR_MAP[sc.color] || COLOR_MAP.slate;

              return (
                <button
                  key={sc.id}
                  onClick={() => handleRun(sc)}
                  disabled={!!runningId}
                  className={`p-2.5 rounded-lg border text-left flex flex-col justify-between transition-all duration-150 ${
                    isCurrent 
                      ? 'bg-zinc-800 border-zinc-500 shadow-sm' 
                      : 'bg-zinc-950/70 border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900'
                  } ${runningId ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  <div className="flex items-center justify-between gap-1 mb-1">
                    <span className={`text-xs font-bold font-mono ${theme.btn}`}>
                      {sc.label}
                    </span>
                    {isRunning && (
                      <span className="text-[10px] animate-spin">⏳</span>
                    )}
                  </div>
                  <span className="text-[10px] font-mono text-zinc-500 leading-tight">
                    {sc.desc}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Status line */}
          {statusMsg && (
            <div className="mt-1 p-1.5 rounded bg-zinc-950 border border-zinc-800/80 text-[10px] font-mono text-zinc-400 flex items-center justify-between">
              <span>{statusMsg}</span>
              <span className="text-zinc-600">Dynamic Orchestration</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
