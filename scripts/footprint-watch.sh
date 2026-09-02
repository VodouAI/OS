#!/usr/bin/env bash
# footprint-watch.sh — catch a vodou-core memory spike IN THE ACT and name it.
#
# WHY THIS EXISTS
#
# 2026-08-29: vodou-core was reported at "300%+ CPU and ~28 GB". By the time
# anyone looked, the machine had been rebooted and the process was gone. The
# whole diagnosis had to be reconstructed from log timing, and the 28 GB was
# never explained. This script exists so the next occurrence explains itself.
#
# WHY NOT RSS
#
# `ps` RSS is the wrong number and actively misleads. On the live daemon it
# read 456 MB — and swung as low as 22 MB — while the real figure, the one
# Activity Monitor shows, was 1848 MB. RSS excludes compressed and swapped
# pages, which is most of this process. Everything here reads phys_footprint.
#
# WHY NOT LAUNCHD
#
# TCC blocks launchd agents from reading this repo on the Desktop; such an
# agent reports "healthy" while blind (see the com.vodou.console EX_CONFIG
# loop). Run this from a terminal instead, where it inherits your TCC grants:
#
#   bash scripts/footprint-watch.sh &
#
# THE COST, STATED HONESTLY
#
# `sample`, `heap` and `vmmap` SUSPEND the target while they read it. On
# 2026-08-29 a manual `heap` on the 2 GB daemon is the most likely reason it
# missed a liveness ping and got recycled. So: the cheap probes run at the
# first threshold, and `heap` — the most disruptive — only at a second, higher
# one, where the process is already in trouble and the answer is worth a stall.
#
# Tunables (env):
#   VODOU_FP_WARN_MB    first threshold, cheap capture      (default 4000)
#   VODOU_FP_HEAP_MB    second threshold, adds `heap`       (default 8000)
#   VODOU_FP_INTERVAL   seconds between polls               (default 20)
#   VODOU_FP_COOLDOWN   seconds between captures            (default 600)
#   VODOU_FP_CPU_PCT    instantaneous CPU that trips a stack sample (default 300)
#   VODOU_FP_OUT        capture directory                   (default .vodou/footprint-incidents)
#
# HOW YOU FIND OUT
#
# A trip posts a macOS notification banner (osascript) naming the process,
# the number, and the capture directory — the file alone was found not to be
# an alert, just a record. Registered in processes.toml as `footprint-watch`;
# start-vodou-services.sh launches it, stop-vodou-services.sh ends it, and
# .vodou/footprint-watch.pid is the single-instance guard.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WARN_MB="${VODOU_FP_WARN_MB:-4000}"
HEAP_MB="${VODOU_FP_HEAP_MB:-8000}"
INTERVAL="${VODOU_FP_INTERVAL:-20}"
COOLDOWN="${VODOU_FP_COOLDOWN:-600}"
CPU_PCT="${VODOU_FP_CPU_PCT:-300}"
OUT="${VODOU_FP_OUT:-$ROOT/.vodou/footprint-incidents}"
LOG="$OUT/watch.log"
PIDFILE="${VODOU_FP_PIDFILE:-$ROOT/.vodou/footprint-watch.pid}"   # overridable so a throwaway test instance can coexist

mkdir -p "$OUT"

# Single instance: a second copy would double every capture and every banner.
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "footprint-watch already running (pid $(cat "$PIDFILE"))"; exit 0
fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

# The alert. Everything else here is a record; this is the part a person sees.
# A banner from a lowered-threshold run says so in its title, because a test
# trip at 00:07 read as a real incident at 00:14 (2026-08-30). Real = the
# defaults; anything under them is a drill.
TITLE="Vodou daemon watch"
if [ "$WARN_MB" -lt 4000 ] || [ "$CPU_PCT" -lt 300 ]; then TITLE="Vodou daemon watch — TEST (lowered threshold)"; fi
notify() {
  osascript -e "display notification \"$2\" with title \"$TITLE\" subtitle \"$1\" sound name \"Basso\"" >/dev/null 2>&1 || true
}

say() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"; }

# phys_footprint in MB for a pid, or empty if the pid is gone.
footprint_mb() {
  footprint -p "$1" 2>/dev/null \
    | grep -E '^ *phys_footprint:' \
    | grep -oE '[0-9]+(\.[0-9]+)? *[KMG]B' \
    | head -1 \
    | awk '{ v=$1; u=$2; if (u=="GB") v*=1024; else if (u=="KB") v/=1024; printf "%.0f", v }'
}

