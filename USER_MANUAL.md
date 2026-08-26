# VNF Edge Streamer: User Manual

A comprehensive guide to understanding, operating, and monitoring the Context-Aware MEC + NFV streaming simulator.

---

## 1. Scientific Overview & Architecture

The **VNF Edge Streamer** is an advanced simulation of a modern video delivery network using **Multi-Access Edge Computing (MEC)** and **Network Function Virtualization (NFV)**. 

Traditional video streaming relies on a central cloud server, which can lead to buffering and latency when thousands of users request data over long distances. This system demonstrates how edge computing solves this by bringing the video segments physically closer to the user.

### The Core Components
1. **Origin Server (Cloud):** The central repository where the highest quality 4K DASH (Dynamic Adaptive Streaming over HTTP) video is stored. It has the highest latency (~150ms).
2. **VNFM Controller (Orchestrator):** The brain of the network. It constantly monitors the health and latency of the edge nodes. If a node fails or degrades, the orchestrator instantly reroutes the user to the next healthiest node.
3. **MEC Nodes (Edge Node 1 & 2):** Virtualized servers located at the edge of the network (closer to the user). They cache video segments from the Origin. Because they are close, their latency is extremely low (5ms - 15ms).
4. **Client (TV/Player):** The end-user's device playing the DASH video stream. It dynamically adjusts video quality (Adaptive Bitrate) based on the network's health.

---

## 2. Understanding the Monitoring Metrics

The **Live Stats Panel** on the right side of the dashboard provides real-time telemetry of the video player's health.

### Key Values & Terminology
* **Resolution (e.g., 1080p, 720p):** The current visual quality of the video. The player uses **ABR (Adaptive Bitrate)**. If the network is healthy, it requests 1080p or 4K. If the network degrades, it automatically drops to 720p or lower to prevent buffering.
* **Throughput (kbps):** The speed at which video data is being downloaded from the active node. Higher is better.
* **Buffer Health (Seconds):** The amount of video pre-loaded ahead of the current playback time. 
  * *Healthy:* 10+ seconds.
  * *Critical:* < 3 seconds (Buffering is imminent).
* **Dropped Frames:** Frames that the player failed to render in time. High dropped frames indicate the CPU is struggling or the video data arrived corrupted/late.
* **Stalls:** The number of times the video completely froze because the buffer ran empty.

### Live Graphs
* **Bitrate History:** Visualizes the ABR algorithm in action. You will see this line step up (when network is fast) or step down (when the network degrades).
* **Buffer Health:** A real-time wave showing the buffer filling up and draining. Sudden dips indicate network latency spikes.

---

## 3. Demo Control Panel (Scenarios)

The bottom-left panel allows you to simulate real-world network events.

### The MEC Engine Toggle
Located at the top center, this toggle switches between:
* **Direct:** Bypasses the Edge Nodes entirely. The client streams directly from the Origin Server (Cloud). You will notice higher latency and slower buffer growth.
* **MEC Engine:** Activates the Edge Nodes and the Orchestrator, dramatically improving throughput and stability.

### Simulation Buttons
1. **✅ Good Edge (Baseline):** 
   * *What it does:* Sets Edge 1 to 5ms latency, Edge 2 to 15ms, and Origin to 150ms.
   * *Expected Result:* The orchestrator routes traffic to Edge 1 (the fastest). Buffer health maximizes, and resolution climbs to the highest possible quality.
2. **🟡 Degraded Edge:**
   * *What it does:* Simulates heavy congestion on Edge 1, increasing its latency to 80ms.
   * *Expected Result:* The orchestrator detects Edge 1 is degraded and seamlessly reroutes traffic to Edge 2 (15ms). You may see a temporary dip in the buffer, but the stream will survive without stalling.
3. **🔴 Edge Outage:**
   * *What it does:* Completely crashes Edge Node 1 ("LINK DEAD").
   * *Expected Result:* The Topology map will show a severed red line. The Orchestrator immediately fails over to Edge 2. A stall might occur if the buffer was extremely low, but the stream will recover rapidly via the backup node.
4. **🔵 Direct Only:**
   * *What it does:* Bypasses the edge entirely, forcing a 150ms latency connection to the Origin.
   * *Expected Result:* The bitrate graph will likely drop as the player struggles to pull heavy 4K segments over a long-distance, high-latency connection.
5. **🔄 Restore All:**
   * *What it does:* Fixes all simulated outages and resets latencies to their optimal baseline state.

---

## 4. Network Topology Map

The glowing diagram on the left is a live representation of your network's physical routing.
* **Blue/Green/Purple Dashed Lines:** Represent active data flowing from a node to the client. The animation speed corresponds to the health of the connection.
* **Faded/Grey Lines:** Represent inactive fallback routes.
* **Red "LINK DEAD" Boxes:** Appear instantly when the orchestrator detects a node has crashed or gone offline.
* **Node Badges (e.g., READY 15ms):** Displays the live ping latency between the client and the respective edge node.
