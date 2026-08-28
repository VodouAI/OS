#!/usr/bin/env python3
"""
CONSOLE P4 — strip gateway-authored presentation out of stored transcripts.

PLAN-CONSOLE-SHOWS-ITS-WORK §4.6. P0 stopped NEW noise at the source and P1
replaced it with structured events; this removes what was already welded into
gateway_messages, so a future reader UI / export / share link inherits signal.

DESIGN, and why it is narrower than the plan assumed
----------------------------------------------------
The plan sized this as "712 <details> + 2,797 step banners". Sampling the real
rows first (rather than trusting the LIKE counts) found three traps:

  1. `LIKE '%## Step %'` matches `### Step 1 of 5` — the skill-creation wizard's
     own prose — and `## Step by step`, an LLM heading. ~2,700 of the 2,798 are
     false positives. A blanket strip would have mangled real content.
  2. 325 matches are USER-role rows: `<active_context>` blocks, i.e. the prompt
     the model was actually sent. That is a faithful record; rewriting it would
     falsify history. Assistant rows only.
  3. 14 `<details>` blocks looked foreign but are `🔍 Raw OI Results` — the
     pre-rename spelling of our own receipt. Whitelisted, not skipped.

So every rule below matches a string the GATEWAY authored, never a string a
model or a human could plausibly have written. `## Step N` is removed ONLY inside
a message that also carries the orchestration banner, which is what makes it
chrome rather than a heading.

Usage:
  strip-transcript-chrome.py --dry-run [--samples N]
  strip-transcript-chrome.py --apply
"""

import argparse
import os
import re
import shutil
import sqlite3
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GW = os.path.join(ROOT, "MCP-servers", "Vodou-Console", "gateway.db")

# ── Block rules: whole gateway receipts, self-contained ────────────────────────
# Non-greedy to the FIRST </details> so a message carrying two receipts loses
# both without swallowing what sits between them.
BLOCK_RE = re.compile(
    r"<details><summary>(?:"
    r"\U0001F50D Raw Vodou Results|"
    r"\U0001F50D Raw OI Results|"      # pre-rename spelling, same producer
    r"\U0001F50D BrainLoader:|"
    r"⚠️ Memory degraded|"
    r"⚠️ Context pipeline"
    r").*?</details>\s*",
    re.DOTALL,
)

# ── Line rules: single lines of engine chrome ────────────────────────────────
TOOL_HEADER_RE = re.compile(r"^\U0001F4CB \*\*[^*\n]+::[^*\n]+\*\* \(\d+ms\)\s*$")
EXEC_BANNER_RE = re.compile(r"^\U0001F3AF \*\*Orchestrated Execution Complete\*\*\s*$")
BAR_RULE_RE = re.compile(r"^━{10,}\s*$")
COMPLETED_RE = re.compile(r"^✅ \*\*Completed \d+ orchestrated steps\*\*\s*$")
EXEC_PATH_RE = re.compile(r"^\U0001F4CB \*\*Execution Path:\*\*\s*$")
STEP_RE = re.compile(r"^## Step \d+\s*$")


def strip(content: str) -> str:
    """Return `content` with gateway chrome removed. Pure; no I/O."""
    out = BLOCK_RE.sub("", content)

    # `## Step N` and `Execution Path:` are only chrome INSIDE an orchestration
    # blob. Outside one, `## Step 3` is a heading a model legitimately wrote.
    in_orchestration = bool(EXEC_BANNER_RE.search(out) or "\U0001F3AF **Orchestrated Execution Complete**" in out)

    kept = []
    for line in out.split("\n"):
        if TOOL_HEADER_RE.match(line):
            continue
        if EXEC_BANNER_RE.match(line) or BAR_RULE_RE.match(line) or COMPLETED_RE.match(line):
            continue
        if in_orchestration and (STEP_RE.match(line) or EXEC_PATH_RE.match(line)):
            continue
        kept.append(line)
    out = "\n".join(kept)

    # Collapse the runs of blank lines the removals leave behind, but never
    # touch leading indentation inside fenced code.
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip()


