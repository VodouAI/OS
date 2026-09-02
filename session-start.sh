#!/bin/bash

# P4 — this entrypoint declares its stack (stacks.toml). Read by
# `vodou-core stacks`, the exec-world seam, and the receipt, so a lane
# that is off in this composition renders `off (stack)` rather than
# absent — indistinguishable from a lane that failed.
export VODOU_STACK="${VODOU_STACK:-web}"
# session-start.sh — Wrapper for SessionStart hook
# Runs normal vodou-hook-bin context, then checks if bootstrap is needed

BOOTSTRAP=".vodou/workspace/BOOTSTRAP.md"
IDENTITY=".vodou/workspace/IDENTITY.md"
CACHE=".vodou/workspace/.context_cache"

if [ -f "$BOOTSTRAP" ]; then
  # BOOTSTRAP.md exists — check if identity is still template/empty
  if grep -q 'Name:.*_(pick' "$IDENTITY" 2>/dev/null || ! grep -qE 'Name:\s*\S' "$IDENTITY" 2>/dev/null; then
    # Fresh install — invalidate stale cache and set bootstrap flag
    rm -f "$CACHE" 2>/dev/null
    touch ".vodou/workspace/.bootstrapping"

    # Get fresh context, strip AGENTS.md (too long, distracts from bootstrap)
    CONTEXT_OUTPUT=$(./vodou-hook-bin context 2>/dev/null | sed '/^### AGENTS\.md$/,/^### [A-Z]/{ /^### [A-Z][^G]/!d; }')

    # Loud bootstrap instruction that can't be missed
    echo "## *** BOOTSTRAP REQUIRED — DO NOT SKIP ***"
    echo ""
    echo "STOP. Do NOT greet the user as if you know them. Do NOT say 'Hey Chad' or 'Lucky here'."
    echo "You are a brand new agent with NO identity yet. Follow BOOTSTRAP.md instructions below EXACTLY."
    echo "You must have the bootstrap conversation, then write ALL files listed in BOOTSTRAP.md before the session ends."
    echo ""
    echo "$CONTEXT_OUTPUT"
  else
    # Identity filled — bootstrap complete, clean up
    rm -f "$BOOTSTRAP"
    CONTEXT_OUTPUT=$(./vodou-hook-bin context 2>/dev/null)
    echo "$CONTEXT_OUTPUT"
  fi
else
  # No BOOTSTRAP.md — normal operation
  CONTEXT_OUTPUT=$(./vodou-hook-bin context 2>/dev/null)
  echo "$CONTEXT_OUTPUT"
fi

# Quick check: if Vodou services aren't running, start them in the background.
# Suppress browser auto-open here — SessionStart is non-interactive (Claude/Cursor
# hook), nobody is watching the terminal to dismiss a popped tab.
# Honor WEB_PORT (multi-instance installs run on non-default ports) — from the
# environment if exported, else from the .env beside this script, else 8765.
VODOU_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${WEB_PORT:-}" ] && [ -f "$VODOU_DIR/.env" ]; then
  WEB_PORT="$(grep -E '^WEB_PORT=' "$VODOU_DIR/.env" | tail -1 | cut -d= -f2 | tr -d '"' | tr -d "'")"
fi
WEB_PORT="${WEB_PORT:-8765}"
if ! curl -sf --max-time 3 "http://127.0.0.1:${WEB_PORT}/health" 2>/dev/null | grep -q '"status"'; then
  VODOU_NO_OPEN_BROWSER=1 nohup "$VODOU_DIR/start-vodou-services.sh" > /tmp/vodou-services-autostart.log 2>&1 &
  echo "## Vodou Services"
  echo "Services not detected — starting in background (log: /tmp/vodou-services-autostart.log)"
fi
