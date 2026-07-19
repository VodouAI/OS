#!/usr/bin/env bash
# oi-with-vodou.sh — Open Interpreter wrapper that injects Vodou continuity context.
#
# OI has --custom_instructions / --instructions flags but no native pre-prompt
# hook. This wrapper:
# 1. Fetches workspace context from vodou-hook-bin
# 2. Writes it to a temp file
# 3. Launches `interpreter` with --custom_instructions pointing at the temp file
# 4. Per-session conversation gets recorded via OI's session storage; the
#    daemon detects Surface::OpenInterpreter from /open-interpreter/ or
#    /.openinterpreter/ in transcript paths.
#
# Usage: oi-with-vodou.sh [interpreter args...]

set -e

VODOU_HOOK_BIN="${VODOU_HOOK_BIN:-vodou-hook-bin}"
OI_BIN="${OI_BIN:-interpreter}"

CONTEXT_FILE=""
if command -v "$VODOU_HOOK_BIN" >/dev/null 2>&1; then
    CONTEXT_FILE="$(mktemp /tmp/vodou-oi-context.XXXXXX.md)"
    if "$VODOU_HOOK_BIN" context > "$CONTEXT_FILE" 2>/dev/null; then
        echo "[oi-with-vodou] injecting $(wc -c < "$CONTEXT_FILE") bytes of Vodou context as custom_instructions" >&2
    else
        rm -f "$CONTEXT_FILE"
        CONTEXT_FILE=""
    fi
else
    echo "[oi-with-vodou] vodou-hook-bin not found on PATH — skipping" >&2
fi

if [ -n "$CONTEXT_FILE" ] && [ -s "$CONTEXT_FILE" ]; then
    # OI's --custom_instructions takes a string; we pass the file content via --custom_instructions "$(cat ...)"
    # If your OI version supports --instructions <path>, prefer that.
    "$OI_BIN" --custom_instructions "$(cat "$CONTEXT_FILE")" "$@"
    EXIT=$?
    rm -f "$CONTEXT_FILE"
else
    "$OI_BIN" "$@"
    EXIT=$?
fi

if command -v "$VODOU_HOOK_BIN" >/dev/null 2>&1; then
    "$VODOU_HOOK_BIN" sock flush 2>/dev/null || true
fi

exit $EXIT
