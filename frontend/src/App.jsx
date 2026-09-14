import { useState, useEffect, useRef, useCallback } from 'react';
import dashjs from 'dashjs';
import PaperGraphsDashboard from './PaperGraphsDashboard';
import MiniVideoPlayer from './MiniVideoPlayer';
import ScenarioPanel from './ScenarioPanel';
import EdgeNodeLEDs from './EdgeNodeLEDs';
import NetworkTopology from './NetworkTopology';
import { useEdgeRouter } from './useEdgeRouter';
import { usePlayerTelemetry } from './usePlayerTelemetry';
import { ORIGIN_MANIFEST, IS_LAN_MODE, VIDEO_CATALOG } from './config';

export default function App() {
  const videoRef  = useRef(null);
  const playerRef = useRef(null);

  const [isEdgeMode,      setIsEdgeMode]      = useState(false);
  const [selectedStream,  setSelectedStream]  = useState(VIDEO_CATALOG[0].id);
  const [playerReady,     setPlayerReady]     = useState(false);
  const [globalError,     setGlobalError]     = useState(null);
  const [connError,       setConnError]       = useState(null);
  const [qualityBadge,    setQualityBadge]    = useState(null);
  const qualityTimerRef = useRef(null);

  const currentStreamObj = VIDEO_CATALOG.find(v => v.id === selectedStream) || VIDEO_CATALOG[0];

  const { manifestUrl, activeNode, routeLog, resolveManifest, handleSegmentError } =
    useEdgeRouter(isEdgeMode);

  // Hook for research metrics & publication time-series
  const {
    graphData,
    stats,
    mecStats,
    qualities,
    selectedQuality,
    setSelectedQuality,
    resetGraphData
  } = usePlayerTelemetry(playerRef, playerReady, isEdgeMode, activeNode);

  // ── Player initialisation / re-init ────────────────────────────────────────
  const initPlayer = useCallback(async (url) => {
    if (!videoRef.current) return;

    if (playerRef.current) {
      playerRef.current.destroy();
      playerRef.current = null;
      setPlayerReady(false);
    }

    setGlobalError(null);
    setConnError(null);

    try {
      const probe = await fetch(url, { method: 'HEAD' });
      if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
    } catch (err) {
      const msg = isEdgeMode
        ? `Edge node / orchestrator unreachable: ${err.message}`
        : `Origin server not reachable on :3000 — start it first.`;
      setConnError(msg);
      return;
    }

    const player = dashjs.MediaPlayer().create();
    playerRef.current = player;
    
    player.updateSettings({
      streaming: {
        abr: {
          autoSwitchBitrate: { video: true },
        },
      }
    });

    player.initialize(videoRef.current, url, true);
    setPlayerReady(true);

    player.on(dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED, (e) => {
      if (e.mediaType !== 'video') return;
      try {
        const reps = player.getRepresentationsByType('video');
        const rep  = reps?.[e.newQuality] ?? reps?.find(r => r.index === e.newQuality);
        if (rep) {
          const label = `${rep.height || '?'}p · ${Math.round((rep.bandwidth||0)/1000)} kbps`;
          setQualityBadge(label);
          clearTimeout(qualityTimerRef.current);
          qualityTimerRef.current = setTimeout(() => setQualityBadge(null), 3000);
        }
      } catch(_) {}
    });

    player.on(dashjs.MediaPlayer.events.ERROR, async (e) => {
      if (e.error === 'download') {
        const newUrl = await handleSegmentError();
        if (newUrl && newUrl !== url) {
          initPlayer(newUrl);
        } else if (!newUrl) {
          setGlobalError('All edge nodes down. Falling back to origin.');
          initPlayer(currentStreamObj.path);
        }
      }
    });
  }, [isEdgeMode, handleSegmentError, currentStreamObj.path]);

  useEffect(() => {
    let cancelled = false;
    resolveManifest(currentStreamObj.path).then(url => {
      if (!cancelled && url) initPlayer(url);
    });
    return () => {
      cancelled = true;
      if (playerRef.current) {
        playerRef.current.destroy();
        playerRef.current = null;
        setPlayerReady(false);
      }
    };
  }, [isEdgeMode, selectedStream, resolveManifest, initPlayer, currentStreamObj.path]);

  return (
    <div className="min-h-screen p-3 md:p-4 text-zinc-100 bg-zinc-950 font-sans selection:bg-blue-600 selection:text-white">

      {/* LAN Warning banner if active */}
      {IS_LAN_MODE && (
        <div className="w-full max-w-[100rem] mx-auto mb-2.5 flex items-center gap-2 skeubrutal-panel text-zinc-400 text-xs px-3 py-1.5 rounded-lg border border-zinc-800">
          <span>📡</span>
          <span><strong>LAN Mode active</strong> — Accessible on local network. Ensure ports 3000, 4001, 4002, 5000, 5173 are open.</span>
        </div>
      )}

      {/* Main Header */}
      <header className="w-full max-w-[100rem] mx-auto mb-2.5 flex flex-wrap justify-between items-center gap-2 border-b border-zinc-800/80 pb-2">
        <div className="flex items-center gap-3">
          <h1 className="text-base md:text-lg font-bold text-zinc-100 tracking-tight flex items-center gap-2">
            <span className="bg-blue-600 text-white px-1.5 py-0.5 rounded text-xs tracking-wider uppercase font-mono">VNF-MEC</span>
            <span>Adaptive Edge Streamer</span>
          </h1>
          <span className="text-zinc-500 text-xs font-mono hidden md:inline border-l border-zinc-800 pl-3">
            NFV Orchestration & FMDASH+ Adaptive Telemetry Suite
          </span>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-xs font-mono">
            <span className="text-zinc-500">Route Status:</span>
            <span className={`font-bold ${isEdgeMode ? 'text-emerald-400' : 'text-amber-400'}`}>
              {isEdgeMode ? '⚡ MEC Acceleration Active' : '☁ Direct Cloud Origin'}
            </span>
          </div>
          <span className="text-[10px] uppercase font-mono tracking-widest text-zinc-500 hidden lg:inline">
            IEEE / ACM Evaluation Suite
          </span>
        </div>
      </header>

      {/* Global Error Banner */}
      {globalError && (
        <div className="w-full max-w-[100rem] mx-auto mb-3 bg-amber-900/40 border border-amber-600/50 text-amber-200 px-4 py-2 rounded-lg text-xs flex justify-between items-center">
          <span>⚠ {globalError}</span>
          <button onClick={() => setGlobalError(null)} className="text-amber-400 hover:text-white font-bold ml-4">✕</button>
        </div>
      )}

      {/* Main Container */}
      <main className="w-full max-w-[100rem] mx-auto flex flex-col gap-2.5">
        
        {/* Node LED Strip */}
        <EdgeNodeLEDs activeNodeId={activeNode?.id || 'origin'} />

        {/* Responsive Grid: Left Column (Small Video + Controls) vs Right Column (Big Paper Graphs) */}
        <div className="grid grid-cols-1 lg:grid-cols-[330px_1fr] xl:grid-cols-[360px_1fr] gap-3 items-start">

          {/* ═══════════════════════════════════════════════════════════════════
              LEFT COLUMN: VERY SMALL VIDEO STREAMING + NETWORK CONTROLS
             ═══════════════════════════════════════════════════════════════════ */}
          <aside className="flex flex-col gap-2.5 w-full">
            
            {/* 1. Small Video Player */}
            <MiniVideoPlayer
              videoRef={videoRef}
              playerRef={playerRef}
              isEdgeMode={isEdgeMode}
              setIsEdgeMode={setIsEdgeMode}
              activeNode={activeNode}
              qualityBadge={qualityBadge}
              connError={connError}
              onRetry={() => resolveManifest(currentStreamObj.path).then(url => url && initPlayer(url))}
              qualities={qualities}
              selectedQuality={selectedQuality}
              setSelectedQuality={setSelectedQuality}
              stats={stats}
              selectedStream={selectedStream}
              setSelectedStream={setSelectedStream}
              videoCatalog={VIDEO_CATALOG}
            />

            {/* 2. Network Topology Flow Map */}
            <div className="card p-2.5 rounded-xl border border-zinc-800 bg-zinc-900/90 shadow-sm">
              <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400 mb-1.5 flex items-center justify-between">
                <span>Network Data Plane</span>
                <span className="text-[9px] text-zinc-500">SVG Topology</span>
              </div>
              <NetworkTopology 
                isEdgeMode={isEdgeMode} 
                activeNodeId={activeNode?.id || 'origin'} 
              />
            </div>

            {/* 3. Scenario Panel */}
            <ScenarioPanel
              onScenarioRun={(id) => {
                if (isEdgeMode) {
                  setTimeout(() => {
                    resolveManifest().then(url => url && initPlayer(url));
                  }, 6000); 
                }
              }}
            />

            {/* 4. Terminal / Routing Event Log */}
            <div className="card p-2.5 rounded-xl border border-zinc-800 bg-zinc-900/90 shadow-sm">
              <h3 className="text-[10px] font-mono font-bold uppercase tracking-widest text-zinc-400 mb-1.5 flex items-center justify-between">
                <span>Routing & Telemetry Log</span>
                <span className="text-[9px] text-zinc-500 font-mono">dash.js / vnfm</span>
              </h3>
              {routeLog.length === 0 ? (
                <p className="text-zinc-600 text-[10px] font-mono py-2">waiting for telemetry events...</p>
              ) : (
                <div className="space-y-1 max-h-[110px] overflow-y-auto pr-1 font-mono text-[10px] leading-tight">
                  {routeLog.map(entry => (
                    <div key={entry.id} className="flex gap-1.5 px-1.5 py-0.5 rounded bg-zinc-950/70 border border-zinc-800/40">
                      <span className="text-zinc-500 shrink-0">[{entry.ts}]</span>
                      <span className={entry.type === 'success' ? 'text-emerald-400' : (entry.type === 'error' ? 'text-rose-400' : 'text-zinc-300')}>
                        » {entry.message}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </aside>

          {/* ═══════════════════════════════════════════════════════════════════
              RIGHT / MAIN AREA: BIG RESEARCH PAPER GRAPHS SHOWCASE
             ═══════════════════════════════════════════════════════════════════ */}
          <section className="w-full">
            <PaperGraphsDashboard
              graphData={graphData}
              stats={stats}
              mecStats={mecStats}
              isEdgeMode={isEdgeMode}
              activeNode={activeNode}
              onReset={resetGraphData}
            />
          </section>

        </div>

      </main>

    </div>
  );
}
