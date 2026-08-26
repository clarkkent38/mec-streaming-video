# Edge-based Video Streaming Optimization — VNF Orchestration Demo

> **Based on:** "NFV-Based Mobile Edge Computing for Lowering Latency of 4K Video Streaming"
> Ma et al., ICUFN 2018

---

## Project Structure

```
edge-streaming-project/
├── origin-server/       ← DASH origin (port 3000)
│   ├── media/           ← Place source video here (source.mp4)
│   ├── dash-output/     ← Generated DASH segments (auto-created)
│   ├── encode.js        ← FFmpeg multi-bitrate encoder
│   └── server.js        ← Express static server
├── edge-node/           ← Simulated MEC/VNF process (ports 3001–3003)
├── orchestrator/        ← VNF lifecycle + routing controller (port 4000)
├── frontend/            ← React player + live dashboard (port 5173)
├── network-sim/         ← Cross-platform latency/bandwidth injection
├── testing/             ← Comparison scripts, logs, charts
│   └── logs/
└── docs/                ← Report, phase notes
```

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 18 | https://nodejs.org |
| npm | ≥ 9 | bundled with Node |
| FFmpeg | any recent | see below |

### Install FFmpeg (Windows — free, official)

**Option A — Winget (easiest):**
```powershell
winget install --id Gyan.FFmpeg -e --source winget
```
Then close & reopen your terminal.

**Option B — Manual zip:**
1. Download from https://www.gyan.dev/ffmpeg/builds/ → `ffmpeg-release-essentials.zip`
2. Extract to `C:\ffmpeg\`
3. Add `C:\ffmpeg\bin` to your user PATH
4. Restart terminal

Verify: `ffmpeg -version`

---

## Phase 1 — Origin Server Setup

### Step 1 — Get a test video

Download any of the following free, Creative Commons–licensed clips:

| Source | URL | License |
|--------|-----|---------|
| Big Buck Bunny (1 min, 720p) | https://test-videos.co.uk/bigbuckbunny/mp4-h264 | CC-BY |
| Blender Foundation (full film) | https://download.blender.org/peach/bigbuckbunny_movies/ | CC-BY |
| Xiph test media | https://media.xiph.org/video/derf/ | free |

Save your chosen file as:
```
origin-server/media/source.mp4
```
Or pass a different filename to the encoder:
```powershell
node encode.js myvideo.mp4
```

### Step 2 — Install dependencies

```powershell
cd origin-server
npm install
```

### Step 3 — Encode to DASH

```powershell
npm run encode
# or: node encode.js source.mp4
```

This produces multi-bitrate DASH segments in `origin-server/dash-output/`:
- `manifest.mpd` — MPEG-DASH manifest
- `init-0.mp4`, `init-1.mp4`, `init-2.mp4`, `init-3.mp4` — init segments
- `seg-*-*.m4s` — 2-second media segments (1080p / 720p / 360p + audio)

### Step 4 — Start the origin server

```powershell
npm start
# or: node server.js
```

Server runs on **http://localhost:3000**

| Endpoint | Description |
|----------|-------------|
| `GET /dash/manifest.mpd` | DASH manifest |
| `GET /dash/seg-*.m4s` | Media segments |
| `GET /health` | Health check (JSON) |
| `GET /stats` | Memory + disk stats (JSON) |
| `GET /manifest` | Redirect to manifest |

### Step 5 — Verify

```powershell
# Fetch manifest
curl http://localhost:3000/dash/manifest.mpd

# Check stats
curl http://localhost:3000/stats
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `NODE_LABEL` | origin | Display name (used by orchestrator) |
| `DELAY_MS` | 0 | Artificial per-request latency (ms) |

Example — simulate 80ms latency:
```powershell
$env:DELAY_MS=80; node server.js
```

---

## VNF Simulation Architecture

> **Process-level VNF simulation** — each "edge node" is a plain Node.js process
> on a separate localhost port, simulating a virtualized network function (VNF)
> running at a Mobile Edge Computing (MEC) host.
>
> Real containerization (Docker/Kubernetes) is left as **future work** to avoid
> Windows virtualization risks on student hardware.

```
Browser (Player)
      │
      ▼
  Orchestrator :4000          ← VNF lifecycle management
   ├─ origin-server  :3000    ← Direct-to-origin (baseline)
   ├─ edge-node-1    :3001    ← MEC node 1 (simulated VNF)
   ├─ edge-node-2    :3002    ← MEC node 2 (simulated VNF)
   └─ edge-node-3    :3003    ← MEC node 3 (simulated VNF)
```

---

## License

Source code: MIT
Test video (Big Buck Bunny): Creative Commons Attribution 3.0 (CC-BY 3.0)
