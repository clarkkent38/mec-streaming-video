import React, { useState, useEffect } from 'react';
import { ORCHESTRATOR_URL } from './config';

const COLORS = {
  active:   { border: '#3b82f6', bg: 'rgba(59, 130, 246, 0.1)', text: '#60a5fa', glow: '#3b82f6' }, // blue
  inactive: { border: '#27272a', bg: '#18181b', text: '#71717a', glow: 'transparent' }, // zinc
  failed:   { border: '#ef4444', bg: 'rgba(239, 68, 68, 0.1)', text: '#f87171', glow: '#ef4444' }, // red
  degraded: { border: '#eab308', bg: 'rgba(234, 179, 8, 0.1)', text: '#fde047', glow: '#eab308' }, // yellow
};

export default function NetworkTopology({ isEdgeMode, activeNodeId }) {
  const [nodes, setNodes] = useState([]);

  useEffect(() => {
    let mounted = true;
    const fetchNodes = async () => {
      try {
        const res = await fetch(`${ORCHESTRATOR_URL}/nodes`);
        if (!res.ok) throw new Error('fetch failed');
        const data = await res.json();
        if (mounted) setNodes(data.nodes);
      } catch (e) {
        if (mounted) setNodes([]);
      }
    };
    fetchNodes();
    const intervalId = setInterval(fetchNodes, 2000);
    return () => { mounted = false; clearInterval(intervalId); };
  }, []);

  const getNodeState = (id, isActiveRoute) => {
    if (id === 'origin') return { state: isActiveRoute ? 'active' : 'inactive', label: 'ORIGIN SERVER' };
    if (id === 'orchestrator') return { state: isEdgeMode ? 'active' : 'inactive', label: 'VNFM CONTROLLER' };
    
    const node = nodes.find(n => n.id === id);
    if (!node) return { state: isActiveRoute ? 'active' : 'inactive', label: 'UNKNOWN' };
    
    if (node.status === 'DOWN') return { state: 'failed', label: 'OFFLINE' };
    if (node.status === 'UP' && node.delay_ms > 50) return { state: 'degraded', label: `DEGRADED (${node.delay_ms}ms)` };
    return { state: isActiveRoute ? 'active' : 'inactive', label: `READY (${node.delay_ms}ms)` };
  };

  const originActive = !isEdgeMode || activeNodeId === 'origin';
  const edge1Active  = isEdgeMode && activeNodeId === 'edge-node-1';
  const edge2Active  = isEdgeMode && activeNodeId === 'edge-node-2';

  const edge1State = getNodeState('edge-node-1', edge1Active);
  const edge2State = getNodeState('edge-node-2', edge2Active);
  const originState = getNodeState('origin', originActive);
  const orchState = getNodeState('orchestrator', isEdgeMode);

  // Node rendered purely in SVG
  const Node = ({ x, y, w = 150, h = 56, title, stateData }) => {
    const c = COLORS[stateData.state];
    return (
      <g>
        <rect x={x} y={y} width={w} height={h} rx={6}
          fill={c.bg} stroke={c.border} strokeWidth={1.5} />
        <text x={x + w/2} y={y + 24} textAnchor="middle"
          style={{ fontSize: 12, fontWeight: 700, fill: c.text, fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {title}
        </text>
        <text x={x + w/2} y={y + 42} textAnchor="middle"
          style={{ fontSize: 10, fill: c.text, opacity: 0.8, fontFamily: 'monospace' }}>
          {stateData.label}
        </text>
        {stateData.state !== 'inactive' && (
          <circle cx={x + w - 12} cy={y + 14} r={4} fill={c.glow} opacity={0.9}>
            <animate attributeName="opacity" values="0.9;0.4;0.9" dur="2s" repeatCount="indefinite" />
          </circle>
        )}
      </g>
    );
  };

  // Wire helper
  const Wire = ({ d, active, dead, color }) => {
    const stroke = dead ? '#3f3f46' : (active ? color : '#3f3f46');
    return (
      <g>
        <path d={d} fill="none" stroke={stroke} strokeWidth={2} opacity={dead ? 0.2 : 0.4} strokeLinecap="round" />
        <path d={d} fill="none" stroke={active ? color : stroke} strokeWidth={2.5} strokeLinecap="round"
          strokeDasharray={active ? '6 6' : undefined} opacity={active ? 1 : (dead ? 0 : 0.2)}>
          {active && <animate attributeName="strokeDashoffset" from="12" to="0" dur="0.6s" repeatCount="indefinite" />}
        </path>
      </g>
    );
  };

  return (
    <div style={{
      width: '100%', height: 220,
      background: '#09090b', // zinc-950
      border: '1px solid #27272a', // zinc-800
      borderRadius: 8,
      overflow: 'hidden',
      position: 'relative',
    }}>
      {/* subtle grid */}
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: 'linear-gradient(#18181b 1px,transparent 1px),linear-gradient(90deg,#18181b 1px,transparent 1px)',
        backgroundSize: '20px 20px',
      }} />

      <svg viewBox="0 0 760 220" width="100%" height="100%" style={{ position: 'relative', zIndex: 1 }}>

        {/* ── Wires ── */}
        {/* Origin → Client */}
        <Wire d="M 76 108 L 76 178 L 305 178" active={originActive} dead={!originActive} color="#3b82f6" />
        {/* Orchestrator control plane dashes */}
        <path d="M 380 64 L 530 64" fill="none" stroke="#3f3f46" strokeWidth={1.5} strokeDasharray="3 3" />
        <path d="M 380 86 L 380 108 L 530 108" fill="none" stroke="#3f3f46" strokeWidth={1.5} strokeDasharray="3 3" />
        
        {/* Edge1 → Client */}
        <Wire d="M 608 64 L 608 178 L 455 178" active={edge1Active} dead={edge1State.state === 'failed'} color="#10b981" />
        {/* Edge2 → Client */}
        <Wire d="M 680 108 L 680 192 L 455 192" active={edge2Active} dead={edge2State.state === 'failed'} color="#a855f7" />

        {/* CONNECTION LOST labels */}
        {edge1State.state === 'failed' && (
          <g>
            <rect x="490" y="162" width="90" height="16" fill="#18181b" rx="2" stroke="#ef4444" strokeWidth="1" />
            <text x="535" y="173" textAnchor="middle" style={{ fontSize: 9, fill: '#ef4444', fontFamily: 'monospace', fontWeight: 600 }}>
              ✕ LINK DEAD
            </text>
          </g>
        )}
        
        {edge2State.state === 'failed' && (
          <g>
            <rect x="520" y="184" width="90" height="16" fill="#18181b" rx="2" stroke="#ef4444" strokeWidth="1" />
            <text x="565" y="195" textAnchor="middle" style={{ fontSize: 9, fill: '#ef4444', fontFamily: 'monospace', fontWeight: 600 }}>
              ✕ LINK DEAD
            </text>
          </g>
        )}

        {/* ── Nodes ── */}
        <Node x={4}   y={82}  w={144} h={56} title="Origin"       stateData={originState} />
        <Node x={305} y={38}  w={150} h={56} title="Orchestrator" stateData={orchState} />
        <Node x={530} y={38}  w={150} h={56} title="Edge Node 1"  stateData={edge1State} />
        <Node x={530} y={108} w={150} h={56} title="Edge Node 2"  stateData={edge2State} />

        {/* Client box */}
        <g>
          <rect x={305} y={152} width={150} height={56} rx={6}
            fill="#18181b" stroke="#52525b" strokeWidth={1.5} />
          <text x={380} y={174} textAnchor="middle"
            style={{ fontSize: 12, fontWeight: 700, fill: '#fafafa', fontFamily: 'monospace', letterSpacing: '0.05em' }}>
            CLIENT / TV
          </text>
          <text x={380} y={192} textAnchor="middle"
            style={{ fontSize: 10, fill: '#a1a1aa', fontFamily: 'monospace' }}>
            {originActive || edge1Active || edge2Active ? '▶ PLAYING' : '⏸ BUFFERING'}
          </text>
        </g>

      </svg>
    </div>
  );
}
