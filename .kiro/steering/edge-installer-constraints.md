---
inclusion: always
---

# EdgeNest — Hard Constraints & Architecture Rules

## 1. Protected Folders (Do NOT Touch)

The following folders and files must never be modified:

- `frontend/` — React/Vite dashboard deployed on Vercel
- `orchestrator/` — VNFM controller on Render
- `origin-server/` — DASH origin on Render
- `edge-node/` — Render-hosted edge proxy
- `render.yaml` — Infrastructure-as-Code for Render
- `archive_legacy/` — Legacy archive

**No API contract, route, or payload in any of those services may change.**

## 2. pc-edge-agent/server.js Rules

Changes must be **additive only**:
- Existing endpoints (`/health`, `/metrics`, `/edge-stats`, `/set-delay`, `/simulate-outage`, `/restore`, `/dash/*`, `/video/*`) stay byte-for-byte compatible.
- Registration payload shape: `{ edgeId, id, url, label }` — do not change.
- Heartbeat payload shape: `{ edgeId, id, cacheHitRatio, requestsServed, cacheHits, cacheMisses }` — do not change.
- All existing env-var semantics (PORT, BIND_HOST, NODE_LABEL, ORCHESTRATOR_URL, ORIGIN_URL, TAILSCALE_FUNNEL_URL, PUBLIC_URL, TUNNEL_URL, AKAMAI_PROXY, DELAY_MS, EDGE_ID) stay as-is.
- Old terminal scripts (`start-edge.bat`, `install-pc.sh`, `start-tunnel.sh`) and the Docker image **must keep working**.

New additions allowed:
- Telemetry middleware (records per-request metrics into a bounded in-memory store).
- Local dashboard API server on `127.0.0.1:5002` (separate `DASHBOARD_PORT` env var).
- `BIND_HOST` env var (defaults to `0.0.0.0` — same as today if not set).

## 3. New Code Location

**All new installer/GUI code goes in `edge-installer/`.**

A `git diff` outside `edge-installer/` and `pc-edge-agent/server.js` must be empty — except the stale-default URL fix in the three old scripts and server.js.

## 4. Network Isolation

- The local dashboard (`edge-installer/`) listens on `127.0.0.1` only, default port **5002**.
- The dashboard port must **never** be exposed through Tailscale Funnel.
- Only the agent port (default 5001) is tunnelled publicly.

## 5. Tailscale Funnel Constraint

The registered public URL must still follow the existing mechanism:
- HTTPS URL `https://<dns-name>.ts.net` forwarding to `http://127.0.0.1:<port>`.
- Passed to the agent as `TAILSCALE_FUNNEL_URL` environment variable.
- Do not invent a new registration mechanism; the orchestrator registration path stays `/api/orchestrator/register`.

## 6. APP_NAME Constant

One constant `APP_NAME` (default: `"EdgeNest"`) controls the product name in:
- Window titles
- NSIS installer product name
- Tray tooltip
- Start Menu / Desktop shortcuts
- `%APPDATA%\<APP_NAME>\` data folder

Renaming must be a one-line change in `edge-installer/src/constants.js`.

## 7. Orchestrator API Field Names (from orchestrator/server.js — read-only)

`GET /api/orchestrator/edges` response shape:
```json
{
  "edges": [
    {
      "edgeId": "...",
      "id": "...",
      "url": "...",
      "label": "...",
      "status": "UP | DOWN",
      "edgeStatus": "online | offline",
      "measuredLatencyMs": 42,
      "simulatedDelayMs": null,
      "delay_ms": 42,
      "cacheHitRatio": 0.85,
      "requestsServed": 1234,
      "lastHeartbeat": 1700000000000,
      "last_check": "2024-...",
      "last_seen": "2024-..."
    }
  ],
  "total": 3,
  "online": 2,
  "offline": 1
}
```

`POST /api/orchestrator/register` body: `{ edgeId, id, url, label }`
Response: `{ status: "registered", edge: {...}, timestamp }`

`POST /api/orchestrator/heartbeat` body: `{ edgeId, id, cacheHitRatio, requestsServed, cacheHits, cacheMisses }`

LIVE detection logic: poll `/api/orchestrator/edges`, find our own `edgeId` in the `edges` array, check that `edgeStatus === "online"` OR `status === "UP"`, AND `measuredLatencyMs !== null`.

## 8. Error Handling

Never swallow errors (no `|| true` patterns). Every failing step must:
1. Log the raw error.
2. Show the user a plain-language reason.
3. Show a suggested fix.

## 9. Correct Default URLs (after the stale-URL fix)

```
ORCHESTRATOR_URL = https://orchestrator-id88.onrender.com
ORIGIN_URL       = https://origin-server-1ge5.onrender.com
```

These come from `edge-installer/defaults.json` so they can be edited without rebuilding.
