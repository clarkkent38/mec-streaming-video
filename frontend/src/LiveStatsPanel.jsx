import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import dashjs from 'dashjs';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid
} from 'recharts';
import { ORCHESTRATOR_URL } from './config';

// ── Custom tooltip for recharts ───────────────────────────────────────────────
const ChartTooltip = ({ active, payload, label, unit }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: '#0f1117',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 6,
      padding: '4px 10px',
      fontSize: 11,
      color: '#e2e8f0',
      fontFamily: 'monospace'
    }}>
      <span style={{ color: payload[0].stroke }}>
        {payload[0].value?.toFixed(1)}{unit}
      </span>
      <span style={{ color: '#475569', marginLeft: 6 }}>@ {label}s</span>
    </div>
  );
};

// ── Stat row ──────────────────────────────────────────────────────────────────
const StatRow = ({ label, value, accent }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
    <span style={{ color: '#64748b', fontSize: 11, fontFamily: 'monospace' }}>{label}</span>
    <span style={{ color: accent || '#e2e8f0', fontSize: 11, fontFamily: 'monospace', fontWeight: 600 }}>{value}</span>
  </div>
);

// ── Mini bar ──────────────────────────────────────────────────────────────────
const MiniBar = ({ pct, color }) => (
  <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 3, height: 4, overflow: 'hidden', flex: 1 }}>
    <div style={{
      width: `${Math.min(100, pct)}%`,
      height: '100%',
      background: color,
      borderRadius: 3,
      transition: 'width 0.4s ease'
    }} />
  </div>
);

