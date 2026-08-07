#!/usr/bin/env bash
# Swap the memory store for a throwaway DEMO brain — the only safe way to record
# Ctrl+B on camera.
#
# WHY THIS EXISTS: Ctrl+B is hardcoded to search ALL memory (content.js, "scope
# 'all'", 2026-07-18 decision — vault scoping hid basic facts like the dog's
# name). So a demo vault CANNOT contain real memory. On a live corpus, a simple
# personal question can surface chat IDs, family details, and provider names.
# The only structural fix is to make the whole store demo-only for the shoot.
#
#   ./scripts/demo-brain.sh enter   # real memory -> backup, seed demo facts
#   ./scripts/demo-brain.sh exit    # restore real memory, delete demo
#
set -euo pipefail
cd "$(dirname "$0")/.."
BACKUP="$HOME/vodou-demo-brain-backup"
SEED="$HOME/vodou-demo-vault"

case "${1:-}" in
enter)
  [ -d "$BACKUP" ] && { echo "REFUSING: $BACKUP already exists — already in demo mode, or a previous exit failed."; exit 1; }
  ./stop-vodou-services.sh >/dev/null 2>&1 || true
  mkdir -p "$BACKUP"
  for f in memory.db memory.db-wal memory.db-shm; do [ -f "$f" ] && mv "$f" "$BACKUP/"; done
  [ -d .vodou/workspace/memory ] && mv .vodou/workspace/memory "$BACKUP/workspace-memory"
  mkdir -p .vodou/workspace/memory
  mkdir -p "$SEED"
  cat > "$SEED/video-facts.md" <<'FACTS'
- Dog is named Biscuit — a golden retriever adopted in 2024.
- Current project is "Aurora", a recipe app for weekly meal planning.
- Prefers TypeScript with strict mode; avoids default exports.
- Writing style: short sentences, no marketing adjectives.
- The release window is Monday to Wednesday; Friday deploys are banned.
FACTS
  VODOU_NO_OPEN_BROWSER=1 ./start-vodou-services.sh >/dev/null 2>&1 &
  for _ in $(seq 1 24); do
    [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:8765/health 2>/dev/null)" = "200" ] && break
    sleep 5
  done
  ./vodou-core mem scan "$SEED" >/dev/null
  echo "DEMO BRAIN ACTIVE. Verifying isolation:"
  # Structural proof, dynamic for any operator: the demo store may contain ONLY
  # chunks indexed from the seed dir — any chunk from another path is real data
  # that survived the swap. (This used to probe a hardcoded list of the
  # operator's real names, which put the very strings it guarded against into a
  # shipped script.)
  TOTAL=$(sqlite3 memory.db "SELECT count(*) FROM memory_chunks;")
  STRAY=$(sqlite3 memory.db "SELECT count(*) FROM memory_chunks WHERE path NOT LIKE '%vodou-demo-vault%';")
  echo "  chunks: $TOTAL total, $STRAY from outside the demo seed"
  [ "$STRAY" != "0" ] && { echo "  ABORT: real data present."; exit 1; }
  # Optional belt: operator-specific probe words, kept OUT of the repo.
  #   export VODOU_DEMO_PROBES="petname hometown lastname"
  for probe in ${VODOU_DEMO_PROBES:-}; do
    n=$(sqlite3 memory.db "SELECT count(*) FROM memory_chunks WHERE text LIKE '%$probe%';")
    printf '  %-10s %s\n' "$probe" "$n"
    [ "$n" != "0" ] && { echo "  ABORT: real data present."; exit 1; }
  done
  echo "  clean — Ctrl+B cannot leak. Run '$0 exit' when finished."
  ;;
exit)
  [ -d "$BACKUP" ] || { echo "No backup at $BACKUP — not in demo mode."; exit 1; }
  ./stop-vodou-services.sh >/dev/null 2>&1 || true
  rm -f memory.db memory.db-wal memory.db-shm
  rm -rf .vodou/workspace/memory
  for f in memory.db memory.db-wal memory.db-shm; do [ -f "$BACKUP/$f" ] && mv "$BACKUP/$f" .; done
  [ -d "$BACKUP/workspace-memory" ] && mv "$BACKUP/workspace-memory" .vodou/workspace/memory
  rmdir "$BACKUP" 2>/dev/null || echo "  NOTE: $BACKUP not empty — inspect before deleting."
  # Un-index the seed from the REAL store before deleting the directory.
  # Learned the hard way 2026-08-01: an early `mem scan` of the seed dir ran while
  # the REAL memory.db was live, so "Dog is named Biscuit" became an ordinary
  # first-party memory — survived the swap, rode back through the restore, and was
  # eligible for injection into a real chat months later. Removing the directory
  # does NOT un-index it; only `mem scan --remove` does.
  ./vodou-core mem scan "$SEED" --remove >/dev/null 2>&1 || true
  LEAK=$(sqlite3 memory.db "SELECT count(*) FROM memory_chunks WHERE path LIKE '%vodou-demo-vault%';" 2>/dev/null || echo 0)
  [ "$LEAK" != "0" ] && echo "  WARNING: $LEAK demo chunk(s) still indexed — run: ./vodou-core mem scan $SEED --remove"
  rm -rf "$SEED"
  VODOU_NO_OPEN_BROWSER=1 ./start-vodou-services.sh >/dev/null 2>&1 &
  for _ in $(seq 1 24); do
    [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:8765/health 2>/dev/null)" = "200" ] && break
    sleep 5
  done
  echo "REAL MEMORY RESTORED. chunks: $(sqlite3 memory.db 'SELECT count(*) FROM memory_chunks;')"
  ;;
*) echo "usage: $0 enter|exit"; exit 1;;
esac
