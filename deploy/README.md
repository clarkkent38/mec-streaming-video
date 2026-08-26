# Railway Deployment Guide

This project is architected as 4 distinct microservices that can be deployed to Railway to simulate a realistic MEC (Multi-Access Edge Computing) and NFV (Network Function Virtualization) environment.

## Repositories & Services

To deploy on Railway, it is easiest to have these split into either separate GitHub repositories, or deployed from a single monorepo using Railway's root directory feature.

1. **Origin Server** (`/origin-server`)
2. **Edge Node 1** (`/edge-node`)
3. **Edge Node 2** (`/edge-node`)
4. **Orchestrator** (`/orchestrator`)
5. **Frontend** (`/frontend`)

## Step-by-Step Deployment

1. **Deploy Origin Server**
   - Create a service pointing to the `origin-server` folder.
   - Railway will automatically detect the `railway.toml`.
   - **Important:** Once deployed, note the public domain Railway assigns it (e.g., `https://origin-service.up.railway.app`).

2. **Deploy Orchestrator**
   - Create a service pointing to the `orchestrator` folder.
   - Note its public domain (e.g., `https://orchestrator.up.railway.app`).

3. **Deploy Edge Node 1**
   - Create a service pointing to the `edge-node` folder.
   - **Environment Variables:**
     - `NODE_ID` = `edge-node-1`
     - `ORIGIN_URL` = `https://origin-service.up.railway.app` (From step 1)

4. **Deploy Edge Node 2**
   - Create *another* service pointing to the `edge-node` folder.
   - **Environment Variables:**
     - `NODE_ID` = `edge-node-2`
     - `ORIGIN_URL` = `https://origin-service.up.railway.app` (From step 1)

5. **Configure Orchestrator to see Edges**
   - Once Edge 1 and Edge 2 are deployed, note their public domains.
   - Go to your Orchestrator service settings in Railway and add:
     - `EDGE1_URL` = `https://edge-node-1.up.railway.app`
     - `EDGE2_URL` = `https://edge-node-2.up.railway.app`
     - `ORIGIN_URL` = `https://origin-service.up.railway.app`

6. **Deploy Frontend**
   - Create a service pointing to the `frontend` folder.
   - **Environment Variables:**
     - `VITE_ORCHESTRATOR_URL` = `https://orchestrator.up.railway.app`
     - `VITE_ORIGIN_MANIFEST` = `https://origin-service.up.railway.app/manifest.mpd`

Once all services are up, open the frontend domain in your browser. You will see the VNF Edge Streamer pulling live data from your real, cloud-deployed edge nodes!
