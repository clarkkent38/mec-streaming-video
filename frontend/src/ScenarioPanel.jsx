/**
 * src/ScenarioPanel.jsx
 *
 * Collapsible demo-control panel — calls orchestrator/edge-node endpoints
 * directly from the browser. 
 */

import { useState, useCallback } from 'react';
import { ORCHESTRATOR_URL, ORIGIN_URL, EDGE1_URL, EDGE2_URL } from './config';

const URLS = {
  origin:       ORIGIN_URL,
  edge1:        EDGE1_URL,
  edge2:        EDGE2_URL,
  orchestrator: ORCHESTRATOR_URL,
};

// ── helpers ────────────────────────────────────────────────────────────────────

async function post(url, body = {}) {
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return res.json();
}

// ── Scenario definitions ───────────────────────────────────────────────────────

const SCENARIOS = [
  {
    id:    'good',
    label: '✅ Good Edge',
    color: 'emerald',
    desc:  'edge1=5ms · edge2=15ms · origin=150ms',
    run:   async () => {
      await post(`${URLS.origin}/set-delay`,  { ms: 150 });
      await post(`${URLS.edge1}/set-delay`,   { ms: 5   });
      await post(`${URLS.edge2}/set-delay`,   { ms: 15  });
      await post(`${URLS.edge1}/restore`);
      await post(`${URLS.edge2}/restore`);
    },
  },
  {
    id:    'degraded',
    label: '🟡 Degraded Edge',
    color: 'amber',
    desc:  'edge1=80ms · edge2=15ms · origin=150ms',
    run:   async () => {
      await post(`${URLS.origin}/set-delay`,  { ms: 150 });
      await post(`${URLS.edge1}/set-delay`,   { ms: 80  });
      await post(`${URLS.edge2}/set-delay`,   { ms: 15  });
      await post(`${URLS.edge1}/restore`);
      await post(`${URLS.edge2}/restore`);
    },
  },
  {
    id:    'outage',
    label: '🔴 Edge Outage',
    color: 'rose',
    desc:  'edge1=DOWN · edge2=15ms · origin=150ms',
    run:   async () => {
      await post(`${URLS.origin}/set-delay`,  { ms: 150 });
      await post(`${URLS.edge2}/set-delay`,   { ms: 15  });
      await post(`${URLS.edge2}/restore`);
      await post(`${URLS.edge1}/simulate-outage`);
    },
  },
  {
    id:    'direct',
    label: '🔵 Direct Only',
    color: 'blue',
    desc:  'origin=150ms · edges=999ms (bypassed)',
    run:   async () => {
      await post(`${URLS.origin}/set-delay`,  { ms: 150 });
      await post(`${URLS.edge1}/set-delay`,   { ms: 999 });
      await post(`${URLS.edge2}/set-delay`,   { ms: 999 });
      await post(`${URLS.edge1}/restore`);
      await post(`${URLS.edge2}/restore`);
    },
  },
  {
    id:    'restore',
    label: '🔄 Restore All',
    color: 'slate',
    desc:  'origin=0ms · edge1=5ms · edge2=15ms',
    run:   async () => {
      await post(`${URLS.origin}/set-delay`,  { ms: 0   });
      await post(`${URLS.edge1}/set-delay`,   { ms: 5   });
      await post(`${URLS.edge2}/set-delay`,   { ms: 15  });
      await post(`${URLS.edge1}/restore`);
      await post(`${URLS.edge2}/restore`);
    },
  },
];

const COLOR_MAP = {
  emerald: { btn: 'bg-emerald-600 hover:bg-emerald-500 text-white',     badge: 'bg-emerald-900/60 text-emerald-300' },
  amber:   { btn: 'bg-amber-600   hover:bg-amber-500   text-white',     badge: 'bg-amber-900/60   text-amber-300'   },
  rose:    { btn: 'bg-rose-600    hover:bg-rose-500    text-white',     badge: 'bg-rose-900/60    text-rose-300'    },
  blue:    { btn: 'bg-blue-600    hover:bg-blue-500    text-white',     badge: 'bg-blue-900/60    text-blue-300'    },
  slate:   { btn: 'bg-slate-600   hover:bg-slate-500   text-white',     badge: 'bg-slate-800      text-slate-300'   },
};

// ── Component ──────────────────────────────────────────────────────────────────

