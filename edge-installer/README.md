# EdgeNest — Developer Guide

> Windows desktop app that turns any PC into a live MEC edge node for the VNF Edge Streamer project.
> Wraps `pc-edge-agent/server.js` in an Electron shell with a GUI setup wizard, Tailscale assistant,
> live performance dashboard, and NSIS installer. No terminal required for end users.

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 18 LTS | Dev machine only — not needed on end-user PC |
| npm | ≥ 9 | Bundled with Node |
| Electron | 30.0.2 | Pinned in package.json |
| electron-builder | 24.13.3 | Pinned in package.json |
| Git | any | To clone the repo |

> **End users** do not need Node.js, npm, or any terminal. The installer bundles everything.

---

## Quick Start (dev)

```powershell
# 1. Clone and enter the repo
git clone <repo-url>
cd Edge_Streaming/edge-installer

# 2. Install dependencies
npm install

# 3. Download bundled Chart.js (runs automatically via prestart hook)
node scripts/download-vendor.js

# 4. Launch in dev mode
npm start
```

The app opens the Setup window on first launch (no config found).
Agent logs stream to the console and to `%APPDATA%\EdgeNest\logs\`.

---

## Build the Windows Installer

```powershell
# Full NSIS installer → dist-installer/EdgeNest Setup 1.0.0.exe
npm run build

# Directory only (faster for testing, no installer wizard)
npm run build:dir
```

### Before building

1. Place `assets/icons/icon.ico` (multi-res, 256/128/64/48/32/16 px).
   See `assets/icons/README.md` for a one-liner to generate a placeholder with ImageMagick.
2. The `extraResources` section in `package.json` automatically bundles `pc-edge-agent/` and `defaults.json`.

### SmartScreen warning

The build is unsigned. End users will see a Windows Defender SmartScreen warning on first run.
Instruct them: **"More info → Run anyway"**.
To suppress this, sign the binary with a code-signing certificate (`electron-builder` supports `signtoolOptions`).

---

## Project Structure

```
edge-installer/
├── src/
│   ├── main/
│   │   ├── app.js                 ← Electron entry point, tray, single-instance lock
│   │   ├── preload.js             ← contextBridge API exposed to renderers
│   │   ├── config-store.js        ← Persist config to %APPDATA%\EdgeNest\config.json
│   │   ├── agent-runner.js        ← Forks pc-edge-agent/server.js as child process
│   │   ├── state-machine.js       ← 6-state FSM, orchestrator polling, LIVE detection
│   │   ├── tailscale-assistant.js ← CLI detection, login, funnel activation
│   │   ├── ipc-handlers.js        ← All ipcMain.handle() registrations
│   │   ├── self-test.js           ← 8-step self-test + diagnostics report
│   │   ├── logger.js              ← Timestamped rolling log file + memory buffer
│   │   └── port-utils.js          ← isPortFree / findFreePort
│   ├── renderer/
│   │   ├── setup/                 ← Setup wizard (setup.html/css/js)
│   │   ├── tailscale/             ← Tailscale checklist (tailscale.html/css/js)
│   │   └── dashboard/             ← Live dashboard (dashboard.html/css/js)
│   ├── vendor/                    ← chart.umd.min.js (downloaded by scripts/download-vendor.js)
│   └── constants.js               ← APP_NAME, STATES, port defaults, intervals
├── assets/
│   ├── icons/                     ← icon.ico + icon.png (see README inside)
│   └── installer.nsh              ← NSIS custom hooks (keep-settings prompt on uninstall)
├── scripts/
│   └── download-vendor.js         ← Downloads Chart.js 4.4.3 to src/vendor/
├── tests/
│   ├── tailscale-parser.test.js   ← 25 tests
│   ├── state-machine.test.js      ← 13 tests
│   ├── config-validation.test.js  ← 48 tests
│   └── metrics-aggregation.test.js← 27 tests (106 total, all passing)
├── defaults.json                  ← Editable default URLs (no rebuild needed)
├── package.json                   ← electron-builder config, scripts, deps
└── README.md                      ← This file
```

---

## Renaming the App

Change one line in `src/constants.js`:

```js
const APP_NAME = 'EdgeNest';   // ← change this
```

This propagates to: window titles, tray tooltip, NSIS installer name, Start Menu shortcut,
`%APPDATA%\<APP_NAME>\` data folder, About window.

---

## Updating the Default Render URLs

Edit `edge-installer/defaults.json` — no rebuild needed. The file is bundled as an `extraResource`
and read at runtime from `process.resourcesPath/defaults.json`.

```json
{
  "orchestratorUrl": "https://orchestrator-id88.onrender.com",
  "originUrl":       "https://origin-server-1ge5.onrender.com"
}
```

---

## Running Tests

```powershell
npm test
# → 4 test suites, 106 tests, all pass
```

Tests are pure Node (no Electron, no browser). They run on any platform without building.

---

## State Machine Summary

| State | Meaning |
|---|---|
| `SETUP` | Config incomplete — setup window is shown |
| `LOCAL_ONLY` | Agent running, Funnel not active; LAN-only, not reachable from Vercel |
| `PUBLIC_PENDING` | Funnel active, agent started, waiting for orchestrator to register + probe RTT |
| `LIVE` | Orchestrator lists our edgeId as `online` **and** `measuredLatencyMs ≠ null` |
| `DEGRADED` | 2–3 consecutive poll failures; retrying with back-off |
| `OFFLINE` | Agent stopped |

LIVE detection polls `GET /api/orchestrator/edges` every 5 s and matches by `edgeId` (exact) or
node label prefix (fallback). Persists the discovered `edgeId` to `config.json` for fast future matching.

---

## Dashboard API (pc-edge-agent addition)

The agent exposes a local-only API on `127.0.0.1:5002` (never tunnelled via Funnel):

| Endpoint | Method | Description |
|---|---|---|
| `/api/stats` | GET | Current KPI snapshot |
| `/api/series?window=seconds\|minutes` | GET | Time-series buckets for charts |
| `/api/requests?limit=N&offset=M` | GET | Paginated raw request log |
| `/api/export.csv` | GET | Download today's CSV |
| `/api/reset` | POST | Clear in-memory stats (keeps CSV) |
| `/api/stream` | GET | Server-Sent Events for live updates |

---

## Architecture Constraints

See `.kiro/steering/edge-installer-constraints.md` for the full list. Key rules:

- **Do not modify** `frontend/`, `orchestrator/`, `origin-server/`, `edge-node/`, `render.yaml`.
- Changes to `pc-edge-agent/server.js` are additive only — existing endpoints and payloads are unchanged.
- Dashboard API is bound to `127.0.0.1` only — never exposed through Tailscale Funnel.
- Only the agent port (5001) is tunnelled publicly.
