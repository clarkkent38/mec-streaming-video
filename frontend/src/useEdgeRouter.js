/**
 * src/useEdgeRouter.js
 *
 * React hook — manages dynamic edge routing, failover, and the routing event log.
 *
 * Behaviour:
 *  - Direct mode:  returns origin manifest URL immediately, no edge routing.
 *  - Edge mode:    calls GET /api/orchestrator/best-edge to get the best online edge.
 *                  If zero edges are registered or online, falls back gracefully to Origin.
 *                  If a segment fetch fails, re-queries /best-edge and switches nodes.
 *
 * Returns: { manifestUrl, activeNode, routeLog, resolveManifest, handleSegmentError }
 */

import { useState, useCallback, useRef } from 'react';
import { ORIGIN_MANIFEST, ORCHESTRATOR_URL, getEdgeManifestUrl } from './config';

function ts() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

export function useEdgeRouter(isEdgeMode) {
  const [manifestUrl, setManifestUrl]   = useState(null);
  const [activeNode,  setActiveNode]    = useState(null);
  const [routeLog,    setRouteLog]      = useState([]);
  const failingRef    = useRef(false);   // debounce concurrent failover calls
  const activeNodeRef = useRef(null);    // mirror of activeNode to avoid stale closure

  const setActiveNodeBoth = useCallback((node) => {
    activeNodeRef.current = node;
    setActiveNode(node);
  }, []);

  const appendLog = useCallback((type, message) => {
    setRouteLog(prev => [{
      id:   Date.now() + Math.random(),
      ts:   ts(),
      type, // 'info' | 'success' | 'warn' | 'error'
      message,
    }, ...prev].slice(0, 30));
  }, []);

  // ── resolveManifest ────────────────────────────────────────────────────────
  const resolveManifest = useCallback(async (streamPath = '/dash/manifest.mpd') => {
    const originUrl = getEdgeManifestUrl(null, streamPath);
    if (!isEdgeMode) {
      appendLog('info', `Direct Mode — Streaming from Origin Cloud (${streamPath})`);
      setActiveNodeBoth({
        id: 'origin',
        edgeId: 'origin',
        label: 'Origin Server (Cloud)',
        url: originUrl,
        measuredLatencyMs: 150,
        delay_ms: 150,
      });
      setManifestUrl(originUrl);
      return originUrl;
    }

    appendLog('info', 'Edge Mode — Querying VNFM Orchestrator for best edge…');
    try {
      // 1. Query dynamic best-edge endpoint
      let res = await fetch(`${ORCHESTRATOR_URL}/api/orchestrator/best-edge`);
      if (!res.ok) {
        // Fallback to legacy /best-node if needed
        res = await fetch(`${ORCHESTRATOR_URL}/best-node`);
      }

      const data = await res.json();

      if (!res.ok || data.error || (!data.best_edge && !data.best_node)) {
        appendLog('warn', `No edge nodes currently online — playing direct from origin. (${data.error || '0 edges online'})`);
        setActiveNodeBoth({
          id: 'origin',
          edgeId: 'origin',
          label: 'Origin Server (Cloud Fallback)',
          url: originUrl,
          measuredLatencyMs: 150,
          delay_ms: 150,
          isFallback: true,
        });
        setManifestUrl(originUrl);
        return originUrl;
      }

      const node = data.best_edge || data.best_node;
      const url  = getEdgeManifestUrl(node.url, streamPath);
      const latencyDisplay = node.measuredLatencyMs != null ? `${node.measuredLatencyMs}ms` : `${node.delay_ms || 5}ms`;

      appendLog('success', `✓ Routed to ${node.label || node.edgeId || node.id} (RTT: ${latencyDisplay}) | Score: ${node.score || 'N/A'}`);
      setActiveNodeBoth(node);
      setManifestUrl(url);
      return url;

    } catch (err) {
      appendLog('error', `Orchestrator unreachable — falling back to origin. (${err.message})`);
      setActiveNodeBoth({
        id: 'origin',
        edgeId: 'origin',
        label: 'Origin Server (Cloud Fallback)',
        url: originUrl,
        measuredLatencyMs: 150,
        delay_ms: 150,
        isFallback: true,
      });
      setManifestUrl(originUrl);
      return originUrl;
    }
  }, [isEdgeMode, appendLog, setActiveNodeBoth]);

  // ── handleSegmentError ─────────────────────────────────────────────────────
  const handleSegmentError = useCallback(async () => {
    if (!isEdgeMode || failingRef.current) return null;
    failingRef.current = true;

    appendLog('warn', '⚠ Segment download failed — initiating autonomous VNF failover…');

    try {
      let res = await fetch(`${ORCHESTRATOR_URL}/api/orchestrator/best-edge`);
      if (!res.ok) {
        res = await fetch(`${ORCHESTRATOR_URL}/best-node`);
      }
      const data = await res.json();

      if (!res.ok || data.error || (!data.best_edge && !data.best_node)) {
        appendLog('error', `Failover: No other edge online. Switching to origin directly.`);
        failingRef.current = false;
        setActiveNodeBoth({
          id: 'origin',
          edgeId: 'origin',
          label: 'Origin Server (Cloud Fallback)',
          url: ORIGIN_MANIFEST,
          measuredLatencyMs: 150,
          delay_ms: 150,
          isFallback: true,
        });
        setManifestUrl(ORIGIN_MANIFEST);
        return ORIGIN_MANIFEST;
      }

      const node = data.best_edge || data.best_node;
      const newUrl = getEdgeManifestUrl(node.url);
      const latencyDisplay = node.measuredLatencyMs != null ? `${node.measuredLatencyMs}ms` : `${node.delay_ms || 5}ms`;

      if (node.url === activeNodeRef.current?.url) {
        appendLog('warn', 'Failover: Same edge node re-selected — waiting for recovery.');
      } else {
        appendLog('success', `✅ Failover complete → ${node.label || node.edgeId || node.id} (RTT: ${latencyDisplay})`);
      }

      setActiveNodeBoth(node);
      setManifestUrl(newUrl);
      failingRef.current = false;
      return newUrl;

    } catch (err) {
      appendLog('error', `Failover error: ${err.message}. Falling back to origin.`);
      failingRef.current = false;
      setActiveNodeBoth({
        id: 'origin',
        edgeId: 'origin',
        label: 'Origin Server (Cloud Fallback)',
        url: ORIGIN_MANIFEST,
        measuredLatencyMs: 150,
        delay_ms: 150,
        isFallback: true,
      });
      setManifestUrl(ORIGIN_MANIFEST);
      return ORIGIN_MANIFEST;
    }
  }, [isEdgeMode, appendLog, setActiveNodeBoth]);

  return { manifestUrl, activeNode, routeLog, resolveManifest, handleSegmentError };
}
