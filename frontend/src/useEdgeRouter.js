/**
 * src/useEdgeRouter.js
 *
 * React hook — manages edge routing, failover, and the routing event log.
 *
 * Behaviour:
 *  - Direct mode:  returns origin manifest URL immediately, no orchestrator call.
 *  - Edge mode:    calls GET /best-node → uses returned edge node URL for manifest.
 *                  If a segment fetch fails (detected via dash.js ERROR event),
 *                  re-calls /best-node and switches to next available node.
 *                  Every routing decision is appended to a visible event log.
 *
 * Returns: { manifestUrl, activeNode, routeLog, resolveManifest, handleSegmentError }
 */

import { useState, useCallback, useRef } from 'react';
import { ORIGIN_MANIFEST, ORCHESTRATOR_URL } from './config';

function ts() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

export function useEdgeRouter(isEdgeMode) {
  const [manifestUrl, setManifestUrl]   = useState(null);
  const [activeNode,  setActiveNode]    = useState(null);
  const [routeLog,    setRouteLog]      = useState([]);
  const failingRef    = useRef(false);   // debounce concurrent failover calls
  const activeNodeRef = useRef(null);    // mirror of activeNode — avoids stale closure in handleSegmentError

  // Keep ref in sync whenever state updates
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
    }, ...prev].slice(0, 30)); // keep last 30 entries
  }, []);

  // ── resolveManifest ────────────────────────────────────────────────────────
  // Called on mount or when the mode toggle changes.
  // Returns the manifest URL string (also sets state).

  const resolveManifest = useCallback(async () => {
    if (!isEdgeMode) {
      appendLog('info', 'Direct Mode — fetching from origin');
      setActiveNodeBoth({ id: 'origin', url: ORIGIN_MANIFEST, delay_ms: null });
      setManifestUrl(ORIGIN_MANIFEST);
      return ORIGIN_MANIFEST;
    }

    appendLog('info', 'Edge Mode — Context-Aware routing query to orchestrator…');
    try {
      const contextPayload = {
        device: 'mobile',
        network: '5G',
        location: 'US-East'
      };
      
      const res  = await fetch(`${ORCHESTRATOR_URL}/context-route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(contextPayload)
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        appendLog('warn', `No edge nodes UP — falling back to origin. (${data.error || 'unknown'})`);
        setActiveNodeBoth({ id: 'origin', url: ORIGIN_MANIFEST, delay_ms: null });
        setManifestUrl(ORIGIN_MANIFEST);
        return ORIGIN_MANIFEST;
      }

      const node = data.best_node;
      const url  = `${node.url}/dash/manifest.mpd`;
      appendLog('success', `Routed to ${node.id} (delay=${node.delay_ms}ms) | Score: ${data.context_applied?.score || 'N/A'}`);
      setActiveNodeBoth(node);
      setManifestUrl(url);
      return url;

    } catch (err) {
      appendLog('error', `Orchestrator unreachable — falling back to origin. (${err.message})`);
      setActiveNodeBoth({ id: 'origin', url: ORIGIN_MANIFEST, delay_ms: null });
      setManifestUrl(ORIGIN_MANIFEST);
      return ORIGIN_MANIFEST;
    }
  }, [isEdgeMode, appendLog, setActiveNodeBoth]);

  // ── handleSegmentError ─────────────────────────────────────────────────────
  // Called by App when dash.js fires a download error.
  // Re-queries /context-route and returns the new manifest URL for player re-init.

  // Uses activeNodeRef (not state) so this callback never needs to change identity
  // even when the active node changes — this prevents the infinite re-render loop in App.jsx
  const handleSegmentError = useCallback(async () => {
    if (!isEdgeMode || failingRef.current) return null;
    failingRef.current = true;

    appendLog('warn', '⚠ Segment download failed — initiating context-aware failover…');

    try {
      const contextPayload = {
        device: 'mobile',
        network: '5G',
        location: 'US-East'
      };

      const res  = await fetch(`${ORCHESTRATOR_URL}/context-route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(contextPayload)
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        appendLog('error', `Failover failed — no UP nodes. Staying on origin. (${data.error})`);
        failingRef.current = false;
        return null;
      }

      const node    = data.best_node;
      const newUrl  = `${node.url}/dash/manifest.mpd`;

      // Read from ref — avoids activeNode being a dep that causes re-renders
      if (node.url === activeNodeRef.current?.url) {
        appendLog('warn', 'Failover: same node re-selected — may still be recovering.');
      } else {
        appendLog('success', `✅ Failover complete → ${node.id} (delay=${node.delay_ms}ms) | Score: ${data.context_applied?.score || 'N/A'}`);
      }

      setActiveNodeBoth(node);
      setManifestUrl(newUrl);
      failingRef.current = false;
      return newUrl;

    } catch (err) {
      appendLog('error', `Failover error: ${err.message}`);
      failingRef.current = false;
      return null;
    }
  }, [isEdgeMode, appendLog, setActiveNodeBoth]); // NO activeNode dep — uses ref instead

  return { manifestUrl, activeNode, routeLog, resolveManifest, handleSegmentError };
}
