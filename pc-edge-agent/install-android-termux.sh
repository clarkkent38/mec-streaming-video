#!/data/data/com.termux/files/usr/bin/bash
# ==============================================================================
# install-android-termux.sh — Android Mobile Edge Agent Setup
# ==============================================================================
# Turns an Android Smartphone into a live MEC Edge Node using Termux!
#
# ==============================================================================
# 📱 TAILSCALE FUNNEL ON ANDROID (MANUAL APP SETUP INSTRUCTIONS):
# ------------------------------------------------------------------------------
# Tailscale Funnel on Android is managed through the Tailscale Android App UI:
#
# 1. Install the official Tailscale App from Google Play Store or F-Droid.
# 2. Open Tailscale, sign in, and tap the switch to connect to your Tailnet.
# 3. Note down your Android node's Tailnet DNS name:
#      (e.g., https://pixel-phone.tail1234.ts.net)
# 4. In the Tailscale Admin Console (https://login.tailscale.com/admin/machines):
#      - Locate your Android device.
#      - Click "Machine Settings" -> Ensure "Funnel" is enabled for port 5001.
# 5. Export your Tailscale URL before launching (or enter it when prompted):
#      export TAILSCALE_FUNNEL_URL="https://pixel-phone.tail1234.ts.net"
# ==============================================================================

set -e

echo -e "\n========================================================"
echo -e "   🚀 Android MEC Edge Node Installer (Termux)"
echo -e "========================================================\n"

# 1. Update Termux repositories and install Node.js & Git
echo "==> [1/3] Updating package index and installing Node.js..."
pkg update -y
pkg install -y nodejs-lts git curl

echo -e "\n✓ Node.js $(node -v) and npm $(npm -v) are ready."

# 2. Install dependencies
echo -e "\n==> [2/3] Installing lightweight edge proxy dependencies..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

npm install --omit=dev

# 3. Configuration & Startup
echo -e "\n==> [3/3] Configuring Android Edge Node..."

# Prompt for Orchestrator URL
DEFAULT_ORCH="https://orchestrator-id88.onrender.com"
read -r -p "Enter Orchestrator URL [default: $DEFAULT_ORCH]: " input_orch
ORCHESTRATOR_URL=${input_orch:-$DEFAULT_ORCH}

# Prompt for Node Label
DEFAULT_LABEL="Android-Edge-Phone"
read -r -p "Enter Node Label [default: $DEFAULT_LABEL]: " input_label
NODE_LABEL=${input_label:-$DEFAULT_LABEL}

# Prompt for Tailscale Funnel URL (Optional)
read -r -p "Enter Tailscale Funnel URL if enabled (e.g. https://myphone.ts.net) [optional]: " input_funnel
TAILSCALE_FUNNEL_URL=${input_funnel:-}

echo -e "\n========================================================"
echo -e " Starting Edge Node on Android..."
echo -e " Node Label        : $NODE_LABEL"
echo -e " Orchestrator      : $ORCHESTRATOR_URL"
if [ -n "$TAILSCALE_FUNNEL_URL" ]; then
  echo -e " Mode              : Mode B (Public Tailscale Funnel)"
  echo -e " Funnel URL        : $TAILSCALE_FUNNEL_URL"
else
  echo -e " Mode              : Mode A (Local Wi-Fi Network)"
fi
echo -e "========================================================\n"

PORT=5001 \
NODE_LABEL="$NODE_LABEL" \
ORCHESTRATOR_URL="$ORCHESTRATOR_URL" \
ORIGIN_URL="https://origin-server-1ge5.onrender.com" \
TAILSCALE_FUNNEL_URL="$TAILSCALE_FUNNEL_URL" \
node server.js
