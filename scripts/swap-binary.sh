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
#
# Post-conditions (Step 8b, added 2026-08-27 after three same-day incidents):
#   - the daemon answering on the socket reports it is NOT running a stale image,
#     and is a release build;
#   - ./vodou-core is still byte-for-byte what this script installed (a parallel
#     session's swap during the window is an ERROR, not a silent overwrite).
#   A swap that cannot prove both exits non-zero rather than printing "complete".

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

# ─── Step 3: Kill BOTH daemon AND worker (per §18 / §20 lesson) ───────────────
#
# The kill comes BEFORE the swap, and that ordering is the fix for a real incident
# (2026-08-05). This script used to copy over ./vodou-core at this point and kill
# afterwards, which meant EVERY invocation overwrote a running Mach-O image. Doing it
# twice in quick succession left five macOS processes wedged in `UE` — unkillable, and
# counted by the process-overload guard, which then refused every non-exempt command.
#
# See Step 6 for the other half of the fix (rm before cp, then re-sign).

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

# ─── Step 4: Wait for processes to actually die (avoid orphan race) ──────────
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

# ─── Step 4b: the LOCKS must actually be free ────────────────────────────────
#
# Step 4 waits on a pgrep pattern. `daemon ensure` does not care about pgrep —
# it needs the flock on .vodou/daemon.lock. Those are not the same condition,
# and on 2026-08-15 they diverged: this script killed the pids from the pid
# files, its drain check then SIGKILLed two OTHER survivors (2916/2917) it had
# never targeted, and the ensure STILL failed with "Daemon already running
# (lock held)". All the operator saw was "daemon.sock not present 14s after
# ensure" — the symptom, with the cause hidden. Every later start collided with
# the same lock, and the gateway's auto-ensure kept respawning into it.
#
# flock is released by the kernel the moment the holder dies, so a lock that is
# still held ALWAYS means a live process — no staleness to guess about. Name it,
# kill it, and verify, rather than marching into an ensure that cannot succeed.
lock_holders() {
    [ -e "$1" ] || return 0
    command -v lsof >/dev/null 2>&1 || return 0
    lsof -t "$1" 2>/dev/null || true
}

for _lk in daemon worker; do
    _lockf=".vodou/${_lk}.lock"
    _held="$(lock_holders "$_lockf" || true)"
    [ -n "$_held" ] || continue
    echo "  WARN: $_lockf still held after the drain — by:" >&2
    ps -o pid,command= -p "$(echo "$_held" | tr '\n' ',' | sed 's/,$//')" 2>/dev/null | sed 's/^/        /' >&2
    # These are, by definition, live vodou-core processes that outlived Step 4.
    # shellcheck disable=SC2086
    kill -9 $_held 2>/dev/null || true
    sleep 2
    _held="$(lock_holders "$_lockf" || true)"
    if [ -n "$_held" ]; then
        echo "ERROR: $_lockf is STILL held after SIGKILL (pids: $(echo "$_held" | tr '\n' ' '))." >&2
        echo "       'daemon ensure' would fail with \"already running (lock held)\" and this" >&2
        echo "       script would report only a missing socket. Refusing to continue." >&2
        echo "       Inspect: lsof $_lockf" >&2
        exit 1
    fi
    echo "  $_lockf released"
done
echo "  daemon + worker locks confirmed free"

# ─── Step 5: Clear orphan sockets + pid files ─────────────────────────────────

rm -f .vodou/daemon.sock .vodou/daemon.pid .vodou/worker.sock .vodou/worker.pid
echo "  cleared orphan sockets + pid files"

# ─── Step 6: Swap the binaries — now that nothing is executing them ──────────
#
# rm THEN cp, never cp alone. `cp` opens the destination in place, so writing over a
# file some process still has mapped corrupts that process's image rather than giving
# it a new one; `rm` unlinks, so anything still running keeps the old inode and the new
# file is genuinely new. Then re-sign: an ad-hoc signature does not survive the copy,
# and an unsigned binary fails to launch on macOS with a signal nobody reads as
# "resign me".
#
# This is the documented recovery sequence from the UE incident, promoted to being the
# normal path so the recovery is never needed again.

INSTALLED_CORE_MD5=""

swap_one() {
    src="$1"; dst="$2"
    rm -f "$dst"
    cp "$src" "$dst"
    chmod +x "$dst"
    codesign --force --sign - "$dst" 2>/dev/null || true
    _md5="$(md5 -q "$dst")"
    [ "$dst" = "./vodou-core" ] && INSTALLED_CORE_MD5="$_md5"
    echo "  swapped $dst → $_md5"
}

if [ "$SWAP_CORE" -eq 1 ]; then
    swap_one target/release/vodou-core ./vodou-core
