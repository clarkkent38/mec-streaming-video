# EdgeNest — User Manual

**Version 1.0.0** | Windows 10 / 11 (x64)

> EdgeNest turns your PC into a live MEC (Multi-Access Edge Computing) edge node that
> caches 4K video segments and serves them with ultra-low latency through the
> [VNF Edge Streamer](https://mec-streaming-video.vercel.app) dashboard.

---

## Table of Contents

1. [Installation](#1-installation)
2. [First Launch — Setup Wizard](#2-first-launch--setup-wizard)
3. [Tailscale Setup (Public Mode)](#3-tailscale-setup-public-mode)
4. [Dashboard](#4-dashboard)
5. [Tray Icon & Menu](#5-tray-icon--menu)
6. [Start with Windows](#6-start-with-windows)
7. [Self-Test](#7-self-test)
8. [Troubleshooting](#8-troubleshooting)
9. [Uninstalling](#9-uninstalling)

---

## 1. Installation

1. Download **EdgeNest Setup 1.0.0.exe** from the releases page.
2. Double-click the file.
3. Windows Defender SmartScreen may show a warning because the app is unsigned.
   Click **"More info"** then **"Run anyway"**.
4. Follow the installer wizard:
   - Choose an install folder (default: `C:\Users\<you>\AppData\Local\Programs\EdgeNest`).
   - Choose whether to create a Desktop shortcut.
5. Click **Install**, then **Finish**.

EdgeNest does **not** require administrator rights.

---

## 2. First Launch — Setup Wizard

On first launch, the Setup window opens automatically.

### Fields

| Field | What to enter |
|---|---|
| **Node Name** | A display name for your PC in the topology map. Letters, digits, dashes only (e.g. `Dell-LivingRoom`). |
| **Connection Mode** | Choose **Public** to be reachable from anywhere (requires Tailscale). Choose **LAN Only** for same-network demos only. |
| **Orchestrator URL** | Leave the default `https://orchestrator-id88.onrender.com` unless told otherwise. |
| **Origin URL** | Leave the default `https://origin-server-1ge5.onrender.com` unless told otherwise. |

### Testing the connection

Click **Test** next to each URL. The first test may show "Waking up server…" — Render's free tier
spins down after inactivity and can take up to 90 seconds to wake. Wait for the green ✓.

### Advanced settings

Click **Advanced settings** to see:

- **Agent Port** (default 5001) — the port your edge node listens on. Click **Check** to verify it is free.
- **Dashboard Port** (default 5002) — the local-only monitoring API. Never exposed publicly.
- **Simulated Delay** — leave at **0** for real latency measurements. Non-zero values are for lab demos only.

### Save & Continue

Click **Save & Continue →**. The app routes you to:
- **Public mode** → Tailscale Setup (section 3).
- **LAN Only mode** → Dashboard (section 4).

---

## 3. Tailscale Setup (Public Mode)

Tailscale Funnel creates a public HTTPS URL that the Vercel-hosted frontend can reach.
You need a free Tailscale account.

### Checklist steps

The app guides you through four steps. Each shows a live status tick.

#### Step 1 — Tailscale installed

- If Tailscale is not installed, click **Download Tailscale** to open the official download page.
- Install Tailscale normally (it requires admin rights for the VPN driver — this is a one-time step).
- Return to EdgeNest; the tick updates automatically within 3 seconds.

#### Step 2 — Logged in & connected

- If not logged in, click **Log In to Tailscale**. Your browser opens the Tailscale login page.
- Sign in (or create a free account). After approving the device, return to EdgeNest.
- The tick updates automatically.

#### Step 3 — HTTPS Certificates & Funnel enabled

EdgeNest tries to enable Funnel automatically. If it shows an **Open Tailscale Admin Console** button:

1. Click the button — the Tailscale admin console opens in your browser.
2. **Enable HTTPS Certificates**:
   - Go to **DNS** → turn **HTTPS Certificates** (MagicDNS) **ON**.
3. **Enable Funnel**:
   - Go to **Access Controls** → add `"funnel": true` under your policy, **or**
   - Go to **Settings → Feature Previews** → enable **Funnel**.
4. Return to EdgeNest and click **↺ Retry**.

#### Step 4 — Funnel active

Once all four ticks are green, your public URL appears:

```
https://your-node-name.tail1234.ts.net
```

**Verify** (optional): Turn off Wi-Fi on your phone (use mobile data), open
`https://your-node-name.tail1234.ts.net/health` in your phone's browser.
If it returns `{"status":"ok"}`, your edge node is genuinely public.

Click **Continue →** to start the agent and open the dashboard.

---

## 4. Dashboard

The dashboard shows live performance data from your edge node.

### Status header

| Element | Meaning |
|---|---|
| State badge | Current state: `LIVE` (green), `DEGRADED` (yellow), `OFFLINE` (red), `PUBLIC_PENDING` (blue), `LOCAL_ONLY` (grey), `SETUP` (grey) |
| State detail | Plain-language description of what is happening |
| Public URL | Your Tailscale Funnel URL — click ⧉ to copy |
| Uptime | How long the agent has been running |

### Progress ticks

While the agent is starting, ticks show each step:
`Agent started` → `Health OK` → `Funnel active` → `Registered` → `Verified by orchestrator` → `LIVE`

Once `LIVE`, the ticks row disappears.

### Reading the numbers

> ⚠ **Important:**
> - **Edge latency** (p50, p95, hit latency) is measured server-side at this PC — it is the time
>   from request receipt to response sent, including the simulated delay (if non-zero).
> - **Orchestrator RTT** is measured from the cloud orchestrator to your node's public URL — it
>   includes the full internet + Tailscale Funnel path.
> - Neither equals what a viewer's player experiences end-to-end.

### KPI cards

| Card | What it measures |
|---|---|
| Requests served | Total number of DASH requests handled since last reset |
| Cache hit ratio | Fraction served from in-memory cache (no origin fetch) |
| p50 latency | Median response time (ms) — server-side |
| p95 latency | 95th percentile response time (ms) — server-side |
| Throughput | Approximate bytes/second served to clients (last 60 s) |
| Data saved vs origin | Bytes served from cache (did not need to fetch from Render) |
| Latency saved | Average origin fetch time minus average hit latency |
| Orchestrator RTT | Last measured round-trip time from the Render orchestrator to your node |

### Charts

| Chart | What it shows |
|---|---|
| Response Latency | Hit latency (green) vs miss latency (red) over time |
| Throughput (Mbps) | Serving rate over time |
| Cache Hit Ratio (%) | Fraction of requests served from cache over time |
| Bytes: Cache vs Origin | Stacked — how much came from cache vs needed origin fetch |
| Origin Fetch vs Hit Latency | Direct comparison of origin time (baseline) vs cache time |
| Orchestrator RTT | Cloud-measured latency to your public Funnel URL |
| Requests / second | Request arrival rate |

Switch between **Last 60 min (seconds)** and **Last 24 h (minutes)** with the window buttons.

### Request table

Shows the 50 most recent individual requests with: time, path, cache result, status, latency, origin fetch time, bytes.

Live new rows appear automatically via Server-Sent Events.

### Buttons

| Button | Action |
|---|---|
| ⬇ Export CSV | Download today's request log as a CSV file |
| ✕ Reset Stats | Clear in-memory metrics (CSV log is preserved) |
| ▶ Run Self-Test | Run 8 diagnostic checks and show pass/fail results |
| 📋 Copy Diagnostics | Copy a full diagnostics report to your clipboard |
| QR Code | Show a QR code of your public URL for opening on a phone |
| ◑ | Toggle dark / light mode |
| ⚙ | Re-open the Setup window |

---

## 5. Tray Icon & Menu

EdgeNest runs in the system tray (bottom-right of the taskbar). Right-click the tray icon to see:

| Menu item | Action |
|---|---|
| Status: … | Current state (not clickable) |
| Open Dashboard | Show the dashboard window |
| Setup / Settings | Re-open the setup wizard |
| ▶ Start Edge / ■ Stop Edge | Start or stop the agent |
| Copy Public URL | Copy `https://…ts.net` to clipboard |
| Run Self-Test | Quick 8-check health test |
| Quit | Stop the agent, remove the Funnel mapping, and exit |

Closing the dashboard window does **not** stop the agent — it continues running in the tray.

---

## 6. Start with Windows

In the Setup window, tick **Start EdgeNest with Windows** to have the app launch automatically
when you log in. The agent starts in the background; click the tray icon to open the dashboard.

Untick the checkbox (and click Save) to disable autostart.

---

## 7. Self-Test

Click **▶ Run Self-Test** in the dashboard or the tray menu before a live demo.

The test checks:

| # | Check | Pass means |
|---|---|---|
| 1 | Configuration complete | Node name, URLs, and ports are set |
| 2 | Orchestrator reachable | `GET /health` returned 200 |
| 3 | Origin server reachable | `GET /health` returned 200 |
| 4 | Agent is running | Child process is alive |
| 5 | Agent /health responds | Port 5001 returns `{"status":"ok"}` |
| 6 | Dashboard API accessible | Port 5002 returns stats JSON |
| 7 | Tailscale installed | (Public mode only) CLI found |
| 8 | Orchestrator sees this edge | Our edge appears in `/api/orchestrator/edges` |

A green ✓ on all 8 means the system is ready for a live demo.

---

## 8. Troubleshooting

### "Waking up server…" stays for a long time

Render's free tier spins down after inactivity. The first request can take 60–90 seconds.
Wait for the Test button to show a green result. Subsequent requests are fast.

### State stays at `PUBLIC_PENDING`

The orchestrator has not yet measured your edge's latency. This happens in the first ~10 seconds
after registration. If it stays pending for more than 30 seconds:
1. Click ▶ Run Self-Test — check that the orchestrator sees your edge (test 8).
2. Check that your Tailscale Funnel URL is reachable from outside your network (section 3, verification step).

### State shows `DEGRADED`

Three consecutive orchestrator polls failed. Possible causes:
- Render orchestrator is sleeping — it wakes up automatically.
- Your Funnel mapping expired — re-open the Tailscale window from Setup.
- Network interrupted — the app retries with back-off.

### Port 5001 is already in use

Open the Setup window → Advanced → click **Check** next to Agent Port.
The app suggests the next free port automatically. Click Save.

### Tailscale Funnel fails with "permission denied"

Step 3 in the Tailscale checklist: you need to enable HTTPS Certificates and Funnel ACL in the
[Tailscale Admin Console](https://login.tailscale.com/admin). The app shows the exact admin console
link when this happens.

### Copy Diagnostics

If you need to report a problem, click **📋 Copy Diagnostics** and paste into your report.
The report includes: app version, OS, config, agent status, Tailscale status, and the last 50 log lines.

---

## 9. Uninstalling

1. Right-click the tray icon → **Quit** (stops the agent and removes the Funnel mapping).
2. Go to **Windows Settings → Apps → Installed apps** → search for **EdgeNest** → **Uninstall**.
3. The uninstaller asks: **"Keep your EdgeNest settings and logs?"**
   - Click **Yes** to preserve your configuration and logs in `%APPDATA%\EdgeNest\`.
   - Click **No** to remove everything.

---

*VNF Edge Streamer — MEC research demo based on Ma et al., ICUFN 2018.*