capture() {
  local pid="$1" mb="$2" stamp dir
  stamp="$(date '+%Y%m%dT%H%M%SZ')"
  dir="$OUT/$stamp-pid$pid-${mb}MB"
  mkdir -p "$dir"
  say "SPIKE ${mb}MB pid=$pid — capturing to $dir"
  notify "memory ${mb} MB (pid $pid)" "capturing footprint + stacks to .vodou/footprint-incidents/$(basename "$dir")"

  # Cheap, no suspend: whole-machine context first, so we can tell a vodou
  # problem from a machine problem (Spotlight reindexing after a reboot looked
  # exactly like a vodou load spike on 2026-08-29).
  {
    echo "== date ==";        date
    echo "== uptime/load =="; uptime
    echo "== vm_stat ==";     vm_stat
    echo "== all vodou-core =="
    ps aux | grep "[v]odou-core"
    echo "== top 15 by CPU =="
    ps aux | sort -k3 -rn | head -15
    echo "== top 15 by RSS (RSS UNDERSTATES — see footprint below) =="
    ps aux | sort -k6 -rn | head -15
  } > "$dir/context.txt" 2>&1

  # Per-process footprint for every vodou-core process, so N-instances-at-1.8GB
  # is distinguishable from one process at N GB.
  {
    for p in $(pgrep -f "vodou-core" 2>/dev/null); do
      echo "--- pid $p: $(ps -o command= -p "$p" 2>/dev/null | cut -c1-100)"
      footprint -p "$p" 2>&1 | tail -6
    done
  } > "$dir/footprints.txt" 2>&1

  # Region-level: names the allocator. The 2026-08-29 heap showed single
  # allocations of 96/384/732 MB — the doubling signature of ORT's arena.
  vmmap -summary "$pid" > "$dir/vmmap-summary.txt" 2>&1

  # Stacks: what it was DOING. Suspends briefly.
  sample "$pid" 3 -file "$dir/sample.txt" >/dev/null 2>&1

  tail -300 "$ROOT/.vodou/system.log"    > "$dir/system.log.tail"    2>&1
  tail -100 "$ROOT/.vodou/extractor.log" > "$dir/extractor.log.tail" 2>&1

  if [ "$mb" -ge "$HEAP_MB" ]; then
    say "  ${mb}MB >= ${HEAP_MB}MB — adding heap dump (suspends the process)"
    heap "$pid" > "$dir/heap.txt" 2>&1
  else
    echo "heap skipped: ${mb}MB < ${HEAP_MB}MB threshold" > "$dir/heap.txt"
  fi

  say "  capture complete: $dir"
}

# CPU trip: the daemon was screenshotted at 694% and 338% today with nothing
# in the logs to say what it was doing. A stack sample the moment it crosses
# the line names the code path instead of leaving it to inference.
cpu_capture() {
  local pid="$1" pct="$2" stamp dir
  stamp="$(date '+%Y%m%dT%H%M%SZ')"
  dir="$OUT/$stamp-pid$pid-cpu${pct%%.*}pct"
  mkdir -p "$dir"
  say "CPU ${pct}% pid=$pid — sampling to $dir"
  notify "CPU ${pct}% (pid $pid)" "stack sample in .vodou/footprint-incidents/$(basename "$dir")"
  sample "$pid" 3 -file "$dir/sample.txt" >/dev/null 2>&1
  awk '/Sort by top of stack/{p=1} p' "$dir/sample.txt" | head -15 > "$dir/top-of-stack.txt" 2>/dev/null
  ps aux | sort -k3 -rn | head -15 > "$dir/top-cpu.txt" 2>&1
  tail -200 "$ROOT/.vodou/system.log" > "$dir/system.log.tail" 2>&1
  say "  sample complete: $dir"
}

say "footprint-watch started (pid $$; warn=${WARN_MB}MB heap=${HEAP_MB}MB cpu=${CPU_PCT}% interval=${INTERVAL}s cooldown=${COOLDOWN}s)"
say "  normal steady state on this box is ~1.9GB (bge-base reranker pinned by model_idle_secs=0)"

last_capture=0
last_cpu_capture=0
while true; do
  # Re-resolve every poll: the daemon gets recycled and swapped, and a watcher
  # pinned to one pid silently stops watching anything.
  for pid in $(pgrep -f "vodou-core (daemon|worker) start" 2>/dev/null); do
    mb="$(footprint_mb "$pid")"
    [ -z "$mb" ] && continue
    now=$(date +%s)
    if [ "$mb" -ge "$WARN_MB" ]; then
      if [ $((now - last_capture)) -ge "$COOLDOWN" ]; then
        last_capture=$now
        capture "$pid" "$mb"
      else
        say "SPIKE ${mb}MB pid=$pid — within cooldown, not re-capturing"
      fi
    fi
    # Instantaneous CPU from top (ps %CPU is a lifetime average and hides spikes).
    pct="$(top -l 1 -pid "$pid" -stats cpu 2>/dev/null | tail -1 | tr -d ' ')"
    case "$pct" in ''|*[!0-9.]*) continue;; esac
    if [ "${pct%%.*}" -ge "$CPU_PCT" ] && [ $((now - last_cpu_capture)) -ge "$COOLDOWN" ]; then
      last_cpu_capture=$now
      cpu_capture "$pid" "$pct"
    fi
  done
  sleep "$INTERVAL"
done
