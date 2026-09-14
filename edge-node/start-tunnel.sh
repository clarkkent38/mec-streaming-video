#!/usr/bin/env bash
# ==============================================================================
# start-tunnel.sh — Tailscale Funnel Public Ingress for MEC Edge Agent (Mode B)
# ==============================================================================
set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

PORT="${PORT:-5001}"
NODE_LABEL="${NODE_LABEL:-PC-Edge-Funnel}"
ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-https://orchestrator-xfwd.onrender.com}"
ORIGIN_URL="${ORIGIN_URL:-https://origin-server-h42h.onrender.com}"

echo -e "\n${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║    MEC Edge Agent — Tailscale Funnel Launcher (Mode B)       ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}\n"

if ! command -v tailscale &> /dev/null; then
  echo -e "${RED}[ERROR] Tailscale CLI is not installed on this machine.${NC}\n"
  echo -e "Please install Tailscale:"
  echo -e "  • Linux   : curl -fsSL https://tailscale.com/install.sh | sh"
  echo -e "  • macOS   : brew install tailscale"
  echo -e "  • Windows : winget install Tailscale.Tailscale"
  exit 1
fi

if ! tailscale status &> /dev/null; then
  echo -e "${YELLOW}Tailscale is not logged in. Logging in...${NC}"
  tailscale up || tailscale login
fi

TAILNET_DNS=$(tailscale status --json 2>/dev/null | grep -o '"DNSName": "[^"]*"' | head -n 1 | cut -d'"' -f4 | sed 's/\.$//' || true)
if [ -z "$TAILNET_DNS" ]; then
  TAILNET_DNS=$(tailscale status 2>/dev/null | head -n 1 | awk '{print $2}' || true)
fi

if [ -z "$TAILNET_DNS" ]; then
  echo -e "${RED}[ERROR] Could not determine your Tailnet DNS name.${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Connected to Tailscale network as: ${CYAN}${TAILNET_DNS}${NC}\n"

echo -e "${BLUE}==> Enabling Tailscale Funnel on port ${PORT}...${NC}"

if tailscale funnel --bg "${PORT}" 2>&1 | tee /tmp/tailscale_funnel_output.log; then
  echo -e "${GREEN}✓ Tailscale Funnel process initiated.${NC}"
elif tailscale serve --bg "http://127.0.0.1:${PORT}" && tailscale funnel --bg on; then
  echo -e "${GREEN}✓ Tailscale Serve & Funnel activated.${NC}"
else
  FUNNEL_ERR=$(cat /tmp/tailscale_funnel_output.log 2>/dev/null || echo "Unknown error")
  echo -e "\n${RED}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${RED}║  ❌ TAILSCALE FUNNEL ACTIVATION FAILED                       ║${NC}"
  echo -e "${RED}╠══════════════════════════════════════════════════════════════╣${NC}"
  echo -e "${YELLOW}Reason:${NC} ${FUNNEL_ERR}\n"
  echo -e "${YELLOW}Prerequisites to enable Funnel in Tailscale:${NC}"
  echo -e "  1. Enable HTTPS Certificates: https://login.tailscale.com/admin/dns"
  echo -e "  2. Enable Funnel in ACL / Settings: https://login.tailscale.com/admin/acls"
  echo -e "  3. Check Funnel Status: tailscale funnel status"
  echo -e "${RED}╚══════════════════════════════════════════════════════════════╝${NC}\n"
  exit 1
fi

FUNNEL_URL="https://${TAILNET_DNS}"
export TAILSCALE_FUNNEL_URL="${FUNNEL_URL}"

echo -e "\n${GREEN}✅ Public Tailscale Funnel Ingress Active: ${CYAN}${TAILSCALE_FUNNEL_URL}${NC}\n"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

if [ ! -d "node_modules" ]; then
  npm install --omit=dev
fi

PORT="${PORT}" \
NODE_LABEL="${NODE_LABEL}" \
ORCHESTRATOR_URL="${ORCHESTRATOR_URL}" \
ORIGIN_URL="${ORIGIN_URL}" \
TAILSCALE_FUNNEL_URL="${TAILSCALE_FUNNEL_URL}" \
node server.js
