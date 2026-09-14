#!/usr/bin/env bash
# ==============================================================================
# install-pc.sh — Standalone MEC Edge Agent Setup (Docker & Native)
# ==============================================================================
set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "\n${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║         MEC Edge Node Agent — Quick PC Setup & Launcher      ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}\n"

# Check if Docker is available
USE_DOCKER=false
if command -v docker &> /dev/null && docker info &> /dev/null; then
  USE_DOCKER=true
  echo -e "${GREEN}✓ Docker is detected and running.${NC}"
else
  echo -e "${YELLOW}ℹ Docker not found or not running. Checking for Node.js...${NC}"
  if ! command -v node &> /dev/null; then
    echo -e "${RED}[ERROR] Neither Docker nor Node.js is installed!${NC}"
    echo -e "Please install either Docker (https://www.docker.com/) or Node.js (https://nodejs.org/)."
    exit 1
  fi
  echo -e "${GREEN}✓ Node.js $(node -v) is available.${NC}"
fi

# Gather configuration
echo -e "\n${BLUE}==> Configuring Edge Agent settings...${NC}"

if [ -z "$ORCHESTRATOR_URL" ]; then
  read -r -p "Enter Orchestrator URL [default: https://orchestrator-xfwd.onrender.com]: " input_orch
  ORCHESTRATOR_URL=${input_orch:-https://orchestrator-xfwd.onrender.com}
fi

if [ -z "$NODE_LABEL" ]; then
  DEFAULT_LABEL="Edge-$(hostname | tr -dc 'a-zA-Z0-9' | head -c 8)"
  read -r -p "Enter Node Label / Name [default: $DEFAULT_LABEL]: " input_label
  NODE_LABEL=${input_label:-$DEFAULT_LABEL}
fi

if [ -z "$ORIGIN_URL" ]; then
  read -r -p "Enter Origin Server URL [default: https://origin-server-h42h.onrender.com]: " input_origin
  ORIGIN_URL=${input_origin:-https://origin-server-h42h.onrender.com}
fi

if [ -z "$PORT" ]; then
  read -r -p "Enter Port [default: 5001]: " input_port
  PORT=${input_port:-5001}
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$USE_DOCKER" = true ]; then
  echo -e "\n${BLUE}==> Building and running with Docker...${NC}"
  docker build -t mec-edge-agent:latest "${SCRIPT_DIR}"
  
  if [ "$(docker ps -aq -f name=mec-edge-agent)" ]; then
    docker rm -f mec-edge-agent > /dev/null 2>&1 || true
  fi

  docker run -d \
    --name mec-edge-agent \
    --restart unless-stopped \
    -p "${PORT}:${PORT}" \
    -e PORT="${PORT}" \
    -e ORCHESTRATOR_URL="${ORCHESTRATOR_URL}" \
    -e ORIGIN_URL="${ORIGIN_URL}" \
    -e NODE_LABEL="${NODE_LABEL}" \
    -e DELAY_MS="5" \
    mec-edge-agent:latest

  echo -e "\n${GREEN}✅ Edge Agent started in Docker container on port ${PORT}!${NC}"
  echo -e "Health check: http://localhost:${PORT}/health\n"
else
  echo -e "\n${BLUE}==> Running directly with Node.js...${NC}"
  cd "${SCRIPT_DIR}"
  if [ ! -d "node_modules" ]; then
    npm install --omit=dev
  fi
  PORT="${PORT}" ORCHESTRATOR_URL="${ORCHESTRATOR_URL}" ORIGIN_URL="${ORIGIN_URL}" NODE_LABEL="${NODE_LABEL}" DELAY_MS="5" node server.js
fi
