#!/bin/bash
# Install Vodou Console as a macOS Launch Agent (auto-starts on login)
# Usage: ./scripts/install-launchd.sh
#   To uninstall: ./scripts/install-launchd.sh --uninstall

set -e

LABEL="com.vodou.console"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
GATEWAY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VODOU_DIR="$(cd "${GATEWAY_DIR}/../.." && pwd)"
NODE_BIN="$(which node)"
LOG_DIR="${GATEWAY_DIR}/logs"

if [ "$1" = "--uninstall" ]; then
  echo "Uninstalling ${LABEL}..."
  launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  echo "Done. Gateway will no longer auto-start."
  exit 0
fi

# Ensure logs directory exists
mkdir -p "$LOG_DIR"

# Unload existing version if present
launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true

echo "Installing ${LABEL}..."
echo "  Gateway dir: ${GATEWAY_DIR}"
echo "  Node:        ${NODE_BIN}"
echo "  Logs:        ${LOG_DIR}"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>dist/index.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${GATEWAY_DIR}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/gateway-stdout.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/gateway-stderr.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${HOME}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>VODOU_PROJECT_PATH</key>
        <string>${VODOU_DIR}</string>
    </dict>

    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
EOF

launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"

echo ""
echo "Installed and started. Gateway will auto-start on login."
echo "  Logs:      tail -f ${LOG_DIR}/gateway-stderr.log"
echo "  Stop:      launchctl kickstart -k gui/$(id -u)/${LABEL}"
echo "  Uninstall: $0 --uninstall"
