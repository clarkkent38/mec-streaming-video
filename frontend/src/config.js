/**
 * src/config.js
 *
 * Exposes core environment variables and endpoints for the frontend.
 * Edge node URLs are discovered dynamically at runtime via the orchestrator.
 */

// Detect if running in cloud (Vercel, Render, custom domain) vs local machine
const isCloudDeploy = typeof window !== 'undefined' && 
  window.location.hostname !== 'localhost' && 
  window.location.hostname !== '127.0.0.1';

// Production Render backend defaults
export const RENDER_ORCHESTRATOR = 'https://mec-orchestrator.onrender.com';
export const RENDER_ORIGIN       = 'https://mec-origin-server.onrender.com';

// Central Orchestrator URL (VNFM Controller)
export const ORCHESTRATOR_URL = import.meta.env.VITE_ORCHESTRATOR_URL || 
  (isCloudDeploy ? RENDER_ORCHESTRATOR : 'http://localhost:5000');

// Central Origin Server URL (Cloud DASH Media)
export const ORIGIN_URL = import.meta.env.VITE_ORIGIN_URL || 
  (isCloudDeploy ? RENDER_ORIGIN : 'http://localhost:3000');

// Direct Origin Manifest URL (Baseline fallback)
export const ORIGIN_MANIFEST = import.meta.env.VITE_ORIGIN_MANIFEST || 
  `${ORIGIN_URL}/dash/manifest.mpd`;

export const IS_LAN_MODE = import.meta.env.VITE_LAN === 'true';

/**
 * Helper to construct manifest URL for any dynamic edge node
 * @param {string} edgeBaseUrl - The full base URL of the edge (e.g. http://192.168.1.5:5001)
 * @returns {string} The full DASH manifest URL
 */
export const getEdgeManifestUrl = (edgeBaseUrl) => {
  if (!edgeBaseUrl) return ORIGIN_MANIFEST;
  const cleanBase = edgeBaseUrl.replace(/\/$/, '');
  return `${cleanBase}/dash/manifest.mpd`;
};