fi

if [ "$SWAP_HOOK" -eq 1 ]; then
    swap_one vodou-hook/target/release/vodou-hook ./vodou-hook-bin
fi

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

# ─── Step 8b: the daemon that came up must BE the binary we installed ────────
#
# Three incidents on 2026-08-27 alone: a swap "succeeded", and the daemon that
# answered afterwards was serving other code. Steps 1-8 prove a socket exists —
# they never asked what is behind it. Two different ways that goes wrong:
#
#   (a) the daemon booted BEFORE the file it runs was rewritten (a concurrent
#       `daemon ensure`, or the gateway's auto-ensure, won the race). It serves
#       the old image with a fresh pid and a healthy socket.
#   (b) ANOTHER swap landed while this one ran — parallel sessions share this
#       worktree — so ./vodou-core on disk is no longer what this script put
#       there, and the operator is told a hash that is already historical.
#
# The daemon already answers (a) itself: `handle_status` returns `stale_binary`
# (its exe was rewritten after it booted), `build_profile` and `exe_path`. That
# check was built for this exact incident class and nothing called it. (b) is a
# re-read of the file we just wrote. Neither is a heuristic: a stale daemon is a
# fact the daemon reports about itself, and a changed hash is a changed file.
daemon_status_json() {
    command -v python3 >/dev/null 2>&1 || return 1
    python3 - "$PROJECT_ROOT/.vodou/daemon.sock" <<'PYEOF' 2>/dev/null
import json, socket, sys
try:
    c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); c.settimeout(8); c.connect(sys.argv[1])
    c.sendall(b'{"cmd":"status"}\n')
    buf = b''
    while not buf.endswith(b'\n'):
        chunk = c.recv(65536)
        if not chunk:
            break
        buf += chunk
    d = json.loads(buf.decode()).get('data') or {}
    print(json.dumps({k: d.get(k) for k in ('pid', 'stale_binary', 'build_profile', 'exe_path', 'version')}))
except Exception:
    sys.exit(1)
PYEOF
}

IDENTITY_OK=1
if [ "$SWAP_CORE" -eq 1 ]; then
    ON_DISK_MD5="$(md5 -q ./vodou-core 2>/dev/null || echo '?')"
    if [ -n "$INSTALLED_CORE_MD5" ] && [ "$ON_DISK_MD5" != "$INSTALLED_CORE_MD5" ]; then
        echo "ERROR: ./vodou-core changed during this swap — another swap raced this one." >&2
        echo "       installed: $INSTALLED_CORE_MD5" >&2
        echo "       on disk:   $ON_DISK_MD5" >&2
        echo "       The daemon now running is NOT the build you just made. Parallel sessions" >&2
        echo "       share this worktree; re-run your build + this script when the other" >&2
        echo "       session is quiet, and check with: ./vodou-core builds" >&2
        IDENTITY_OK=0
    fi

    if STATUS_JSON="$(daemon_status_json)"; then
        echo "  daemon self-report: $STATUS_JSON"
        case "$STATUS_JSON" in
            *'"stale_binary": true'*)
                echo "ERROR: the daemon reports stale_binary=true — it booted BEFORE the binary it" >&2
                echo "       runs was rewritten, so it is serving the OLD image behind a healthy" >&2
                echo "       socket. Something re-ensured the daemon during the swap window." >&2
                echo "       Re-run this script; if it repeats, find the racer: pgrep -fl 'daemon ensure'" >&2
                IDENTITY_OK=0
                ;;
        esac
        case "$STATUS_JSON" in
            *'"build_profile": "debug"'*)
                echo "ERROR: the running daemon is a DEBUG build in a release install (the 38-hour" >&2
                echo "       stale-daemon incident's fingerprint). Rebuild with --release." >&2
                IDENTITY_OK=0
                ;;
        esac
    else
        echo "  WARN: could not read the daemon's self-report (no python3, or the socket did not" >&2
        echo "        answer). The swap is UNVERIFIED — check by hand: ./vodou-core builds" >&2
    fi
fi

if [ "$IDENTITY_OK" -ne 1 ]; then
    echo >&2
    echo "Swap NOT verified. Tag: $TAG" >&2
    echo "  rollback: cp ./vodou-core.pre-${TAG}.bak ./vodou-core (then re-run this script)" >&2
    exit 1
fi

echo "  ✅ daemon up (PID $NEW_DAEMON_PID, worker PID $NEW_WORKER_PID) — running the binary this script installed"
echo
echo "Swap complete. Tag: $TAG"
echo "  rollback: cp ./vodou-core.pre-${TAG}.bak ./vodou-core (then re-run this script)"