export default function ScenarioPanel({ onScenarioRun }) {
  const [open,       setOpen]       = useState(true);
  const [running,    setRunning]    = useState(null);   
  const [lastResult, setLastResult] = useState(null);   
  const [nodes,      setNodes]      = useState(null);   

  const fetchNodes = useCallback(async () => {
    try {
      const res  = await fetch(`${ORCHESTRATOR_URL}/nodes`);
      const data = await res.json();
      setNodes(data);
    } catch {
      setNodes(null);
    }
  }, []);

  const runScenario = useCallback(async (scenario) => {
    setRunning(scenario.id);
    setLastResult(null);
    try {
      await scenario.run();
      // Wait one health-check cycle so /nodes reflects the change
      await new Promise(r => setTimeout(r, 5500));
      await fetchNodes();
      setLastResult({ id: scenario.id, ok: true, message: `${scenario.label} applied ✓` });
      onScenarioRun?.(scenario.id);
    } catch (err) {
      setLastResult({ id: scenario.id, ok: false, message: `Error: ${err.message}` });
    } finally {
      setRunning(null);
    }
  }, [fetchNodes, onScenarioRun]);

  return (
    <div className="skeubrutal-panel rounded-xl mt-4">
      {/* Header / toggle */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/5 transition-colors rounded-t-xl"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-widest text-[#b8860b]">🎮 VNFM Demo Control Panel</span>
        </div>
        <span className="text-slate-500 text-xs font-mono">{open ? '▲ collapse' : '▼ expand'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4">
          {/* Scenario buttons (Skeubrutal styling) */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {SCENARIOS.map(s => {
              const colors = COLOR_MAP[s.color];
              const isRunning = running === s.id;
              return (
                <button
                  key={s.id}
                  disabled={running !== null}
                  onClick={() => runScenario(s)}
                  title={s.desc}
                  className={`
                    skeubrutal-button flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg text-[10px] font-semibold
                    transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed
                    ${colors.btn}
                  `}
                >
                  {isRunning ? (
                    <>
                      <span className="animate-spin text-sm">⟳</span>
                      <span>Running…</span>
                    </>
                  ) : (
                    <>
                      <span className="text-sm leading-none">{s.label.split(' ')[0]}</span>
                      <span>{s.label.split(' ').slice(1).join(' ')}</span>
                    </>
                  )}
                </button>
              );
            })}
          </div>

          {/* Descriptions */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {SCENARIOS.map(s => {
              const colors = COLOR_MAP[s.color];
              return (
                <div key={s.id} className={`text-[8px] px-1 py-1 border border-slate-700/50 shadow-inner rounded ${colors.badge} text-center leading-snug font-mono`}>
                  {s.desc}
                </div>
              );
            })}
          </div>

          {/* Last result */}
          {lastResult && (
            <div className={`text-[11px] font-mono px-3 py-2 rounded-lg border shadow-inner ${lastResult.ok ? 'bg-emerald-900/30 text-emerald-400 border-emerald-800' : 'bg-rose-900/30 text-rose-400 border-rose-800'}`}>
              {lastResult.message}
              {running === null && <span className="ml-2 opacity-60">— node status refreshed</span>}
            </div>
          )}

          {/* Live /nodes snapshot */}
          {nodes && (
            <div className="bg-black/30 shadow-[inset_2px_2px_8px_rgba(0,0,0,0.5)] border border-[#2a2a35] rounded-lg p-3 space-y-1 relative">
              <div className="text-[10px] font-bold uppercase tracking-widest text-[#b8860b] mb-2 flex justify-between">
                <span>Live Node Status</span>
                <span>{nodes.up}/{nodes.total} UP</span>
              </div>
              {nodes.nodes.map(n => (
                <div key={n.id} className="flex items-center justify-between text-[11px] font-mono mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px]">{n.status === 'UP' ? '🟢' : n.status === 'DOWN' ? '🔴' : '🟡'}</span>
                    <span className="text-slate-300">{n.id}</span>
                  </div>
                  <div className="flex gap-4 text-slate-400">
                    <span className="w-12 text-right">{n.delay_ms != null ? `${n.delay_ms}ms` : '—'}</span>
                    <span className={`w-12 text-right ${n.status === 'UP' ? 'text-emerald-400' : 'text-rose-400'}`}>{n.status}</span>
                  </div>
                </div>
              ))}
              <div className="text-[9px] text-slate-600 pt-2 border-t border-slate-800 mt-2 flex justify-between">
                <span>Last checked: {new Date(nodes.timestamp).toLocaleTimeString()}</span>
                <button
                  onClick={fetchNodes}
                  disabled={running !== null}
                  className="hover:text-slate-300 underline disabled:opacity-40 transition-colors"
                >
                  ↻ Refresh
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