// ── Main component ────────────────────────────────────────────────────────────
export default function LiveStatsPanel({ playerRef, playerReady }) {
  const [graphData,   setGraphData]   = useState([]);
  const [stallEvents, setStallEvents] = useState([]);
  const [stats, setStats] = useState({
    bitrate: 0, buffer: 0, resolution: '—',
    droppedFrames: 0, totalFrames: 0, stallCount: 0
  });
  const [qualities,      setQualities]      = useState([]);
  const [selectedQuality, setSelectedQuality] = useState(-1);
  const [mecStats,       setMecStats]       = useState(null);

  const [graphsTarget, setGraphsTarget] = useState(null);
  const [qualityTarget, setQualityTarget] = useState(null);

  useEffect(() => {
    setGraphsTarget(document.getElementById('graphs-container'));
    setQualityTarget(document.getElementById('quality-container'));
  }, []);

  const timeRef          = useRef(0);
  const bitrateRef       = useRef(0);   // kbps from real throughput
  const latencyRef       = useRef(0);
  const resolutionRef    = useRef('—');
  const stallCountRef    = useRef(0);

  useEffect(() => {
    if (!playerReady || !playerRef?.current) return;
    const player = playerRef.current;

    // ── Load quality list ───────────────────────────────────────────────────
    const loadQualities = () => {
      try {
        const reps = player.getRepresentationsByType('video');
        if (reps?.length) setQualities(reps);
      } catch (_) {}
    };

    // ── QUALITY_CHANGE_RENDERED → resolution ────────────────────────────────
    const onQualityChange = (e) => {
      if (e.mediaType !== 'video') return;
      try {
        const reps = player.getRepresentationsByType('video');
        const rep  = reps?.[e.newQuality] ?? reps?.find(r => r.index === e.newQuality);
        if (rep) {
          resolutionRef.current = `${rep.width || 0}×${rep.height || 0}`;
          // Also capture nominal bitrate from representation
          if (rep.bandwidth && bitrateRef.current === 0) {
            bitrateRef.current = Math.round(rep.bandwidth / 1000);
          }
        }
      } catch (_) {}
    };

    // ── FRAGMENT_LOADING_COMPLETED → real throughput & latency ───────────────
    // This gives us actual bytes-over-wire kbps, not just nominal ABR bitrate
    const onFragment = (e) => {
      if (e.request?.mediaType !== 'video') return;
      try {
        const bytes  = e.request.bytesLoaded || 0;
        const start  = e.request.requestStartDate?.getTime?.() ?? 0;
        const end    = e.request.requestEndDate?.getTime?.()   ?? 0;
        const ms     = end - start;
        if (ms > 0) {
          latencyRef.current = ms;
          if (bytes > 0) {
            bitrateRef.current = Math.round((bytes * 8) / ms);  // kbps
          }
        }
      } catch (_) {}
    };

    // ── BUFFER_EMPTY → stall ────────────────────────────────────────────────
    const onStall = () => {
      stallCountRef.current += 1;
      setStallEvents(prev => [
        { time: timeRef.current, msg: 'Buffer underrun (stall)' },
        ...prev
      ].slice(0, 8));
    };

    player.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED,         loadQualities);
    player.on(dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED,    onQualityChange);
    player.on(dashjs.MediaPlayer.events.FRAGMENT_LOADING_COMPLETED, onFragment);
    player.on(dashjs.MediaPlayer.events.BUFFER_EMPTY,               onStall);
    setTimeout(loadQualities, 600);

    // ── Polling loop (500 ms) ───────────────────────────────────────────────
    const timer = setInterval(() => {
      if (!playerRef.current) return;
      try {
        // Buffer
        let buf = 0;
        try {
          const b = playerRef.current.getBufferLength('video');
          if (b !== null && !isNaN(b)) buf = parseFloat(b.toFixed(1));
        } catch (_) {}

        // Frames
        let dropped = 0, total = 0;
        try {
          const vq = playerRef.current.getVideoElement()?.getVideoPlaybackQuality?.();
          if (vq) { dropped = vq.droppedVideoFrames || 0; total = vq.totalVideoFrames || 0; }
        } catch (_) {}

        // Try getCurrentRepresentationForType as secondary bitrate source
        try {
          const rep = playerRef.current.getCurrentRepresentationForType('video');
          if (rep) {
            if (rep.width && rep.height) resolutionRef.current = `${rep.width}×${rep.height}`;
            if (bitrateRef.current === 0 && rep.bandwidth) {
              bitrateRef.current = Math.round(rep.bandwidth / 1000);
            }
          }
        } catch (_) {}

        const t = +(timeRef.current + 0.5).toFixed(1);
        timeRef.current = t;

        setGraphData(prev => {
          const next = [...prev, {
            t,
            bitrate: bitrateRef.current,
            buffer:  buf,
          }];
          return next.length > 60 ? next.slice(next.length - 60) : next;
        });

        setStats({
          bitrate:      bitrateRef.current,
          buffer:       buf,
          resolution:   resolutionRef.current,
          droppedFrames: dropped,
          totalFrames:   total,
          stallCount:    stallCountRef.current,
        });

        // Send telemetry to Orchestrator MEC Engine
        fetch(`${ORCHESTRATOR_URL}/telemetry`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bandwidth_bps: bitrateRef.current * 1000,
            buffer_s: buf,
            latency_ms: latencyRef.current
          })
        }).catch(() => {});

        // Fetch MEC stats
        fetch(`${ORCHESTRATOR_URL}/mec-stats`)
          .then(res => res.json())
          .then(data => setMecStats(data))
          .catch(() => {});

      } catch (_) {}
    }, 500);

    return () => {
      clearInterval(timer);
      try {
        player.off(dashjs.MediaPlayer.events.STREAM_INITIALIZED,         loadQualities);
        player.off(dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED,    onQualityChange);
        player.off(dashjs.MediaPlayer.events.FRAGMENT_LOADING_COMPLETED, onFragment);
        player.off(dashjs.MediaPlayer.events.BUFFER_EMPTY,               onStall);
      } catch (_) {}
    };
  }, [playerRef, playerReady]);

  const maxBitrate = 16000; // kbps
  const barPct     = Math.min(100, (stats.bitrate / maxBitrate) * 100);
  const bufPct     = Math.min(100, (stats.buffer  / 15) * 100);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%' }}>

      {/* ── Quality Selector ──────────────────────────────────────────────── */}
      {qualityTarget && createPortal(
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: 9, fontFamily: 'monospace', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Quality</span>
          <select
            className="select-clean"
            value={selectedQuality}
            onChange={e => {
              const v = parseInt(e.target.value);
              setSelectedQuality(v);
              if (playerRef.current) {
                playerRef.current.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: v === -1 } } } });
                if (v !== -1) playerRef.current.setRepresentationForTypeByIndex('video', v);
              }
            }}
          >
            <option value={-1}>Auto (ABR)</option>
            {qualities.map(q => (
              <option key={q.index} value={q.index}>
                {q.height || '?'}p — {Math.round((q.bandwidth || 0) / 1000)} kbps
              </option>
            ))}
          </select>
        </div>,
        qualityTarget
      )}

      {/* ── Streaming Telemetry ───────────────────────────────────────────── */}
      <div className="card" style={{ padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#3b82f6', boxShadow: '0 0 8px #3b82f6' }} />
          <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Telemetry</span>
        </div>

        <StatRow label="Resolution"     value={stats.resolution} accent="#e4e4e7" />
        <StatRow label="Dropped Frames" value={`${stats.droppedFrames} / ${stats.totalFrames}`} accent={stats.droppedFrames > 0 ? '#fbbf24' : '#e4e4e7'} />
        <StatRow label="Stalls"         value={stats.stallCount} accent={stats.stallCount > 0 ? '#ef4444' : '#10b981'} />

        {/* Bitrate bar */}
        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#71717a' }}>Throughput</span>
            <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#60a5fa', fontWeight: 600 }}>
              {stats.bitrate > 0 ? `${stats.bitrate.toLocaleString()} kbps` : '— kbps'}
            </span>
          </div>
          <MiniBar pct={barPct} color="#3b82f6" />
        </div>

        {/* Buffer bar */}
        <div style={{ marginTop: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#71717a' }}>Buffer</span>
            <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#34d399', fontWeight: 600 }}>
              {stats.buffer.toFixed(1)} s
            </span>
          </div>
          <MiniBar pct={bufPct} color={bufPct < 10 ? '#ef4444' : '#10b981'} />
        </div>
      </div>

      {/* ── MEC Stats ────────────────────────────────────────────────────── */}
      {mecStats && (
        <div className="card" style={{ padding: '10px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#a855f7', boxShadow: '0 0 8px #a855f7' }} />
            <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: '0.1em' }}>MEC FMDASH+ Engine</span>
          </div>
          
          <StatRow label="Shannon Entropy (H)" value={mecStats.entropy?.toFixed(3)} accent="#c084fc" />
          <StatRow label="Traceback Window (k)" value={mecStats.k} accent="#e4e4e7" />
          <StatRow label="Smoothed Bandwidth" value={`${(mecStats.smoothedBandwidth / 1000).toFixed(0)} kbps`} accent="#c084fc" />
          <StatRow label="MEC ABR Decision" value={`${mecStats.abrDecision} kbps`} accent="#d8b4fe" />
          <StatRow label="Bandwidth Efficiency" value={`${mecStats.utilizationPct}%`} accent="#a78bfa" />
          
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: 9, fontFamily: 'monospace', color: '#71717a' }}>Fuzzy BW</span>
              <div style={{ display: 'flex', gap: 2, marginTop: 4 }}>
                <div style={{ flex: 1, height: 4, background: `rgba(239,68,68,${Math.max(0.2, mecStats.fuzzyBw.low)})`, borderRadius: 2 }} title="Low" />
                <div style={{ flex: 1, height: 4, background: `rgba(245,158,11,${Math.max(0.2, mecStats.fuzzyBw.medium)})`, borderRadius: 2 }} title="Med" />
                <div style={{ flex: 1, height: 4, background: `rgba(16,185,129,${Math.max(0.2, mecStats.fuzzyBw.high)})`, borderRadius: 2 }} title="High" />
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: 9, fontFamily: 'monospace', color: '#71717a' }}>Fuzzy BUF</span>
              <div style={{ display: 'flex', gap: 2, marginTop: 4 }}>
                <div style={{ flex: 1, height: 4, background: `rgba(239,68,68,${Math.max(0.2, mecStats.fuzzyBuf.low)})`, borderRadius: 2 }} title="Low" />
                <div style={{ flex: 1, height: 4, background: `rgba(245,158,11,${Math.max(0.2, mecStats.fuzzyBuf.medium)})`, borderRadius: 2 }} title="Med" />
                <div style={{ flex: 1, height: 4, background: `rgba(16,185,129,${Math.max(0.2, mecStats.fuzzyBuf.high)})`, borderRadius: 2 }} title="High" />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Graphs via Portal ───────────────────────────────────────────── */}
      {graphsTarget && createPortal(
        <>
          {/* ── Bitrate History ───────────────────────────────────────────────── */}
          <div className="card" style={{ padding: '6px 10px', flex: 1, minHeight: 90, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
              <span style={{ fontSize: 9, fontFamily: 'monospace', color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Bitrate History</span>
              <span style={{ fontSize: 8, fontFamily: 'monospace', color: '#52525b' }}>30s · kbps</span>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={graphData} margin={{ top: 2, right: 4, left: -10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradBitrate" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}   />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                  <XAxis dataKey="t" hide />
                  <YAxis
                    domain={[0, dataMax => Math.max(1000, Math.ceil(dataMax * 1.15 / 500) * 500)]}
                    tickCount={4}
                    tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(1)}k` : String(v)}
                    style={{ fontSize: 8, fontFamily: 'monospace', fill: '#60a5fa' }}
                    width={28}
                  />
                  <Tooltip content={<ChartTooltip unit=" kbps" />} />
                  <Area
                    type="monotone"
                    dataKey="bitrate"
                    stroke="#3b82f6"
                    strokeWidth={1.5}
                    fill="url(#gradBitrate)"
                    dot={false}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* ── Buffer History ────────────────────────────────────────────────── */}
          <div className="card" style={{ padding: '6px 10px', flex: 1, minHeight: 90, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
              <span style={{ fontSize: 9, fontFamily: 'monospace', color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Buffer Health</span>
              <span style={{ fontSize: 8, fontFamily: 'monospace', color: '#52525b' }}>30s · sec</span>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={graphData} margin={{ top: 2, right: 4, left: -10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradBuffer" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#10b981" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0}   />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                  <XAxis dataKey="t" hide />
                  <YAxis
                    domain={[0, dataMax => Math.max(10, Math.ceil(dataMax * 1.2))]}
                    tickCount={4}
                    tickFormatter={v => `${v}s`}
                    style={{ fontSize: 8, fontFamily: 'monospace', fill: '#34d399' }}
                    width={24}
                  />
                  <Tooltip content={<ChartTooltip unit="s" />} />
                  <Area
                    type="monotone"
                    dataKey="buffer"
                    stroke="#10b981"
                    strokeWidth={1.5}
                    fill="url(#gradBuffer)"
                    dot={false}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>,
        graphsTarget
      )}

    </div>
  );
}
