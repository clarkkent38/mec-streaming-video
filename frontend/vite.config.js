import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import os from 'os';

// Detect the machine's LAN IP (first non-internal IPv4 address)
function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

const IS_LAN = process.env.VITE_LAN === 'true';
const LAN_IP = getLanIp();

export default defineConfig({
  plugins: [react(), tailwindcss()],

  // Inject LAN IP so config.js can use it at runtime
  define: {
    'import.meta.env.VITE_LAN_IP': JSON.stringify(LAN_IP),
  },

  server: {
    port: 5173,
    open: false,
    // 0.0.0.0 only when LAN mode is explicitly requested
    host: IS_LAN ? '0.0.0.0' : 'localhost',
  },
});
