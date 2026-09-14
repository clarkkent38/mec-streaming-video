#!/usr/bin/env bash
# ==============================================================================
# install-pc.sh — One-Click MEC Edge Agent Setup & Launcher
# ==============================================================================
# Turns this PC into a real, self-registering MEC edge node using Docker.
#
# Usage:
#   chmod +x install-pc.sh
#   ./install-pc.sh
# ==============================================================================

set -e

# ANSI Color formatting
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "\n${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║         MEC Edge Node Agent — Quick PC Installer             ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}\n"

# ─── 1. Check Docker Prerequisites ───────────────────────────────────────────

echo -e "${BLUE}==> [1/4] Checking Docker environment...${NC}"

if ! command -v docker &> /dev/null; then
  echo -e "${RED}[ERROR] Docker is not installed on this machine.${NC}"
  echo -e "Please install Docker Desktop / Docker Engine first:"
  echo -e "  - Windows/Mac : https://www.docker.com/products/docker-desktop"
  echo -e "  - Linux       : https://docs.docker.com/engine/install/"
  exit 1
fi

if ! docker info &> /dev/null; then
  echo -e "${RED}[ERROR] Docker daemon is not running.${NC}"
  echo -e "Please start the Docker service / Docker Desktop and try again."
  exit 1
fi

echo -e "${GREEN}✓ Docker is active and accessible.${NC}\n"

# ─── 2. Configuration & Interactive Prompts ───────────────────────────────────

echo -e "${BLUE}==> [2/4] Configuring Edge Agent settings...${NC}"

# Detect Host IP
HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")

# Prompt for Orchestrator URL
if [ -z "$ORCHESTRATOR_URL" ]; then
  read -r -p "Enter Orchestrator URL [default: https://orchestrator-xfwd.onrender.com]: " input_orch
  ORCHESTRATOR_URL=${input_orch:-https://orchestrator-xfwd.onrender.com}
fi

# Prompt for Node Label
if [ -z "$NODE_LABEL" ]; then
  DEFAULT_LABEL="Edge-$(hostname | tr -dc 'a-zA-Z0-9' | head -c 8)"
  read -r -p "Enter Node Label / Name [default: $DEFAULT_LABEL]: " input_label
  NODE_LABEL=${input_label:-$DEFAULT_LABEL}
fi

# Prompt for Origin URL
if [ -z "$ORIGIN_URL" ]; then
  read -r -p "Enter Origin Server URL [default: https://origin-server-h42h.onrender.com]: " input_origin
  ORIGIN_URL=${input_origin:-https://origin-server-h42h.onrender.com}
fi

# Prompt for Port
if [ -z "$PORT" ]; then
  read -r -p "Enter Port to bind on this machine [default: 5001]: " input_port
  PORT=${input_port:-5001}
fi

echo -e "\n${YELLOW}Summary of Configuration:${NC}"
echo -e "  • Node Label       : ${GREEN}${NODE_LABEL}${NC}"
echo -e "  • Orchestrator     : ${GREEN}${ORCHESTRATOR_URL}${NC}"
echo -e "  • Origin URL       : ${GREEN}${ORIGIN_URL}${NC}"
echo -e "  • Port             : ${GREEN}${PORT}${NC}"
echo -e "  • Host LAN IP      : ${GREEN}${HOST_IP}${NC}\n"

# ─── 3. Build Docker Image ───────────────────────────────────────────────────

echo -e "${BLUE}==> [3/4] Building 'edge-agent' Docker image...${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_CONTEXT="${SCRIPT_DIR}"

if [ -f "${SCRIPT_DIR}/edge-node/Dockerfile" ]; then
  DOCKER_CONTEXT="${SCRIPT_DIR}/edge-node"
fi

docker build -t edge-agent -f "${DOCKER_CONTEXT}/Dockerfile" "${DOCKER_CONTEXT}"

echo -e "${GREEN}✓ Build completed successfully.${NC}\n"

# ─── 4. Run Edge Agent Container ─────────────────────────────────────────────

echo -e "${BLUE}==> [4/4] Starting Edge Agent container...${NC}"

# Stop existing container if running
if [ "$(docker ps -aq -f name=edge-agent)" ]; then
  echo -e "Stopping existing 'edge-agent' container..."
  docker rm -f edge-agent > /dev/null 2>&1 || true
fi

docker run -d \
  --name edge-agent \
  --restart unless-stopped \
  -p "${PORT}:${PORT}" \
  -e PORT="${PORT}" \
  -e ORCHESTRATOR_URL="${ORCHESTRATOR_URL}" \
  -e ORIGIN_URL="${ORIGIN_URL}" \
  -e NODE_LABEL="${NODE_LABEL}" \
  -e DELAY_MS="5" \
  edge-agent

echo -e "\n${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  ✅ Edge Agent is running and registered!                    ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║  Health Check : http://localhost:${PORT}/health                 ║${NC}"
echo -e "${GREEN}║  Live Metrics : http://localhost:${PORT}/metrics                ║${NC}"
echo -e "${GREEN}║  View Logs    : docker logs -f edge-agent                    ║${NC}"
echo -e "${GREEN}║  Stop Agent   : docker stop edge-agent                       ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}\n"
