#!/usr/bin/env bash
# Derive the ALPHA-READINESS-AUDIT's OPEN set instead of maintaining a tally.
#
# Twice on 2026-09-06 a hand-kept state table in .build/ALPHA-GATE-BUILD-LOG.md
# was wrong in the same direction: it was written from the findings that had been
# EXAMINED, never from the findings that exist. The second time it reported
# "P1: 5 open, 0 code" while two P1 NOT-WIRED items (CO-4, GW-9) had never been
# touched at all. That is an absence-shaped count — the same failure this audit
# keeps finding in the product.
#
# A finding is treated as WORKED if any commit message names it or the tracked
# build log mentions it. That is deliberately generous: it can call a finding
# worked when it was only discussed. It cannot call one worked when nothing has
# said its name, which is the direction that was wrong.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
AUDIT="$ROOT/PLANS/0.6.31/really look into/ALPHA-READINESS-AUDIT/README.md"
LOG="$ROOT/.build/ALPHA-GATE-BUILD-LOG.md"
[ -f "$AUDIT" ] || { echo "audit README not found (PLANS/ is gitignored — this needs the local copy)"; exit 2; }

python3 - "$AUDIT" "$LOG" "$ROOT" <<'PY'
import re, subprocess, sys, pathlib
audit, log, root = sys.argv[1], sys.argv[2], sys.argv[3]
s = pathlib.Path(audit).read_text()
sec5 = s[s.index('## 5.'):s.index('## 9.')]
found = {}
for line in sec5.splitlines():
    m = re.match(r'^\|\s*([A-Z]{2,3}-\d+[a-z]?)\s*\|\s*(P[0-3])\s*\|\s*([A-Z-]+)\s*\|', line)
    if m:
        found.setdefault(m.group(1), (m.group(2), m.group(3)))
logtxt = pathlib.Path(log).read_text() if pathlib.Path(log).exists() else ''
commits = subprocess.run(['git','-C',root,'log','--all','--format=%s%n%b'],
                         capture_output=True, text=True).stdout
open_ = []
for fid, (pri, kind) in sorted(found.items()):
    if re.search(rf'\b{re.escape(fid)}\b', logtxt) or re.search(rf'\b{re.escape(fid)}\b', commits):
        continue
    open_.append((pri, kind, fid))
print(f"§5 findings with a priority row: {len(found)}")
print(f"never named by a commit or the build log: {len(open_)}\n")
for pri in ('P0','P1','P2','P3'):
    rows = [r for r in open_ if r[0] == pri]
    if rows:
        print(f"{pri} ({len(rows)})")
        for _, kind, fid in rows:
            print(f"   {fid:<8} {kind}")
PY
