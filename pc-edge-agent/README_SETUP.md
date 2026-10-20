# 🚀 PC Edge Agent — Setup & Deployment Guide

This standalone package (`pc-edge-agent/`) turns **any computer** (Windows, Mac, Linux laptop, desktop, or Android smartphone) into a real, live **MEC (Multi-Access Edge Computing) Edge Node**.

Once started, the agent:
1. Determines its reachable address (**Mode A: Local LAN** or **Mode B: Public Tailscale Funnel**).
2. Self-registers with the central **VNFM Orchestrator** (`https://orchestrator-id88.onrender.com` or local).
3. Sends 5-second telemetry heartbeats (cache hit ratio, requests served).
4. Serves cached 4K/1080p DASH media chunks with ultra-low sub-10ms response times.

---

## 🌐 Mode Comparison: Mode A vs. Mode B vs. Mode C

| Feature | Mode A: Local LAN | Mode B: Public Tailscale Funnel | Mode C: Android Termux |
|---|---|---|---|
| **Best For** | Testing on same Wi-Fi network | Global public internet (Vercel-hosted frontend) | Turning a mobile phone into an edge node |
| **Reachability** | Local Wi-Fi devices only | Anywhere on the public internet | Local Wi-Fi or Tailscale Funnel |
| **Requirements** | Node.js or Docker | Tailscale CLI (Free account) | Android phone + Termux app |
| **URL Format** | `http://192.168.1.X:5001` | `https://your-node.tailnet.ts.net` | Local IP or Funnel URL |

---

## ⚡ Mode A: Local LAN Setup (Default — Quickest)

### On Windows (Double-Click):
1. Double-click **`start-edge.bat`**.
2. Press **Enter** to accept default orchestrator (`https://orchestrator-id88.onrender.com`).
3. Enter a label (e.g. `Dell-LivingRoom`) and press **Enter**.

### On Mac / Linux / WSL:
```bash
chmod +x install-pc.sh
./install-pc.sh
```

### With Docker:
```bash
docker build -t mec-edge-agent .
docker run -d --name mec-edge-agent -p 5001:5001 -e ORCHESTRATOR_URL="https://orchestrator-id88.onrender.com" -e NODE_LABEL="My-PC-Edge" mec-edge-agent
```

---

## 🌍 Mode B: Public Internet Ingress (Tailscale Funnel)

Use **Mode B** when your frontend is hosted on **Vercel** (`https://<app>.vercel.app`) and you want remote users outside your Wi-Fi network to stream through your PC edge node.

### 1. Prerequisites in Tailscale Admin Console (One-Time Setup)
Tailscale Funnel requires two settings enabled on your Tailscale account:
1. **Enable HTTPS Certificates**: Go to [Tailscale DNS Admin](https://login.tailscale.com/admin/dns) and turn **HTTPS Certificates** `ON` (MagicDNS).
2. **Enable Funnel**: Go to [Tailscale ACL Admin](https://login.tailscale.com/admin/acls) and enable Funnel for your tailnet, or turn it on in **Settings → Feature Previews**.

---

### 2. Install Tailscale (if not already installed)
- **Linux:** `curl -fsSL https://tailscale.com/install.sh | sh`
- **macOS:** `brew install tailscale` (or download from Mac App Store)
- **Windows:** `winget install Tailscale.Tailscale` (or download from https://tailscale.com/download/windows)

---

### 3. Run the Public Tunnel Launcher
In terminal inside `pc-edge-agent/`:
```bash
chmod +x start-tunnel.sh
./start-tunnel.sh
```
The script will start `tailscale funnel` on port `5001`, check the exit status without swallowing errors, export `TAILSCALE_FUNNEL_URL`, and register the public HTTPS URL with the central Orchestrator.

---

### 4. How to Verify Public Ingress (Cellular Test)
1. Run `tailscale funnel status` in your terminal to see the recorded public funnel state.
2. Turn **OFF Wi-Fi** on your mobile phone (switch to Cellular 4G/5G).
3. Open `https://your-node.tailnet.ts.net/health` in your phone browser.
   - If it returns `{ "status": "ok" }` over mobile cellular data, your edge node is genuinely public and ready for global streaming!

---

## 📱 Mode C: Android Mobile Phone (Termux)

Turn any Android smartphone into an active MEC edge node!

1. Install **Termux** from [F-Droid](https://f-droid.org/en/packages/com.termux/) or GitHub releases.
2. Open Termux and copy/git pull this `pc-edge-agent` folder into Termux.
3. Run the Android installer:
   ```bash
   chmod +x install-android-termux.sh
   ./install-android-termux.sh
   ```
4. *(Optional Public Ingress on Android)*:
   - Install the **Tailscale Android App** from Google Play Store.
   - Connect to your Tailnet.
   - Enable Funnel in the Tailscale Admin Console for your Android device on port `5001`.
   - Pass the Funnel URL when prompted by the script!

---

## 🔍 How to Verify the Edge Agent is Active

1. **Local Health Check:**
   Open in browser: `http://localhost:5001/health`  
   Should return:
   ```json
   {
     "status": "ok",
     "edgeId": "dell-livingroom-a1b2",
     "label": "Dell-LivingRoom",
     "delay_ms": 5,
     "cacheHitRatio": 0,
     "uptime_s": 15
   }
   ```

2. **Live Cloud Orchestrator Registry:**
   Visit: `https://orchestrator-id88.onrender.com/api/orchestrator/edges`  
   Your PC/phone will appear dynamically in the live edge array!

3. **Live Streaming Dashboard:**
   Open your streaming app on Vercel (`https://<app>.vercel.app`) or `http://localhost:5173`. In the **Network Topology Map**, your new edge node will light up with active streaming routes and live measured RTT!
