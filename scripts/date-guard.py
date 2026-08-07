#!/usr/bin/env python3
"""date-guard — block commits that re-mix timestamp zones/formats.

Why this exists (2026-08-04): a codebase-wide audit found the daily-memory
lane split across zones — memory_flush named files by the LOCAL day while
gateway_extractor and two console writers used the UTC day, so promotion
read a different file than flush wrote for part of every evening. A second
class: three writers put RFC3339 (`…+00:00`) into automations columns whose
other writers use naive `datetime('now')`, the exact string-comparison bug
class documented (and once fixed) in src/board/db.rs:271. The sites were
unified under one canon (PLANS/PLAN-TIME-CANON.md); this guard keeps new
code from re-introducing either mistake.

The canon:
  * Instants in SQLite: naive UTC `YYYY-MM-DD HH:MM:SS` (what
    CURRENT_TIMESTAMP writes). Compare via datetime() in SQL.
  * Day/month identity (filenames, bucket keys, "today"): the LOCAL day.
  * Display: parse naive as UTC, render local.

Scans STAGED added lines only (same rationale as secret-guard: staged
content is what enters history; pre-existing offenders don't block
unrelated work).

Patterns blocked (added lines, code files only):
  1. UTC day/month identity:  Utc::now()…format("%Y-%m-%d") / ("%Y-%m")
     — a date-ONLY format from a UTC clock is a day identity in the wrong
     zone. Naive-instant storage ("%Y-%m-%d %H:%M:%S") stays legal.
  2. JS UTC day identity:  toISOString().split('T')[0]
     — the JS spelling of the same mistake.
  3. RFC3339 into known naive columns:  to_rfc3339 on a line that also
     names next_run_at / last_run_at / expires_at
     — the automations/session-manager mix, at its recurring call sites.
  4. SQL day-bucketing without a zone:  date(<col>) as/AS day or GROUP BY
     over date(created_at) lacking 'localtime'
     — buckets a naive-UTC column by the UTC day; days shown to a human
     are local days.

Bypass when a hit is genuinely correct (e.g. a deliberately-UTC protocol
field):  VODOU_SKIP_DATE_GUARD=1 git commit ...
"""

import os
import re
import subprocess
import sys

CODE_EXT = (".rs", ".ts", ".js", ".mjs", ".py", ".sql")
SKIP_DIRS = ("node_modules/", ".build/", "target/", "dist/", "vendor/")

RULES = [
    (
        re.compile(r'Utc::now\(\)[^;]{0,80}format\(\s*"%Y-%m(-%d)?"\s*\)'),
        "UTC day/month identity — day-granular names/keys use the LOCAL day "
        "(Local::now). Naive instant storage (\"%Y-%m-%d %H:%M:%S\") is fine.",
    ),
    (
        re.compile(r"toISOString\(\)\s*\.\s*split\(\s*['\"]T['\"]\s*\)\s*\[\s*0\s*\]"),
        "UTC day identity in JS — build the day from local date components.",
    ),
    (
        re.compile(r"to_rfc3339[^\n]*(next_run_at|last_run_at|expires_at)|"
                   r"(next_run_at|last_run_at|expires_at)[^\n]*to_rfc3339"),
        "RFC3339 into a naive-UTC column — write \"%Y-%m-%d %H:%M:%S\" like "
        "the column's other writers (see src/board/db.rs:271 for the bug class).",
    ),
    (
        re.compile(r"date\(\s*(\w+\.)?created_at\s*\)\s+(as\s+|AS\s+)?day", re.IGNORECASE),
        "day-bucketing a naive-UTC column in UTC — use "
        "date(created_at, 'localtime') so bars match the local calendar.",
    ),
]


def staged_added_lines():
    out = subprocess.run(
        ["git", "diff", "--cached", "--unified=0", "--no-color"],
        capture_output=True, text=True, check=False,
    ).stdout
    path = None
    for line in out.splitlines():
        if line.startswith("+++ b/"):
            path = line[6:]
        elif line.startswith("+") and not line.startswith("+++") and path:
            yield path, line[1:]


def main() -> int:
    if os.environ.get("VODOU_SKIP_DATE_GUARD") == "1":
        return 0
    hits = []
    for path, line in staged_added_lines():
        if not path.endswith(CODE_EXT):
            continue
        if any(d in path for d in SKIP_DIRS):
            continue
        # The guard's own rule table would trip itself.
        if path == "scripts/date-guard.py":
            continue
        for rx, why in RULES:
            if rx.search(line):
                hits.append((path, line.strip()[:110], why))
    if not hits:
        return 0
    print("date-guard: staged lines violate the time canon "
          "(PLANS/PLAN-TIME-CANON.md):\n", file=sys.stderr)
    for path, line, why in hits:
        print(f"  {path}\n    + {line}\n    → {why}\n", file=sys.stderr)
    print("Fix the line, or bypass a true false-positive with "
          "VODOU_SKIP_DATE_GUARD=1.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
