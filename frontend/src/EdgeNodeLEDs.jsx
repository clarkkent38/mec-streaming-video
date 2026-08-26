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

  const getLedClass = (node) => {
    if (node.status === 'DOWN') return 'led-red-strobe';
    if (node.status === 'UNKNOWN') return 'led-amber-blink';
    if (node.status === 'UP') {
      if (node.id === activeNodeId) return 'led-green-pulse';
      return 'led-green-steady';
    }
    return 'led-inactive';
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
              <div 
                className={`w-4 h-4 rounded-full border border-black shadow-[inset_1px_1px_2px_rgba(0,0,0,0.5)] ${isActive && node.id === 'origin' ? 'led-green-pulse' : getLedClass(node)}`}
              />
              <div className="flex flex-col">
                <span className={`text-[9px] font-bold uppercase tracking-wider ${isActive ? 'text-green-400' : 'text-slate-400'}`}>
                  {node.id}
                </span>
                <span className="text-[8px] text-slate-500 font-mono">
                  {node.isMaster ? 'MASTER NODE' : (node.status === 'UP' ? `ENABLED / ${node.delay_ms}ms` : node.status)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="text-[9px] uppercase text-slate-500 tracking-widest border border-slate-700 px-2 py-0.5 rounded bg-slate-900/50">
        VNF Cluster Status
      </div>
    </div>
  );
}
