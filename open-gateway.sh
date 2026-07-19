#!/bin/bash
# open-gateway.sh — Open the Vodou gateway UI in the default browser.
# The gateway service keeps running under launchd even when no window is open;
# this just (re)opens a browser tab pointed at it.

set -e

VODOU_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_PORT="${WEB_PORT:-8765}"

# Load WEB_PORT override from .env if present
if [ -f "$VODOU_DIR/.env" ]; then
    ENV_PORT="$(grep -E '^WEB_PORT=' "$VODOU_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"' | tr -d "'")"
    [ -n "$ENV_PORT" ] && WEB_PORT="$ENV_PORT"
fi

URL="http://localhost:$WEB_PORT"

# If the gateway isn't bound, start it (suppressing its own auto-open since
# we're about to open the URL ourselves anyway).
if ! command -v lsof &>/dev/null || ! lsof -ti :"$WEB_PORT" &>/dev/null; then
    echo "Gateway not running on :$WEB_PORT — starting it…"
    if [ -x "$VODOU_DIR/start-vodou-services.sh" ]; then
        VODOU_NO_OPEN_BROWSER=1 "$VODOU_DIR/start-vodou-services.sh" >/dev/null 2>&1 || true
        # Wait up to 10s for it to come up
        for _i in $(seq 1 10); do
            command -v lsof &>/dev/null && lsof -ti :"$WEB_PORT" &>/dev/null && break
            sleep 1
        done
    fi
fi

echo "Opening $URL"
if [[ "$(uname)" == "Darwin" ]]; then
    open "$URL" 2>/dev/null || osascript -e "open location \"$URL\"" 2>/dev/null || true
elif command -v xdg-open &>/dev/null; then
    xdg-open "$URL" 2>/dev/null
else
    echo "Please open $URL manually."
fi
