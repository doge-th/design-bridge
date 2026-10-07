#!/bin/bash
# Restore MiniMax Design to its official cloud gateway.
set -euo pipefail

AGENT_LABEL="com.design-bridge.server"
AGENT_PLIST="$HOME/Library/LaunchAgents/${AGENT_LABEL}.plist"

launchctl unsetuserenv CLOUD_GATEWAY_BASE_URL && echo "==> CLOUD_GATEWAY_BASE_URL cleared" || true

if [ -f "$AGENT_PLIST" ]; then
  launchctl unload "$AGENT_PLIST" 2>/dev/null || true
  rm -f "$AGENT_PLIST"
  echo "==> LaunchAgent removed"
fi

echo "DONE. Fully quit MiniMax Design (tray included) and reopen to go back to official billing."
