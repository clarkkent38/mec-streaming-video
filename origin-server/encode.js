/**
 * encode.js — Multi-bitrate DASH encoder
 *
 * Uses FFmpeg filter_complex "split" to produce 3 video renditions + audio
 * in a single pass — the most robust cross-platform approach.
 *
 * Usage:  node encode.js [input-filename]   (default: source.mp4)
 * Requires: FFmpeg on PATH
 */

'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

// ─── Config ───────────────────────────────────────────────────────────────────

const INPUT_FILE = process.argv[2] || 'source.mp4';
const MEDIA_DIR  = path.join(__dirname, 'media');
const OUTPUT_DIR = path.join(__dirname, 'dash-output');
const INPUT_PATH = path.join(MEDIA_DIR, INPUT_FILE);
const SEG_DUR    = 2;

// ─── Sanity checks ────────────────────────────────────────────────────────────

if (!fs.existsSync(INPUT_PATH)) {
  console.error(`\n❌  Input file not found: ${INPUT_PATH}`);
  console.error('   Place your video at origin-server/media/source.mp4\n');
  process.exit(1);
}

if (fs.existsSync(OUTPUT_DIR)) fs.rmSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ─── Probe source dims ────────────────────────────────────────────────────────

let srcW = 1280, srcH = 720;
let hasAudio = false;
try {
  const raw = execSync(
    `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${INPUT_PATH}"`,
    { encoding: 'utf8' }
  ).trim();
  const [w, h] = raw.split(',').map(Number);
  if (w && h) { srcW = w; srcH = h; }
} catch (_) {}

try {
  const aStreams = execSync(
    `ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "${INPUT_PATH}"`,
    { encoding: 'utf8' }
  ).trim();
  hasAudio = aStreams.includes('audio');
} catch (_) {}

console.log(`   Audio track : ${hasAudio ? '✅ found' : '⚠️  none — will generate silent track'}`);

// Cap rendition to source size (never upscale), keep even numbers
const cap = (w, h) => [
  Math.min(w, srcW) % 2 === 0 ? Math.min(w, srcW) : Math.min(w, srcW) - 1,
  Math.min(h, srcH) % 2 === 0 ? Math.min(h, srcH) : Math.min(h, srcH) - 1,
];

const [w0, h0] = cap(1280, 720);
const [w1, h1] = cap(854,  480);
const [w2, h2] = cap(640,  360);

console.log('\n🎬  Multi-bitrate DASH encoding (filter_complex single-pass)');
console.log(`   Input  : ${INPUT_PATH}  (${srcW}x${srcH})`);
console.log(`   Output : ${OUTPUT_DIR}`);
console.log(`   R0: ${w0}x${h0} @ 2500kbps`);
console.log(`   R1: ${w1}x${h1} @ 1200kbps`);
console.log(`   R2: ${w2}x${h2} @ 700kbps`);
console.log('');

const GOP = SEG_DUR * 25; // keyframe interval = seg duration × fps

// ─── Build FFmpeg args ────────────────────────────────────────────────────────
//
// filter_complex splits the input video into 3 labelled streams,
// scales each independently, then we map each label to an output stream.
//
// Output stream order:  [v0out] [v1out] [v2out]  then audio → stream indices 0,1,2,3
// adaptation_sets uses those output stream indices.

// Build filter_complex:
// - Always split video into 3 scaled streams
// - If no audio in source, generate silent track via anullsrc
let filterComplex, audioMap;

if (hasAudio) {
  filterComplex = [
    `[0:v]split=3[vA][vB][vC]`,
    `[vA]scale=${w0}:${h0}[v0out]`,
    `[vB]scale=${w1}:${h1}[v1out]`,
    `[vC]scale=${w2}:${h2}[v2out]`,
  ].join(';');
  audioMap = ['0:a'];
} else {
  // anullsrc generates a silent stereo audio stream
  filterComplex = [
    `[0:v]split=3[vA][vB][vC]`,
    `[vA]scale=${w0}:${h0}[v0out]`,
    `[vB]scale=${w1}:${h1}[v1out]`,
    `[vC]scale=${w2}:${h2}[v2out]`,
    `anullsrc=r=44100:cl=stereo[aout]`,
  ].join(';');
  audioMap = ['[aout]'];
}

