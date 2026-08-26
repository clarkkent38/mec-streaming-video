import { useState, useEffect } from 'react';
import { ORCHESTRATOR_URL } from './config';

export default function EdgeNodeLEDs({ activeNodeId }) {
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
    const intervalId = setInterval(fetchNodes, 3000);
    return () => {
      mounted = false;
      clearInterval(intervalId);
    };
  }, []);

  const getStatusBadge = (node, isActive) => {
    if (node.status === 'DOWN') {
      return <span className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-red-950/50 text-red-500 border border-red-900">OFFLINE</span>;
    }
    if (node.status === 'UNKNOWN') {
      return <span className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-amber-950/50 text-amber-500 border border-amber-900">WAIT</span>;
    }
    
    // Check if UP but degraded
    if (node.status === 'UP' && node.delay_ms > 50) {
       return <span className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-yellow-950/50 text-yellow-500 border border-yellow-900">DEGRADED</span>;
    }

    if (isActive) {
      return <span className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-zinc-100 text-zinc-900 border border-zinc-300">ACTIVE</span>;
    }
    return <span className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-zinc-900 text-zinc-500 border border-zinc-800">STANDBY</span>;
  };

  const masterNode = { id: 'origin', status: 'UP', isMaster: true };
  const displayNodes = [...nodes, masterNode];

  return (
    <div className="skeubrutal-panel p-2 rounded-lg mb-2 flex flex-wrap gap-2 items-center justify-between">
      <div className="flex gap-4">
        {displayNodes.map(node => {
          const isActive = activeNodeId === node.id || (!activeNodeId && node.isMaster);
          return (
            <div key={node.id} className="flex items-center gap-2">
              {getStatusBadge(node, isActive && (node.id === 'origin' || node.status === 'UP'))}
              <div className="flex flex-col">
                <span className={`text-[9px] font-bold uppercase tracking-wider ${isActive ? 'text-zinc-200' : 'text-zinc-500'}`}>
                  {node.id}
                </span>
                <span className="text-[8px] text-zinc-600 font-mono">
                  {node.isMaster ? 'ORIGIN SERVER' : (node.status === 'UP' ? `LATENCY: ${node.delay_ms}ms` : node.status)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="text-[9px] uppercase text-zinc-500 tracking-widest border border-zinc-800 px-2 py-0.5 rounded bg-zinc-900">
        Infrastructure Status
      </div>
    </div>
  );
}
