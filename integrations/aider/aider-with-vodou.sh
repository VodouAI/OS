#!/usr/bin/env bash
# aider-with-vodou.sh — Aider wrapper that injects Vodou continuity context.
#
# Aider has no native session-start hook, so this wrapper:
# 1. Fetches workspace bootstrap from vodou-hook-bin context
# 2. Writes it to a temp file
# 3. Launches aider with --read pointing at the temp file
# 4. After aider exits, optionally records a "session ended" turn
#
# For per-prompt recording, aider would need to call vodou-hook-bin sock prompt
# on each user input — which Aider doesn't expose as a hook. The fallback is the
# gateway extractor reading .aider.chat.history.md on its 5-min cycle (which
# our daemon's surface heuristic detects as Surface::Aider via the
# `.aider.chat.history` substring match).
#
# Usage: aider-with-vodou.sh [aider args...]
# Example: aider-with-vodou.sh --model sonnet src/foo.rs

set -e

VODOU_HOOK_BIN="${VODOU_HOOK_BIN:-vodou-hook-bin}"
VODOU_PROJECT_PATH="${VODOU_PROJECT_PATH:-$(pwd)}"
AIDER_BIN="${AIDER_BIN:-aider}"

# 1. Fetch Vodou workspace context (skip silently if vodou-hook-bin not found)
CONTEXT_FILE=""
if command -v "$VODOU_HOOK_BIN" >/dev/null 2>&1; then
    CONTEXT_FILE="$(mktemp /tmp/vodou-aider-context.XXXXXX.md)"
    if "$VODOU_HOOK_BIN" context > "$CONTEXT_FILE" 2>/dev/null; then
        echo "[aider-with-vodou] injecting $(wc -c < "$CONTEXT_FILE") bytes of Vodou context" >&2
    else
        rm -f "$CONTEXT_FILE"
        CONTEXT_FILE=""
    fi
else
    echo "[aider-with-vodou] vodou-hook-bin not found on PATH — skipping context injection" >&2
fi

# 2. Launch aider — inject context via --read if we got it
if [ -n "$CONTEXT_FILE" ] && [ -s "$CONTEXT_FILE" ]; then
    "$AIDER_BIN" --read "$CONTEXT_FILE" "$@"
    EXIT=$?
    rm -f "$CONTEXT_FILE"
else
    "$AIDER_BIN" "$@"
    EXIT=$?
fi

# 3. Best-effort flush after aider exits — aider's chat history file
# (.aider.chat.history.md in cwd) will be picked up by the gateway extractor
# on its next 5-min cycle. Optionally trigger an immediate flush:
if command -v "$VODOU_HOOK_BIN" >/dev/null 2>&1; then
    "$VODOU_HOOK_BIN" sock flush 2>/dev/null || true
fi

exit $EXIT