const ffmpegArgs = [
  '-y',
  '-i', INPUT_PATH,

  // Filter graph
  '-filter_complex', filterComplex,

  // Map each scaled video output
  '-map', '[v0out]',
  '-map', '[v1out]',
  '-map', '[v2out]',
  // Map audio (real or generated silent track)
  '-map', ...audioMap,

  // Video codec — applied to all video streams
  '-c:v', 'libx264',
  '-preset', 'fast',

  // Per-stream video bitrates
  '-b:v:0', '2500k', '-maxrate:v:0', '2750k', '-bufsize:v:0', '5000k',
  '-b:v:1', '1200k', '-maxrate:v:1', '1320k', '-bufsize:v:1', '2400k',
  '-b:v:2',  '700k', '-maxrate:v:2',  '770k', '-bufsize:v:2', '1400k',

  // Profiles
  '-profile:v:0', 'high',
  '-profile:v:1', 'main',
  '-profile:v:2', 'baseline',

  // Keyframe alignment (critical for DASH segment boundaries)
  '-keyint_min:v', String(GOP),
  '-g:v',          String(GOP),
  '-sc_threshold:v', '0',

  // Audio
  '-c:a', 'aac',
  '-b:a', '128k',
  '-ac', '2',
  '-ar', '44100',

  // If we generated a silent track via anullsrc, trim it to video length
  ...(hasAudio ? [] : ['-shortest']),

  // DASH muxer
  '-f', 'dash',
  '-seg_duration', String(SEG_DUR),
  '-use_timeline', '1',
  '-use_template', '1',
  // Output stream indices: 0,1,2 = video renditions; 3 = audio
  '-adaptation_sets', 'id=0,streams=0,1,2 id=1,streams=3',

  'manifest.mpd',
];

// ─── Run ─────────────────────────────────────────────────────────────────────

const start = Date.now();

const ff = spawn('ffmpeg', ffmpegArgs, {
  stdio: ['ignore', 'pipe', 'pipe'],
  cwd: OUTPUT_DIR,   // ← segments written relative to this dir
});

ff.stderr.on('data', d => {
  const s = d.toString();
  if (s.includes('time=') || s.toLowerCase().includes('error')) {
    process.stdout.write('\r  ' + s.trim().substring(0, 100).padEnd(102));
  }
});

ff.on('error', err => {
  if (err.code === 'ENOENT') {
    console.error('\n\n❌  FFmpeg not found on PATH. Install it first — see README.\n');
  } else {
    console.error('\n\n❌  spawn error:', err.message);
  }
  process.exit(1);
});

ff.on('close', code => {
  process.stdout.write('\n');
  if (code !== 0) {
    console.error(`\n❌  FFmpeg exited with code ${code}.`);
    process.exit(1);
  }

  const files      = fs.readdirSync(OUTPUT_DIR);
  const mpd        = files.find(f => f.endsWith('.mpd'));
  const initSegs   = files.filter(f => f.endsWith('.mp4'));
  const mediaSegs  = files.filter(f => f.endsWith('.m4s'));
  const totalBytes = files.reduce((acc, f) => {
    try { return acc + fs.statSync(path.join(OUTPUT_DIR, f)).size; } catch { return acc; }
  }, 0);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  ✅  DASH encoding complete!                     ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Time elapsed   : ${String(elapsed + 's').padEnd(30)} ║`);
  console.log(`║  Manifest       : ${String(mpd || 'N/A').padEnd(30)} ║`);
  console.log(`║  Init segments  : ${String(initSegs.length).padEnd(30)} ║`);
  console.log(`║  Media segments : ${String(mediaSegs.length).padEnd(30)} ║`);
  console.log(`║  Total disk use : ${String((totalBytes/1024/1024).toFixed(2)+' MB').padEnd(30)} ║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Manifest URL (after npm start):                 ║`);
  console.log(`║  http://localhost:3000/dash/manifest.mpd         ║`);
  console.log('╚══════════════════════════════════════════════════╝\n');
});
