#!/usr/bin/env bash
# ==============================================================================
# start-tunnel.sh — Tailscale Funnel Public Ingress for MEC Edge Agent (Mode B)
# ==============================================================================
# Exposes the local Edge Agent to the public internet using Tailscale Funnel (free).
# Allows Vercel-hosted frontends and remote clients to stream from this PC node.
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

# ── 1. Check Tailscale CLI ───────────────────────────────────────────────────

echo -e "${BLUE}==> [1/4] Checking Tailscale installation...${NC}"

if ! command -v tailscale &> /dev/null; then
  echo -e "${RED}[ERROR] Tailscale CLI is not installed on this machine.${NC}\n"
  echo -e "Please install Tailscale using the official installer for your OS:"
  echo -e "  • ${YELLOW}Linux${NC}   : curl -fsSL https://tailscale.com/install.sh | sh"
  echo -e "  • ${YELLOW}macOS${NC}   : brew install tailscale  (or install Tailscale App from Mac App Store)"
  echo -e "  • ${YELLOW}Windows${NC} : winget install Tailscale.Tailscale  (or download from https://tailscale.com/download/windows)"
  echo -e ""
  exit 1
fi

echo -e "${GREEN}✓ Tailscale CLI found.${NC}"

# ── 2. Check Tailscale Authentication ────────────────────────────────────────

echo -e "${BLUE}==> [2/4] Verifying Tailscale connection...${NC}"

if ! tailscale status &> /dev/null; then
  echo -e "${YELLOW}Tailscale is not logged in. Initiating authentication...${NC}"
  tailscale up || tailscale login
fi

TAILNET_DNS=$(tailscale status --json 2>/dev/null | grep -o '"DNSName": "[^"]*"' | head -n 1 | cut -d'"' -f4 | sed 's/\.$//' || true)

if [ -z "$TAILNET_DNS" ]; then
  TAILNET_DNS=$(tailscale status 2>/dev/null | head -n 1 | awk '{print $2}' || true)
fi

if [ -z "$TAILNET_DNS" ]; then
  echo -e "${RED}[ERROR] Could not determine your Tailnet DNS name.${NC}"
  echo -e "Make sure Tailscale is connected (run 'tailscale status')."
  exit 1
fi

echo -e "${GREEN}✓ Connected to Tailscale network as: ${CYAN}${TAILNET_DNS}${NC}\n"

# ── 3. Start Tailscale Funnel & Validate Ingress ──────────────────────────────

echo -e "${BLUE}==> [3/4] Enabling Tailscale Funnel on port ${PORT}...${NC}"

# Attempt to configure serve and funnel without swallowing errors
FUNNEL_ERR=""
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
  echo -e "  1. ${CYAN}Enable HTTPS Certificates${NC}:"
  echo -e "     Visit https://login.tailscale.com/admin/dns and toggle 'HTTPS Certificates' ON."
  echo -e "  2. ${CYAN}Enable Funnel in Access Controls (ACL)${NC}:"
  echo -e "     Visit https://login.tailscale.com/admin/acls and add funnel permissions,"
  echo -e "     or enable Funnel in Settings -> Feature Previews."
  echo -e "  3. ${CYAN}Check Funnel Status Directly${NC}:"
  echo -e "     Run: ${GREEN}tailscale funnel status${NC}"
  echo -e "${RED}╚══════════════════════════════════════════════════════════════╝${NC}\n"
  exit 1
fi

# The public URL will be https://<node-name>.<tailnet>.ts.net
FUNNEL_URL="https://${TAILNET_DNS}"
export TAILSCALE_FUNNEL_URL="${FUNNEL_URL}"

echo -e "\n${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  ✅ Public Tailscale Funnel Ingress Active!                  ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║  Public HTTPS URL : ${CYAN}${TAILSCALE_FUNNEL_URL}${NC}"
echo -e "${GREEN}║  Local Target     : http://127.0.0.1:${PORT}${NC}"
echo -e "${GREEN}║  Target Orchestr  : ${ORCHESTRATOR_URL}${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"

echo -e "\n${YELLOW}📱 VERIFY BEFORE TRUSTING:${NC}"
echo -e "  1. Check actual recorded funnel status:  ${GREEN}tailscale funnel status${NC}"
echo -e "  2. Turn ${RED}OFF Wi-Fi${NC} on your mobile phone (use Cellular 4G/5G data),"
echo -e "     and open: ${CYAN}${TAILSCALE_FUNNEL_URL}/health${NC} in your phone browser."
echo -e "     If it loads, the tunnel is genuinely live and reachable worldwide!\n"

# ── 4. Launch Edge Agent with Public URL ──────────────────────────────────────

echo -e "${BLUE}==> [4/4] Starting Edge Agent process in Mode B...${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

if [ ! -d "node_modules" ]; then
  echo -e "Installing dependencies..."
  npm install --omit=dev
fi

PORT="${PORT}" \
NODE_LABEL="${NODE_LABEL}" \
ORCHESTRATOR_URL="${ORCHESTRATOR_URL}" \
ORIGIN_URL="${ORIGIN_URL}" \
TAILSCALE_FUNNEL_URL="${TAILSCALE_FUNNEL_URL}" \
node server.js
