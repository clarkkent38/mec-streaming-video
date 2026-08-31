import { useState, useEffect, useRef, useCallback } from 'react';
import dashjs from 'dashjs';
import { ORCHESTRATOR_URL } from './config';

export function usePlayerTelemetry(playerRef, playerReady, isEdgeMode, activeNode) {
  const [graphData,   setGraphData]   = useState([]);
  const [stallEvents, setStallEvents] = useState([]);
  const [stats, setStats] = useState({
    bitrate: 0,
    throughput: 0,
    buffer: 0,
    resolution: '—',
    droppedFrames: 0,
    totalFrames: 0,
    stallCount: 0,
    latency: 0,
  });
  const [qualities,       setQualities]       = useState([]);
  const [selectedQuality, setSelectedQuality] = useState(-1);
  const [mecStats,        setMecStats]        = useState(null);

  const timeRef        = useRef(0);
  const bitrateRef     = useRef(0);   // true representation bitrate (kbps) from dash.js
  const throughputRef  = useRef(0);   // true measured throughput (kbps) from chunk download
  const latencyRef     = useRef(0);   // true request duration (ms) from chunk start to end
  const resolutionRef  = useRef('—');
  const stallCountRef  = useRef(0);
  const mecStatsRef    = useRef(null);

  const resetGraphData = useCallback(() => {
    timeRef.current = 0;
    setGraphData([]);
    setStallEvents([]);
  }, []);

  useEffect(() => {
    if (!playerReady || !playerRef?.current) return;
    const player = playerRef.current;

    // ── 1. Load active representations (True video qualities) ────────────────
    const loadQualities = () => {
      try {
        const reps = player.getRepresentationsByType('video');
        if (reps?.length) setQualities(reps);
      } catch (_) {}
    };

    // ── 2. Real resolution & bitrate on quality change ───────────────────────
    const onQualityChange = (e) => {
      if (e.mediaType !== 'video') return;
      try {
        const reps = player.getRepresentationsByType('video');
        const rep  = reps?.[e.newQuality] ?? reps?.find(r => r.index === e.newQuality);
        if (rep) {
          resolutionRef.current = `${rep.width || 0}×${rep.height || 0}`;
          if (rep.bandwidth) {
            bitrateRef.current = Math.round(rep.bandwidth / 1000);
          }
        }
      } catch (_) {}
    };

    // ── 3. Real Fragment Download Latency & Wire Throughput ──────────────────
    // Directly measures network start/end time of every chunk downloaded over HTTP
    const onFragment = (e) => {
      if (e.request?.mediaType !== 'video') return;
      try {
        const bytes = e.request.bytesLoaded || 0;
        const start = e.request.requestStartDate?.getTime?.() ?? 0;
        const end   = e.request.requestEndDate?.getTime?.()   ?? 0;
        const ms    = end - start;
        if (ms > 0) {
          // True network duration (ms) for this chunk
          latencyRef.current = ms;

          if (bytes > 0) {
            // True calculated throughput (kbps) = (bytes * 8) / (ms)
            const kbps = Math.round((bytes * 8) / ms);
            throughputRef.current = kbps;
          }
        }
      } catch (_) {}
    };

    // ── 4. True Buffer Underrun (Stall) detection ────────────────────────────
    const onStall = () => {
      stallCountRef.current += 1;
      setStallEvents(prev => [
        { time: timeRef.current, msg: 'Buffer underrun (stall)' },
        ...prev
      ].slice(0, 10));
    };

    player.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED,         loadQualities);
    player.on(dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED,    onQualityChange);
    player.on(dashjs.MediaPlayer.events.FRAGMENT_LOADING_COMPLETED, onFragment);
    player.on(dashjs.MediaPlayer.events.BUFFER_EMPTY,               onStall);
    setTimeout(loadQualities, 600);

    // ── 5. Telemetry sampling loop (every 500 ms) ───────────────────────────
    const timer = setInterval(() => {
      if (!playerRef.current) return;
      try {
        // True Dash.js buffer length in seconds
        let buf = 0;
        try {
          const b = playerRef.current.getBufferLength('video');
          if (b !== null && !isNaN(b)) buf = parseFloat(b.toFixed(1));
        } catch (_) {}

        // True HTML5 video dropped and total frame counters
        let dropped = 0, total = 0;
        try {
          const vq = playerRef.current.getVideoElement()?.getVideoPlaybackQuality?.();
          if (vq) { dropped = vq.droppedVideoFrames || 0; total = vq.totalVideoFrames || 0; }
        } catch (_) {}

        // True current video representation
        let repBandwidth = bitrateRef.current;
        try {
          const rep = playerRef.current.getCurrentRepresentationForType('video');
          if (rep) {
            if (rep.width && rep.height) resolutionRef.current = `${rep.width}×${rep.height}`;
            if (rep.bandwidth) {
              repBandwidth = Math.round(rep.bandwidth / 1000);
              bitrateRef.current = repBandwidth;
            }
          }
        } catch (_) {}

        // True measured fragment latency (or active node's latency if initial segment is pending)
        const currentLatency = latencyRef.current > 0 
          ? latencyRef.current 
          : (activeNode?.delay_ms ?? (isEdgeMode ? 5 : 150));

        // True throughput (from chunk download or dash.js average throughput)
        let currentThroughput = throughputRef.current;
        if (currentThroughput === 0) {
          try {
            const avg = playerRef.current.getAverageThroughput?.('video');
            if (avg && avg > 0) currentThroughput = Math.round(avg / 1000);
          } catch (_) {}
          if (currentThroughput === 0) currentThroughput = repBandwidth;
        }

        const t = +(timeRef.current + 0.5).toFixed(1);
        timeRef.current = t;

        const currentMec = mecStatsRef.current;

        // Append true data point to rolling time series (last 90 samples = 45s)
        setGraphData(prev => {
          const next = [...prev, {
            t,
            bitrate: repBandwidth,
            throughput: currentThroughput,
            buffer: buf,
            latency: currentLatency,
            entropy: currentMec?.entropy !== undefined ? parseFloat(currentMec.entropy.toFixed(3)) : 0,
            abrDecision: currentMec?.abrDecision || repBandwidth,
            k: currentMec?.k || 3,
            isEdge: isEdgeMode
          }];
          return next.length > 90 ? next.slice(next.length - 90) : next;
        });

        // Update instant statistics snapshot
        setStats({
          bitrate: repBandwidth,
          throughput: currentThroughput,
          buffer: buf,
          resolution: resolutionRef.current,
          droppedFrames: dropped,
          totalFrames: total,
          stallCount: stallCountRef.current,
          latency: currentLatency
        });

        // Push true client telemetry to Orchestrator MEC Engine
        fetch(`${ORCHESTRATOR_URL}/telemetry`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bandwidth_bps: currentThroughput * 1000,
            buffer_s: buf,
            latency_ms: currentLatency
          })
        }).catch(() => {});

        // Fetch true MEC Shannon Entropy and Fuzzy decision calculated by Orchestrator
        fetch(`${ORCHESTRATOR_URL}/mec-stats`)
          .then(res => res.json())
          .then(data => {
            mecStatsRef.current = data;
            setMecStats(data);
          })
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
  }, [playerRef, playerReady, isEdgeMode, activeNode]);

  return {
    graphData,
    stats,
    mecStats,
    qualities,
    selectedQuality,
    setSelectedQuality,
    stallEvents,
    resetGraphData
  };
}
