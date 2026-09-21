/**
 * src/config.js
 *
 * Exposes core environment variables and endpoints for the frontend.
 * Edge node URLs are discovered dynamically at runtime via the orchestrator.
 * 
 * When deployed on Render via render.yaml, all VITE_* env vars are
 * automatically injected. Localhost fallbacks are used for local dev.
 */

// Detect if running in cloud (Render, Vercel, custom domain) vs local machine
const isCloudDeploy = typeof window !== 'undefined' && 
  window.location.hostname !== 'localhost' && 
  window.location.hostname !== '127.0.0.1';

// Central Orchestrator URL (VNFM Controller) — injected by Render via render.yaml
export const ORCHESTRATOR_URL = import.meta.env.VITE_ORCHESTRATOR_URL || 
  (isCloudDeploy ? '' : 'http://localhost:5000');

// Central Origin Server URL (Cloud DASH Media) — injected by Render via render.yaml
export const ORIGIN_URL = import.meta.env.VITE_ORIGIN_URL || 
  (isCloudDeploy ? '' : 'http://localhost:3000');

// Direct Origin Manifest URL (Baseline fallback)
export const ORIGIN_MANIFEST = import.meta.env.VITE_ORIGIN_MANIFEST || 
  `${ORIGIN_URL}/dash/manifest.mpd`;

export const IS_LAN_MODE = import.meta.env.VITE_LAN === 'true';

// Available multi-bitrate video streams
export const VIDEO_CATALOG = [
  {
    id: 'bbb',
    title: '🐰 Big Buck Bunny (Animation · 5 Bitrates: 240p to 1080p)',
    path: '/dash/manifest.mpd',
    badge: 'Standard ABR Benchmark'
  },
  {
    id: 'envivio',
    title: '⚡ Envivio Action Showcase (High Dynamics · 6 Bitrates)',
    path: '/dash/envivio/manifest.mpd',
    badge: 'HDR Multi-rate'
  },
  {
    id: 'tos',
    title: '🚀 Tears of Steel (Sci-Fi · 4K / HD Ladder)',
    path: '/dash/tos/manifest.mpd',
    badge: 'Cinematic Film'
  }
];

/**
 * Helper to construct manifest URL for any dynamic edge node
 * @param {string} edgeBaseUrl - Base URL of edge (e.g. https://... or http://192.168.1.5:5001)
 * @param {string} streamPath - Path to manifest (e.g. /dash/manifest.mpd or /dash/envivio/manifest.mpd)
 * @returns {string} The full DASH manifest URL
 */
export const getEdgeManifestUrl = (edgeBaseUrl, streamPath = '/dash/manifest.mpd') => {
  if (!edgeBaseUrl) return getOriginManifestUrl(streamPath);
  const cleanBase = edgeBaseUrl.replace(/\/$/, '');
  const cleanPath = streamPath.startsWith('/') ? streamPath : `/${streamPath}`;
  return `${cleanBase}${cleanPath}`;
};

export const getOriginManifestUrl = (streamPath = '/dash/manifest.mpd') => {
  // Origin is on Render — it has the Express /dash/ route prefix
  const cleanPath = streamPath.startsWith('/') ? streamPath : `/${streamPath}`;
  return `${ORIGIN_URL}${cleanPath}`;
};
