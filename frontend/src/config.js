/**
 * src/config.js
 *
 * Exposes environment variables or defaults for the frontend.
 */

// Allow overriding via VITE_ variables (Railway/Docker compatible)
export const ORCHESTRATOR_URL = import.meta.env.VITE_ORCHESTRATOR_URL || 'http://localhost:5000';
export const ORIGIN_URL       = import.meta.env.VITE_ORIGIN_URL       || 'http://localhost:3000';
export const ORIGIN_MANIFEST  = import.meta.env.VITE_ORIGIN_MANIFEST  || `${ORIGIN_URL}/dash/manifest.mpd`;
export const IS_LAN_MODE      = import.meta.env.VITE_LAN === 'true';

// Base URLs for direct control (Scenario Panel)
export const EDGE1_URL  = import.meta.env.VITE_EDGE1_URL  || 'http://localhost:4001';
export const EDGE2_URL  = import.meta.env.VITE_EDGE2_URL  || 'http://localhost:4002';

// Helper to resolve an edge node URL depending on LAN mode
export const getEdgeManifestUrl = (edgePort, edgeHostUrl) => {
  if (edgeHostUrl) {
    // If orchestrator explicitly provided a full URL for the node, use it
    return `${edgeHostUrl}/dash/manifest.mpd`;
  }
  
  if (IS_LAN_MODE) {
    const hostIp = window.location.hostname;
    return `http://${hostIp}:${edgePort}/dash/manifest.mpd`;
  }
  return `http://localhost:${edgePort}/dash/manifest.mpd`;
};
