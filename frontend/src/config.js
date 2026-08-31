/**
 * src/config.js
 *
 * Exposes environment variables or defaults for the frontend.
 */

// Detect if running in cloud (Vercel, Render, custom domain) vs local machine
const isCloudDeploy = typeof window !== 'undefined' && 
  window.location.hostname !== 'localhost' && 
  window.location.hostname !== '127.0.0.1';

// Production Render backend endpoints (provided by user)
export const RENDER_ORCHESTRATOR = 'https://orchestrator-xfwd.onrender.com';
export const RENDER_ORIGIN       = 'https://origin-server-h42h.onrender.com';
export const RENDER_EDGE1        = 'https://edge-node-1.onrender.com';
export const RENDER_EDGE2        = 'https://edge-node-2.onrender.com';

// Allow overriding via VITE_ variables (Vercel / Render / Docker compatible)
export const ORCHESTRATOR_URL = import.meta.env.VITE_ORCHESTRATOR_URL || 
  (isCloudDeploy ? RENDER_ORCHESTRATOR : 'http://localhost:5000');

export const ORIGIN_URL = import.meta.env.VITE_ORIGIN_URL || 
  (isCloudDeploy ? RENDER_ORIGIN : 'http://localhost:3000');

export const ORIGIN_MANIFEST = import.meta.env.VITE_ORIGIN_MANIFEST || 
  `${ORIGIN_URL}/dash/manifest.mpd`;

export const IS_LAN_MODE = import.meta.env.VITE_LAN === 'true';

// Base URLs for direct control (Scenario Panel)
export const EDGE1_URL = import.meta.env.VITE_EDGE1_URL || 
  (isCloudDeploy ? RENDER_EDGE1 : 'http://localhost:4001');

export const EDGE2_URL = import.meta.env.VITE_EDGE2_URL || 
  (isCloudDeploy ? RENDER_EDGE2 : 'http://localhost:4002');

// Helper to resolve an edge node URL depending on LAN mode or cloud
export const getEdgeManifestUrl = (edgePort, edgeHostUrl) => {
  if (edgeHostUrl) {
    return `${edgeHostUrl}/dash/manifest.mpd`;
  }
  
  if (isCloudDeploy) {
    if (edgePort === 4001 || edgePort === 3001) return `${RENDER_EDGE1}/dash/manifest.mpd`;
    if (edgePort === 4002 || edgePort === 3002) return `${RENDER_EDGE2}/dash/manifest.mpd`;
    return `${RENDER_ORIGIN}/dash/manifest.mpd`;
  }

  if (IS_LAN_MODE) {
    const hostIp = window.location.hostname;
    return `http://${hostIp}:${edgePort}/dash/manifest.mpd`;
  }
  return `http://localhost:${edgePort}/dash/manifest.mpd`;
};
