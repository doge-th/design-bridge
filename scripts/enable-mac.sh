#!/bin/bash
# Point MiniMax Design at the local design-bridge proxy (macOS).
#
# 1. sets CLOUD_GATEWAY_BASE_URL in the GUI environment (launchctl setuserenv)
# 2. (optional, --agent) installs a LaunchAgent so the bridge auto-starts
# 3. reminds you to fully quit MiniMax Design (tray icon included) and reopen
set -euo pipefail

PORT="${DESIGN_BRIDGE_PORT:-9527}"
BRIDGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_LABEL="com.design-bridge.server"
AGENT_PLIST="$HOME/Library/LaunchAgents/${AGENT_LABEL}.plist"
NODE_BIN="$(command -v node)"

echo "==> bridge dir: $BRIDGE_DIR"
echo "==> node:       ${NODE_BIN:-NOT FOUND}"
[ -z "$NODE_BIN" ] && { echo "error: node not found in PATH"; exit 1; }

# 1. env injection for the app
launchctl setuserenv CLOUD_GATEWAY_BASE_URL "http://127.0.0.1:${PORT}"
echo "==> CLOUD_GATEWAY_BASE_URL=http://127.0.0.1:${PORT} set for GUI apps"

# 2. keep the bridge alive across reboots (skip with --no-agent)
if [ "${1:-}" != "--no-agent" ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$AGENT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${BRIDGE_DIR}/bridge.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${BRIDGE_DIR}/bridge.log</string>
  <key>StandardErrorPath</key><string>${BRIDGE_DIR}/bridge.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF
  launchctl unload "$AGENT_PLIST" 2>/dev/null || true
  launchctl load "$AGENT_PLIST"
  echo "==> LaunchAgent installed and started (log: ${BRIDGE_DIR}/bridge.log)"
fi

echo ""
echo "DONE. Now fully quit MiniMax Design (also the menu-bar/tray icon) and reopen it."
echo "Verify:  curl -s http://127.0.0.1:${PORT}/__bridge/health"
echo "Undo:    ./scripts/disable-mac.sh"
