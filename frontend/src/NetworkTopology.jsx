import React, { useState, useEffect } from 'react';
import { ORCHESTRATOR_URL } from './config';

const COLORS = {
  active:   { border: '#3b82f6', bg: 'rgba(59, 130, 246, 0.12)', text: '#60a5fa', glow: '#3b82f6' }, // blue
  inactive: { border: '#27272a', bg: '#18181b', text: '#71717a', glow: 'transparent' }, // zinc
  failed:   { border: '#ef4444', bg: 'rgba(239, 68, 68, 0.12)', text: '#f87171', glow: '#ef4444' }, // red
  degraded: { border: '#eab308', bg: 'rgba(234, 179, 8, 0.12)', text: '#fde047', glow: '#eab308' }, // yellow
  edgeActive: { border: '#10b981', bg: 'rgba(16, 185, 129, 0.12)', text: '#34d399', glow: '#10b981' } // emerald
};

export default function NetworkTopology({ isEdgeMode, activeNodeId }) {
  const [edges, setEdges] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);

  useEffect(() => {
    let mounted = true;
    const fetchEdges = async () => {
      try {
        let res = await fetch(`${ORCHESTRATOR_URL}/api/orchestrator/edges`);
        if (!res.ok) {
          res = await fetch(`${ORCHESTRATOR_URL}/nodes`);
        }
        const data = await res.json();
        const edgeList = data.edges || data.nodes || [];
        if (mounted) {
          setEdges(edgeList);
          setLastUpdated(new Date().toLocaleTimeString());
        }
      } catch (e) {
        if (mounted) {
          // If orchestrator is unreachable, fallback to empty list
          setEdges([]);
        }
      }
    };

    fetchEdges();
    const intervalId = setInterval(fetchEdges, 2500);
    return () => { mounted = false; clearInterval(intervalId); };
  }, []);

  const originActive = !isEdgeMode || activeNodeId === 'origin' || edges.length === 0;

  // Compute dynamic SVG dimensions based on number of registered edges
  const edgeCount = edges.length;
  const nodeHeight = 58;
  const gap = 16;
  const minSvgHeight = 270;
  const requiredEdgeHeight = Math.max(minSvgHeight, (edgeCount * (nodeHeight + gap)) + 40);
  const svgHeight = Math.max(minSvgHeight, requiredEdgeHeight);

  // SVG Wire component
  const Wire = ({ d, active, dead, color = '#10b981' }) => {
    const stroke = dead ? '#ef4444' : (active ? color : '#3f3f46');
    return (
      <g>
        <path d={d} fill="none" stroke={stroke} strokeWidth={2} opacity={dead ? 0.3 : 0.4} strokeLinecap="round" />
        <path
          d={d}
          fill="none"
          stroke={active ? color : stroke}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={active ? '6 6' : undefined}
          opacity={active ? 1 : (dead ? 0 : 0.15)}
        >
          {active && <animate attributeName="strokeDashoffset" from="12" to="0" dur="0.6s" repeatCount="indefinite" />}
        </path>
      </g>
    );
  };

  // Node box component
  const NodeBox = ({ x, y, w = 170, h = 58, title, subtitle, state = 'inactive', pill = null, isOnline = true }) => {
    const c = COLORS[state] || COLORS.inactive;
    return (
      <g>
        <rect
          x={x} y={y} width={w} height={h} rx={8}
          fill={c.bg} stroke={c.border} strokeWidth={1.5}
        />
        {/* Title */}
        <text
          x={x + 14} y={y + 22}
          style={{ fontSize: 12, fontWeight: 700, fill: c.text, fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.04em' }}
        >
          {title.length > 18 ? `${title.slice(0, 16)}…` : title}
        </text>

        {/* Subtitle / Latency */}
        <text
          x={x + 14} y={y + 42}
          style={{ fontSize: 10, fill: c.text, opacity: 0.85, fontFamily: 'monospace' }}
        >
          {subtitle}
        </text>

        {/* Status indicator dot */}
        {pill && (
          <text
            x={x + w - 12} y={y + 22} textAnchor="end"
            style={{ fontSize: 9, fontWeight: 700, fill: c.text, fontFamily: 'monospace' }}
          >
            {pill}
          </text>
        )}

        {state !== 'inactive' && (
          <circle cx={x + w - 10} cy={y + 38} r={4} fill={c.glow} opacity={0.9}>
            <animate attributeName="opacity" values="0.9;0.3;0.9" dur="2s" repeatCount="indefinite" />
          </circle>
        )}
      </g>
    );
  };

  return (
    <div style={{
      width: '100%',
      minHeight: 270,
      background: '#09090b',
      border: '1px solid #27272a',
      borderRadius: 10,
      overflow: 'hidden',
      position: 'relative',
      boxShadow: '0 4px 20px rgba(0,0,0,0.5)'
    }}>
      {/* Topology Header bar */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '8px 14px',
        borderBottom: '1px solid #18181b',
        background: '#121214',
        fontSize: 11,
        fontFamily: 'monospace'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#10b981' }} />
          <span style={{ fontWeight: 700, color: '#f4f4f5', letterSpacing: '0.05em' }}>
            DYNAMIC NETWORK TOPOLOGY
          </span>
          <span style={{ background: '#27272a', color: '#a1a1aa', padding: '1px 6px', borderRadius: 4, fontSize: 10 }}>
            {edgeCount} Edge Node{edgeCount === 1 ? '' : 's'} Registered
          </span>
        </div>
        <div style={{ color: '#71717a', fontSize: 10 }}>
          {lastUpdated ? `Sync: ${lastUpdated}` : 'Connecting to Orchestrator…'}
        </div>
      </div>

      {/* Grid background */}
      <div style={{
        position: 'absolute', inset: '34px 0 0 0',
        backgroundImage: 'linear-gradient(#18181b 1px,transparent 1px),linear-gradient(90deg,#18181b 1px,transparent 1px)',
        backgroundSize: '20px 20px',
      }} />

      <svg viewBox={`0 0 820 ${svgHeight}`} width="100%" height={svgHeight} style={{ position: 'relative', zIndex: 1, marginTop: 4 }}>
        
        {/* ── 1. Origin Server (Left Column) ── */}
        <NodeBox
          x={20}
          y={svgHeight / 2 - 32}
          w={170}
          h={64}
          title="Origin Server"
          subtitle="Cloud Baseline ~150ms"
          state={originActive ? 'active' : 'inactive'}
          pill={originActive ? 'ACTIVE' : 'IDLE'}
        />

        {/* ── 2. Orchestrator VNFM Controller (Center Top) ── */}
        <NodeBox
          x={320}
          y={20}
          w={180}
          h={60}
          title="VNFM Controller"
          subtitle={isEdgeMode ? 'Entropy Routing ON' : 'Direct Cloud Mode'}
          state={isEdgeMode ? 'active' : 'inactive'}
          pill=":5000"
        />

        {/* ── 3. Client / TV Player Box (Center Bottom) ── */}
        <g>
          <rect
            x={320} y={svgHeight - 84} width={180} height={64} rx={8}
            fill="#18181b" stroke="#52525b" strokeWidth={1.5}
          />
          <text
            x={410} y={svgHeight - 58} textAnchor="middle"
            style={{ fontSize: 13, fontWeight: 700, fill: '#fafafa', fontFamily: 'monospace', letterSpacing: '0.05em' }}
          >
            CLIENT / TV
          </text>
          <text
            x={410} y={svgHeight - 38} textAnchor="middle"
            style={{ fontSize: 11, fill: originActive || isEdgeMode ? '#34d399' : '#a1a1aa', fontFamily: 'monospace', fontWeight: 600 }}
          >
            {originActive ? '▶ STREAMING DIRECT' : (isEdgeMode ? '▶ MEC ACCELERATED' : '⏸ IDLE')}
          </text>
        </g>

        {/* Wire: Origin -> Client */}
        <Wire
          d={`M 190 ${svgHeight / 2} L 255 ${svgHeight / 2} L 255 ${svgHeight - 52} L 320 ${svgHeight - 52}`}
          active={originActive}
          dead={!originActive}
          color="#3b82f6"
        />

        {/* ── 4. Dynamic Registered Edge Nodes (Right Column) ── */}
        {edgeCount === 0 ? (
          /* Zero Edges Registered Empty State */
          <g>
            <rect
              x={580} y={svgHeight / 2 - 40} width={220} height={80} rx={8}
              fill="rgba(24, 24, 27, 0.9)" stroke="#3f3f46" strokeWidth={1.5} strokeDasharray="4 4"
            />
            <text
              x={690} y={svgHeight / 2 - 14} textAnchor="middle"
              style={{ fontSize: 11, fontWeight: 700, fill: '#f59e0b', fontFamily: 'monospace' }}
            >
              ⚠ NO EDGE NODES ONLINE
            </text>
            <text
              x={690} y={svgHeight / 2 + 8} textAnchor="middle"
              style={{ fontSize: 9.5, fill: '#a1a1aa', fontFamily: 'monospace' }}
            >
              Run pc-edge-agent on your PC
            </text>
            <text
              x={690} y={svgHeight / 2 + 24} textAnchor="middle"
              style={{ fontSize: 9, fill: '#71717a', fontFamily: 'monospace' }}
            >
              (Direct Origin active fallback)
            </text>
          </g>
        ) : (
          edges.map((edge, idx) => {
            const edgeId = edge.edgeId || edge.id;
            const edgeY = 20 + idx * (nodeHeight + gap);
            const isOnline = edge.status === 'UP' || edge.status === 'online' || edge.edgeStatus === 'online';
            const isThisActive = isEdgeMode && (activeNodeId === edgeId || activeNodeId === edge.id);
            const isDegraded = isOnline && (
              (edge.measuredLatencyMs && edge.measuredLatencyMs > 60) ||
              (edge.delay_ms && edge.delay_ms > 60)
            );

            let nodeState = 'inactive';
            if (!isOnline) {
              nodeState = 'failed';
            } else if (isThisActive) {
              nodeState = isDegraded ? 'degraded' : 'edgeActive';
            } else if (isDegraded) {
              nodeState = 'degraded';
            }

            // Real measured latency display
            const latencyStr = edge.measuredLatencyMs != null
              ? `${edge.measuredLatencyMs}ms RTT`
              : (edge.delay_ms != null ? `${edge.delay_ms}ms (sim)` : '— ms');

            const subtitle = !isOnline
              ? '✕ LINK DEAD / OFFLINE'
              : (isDegraded ? `DEGRADED · ${latencyStr}` : `ONLINE · ${latencyStr}`);

            // Color themes for different dynamic edges
            const edgeColors = ['#10b981', '#a855f7', '#06b6d4', '#f59e0b', '#ec4899'];
            const wireColor = edgeColors[idx % edgeColors.length];

            return (
              <g key={edgeId || idx}>
                {/* Control plane dashed wire: Orchestrator -> Edge */}
                <path
                  d={`M 500 50 L 540 50 L 540 ${edgeY + 29} L 590 ${edgeY + 29}`}
                  fill="none"
                  stroke="#3f3f46"
                  strokeWidth={1.2}
                  strokeDasharray="3 3"
                  opacity={isOnline ? 0.6 : 0.2}
                />

                {/* Data plane wire: Edge -> Client */}
                <Wire
                  d={`M 590 ${edgeY + 32} L 550 ${edgeY + 32} L 550 ${svgHeight - 52} L 500 ${svgHeight - 52}`}
                  active={isThisActive && isOnline}
                  dead={!isOnline}
                  color={wireColor}
                />

                {/* LINK DEAD banner on severed wire */}
                {!isOnline && (
                  <g>
                    <rect x="525" y={edgeY + 24} width="70" height="16" fill="#18181b" rx="2" stroke="#ef4444" strokeWidth="1" />
                    <text x="560" y={edgeY + 35} textAnchor="middle" style={{ fontSize: 8.5, fill: '#ef4444', fontFamily: 'monospace', fontWeight: 700 }}>
                      ✕ LINK DEAD
                    </text>
                  </g>
                )}

                {/* Edge Node Box */}
                <NodeBox
                  x={590}
                  y={edgeY}
                  w={210}
                  h={nodeHeight}
                  title={edge.label || edgeId}
                  subtitle={subtitle}
                  state={nodeState}
                  pill={isThisActive ? 'ACTIVE' : (isOnline ? 'STANDBY' : 'DOWN')}
                  isOnline={isOnline}
                />
              </g>
            );
          })
        )}

      </svg>
    </div>
  );
}
