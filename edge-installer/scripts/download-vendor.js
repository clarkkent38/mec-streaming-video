#!/usr/bin/env node
/**
 * scripts/download-vendor.js
 * Downloads Chart.js UMD bundle into src/vendor/ so the dashboard works
 * fully offline (no CDN required at runtime).
 * Run once before building: node scripts/download-vendor.js
 */

'use strict';
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const VENDOR_DIR = path.join(__dirname, '..', 'src', 'vendor');
const CHART_URL  = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js';
const CHART_OUT  = path.join(VENDOR_DIR, 'chart.umd.min.js');

if (!fs.existsSync(VENDOR_DIR)) fs.mkdirSync(VENDOR_DIR, { recursive: true });

if (fs.existsSync(CHART_OUT)) {
  console.log('✓ chart.umd.min.js already present — skipping download.');
  process.exit(0);
}

console.log('Downloading Chart.js…');
const file = fs.createWriteStream(CHART_OUT);

https.get(CHART_URL, (res) => {
  if (res.statusCode !== 200) {
    console.error(`ERROR: HTTP ${res.statusCode} from ${CHART_URL}`);
    fs.unlinkSync(CHART_OUT);
    process.exit(1);
  }
  res.pipe(file);
  file.on('finish', () => {
    file.close();
    const size = fs.statSync(CHART_OUT).size;
    console.log(`✓ chart.umd.min.js downloaded (${(size/1024).toFixed(0)} KB)`);
  });
}).on('error', (err) => {
  console.error('Download failed:', err.message);
  try { fs.unlinkSync(CHART_OUT); } catch (_) {}
  process.exit(1);
});
