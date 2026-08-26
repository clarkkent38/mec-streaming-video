import React from 'react';

const COLORS = {
  blue:    { border: '#3b82f6', bg: 'rgba(29,78,216,0.18)', text: '#93c5fd' },
  purple:  { border: '#a855f7', bg: 'rgba(126,34,206,0.18)', text: '#d8b4fe' },
  emerald: { border: '#10b981', bg: 'rgba(4,120,87,0.18)',   text: '#6ee7b7' },
  amber:   { border: '#f59e0b', bg: 'rgba(180,83,9,0.18)',   text: '#fcd34d' },
  rose:    { border: '#f43f5e', bg: 'rgba(190,18,60,0.18)',  text: '#fda4af' },
  slate:   { border: '#475569', bg: 'rgba(30,41,59,0.5)',    text: '#94a3b8' },
};

export default function NetworkTopology({ isEdgeMode, activeNodeId }) {
  const originActive = !isEdgeMode || activeNodeId === 'origin';
  const edge1Active  = isEdgeMode && activeNodeId === 'edge-node-1';
  const edge2Active  = isEdgeMode && activeNodeId === 'edge-node-2';
  const edge1Failed  = isEdgeMode && activeNodeId === 'edge-node-2';

  // Node rendered purely in SVG — no foreignObject sizing issues
  const Node = ({ x, y, w = 150, h = 52, title, sub, colorKey, isActive, isFailed }) => {
    const c = isFailed ? COLORS.rose : isActive ? COLORS[colorKey] : COLORS.slate;
    return (
      <g>
        <rect x={x} y={y} width={w} height={h} rx={7}
          fill={c.bg} stroke={c.border} strokeWidth={isActive || isFailed ? 1.5 : 1} />
        {(isActive || isFailed) && (
          <rect x={x} y={y} width={w} height={h} rx={7}
            fill="none" stroke={c.border} strokeWidth={6} opacity={0.12} />
        )}
        <text x={x + w/2} y={y + 20} textAnchor="middle"
          style={{ fontSize: 11, fontWeight: 800, fill: c.text, fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {title}
        </text>
        <text x={x + w/2} y={y + 36} textAnchor="middle"
          style={{ fontSize: 9, fill: isFailed ? '#fda4af' : '#64748b', fontFamily: 'monospace' }}>
          {isFailed ? 'OFFLINE' : sub}
        </text>
        {/* Active indicator dot */}
        {isActive && <circle cx={x + w - 10} cy={y + 10} r={4} fill={c.border} opacity={0.9}>
          <animate attributeName="opacity" values="0.9;0.3;0.9" dur="1.5s" repeatCount="indefinite" />
        </circle>}
      </g>
    );
  };

  // Wire helper
  const Wire = ({ d, colorKey, active, dead }) => {
    const stroke = dead ? '#1e293b' : COLORS[colorKey]?.border ?? '#475569';
    return (
      <g>
        <path d={d} fill="none" stroke={stroke} strokeWidth={5} opacity={0.15} strokeLinecap="round" />
        <path d={d} fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round"
          strokeDasharray={active ? '7 5' : undefined} opacity={active ? 0.9 : 0.25}>
          {active && <animate attributeName="strokeDashoffset" from="12" to="0" dur="0.6s" repeatCount="indefinite" />}
        </path>
      </g>
    );
  };

  return (
    <div style={{
      width: '100%', height: 220,
      background: 'linear-gradient(135deg, #0a0f1a 0%, #0d1424 100%)',
      border: '1px solid rgba(255,255,255,0.07)',
      borderRadius: 10,
      overflow: 'hidden',
      position: 'relative',
    }}>
      {/* subtle grid */}
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: 'linear-gradient(rgba(255,255,255,0.015) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.015) 1px,transparent 1px)',
        backgroundSize: '28px 28px',
      }} />

      <svg viewBox="0 0 760 220" width="100%" height="100%" style={{ position: 'relative', zIndex: 1 }}>

        {/* ── Wires ── */}
        {/* Origin → Client */}
        <Wire d="M 76 108 L 76 178 L 305 178" colorKey="blue" active={originActive} dead={!originActive} />
        {/* Orchestrator control plane dashes */}
        <path d="M 380 64 L 530 64" fill="none" stroke="#334155" strokeWidth={1} strokeDasharray="4 4" />
        <path d="M 380 86 L 380 108 L 530 108" fill="none" stroke="#334155" strokeWidth={1} strokeDasharray="4 4" />
        {/* Edge1 → Client */}
        <Wire d="M 608 64 L 608 178 L 455 178" colorKey="emerald"
          active={edge1Active} dead={!edge1Active && !edge1Failed} />
        {/* Edge2 → Client */}
        <Wire d="M 680 108 L 680 192 L 455 192" colorKey="amber"
          active={edge2Active} dead={!edge2Active} />
        {/* CONNECTION LOST label */}
        {edge1Failed && (
          <text x="540" y="172" textAnchor="middle" style={{ fontSize: 8, fill: '#f43f5e', fontFamily: 'monospace', fontWeight: 700, letterSpacing: '0.08em' }}>
            ✕ CONNECTION LOST
          </text>
        )}

        {/* ── Nodes ── */}
        <Node x={4}   y={82}  w={144} h={52} title="Origin"       sub="Cloud Storage"  colorKey="blue"    isActive={originActive} />
        <Node x={305} y={38}  w={150} h={52} title="Orchestrator" sub="VNFM · Control" colorKey="purple"  isActive={isEdgeMode} />
        <Node x={530} y={38}  w={150} h={52} title="Edge Node 1"  sub="Primary MEC"    colorKey="emerald" isActive={edge1Active} isFailed={edge1Failed} />
        <Node x={530} y={108} w={150} h={52} title="Edge Node 2"  sub="Backup MEC"     colorKey="amber"   isActive={edge2Active} />

        {/* Client box */}
        <g>
          <rect x={305} y={152} width={150} height={52} rx={7}
            fill="rgba(30,41,59,0.7)" stroke="#94a3b8" strokeWidth={1.5} />
          <text x={380} y={172} textAnchor="middle"
            style={{ fontSize: 11, fontWeight: 800, fill: '#e2e8f0', fontFamily: 'monospace', letterSpacing: '0.05em' }}>
            CLIENT / TV
          </text>
          <text x={380} y={188} textAnchor="middle"
            style={{ fontSize: 9, fill: '#10b981', fontFamily: 'monospace' }}>
            ▶ Receiving Stream
          </text>
        </g>

      </svg>
    </div>
  );
}
