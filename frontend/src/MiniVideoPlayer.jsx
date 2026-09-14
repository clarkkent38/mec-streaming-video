import React from 'react';

export default function MiniVideoPlayer({
  videoRef,
  playerRef,
  isEdgeMode,
  setIsEdgeMode,
  activeNode,
  qualityBadge,
  connError,
  onRetry,
  qualities = [],
  selectedQuality = -1,
  setSelectedQuality,
  stats = {}
}) {
  return (
    <div className="card p-3 rounded-xl flex flex-col gap-2 border-zinc-800 bg-zinc-900/90 shadow-md">
      {/* Mini Player Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
          <span className="text-[11px] font-bold font-mono tracking-wider text-zinc-300 uppercase">
            Client Video Preview
          </span>
        </div>
        <span className={`px-2 py-0.5 rounded text-[9px] font-mono font-bold uppercase tracking-wider max-w-[150px] truncate ${
          isEdgeMode 
            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' 
            : 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
        }`} title={activeNode?.label || activeNode?.edgeId || (isEdgeMode ? 'MEC EDGE' : 'ORIGIN')}>
          {activeNode?.label || activeNode?.edgeId || activeNode?.id || (isEdgeMode ? 'MEC EDGE' : 'ORIGIN')}
        </span>
      </div>

      {/* Small Video Container */}
      {connError ? (
        <div className="w-full aspect-video rounded-lg border border-rose-900/60 bg-rose-950/20 p-4 text-center flex flex-col items-center justify-center">
          <div className="text-2xl mb-1">🔌</div>
          <div className="text-rose-300 font-bold text-xs">Node Unreachable</div>
          <div className="text-rose-400/80 text-[10px] my-1 max-w-[200px] truncate">{connError}</div>
          <button
            onClick={onRetry}
            className="px-3 py-1 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded text-[10px] mt-1 transition-all"
          >
            ↻ Retry
          </button>
        </div>
      ) : (
        <div className="relative w-full aspect-video rounded-lg overflow-hidden border border-zinc-700/80 bg-black shadow-inner">
          <video
            ref={videoRef}
            controls
            autoPlay
            muted
            playsInline
            className="w-full h-full object-contain outline-none block"
          />
          {/* Quality Badge Overlay */}
          {qualityBadge && (
            <div className="absolute top-2 right-2 bg-black/80 backdrop-blur-sm border border-white/20 rounded px-1.5 py-0.5 text-[10px] font-mono font-bold text-zinc-100 z-20 pointer-events-none">
              📺 {qualityBadge}
            </div>
          )}
        </div>
      )}

      {/* Mode Toggle & Quality Controls Row */}
      <div className="flex items-center justify-between gap-2 pt-1 border-t border-zinc-800/80">
        {/* Toggle Mode */}
        <div className="flex items-center gap-1.5">
          <span className={`text-[11px] font-mono ${!isEdgeMode ? 'text-white font-bold' : 'text-zinc-500'}`}>
            Direct
          </span>
          <button
            id="mode-toggle"
            onClick={() => setIsEdgeMode(m => !m)}
            className={`w-9 h-5 rounded-full transition-colors relative focus:outline-none ${
              isEdgeMode ? 'bg-emerald-500' : 'bg-zinc-700'
            }`}
            title="Toggle between Direct Cloud Origin and MEC Edge Engine"
          >
            <div
              className={`w-4 h-4 rounded-full absolute top-[2px] transition-transform duration-200 bg-white shadow-sm ${
                isEdgeMode ? 'translate-x-[18px]' : 'translate-x-[2px]'
              }`}
            />
          </button>
          <span className={`text-[11px] font-mono ${isEdgeMode ? 'text-emerald-400 font-bold' : 'text-zinc-500'}`}>
            MEC
          </span>
        </div>

        {/* Quality Selector */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] font-mono text-zinc-500 uppercase">Res</span>
          <select
            value={selectedQuality}
            onChange={e => {
              const v = parseInt(e.target.value);
              setSelectedQuality(v);
              if (playerRef?.current) {
                playerRef.current.updateSettings({
                  streaming: { abr: { autoSwitchBitrate: { video: v === -1 } } }
                });
                if (v !== -1) playerRef.current.setRepresentationForTypeByIndex('video', v);
              }
            }}
            className="bg-zinc-800 text-zinc-200 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px] font-mono outline-none focus:border-zinc-500"
          >
            <option value={-1}>Auto (ABR)</option>
            {qualities.map(q => (
              <option key={q.index} value={q.index}>
                {q.height || '?'}p ({Math.round((q.bandwidth || 0) / 1000)}k)
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Compact Video Telemetry Strip */}
      <div className="grid grid-cols-4 gap-1 p-1.5 rounded-lg bg-zinc-950/80 border border-zinc-800/80 text-[10px] font-mono">
        <div className="flex flex-col text-center">
          <span className="text-zinc-500 text-[9px]">RES</span>
          <span className="text-zinc-200 font-bold truncate">{stats.resolution || '—'}</span>
        </div>
        <div className="flex flex-col text-center border-l border-zinc-800">
          <span className="text-zinc-500 text-[9px]">RTT</span>
          <span className={`font-bold ${isEdgeMode ? 'text-emerald-400' : 'text-amber-400'}`}>
            {stats.latency || (isEdgeMode ? '5' : '150')}ms
          </span>
        </div>
        <div className="flex flex-col text-center border-l border-zinc-800">
          <span className="text-zinc-500 text-[9px]">BUF</span>
          <span className="text-sky-400 font-bold">{stats.buffer ? `${stats.buffer.toFixed(1)}s` : '0s'}</span>
        </div>
        <div className="flex flex-col text-center border-l border-zinc-800">
          <span className="text-zinc-500 text-[9px]">STALL</span>
          <span className={`font-bold ${(stats.stallCount || 0) > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
            {stats.stallCount || 0}
          </span>
        </div>
      </div>

    </div>
  );
}
