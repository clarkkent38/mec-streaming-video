# Changelog — EdgeNest

All notable changes to the EdgeNest desktop app are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.0.0] — 2026-10-20

### Added

**Phase 1 — Telemetry & dashboard API (pc-edge-agent/server.js — additive)**
- Per-request telemetry middleware recording: timestamp, path, HIT/MISS, status code, total ms, bytes, origin fetch ms.
- Bounded in-memory ring stores: 5,000 raw requests, 3,600 one-second buckets (60 min), 1,440 one-minute buckets (24 h).
- Daily CSV append to `exports/requests-YYYY-MM-DD.csv`.
- Server-Sent Events stream (`/api/stream`) for live dashboard updates.
- Local-only dashboard API server on `127.0.0.1:5002` (bound exclusively to loopback — never tunnelled):
  - `GET /api/stats` — current KPI snapshot with p50/p95, hit ratio, throughput, latency saved.
  - `GET /api/series?window=seconds|minutes` — time-series for all charts.
  - `GET /api/requests` — paginated raw request log.
  - `GET /api/export.csv` — download today's CSV.
  - `POST /api/reset` — clear in-memory stats.
- `DASHBOARD_PORT` env var (default 5002).
- `DASHBOARD_ENABLED` env var (opt-out, default true).

**Phase 1 — Scaffold (edge-installer/)**
- `src/constants.js` — `APP_NAME = 'EdgeNest'`, `STATES` enum, port and interval defaults.
- `defaults.json` — editable Render URLs without rebuilding.
- `package.json` — Electron 30.0.2, electron-builder 24.13.3, Jest 29.7.0; NSIS per-user installer config.
- `assets/installer.nsh` — NSIS keep-settings prompt on uninstall.
- `scripts/download-vendor.js` — downloads Chart.js 4.4.3 UMD to `src/vendor/` (no CDN at runtime).

**Phase 2 — Electron shell**
- `src/main/app.js` — single-instance lock, system tray with dynamic menu, window managers (setup / tailscale / dashboard), `before-quit` cleanup.
- `src/main/preload.js` — narrow `contextBridge` API (`window.edgenest`) covering config, agent, state, Tailscale, tests, diagnostics, windows, shell, autostart.
- `src/main/config-store.js` — loads `defaults.json` from `extraResources` or dev path; persists to `%APPDATA%\EdgeNest\config.json`; `reset()` clears saved values.
- `src/main/logger.js` — timestamped rolling file log in `%APPDATA%\EdgeNest\logs\`; 500-line in-memory ring buffer for diagnostics.
- `src/main/ipc-handlers.js` — all `ipcMain.handle()` registrations; `testEndpoint()` with 90 s Render free-tier wake-up retry.
- `src/main/port-utils.js` — `isPortFree` / `findFreePort` via `net.createServer`.
- `src/renderer/setup/` — setup wizard: all fields (node label, mode, URLs, ports, delay, autostart), inline validation, Test/Check buttons with live results, Restore Defaults, Save & Continue routing.
- `src/main/agent-runner.js` — `fork()` of `pc-edge-agent/server.js` with correct env; captures stdout/stderr; exponential back-off auto-restart; `setPublicUrl()` restarts agent to re-register; `stop()` with SIGTERM + 5 s SIGKILL fallback.

**Phase 3 — Tailscale assistant & state machine**
- `src/main/tailscale-assistant.js` — CLI detection across PATH + two install dirs; `tailscale status --json` parsing; version-aware funnel syntax (`<port>` vs `on|off`); funnel verification via `tailscale funnel status`; admin console link extraction; clean `stopFunnel()` for only the mapping we created.
- `src/renderer/tailscale/` — 4-step checklist (installed / logged-in / HTTPS+Funnel / mapping active); live 3 s poll; admin console link surfaced as button with plain-language instructions; auto-triggers funnel after login.
- `src/main/state-machine.js` — 6-state EventEmitter FSM; orchestrator polling every 5 s; LIVE detection (`edgeStatus === 'online' || status === 'UP'` AND `measuredLatencyMs !== null`); sleep/resume detection; DEGRADED after 3 consecutive failures; broadcasts `state:changed` to all BrowserWindows.

**Phase 4 — Dashboard, installer, self-test**
- `src/renderer/dashboard/` — full dashboard: topbar (state badge, public URL, dark mode toggle), progress ticks, help banner (latency measurement semantics), 8 KPI cards, window selector (seconds / minutes), 8 Chart.js charts (latency hit vs miss, throughput, hit ratio, bytes stacked, origin vs hit, orchestrator RTT, requests/sec, bytes), heartbeat timeline, live request table with HIT/MISS badges, self-test results panel, QR modal.
- `src/main/self-test.js` — 8 checks: config complete, orchestrator reachable, origin reachable, agent running, agent `/health` responds, dashboard API accessible, Tailscale installed (if public mode), orchestrator sees our edge. `collectDiagnostics()` builds a formatted report for clipboard.
- NSIS installer: per-user, no UAC, Desktop + Start Menu shortcuts, keep-settings prompt on uninstall, autostart via `app.setLoginItemSettings`.

**Tests**
- 4 test files, **106 tests**, all passing (Jest 29.7.0, pure Node, no browser/Electron).
  - `tailscale-parser.test.js` — 25 tests.
  - `state-machine.test.js` — 13 tests.
  - `config-validation.test.js` — 48 tests.
  - `metrics-aggregation.test.js` — 27 tests.

### Fixed

- Stale documentation references to old `-xfwd`/`-h42h` Render slugs corrected to the confirmed live `-id88`/`-1ge5` URLs (verified via Render dashboard and Vercel env vars) across all scripts, docs, and `defaults.json`.
- `detectFunnelSyntax` regex false-positive that misclassified older CLI help text as newer syntax.

### Constraints honoured

- `frontend/`, `orchestrator/`, `origin-server/`, `edge-node/`, `render.yaml` — untouched.
- `pc-edge-agent/server.js` — additive only; all existing endpoints, payloads, and env-var semantics preserved.
- Dashboard API bound exclusively to `127.0.0.1` — never reachable through Tailscale Funnel.
- Registered public URL still `https://<dns-name>.ts.net` via `TAILSCALE_FUNNEL_URL`.
