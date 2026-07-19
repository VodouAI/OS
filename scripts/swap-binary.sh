#!/usr/bin/env bash
# swap-binary.sh — atomic vodou-core / vodou-hook binary swap with safe
# daemon restart (kill BOTH daemon + worker, wait for processes to die,
# clear orphan sockets, then ensure).
#
# Per PLAN-HOST-ADAPTER-UNIFICATION.md §18 + §20 lesson: the previous
# "kill daemon only + ensure" pattern reliably triggered post-swap UE
# because orphan worker.sock from the prior daemon raced the new
# daemon's startup.
#
# Usage:
#   bash scripts/swap-binary.sh                # both binaries from target/release/
#   bash scripts/swap-binary.sh --core-only    # just vodou-core
#   bash scripts/swap-binary.sh --hook-only    # just vodou-hook-bin
#   bash scripts/swap-binary.sh --tag <name>   # name the .bak files (default: timestamp)
#
# Pre-conditions:
#   - target/release/vodou-core exists (cargo build --release run beforehand)
#   - vodou-hook/target/release/vodou-hook exists (when swapping hook)
#   - Daemon ideally settled ≥60s before invoking (per UE-avoidance discipline)

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

SWAP_CORE=1
SWAP_HOOK=1
TAG=""

while [ $# -gt 0 ]; do
    case "$1" in
        --core-only) SWAP_HOOK=0; shift ;;
        --hook-only) SWAP_CORE=0; shift ;;
        --tag)       TAG="$2"; shift 2 ;;
        --help|-h)
            grep '^# ' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *) echo "Unknown arg: $1" >&2; exit 2 ;;
    esac
done

if [ -z "$TAG" ]; then
    TAG="swap-$(date -u +%Y%m%dT%H%M%SZ)"
fi

# ─── Step 1: Pre-flight checks ────────────────────────────────────────────────

if [ "$SWAP_CORE" -eq 1 ] && [ ! -x target/release/vodou-core ]; then
    echo "ERROR: target/release/vodou-core not found. Run 'cargo build --release --bin vodou-core' first." >&2
    exit 1
fi

if [ "$SWAP_HOOK" -eq 1 ] && [ ! -x vodou-hook/target/release/vodou-hook ]; then
    echo "ERROR: vodou-hook/target/release/vodou-hook not found. Run 'cd vodou-hook && cargo build --release' first." >&2
    exit 1
fi

# ─── Step 2: Backup current binaries ──────────────────────────────────────────

if [ "$SWAP_CORE" -eq 1 ]; then
    cp ./vodou-core "./vodou-core.pre-${TAG}.bak"
    echo "  backup: ./vodou-core.pre-${TAG}.bak ($(md5 -q ./vodou-core))"
fi

if [ "$SWAP_HOOK" -eq 1 ] && [ -x ./vodou-hook-bin ]; then
    cp ./vodou-hook-bin "./vodou-hook-bin.pre-${TAG}.bak"
    echo "  backup: ./vodou-hook-bin.pre-${TAG}.bak ($(md5 -q ./vodou-hook-bin))"
fi

# ─── Step 3: Atomic swap (cp, not mv — preserves perms) ───────────────────────

if [ "$SWAP_CORE" -eq 1 ]; then
    cp target/release/vodou-core ./vodou-core
    echo "  swapped vodou-core → $(md5 -q ./vodou-core)"
fi

if [ "$SWAP_HOOK" -eq 1 ]; then
    cp vodou-hook/target/release/vodou-hook ./vodou-hook-bin
    echo "  swapped vodou-hook-bin → $(md5 -q ./vodou-hook-bin)"
fi

# ─── Step 4: Kill BOTH daemon AND worker (per §18 / §20 lesson) ───────────────

DAEMON_PID="$(cat .vodou/daemon.pid 2>/dev/null || true)"
WORKER_PID="$(cat .vodou/worker.pid 2>/dev/null || true)"

if [ -n "$DAEMON_PID" ]; then
    echo "  killing daemon PID $DAEMON_PID"
    kill "$DAEMON_PID" 2>/dev/null || true
fi
if [ -n "$WORKER_PID" ]; then
    echo "  killing worker PID $WORKER_PID"
    kill "$WORKER_PID" 2>/dev/null || true
fi

# ─── Step 5: Wait for processes to actually die (avoid orphan race) ──────────
# This is the KEY missing piece from earlier swap attempts. SIGTERM doesn't
# return until handler runs; we have to poll until the processes are gone
# before clearing sockets and re-ensuring.

deadline=$(($(date +%s) + 30))
while pgrep -f "vodou-core (daemon|worker) start" >/dev/null 2>&1; do
    if [ "$(date +%s)" -gt "$deadline" ]; then
        # Per PLAN-HOST-ADAPTER-UNIFICATION §24 lesson: wedged graceful-shutdown
        # is a real failure mode (daemon acks SIGTERM, starts WAL checkpoint, then
        # hangs indefinitely). Escalate to SIGKILL for any survivors before
        # clearing sockets, otherwise the live-but-wedged daemon races the new
        # ensure for socket bind.
        survivors="$(pgrep -f "vodou-core (daemon|worker) start" || true)"
        if [ -n "$survivors" ]; then
            echo "  WARN: SIGTERM didn't drain in 30s — escalating to SIGKILL on: $survivors" >&2
            echo "$survivors" | xargs kill -9 2>/dev/null || true
            sleep 2
        fi
        break
    fi
    sleep 1
done
echo "  daemon + worker processes confirmed dead"

# ─── Step 6: Clear orphan sockets + pid files ─────────────────────────────────

rm -f .vodou/daemon.sock .vodou/daemon.pid .vodou/worker.sock .vodou/worker.pid
echo "  cleared orphan sockets + pid files"

# ─── Step 7: Daemon ensure (detached so we can sleep + check) ────────────────

nohup ./vodou-core daemon ensure </dev/null >/dev/null 2>&1 & disown
echo "  daemon ensure dispatched (waiting 14s for warmup)"
sleep 14

# ─── Step 8: Verify daemon is up ─────────────────────────────────────────────

if [ ! -S .vodou/daemon.sock ]; then
    echo "ERROR: daemon.sock not present 14s after ensure. Check .vodou/system.log:" >&2
    tail -10 .vodou/system.log >&2
    echo
    echo "Rollback with: cp ./vodou-core.pre-${TAG}.bak ./vodou-core && bash $0 --core-only --tag rollback"
    exit 1
fi

NEW_DAEMON_PID="$(cat .vodou/daemon.pid 2>/dev/null || echo '?')"
NEW_WORKER_PID="$(cat .vodou/worker.pid 2>/dev/null || echo '?')"

echo "  ✅ daemon up (PID $NEW_DAEMON_PID, worker PID $NEW_WORKER_PID)"
echo
echo "Swap complete. Tag: $TAG"
echo "  rollback: cp ./vodou-core.pre-${TAG}.bak ./vodou-core (then re-run this script)"