def candidates(conn):
    """Assistant rows that contain at least one thing a rule could match."""
    return conn.execute(
        """
        SELECT id, content FROM gateway_messages
         WHERE role = 'assistant'
           AND (content LIKE '%<details><summary>%'
             OR content LIKE '%Orchestrated Execution Complete%'
             OR content LIKE '%📋 **%::%** (%ms)%'
             OR content LIKE '%✅ **Completed %orchestrated steps**%')
        """
    ).fetchall()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--samples", type=int, default=3)
    args = ap.parse_args()
    if args.apply == args.dry_run:
        sys.exit("choose exactly one of --dry-run / --apply")

    conn = sqlite3.connect(GW)
    conn.execute("PRAGMA trusted_schema=ON")   # gateway_messages has FTS triggers
    conn.execute("PRAGMA busy_timeout=15000")

    rows = candidates(conn)
    changed, unchanged, emptied, bytes_saved = [], 0, [], 0
    for mid, content in rows:
        new = strip(content)
        if new == content:
            unchanged += 1
            continue
        if not new.strip():
            # A message that is ONLY chrome. Do not blank it — an empty assistant
            # turn breaks pairing for the extractor and reads as a failed reply.
            emptied.append(mid)
            continue
        changed.append((mid, content, new))
        bytes_saved += len(content) - len(new)

    print(f"candidates      : {len(rows)}")
    print(f"would change    : {len(changed)}")
    print(f"unchanged       : {unchanged}")
    print(f"chrome-only (skipped, would be blank): {len(emptied)}")
    print(f"bytes reclaimed : {bytes_saved:,}")

    if args.dry_run:
        for mid, old, new in changed[: args.samples]:
            print("\n" + "=" * 70)
            print(f"id {mid}   {len(old)} -> {len(new)} bytes")
            print("--- BEFORE " + "-" * 58)
            print(old[:600])
            print("--- AFTER  " + "-" * 58)
            print(new[:600])
        if emptied:
            print(f"\nchrome-only ids (left untouched): {emptied[:20]}")
        return

    # ── apply ────────────────────────────────────────────────────────────────
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    backup_dir = os.path.join(ROOT, "backups", f"pre-p4-strip-{stamp}")
    os.makedirs(backup_dir, exist_ok=True)
    snap = os.path.join(backup_dir, "gateway.db")
    # VACUUM INTO gives a consistent copy of a live WAL database — safer than cp,
    # which can catch a torn wal/shm pair (PLAN-GATEWAY-DB-REPAIR D4/D5).
    conn.execute(f"VACUUM INTO '{snap}'")
    print(f"snapshot        : {snap} ({os.path.getsize(snap):,} bytes)")

    conn.execute(
        """CREATE TABLE IF NOT EXISTS gateway_messages_pre_strip (
             id INTEGER PRIMARY KEY,
             content TEXT NOT NULL,
             stripped_at TEXT NOT NULL DEFAULT (datetime('now'))
           )"""
    )
    conn.execute("BEGIN IMMEDIATE")
    try:
        for mid, old, new in changed:
            conn.execute(
                "INSERT OR REPLACE INTO gateway_messages_pre_strip (id, content) VALUES (?, ?)",
                (mid, old),
            )
            conn.execute("UPDATE gateway_messages SET content = ? WHERE id = ?", (new, mid))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    print(f"updated         : {len(changed)} rows (originals kept in gateway_messages_pre_strip)")

    qc = conn.execute("PRAGMA quick_check").fetchone()[0]
    print(f"quick_check     : {qc}")
    conn.execute("INSERT INTO gateway_messages_fts(gateway_messages_fts) VALUES('integrity-check')")
    print("fts integrity   : ok")
    conn.close()


if __name__ == "__main__":
    main()
