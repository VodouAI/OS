#!/usr/bin/env bash
# vodou-deploy.sh — atomic vodou-core binary swap.
#
# Replaces the running vodou-core binary without leaving a stale-code PID
# serving requests. Solves the "I fixed that bug, why is it still happening?"
# class of failure caused by `cp vodou-core` while the old PID is alive.
#
# Usage:
#   bin/vodou-deploy.sh <path-to-new-binary>
#
# Example:
#   cargo build --release
#   bin/vodou-deploy.sh target/release/vodou-core
#
# What it does (in order):
#   1. Read .vodou/daemon.pid
#   2. SIGTERM the PID (clean shutdown — runs WAL checkpoint + Drops)
#   3. Wait up to 10s for the process to exit and the socket to disappear
#   4. Atomically replace ./vodou-core with the new binary
#   5. Start the new daemon (./vodou daemon start)
#   6. Wait up to 10s for the new socket to appear
#   7. Print version of the running daemon for confirmation
#
# Exit codes:
#   0  success
#   1  bad arguments
#   2  source binary missing or not executable
#   3  daemon failed to stop within timeout
#   4  daemon failed to start within timeout
#   5  could not read project root

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT" || { echo "vodou-deploy: could not cd to project root" >&2; exit 5; }

SRC="${1:-}"
if [ -z "$SRC" ]; then
  echo "Usage: $0 <path-to-new-binary>" >&2
  exit 1
fi
if [ ! -x "$SRC" ]; then
  echo "vodou-deploy: source binary not found or not executable: $SRC" >&2
  exit 2
fi

DEST="$PROJECT_ROOT/vodou-core"
PID_FILE="$PROJECT_ROOT/.vodou/daemon.pid"
SOCK_FILE="$PROJECT_ROOT/.vodou/daemon.sock"

echo "vodou-deploy: target = $DEST"
echo "vodou-deploy: source = $SRC"

# --- Step 1+2: stop running daemon, if any ----------------------------------
if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "vodou-deploy: SIGTERM to running daemon (PID $PID)"
    kill -TERM "$PID" || true

    # --- Step 3: wait for clean exit ---
    for i in $(seq 1 20); do
      if ! kill -0 "$PID" 2>/dev/null && [ ! -S "$SOCK_FILE" ]; then
        echo "vodou-deploy: daemon stopped cleanly (after ${i}x500ms)"
        break
      fi
      sleep 0.5
    done

    if kill -0 "$PID" 2>/dev/null; then
      echo "vodou-deploy: daemon did not exit within 10s — escalating to SIGKILL" >&2
      kill -KILL "$PID" || true
      sleep 1
      if kill -0 "$PID" 2>/dev/null; then
        echo "vodou-deploy: daemon still alive after SIGKILL — kernel may be wedged" >&2
        exit 3
      fi
    fi
  else
    echo "vodou-deploy: stale PID file (PID $PID not running) — ignoring"
  fi
else
  echo "vodou-deploy: no daemon.pid found — assuming no daemon running"
fi

# Belt-and-suspenders: if the socket file lingered, remove it.
if [ -S "$SOCK_FILE" ]; then
  echo "vodou-deploy: removing stale socket file"
  rm -f "$SOCK_FILE"
fi

# --- Step 4: atomic binary swap --------------------------------------------
# Use `mv` over the destination — POSIX mv is atomic on the same filesystem.
# Compare bytes first; skip swap if identical (idempotent re-runs).
if [ -f "$DEST" ] && cmp -s "$SRC" "$DEST"; then
  echo "vodou-deploy: binary unchanged (cmp identical) — skipping swap"
else
  echo "vodou-deploy: swapping binary"
  cp "$SRC" "$DEST.new"
  chmod +x "$DEST.new"
  mv -f "$DEST.new" "$DEST"
fi

# --- Step 5+6: start the new daemon ----------------------------------------
echo "vodou-deploy: starting new daemon"
./vodou daemon start >/dev/null 2>&1 &
START_PID=$!

# Wait for socket to appear (up to 10s)
for i in $(seq 1 20); do
  if [ -S "$SOCK_FILE" ]; then
    echo "vodou-deploy: daemon socket up (after ${i}x500ms)"
    break
  fi
  sleep 0.5
done

if [ ! -S "$SOCK_FILE" ]; then
  echo "vodou-deploy: daemon failed to start within 10s — check .vodou/system.log" >&2
  exit 4
fi

# --- Step 7: confirm version -----------------------------------------------
if command -v ./vodou >/dev/null 2>&1; then
  VERSION_LINE="$(./vodou --version 2>/dev/null || true)"
  if [ -n "$VERSION_LINE" ]; then
    echo "vodou-deploy: $VERSION_LINE"
  fi
fi

echo "vodou-deploy: done."
