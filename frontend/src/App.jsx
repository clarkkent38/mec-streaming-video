import { useState, useEffect, useRef, useCallback } from 'react';
import dashjs from 'dashjs';
import LiveStatsPanel from './LiveStatsPanel';
import ScenarioPanel from './ScenarioPanel';
import EdgeNodeLEDs from './EdgeNodeLEDs';
import NetworkTopology from './NetworkTopology';
import { useEdgeRouter } from './useEdgeRouter';
import { ORIGIN_MANIFEST, IS_LAN_MODE } from './config';

export default function App() {
  const videoRef  = useRef(null);
  const playerRef = useRef(null);

  const [isEdgeMode,   setIsEdgeMode]   = useState(false);
  const [playerReady,  setPlayerReady]  = useState(false);
  const [globalError,  setGlobalError]  = useState(null);
  const [connError,    setConnError]    = useState(null);
  const [qualityBadge, setQualityBadge] = useState(null); // { label, visible }
  const qualityTimerRef = useRef(null);

  const { manifestUrl, activeNode, routeLog, resolveManifest, handleSegmentError } =
    useEdgeRouter(isEdgeMode);

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
          initPlayer(ORIGIN_MANIFEST);
        }
      }
    });
  }, [isEdgeMode, handleSegmentError]);

  useEffect(() => {
    let cancelled = false;
    resolveManifest().then(url => {
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
  }, [isEdgeMode, resolveManifest, initPlayer]);

  const logColor = (type) => ({
    info:    'text-slate-400',
    success: 'text-emerald-400',
    warn:    'text-amber-400',
    error:   'text-rose-400',
  }[type] || 'text-slate-400');

  const logBg = (type) => ({
    info:    'bg-slate-800/60',
    success: 'bg-emerald-900/30',
    warn:    'bg-amber-900/30',
    error:   'bg-rose-900/30',
  }[type] || 'bg-slate-800/60');

  return (
    <div className="min-h-screen p-4 md:p-6 overflow-hidden relative">
      
      {/* Background ambient light */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-blue-900/20 rounded-full blur-[100px] pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-emerald-900/20 rounded-full blur-[100px] pointer-events-none" />

      {IS_LAN_MODE && (
        <div className="w-full max-w-[90rem] mx-auto mb-3 flex items-center gap-2 skeubrutal-panel border border-violet-700/50 text-violet-300 text-xs px-4 py-2 rounded-lg relative z-10">
          <span>📡</span>
          <span><strong>LAN Mode active</strong> — frontend is accessible on your local network. Make sure firewall allows ports 3000, 4001, 4002, 5000, 5173.</span>
        </div>
      )}

      {/* Header */}
      <div className="w-full max-w-[90rem] mx-auto mb-3 relative z-10 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-black text-slate-100 tracking-tight">
            VNF <span className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-blue-500">Edge Streamer</span>
          </h1>
          <span className="text-slate-600 text-xs font-mono hidden md:inline">Adaptive DASH · Context-Aware MEC + NFV</span>
        </div>
        <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/d/d4/Akamai_logo.svg/512px-Akamai_logo.svg.png" className="h-3 opacity-30 contrast-200 grayscale brightness-200 hidden md:block" alt="Powered by Akamai" />
      </div>

      {globalError && (
        <div className="w-full max-w-[90rem] mx-auto mb-4 bg-amber-900/40 border border-amber-600/50 text-amber-200 px-4 py-3 rounded-lg text-sm flex justify-between relative z-10">
          <span>⚠ {globalError}</span>
          <button onClick={() => setGlobalError(null)} className="text-amber-400 hover:text-white ml-4">✕</button>
        </div>
      )}

      {/* Main layout */}
      <div className="w-full max-w-[90rem] mx-auto relative z-10">
        
        {/* LED Strip Component */}
        <EdgeNodeLEDs activeNodeId={activeNode?.id || 'origin'} />

        <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1.7fr_0.9fr] gap-4 items-start">

          {/* LEFT COLUMN: Topology + Scenarios */}
          <div className="flex flex-col gap-2 h-[80vh]">
            {/* TRON NETWORK TOPOLOGY MAP */}
            <NetworkTopology 
              isEdgeMode={isEdgeMode} 
              activeNodeId={activeNode?.id || 'origin'} 
            />

            {/* Scenario Panel */}
            <ScenarioPanel
              onScenarioRun={(id) => {
                if (isEdgeMode) {
                  setTimeout(() => {
                    resolveManifest().then(url => url && initPlayer(url));
                  }, 6000); 
                }
              }}
            />
          </div>

          {/* CENTER COLUMN: Toggle + Video + Log */}
          <div className="flex flex-col gap-2">
            {/* Super minimal top row: Acceleration + Quality Portal */}
            <div className="flex items-center justify-between px-2">
              <div className="flex items-center gap-3">
                <span className="text-slate-300 font-bold uppercase tracking-wider text-sm flex items-center gap-2">
                  <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                  Acceleration
                </span>
              </div>
              <div className="flex items-center gap-4">
                <span className={`text-sm font-mono transition-colors ${!isEdgeMode ? 'text-blue-400 font-bold' : 'text-slate-500'}`}>
                  ORIGIN (DIRECT)
                </span>
                
                {/* Physical-looking toggle */}
                <button
                  id="mode-toggle"
                  onClick={() => setIsEdgeMode(m => !m)}
                  className={`w-14 h-7 rounded-full transition-colors relative shadow-[inset_2px_2px_8px_rgba(0,0,0,0.8)] border border-slate-700/50 ${isEdgeMode ? 'bg-emerald-900/50' : 'bg-slate-900'}`}
                >
                  <div className={`w-5 h-5 rounded-full absolute top-[3px] transition-all duration-300 shadow-[0_2px_6px_rgba(0,0,0,0.5),inset_1px_1px_2px_rgba(255,255,255,0.2)] flex items-center justify-center ${isEdgeMode ? 'left-[33px] bg-emerald-500' : 'left-[3px] bg-slate-400'}`}>
                    <div className="w-1.5 h-1.5 rounded-full shadow-[inset_1px_1px_2px_rgba(0,0,0,0.3)] bg-black/10" />
                  </div>
                </button>
              </div>
              <div id="quality-container"></div>
            </div>

            {/* Video or Error */}
            {connError ? (
              <div className="skeubrutal-panel border border-rose-700 rounded-xl p-12 text-center aspect-video flex flex-col items-center justify-center">
                <div className="text-5xl mb-4">🔌</div>
                <div className="text-rose-300 font-bold text-xl mb-2">Connection Failed</div>
                <div className="text-rose-400 text-sm mb-6 max-w-md">{connError}</div>
                <button
                  onClick={() => resolveManifest().then(url => url && initPlayer(url))}
                  className="skeubrutal-button px-6 py-2.5 text-white font-bold rounded-lg text-sm"
                >
                  ↻ RETRY CONNECTION
                </button>
              </div>
            ) : (
              /* Video player — clean flat container */
              <div
                className="rounded-xl overflow-hidden border border-white/10 bg-black w-[90%] mx-auto relative"
                style={{ boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}
              >
                <video
                  ref={videoRef}
                  controls
                  autoPlay
                  muted
                  className="w-full aspect-video outline-none block"
                />
                {/* Quality badge overlay */}
                {qualityBadge && (
                  <div style={{
                    position: 'absolute', top: 10, right: 10,
                    background: 'rgba(0,0,0,0.75)',
                    backdropFilter: 'blur(6px)',
                    border: '1px solid rgba(255,255,255,0.15)',
                    borderRadius: 6, padding: '4px 10px',
                    fontSize: 11, fontFamily: 'monospace', fontWeight: 700,
                    color: '#e2e8f0', zIndex: 30,
                    animation: 'fadeIn 0.2s ease',
                  }}>
                    📺 {qualityBadge}
                  </div>
                )}
              </div>
            )}

            {/* Graphs Portal Target */}
            <div id="graphs-container" className="flex gap-2 w-full mt-1"></div>

            {/* Routing event log */}
            <div className="card rounded-xl p-3 flex-1 min-h-[90px] mt-1">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-[#b8860b] mb-2 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[#b8860b] animate-pulse"></span>
                Terminal / Route Log
              </h3>
              {routeLog.length === 0 ? (
                <p className="text-slate-600 text-[10px] italic font-mono">_ waiting for telemetry</p>
              ) : (
                <div className="space-y-1 h-[80px] overflow-y-auto pr-1 font-mono text-[10px] leading-tight scrollbar-thin scrollbar-thumb-slate-700">
                  {routeLog.map(entry => (
                    <div key={entry.id} className={`flex gap-2 px-2 py-1 rounded ${logBg(entry.type)}`}>
                      <span className="text-slate-500 shrink-0">[{entry.ts}]</span>
                      <span className={logColor(entry.type)}>» {entry.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* RIGHT COLUMN: Stats for Nerds */}
          <div className="h-full min-h-[600px] flex flex-col">
            <LiveStatsPanel playerRef={playerRef} playerReady={playerReady} />
          </div>

        </div>
      </div>
    </div>
  );
}
