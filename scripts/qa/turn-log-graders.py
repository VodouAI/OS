#!/usr/bin/env python3
"""QA graders for the turn event log — PLAN-TRUTHFUL-TURN-VERIFY §Q.

Four questions the nightly asks of the log, each answerable only from evidence
the product produced by running:

  Q.1  turn-derive          do recent turns rebuild the request they sent?
  Q.3  receipt-completeness does the receipt show what the log holds?
  Q.4  guest-privacy        did a guest turn ever store text?          ← P0
  Q.6  world-tagged         does every tool call name the world it ran in?

Two rules this file holds to, both learned the hard way in this repo:

  A grader with NO EVIDENCE answers `unknown`, never `ok`. A fresh install has
  no turns; reporting health for a question never asked is the exact defect
  `flows` exists to refuse, and `dead-server-passes-noise-fixtures` is the same
  lesson from the other end — absence-shaped metrics are satisfied by total
  failure.

  Exit 2 ONLY for a real failure. `unknown` exits 0 with its reason printed,
  because a nightly that goes red on a machine with no traffic trains everyone
  to ignore it.

Usage:  turn-log-graders.py [--json]   (reads vodou-core.db read-only)
"""
from __future__ import annotations
import json
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB = os.path.join(ROOT, "vodou-core.db")
WINDOW = 50
# A NIGHTLY grades last night's traffic, not all history. A receipt written by a
# build that has since been fixed is a fact about the past; leaving it in scope
# pins the nightly red forever on a defect that no longer happens, which is how
# a grader stops being read. 24h by default: wide enough that a real regression
# cannot hide, narrow enough that yesterday's fix shows up as green tomorrow.
WINDOW_HOURS = int(os.environ.get("VODOU_QA_TURN_WINDOW_HOURS", "24"))


def connect() -> sqlite3.Connection | None:
    if not os.path.exists(DB):
        return None
    try:
        # Read-only URI: an instrument must not perturb what it measures.
        return sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error:
        return None


def has_table(c: sqlite3.Connection, name: str) -> bool:
    return bool(c.execute(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()[0])


def q1_turn_derive(c):
    """Do recent turns rebuild the request they sent? (mirrors flows Flow 12)"""
    # Windowed for the same reason q3 is, and the reason is worth repeating: a
    # turn graded by a build that has since been fixed is a fact about the past.
    # Without the window this grader keeps the last 50 turn/end rows in scope
    # FOREVER, so one historical `mismatch` holds the nightly red until fifty
    # more turns push it out — which is how a grader stops being read. A real
    # regression still stays visible for a full day.
    rows = c.execute(
        "SELECT meta FROM turn_events WHERE kind='turn/end' AND at >= datetime('now', ?) "
        "ORDER BY id DESC LIMIT ?", (f"-{WINDOW_HOURS} hours", WINDOW),
    ).fetchall()
    counts = {"match": 0, "partial": 0, "unlogged": 0, "overlogged": 0, "mismatch": 0, "unmeasured": 0}
    worst = 0
    for (meta,) in rows:
        try:
            m = json.loads(meta or "{}")
        except ValueError:
            m = {}
        v = m.get("derive")
        counts[v if v in counts else "unmeasured"] += 1
        # `worst` belongs to the turns this grader is REPORTING, not to every row
        # it read. Counting all of them attributed 14,388 chars — a stale value on
        # an `unknown` guest turn — to a warning about a single turn carrying 154.
        # A number in a sentence has to come from the thing the sentence is about.
        if v == "unlogged":
            worst = max(worst, int(m.get("unlogged_chars") or 0))
    graded = counts["match"] + counts["unlogged"] + counts["overlogged"] + counts["mismatch"]
    if graded == 0:
        return "unknown", "no turn in the window carries a derive verdict", counts
    # A MISMATCH is the log disagreeing with what was sent — the only red.
    if counts["overlogged"]:
        return "fail", (f"{counts['overlogged']} turn(s) in the last {WINDOW_HOURS}h derive to MORE "
                        f"text than the request carried — a lane is placed twice, or in a slot it "
                        f"did not travel in"), counts
    if counts["mismatch"]:
        return "fail", (f"{counts['mismatch']} turn(s) in the last {WINDOW_HOURS}h derive to the same "
                        f"length as the request and different bytes"), counts
    if counts["unlogged"]:
        return "warn", f"{counts['unlogged']} turn(s) carry bytes no lane accounts for (worst {worst} chars)", counts
    return "ok", f"{counts['match']} of {graded} turns rebuild their request exactly", counts


def q3_receipt_completeness(c):
    """Does the receipt show what the log holds? (P0d made it a projection)"""
    if not has_table(c, "turn_receipts"):
        return "unknown", "no turn_receipts table", {}
    rows = c.execute(
        # NOT "lanes IS NOT NULL". That filter removed exactly the rows that are
        # broken: a receipt whose lanes were never written at all. Nineteen of
        # them sat in the database while this grader reported `ok`, and the
        # symptom a user saw was a turn with no receipt whatsoever. Same blind
        # spot as the guest grader that only inspected rows already MARKED
        # redacted — an instrument that only looks where the value is present
        # cannot see the value being absent.
        # ONLY FINISHED TURNS. A receipt row is created when the turn starts and
        # its lanes are persisted when it ends, so a turn in flight legitimately
        # has fewer lanes than the log already holds — and grading it reports a
        # defect that does not exist. Found 2026-08-30: the QA run itself was
        # racing a live turn, so the suite manufactured its own failure.
        #
        # Same epistemics as the rest of this file: measure a finished thing, or
        # do not measure it. An unfinished turn is `unknown`, not `red`.
        "SELECT r.turn_id, r.lanes, r.at FROM turn_receipts r "
        "WHERE r.turn_id IS NOT NULL AND r.at >= datetime('now', ?) "
        "AND EXISTS (SELECT 1 FROM turn_events e "
        "            WHERE e.turn_id = r.turn_id AND e.kind = 'turn/end') "
        "ORDER BY r.id DESC LIMIT ?",
        (f"-{WINDOW_HOURS} hours", WINDOW),
    ).fetchall()
    checked = 0
    short = []
    for turn_id, lanes, _at in rows:
        try:
            receipt = {l["lane"] for l in json.loads(lanes or "[]") if isinstance(l, dict) and "lane" in l}
        except ValueError:
            continue
        if lanes is None:
            # A receipt with NO lanes at all, on a turn whose log HAS lanes, is
            # the worst version of what this grader checks — not "the receipt
            # shows fewer", but "the user was shown nothing".
            log_any = c.execute(
                "SELECT count(*) FROM turn_events WHERE turn_id=? AND kind='inject' AND lane IS NOT NULL",
                (turn_id,)).fetchone()[0]
            if log_any:
                checked += 1
                short.append((turn_id[:8], [f"ALL {log_any} lanes — receipt has none"]))
            continue
        # A turn the gateway declared SILENT sent no receipt at all — "nothing
        # used; sending no receipt (silent by design)". Its `turn_receipts` row
        # exists only because `recordMemoriesInjected` inserts one per turn, and
        # the daemon then annotates it with `hook_memory`. Comparing that row to
        # the log calls it "short" when there was no receipt to be short: 21 of
        # them in one day, every one a false alarm. The tell is a row carrying
        # ONLY daemon-written `hook_*` lanes — the gateway never persisted.
        #
        # This grader exists to catch the receipt showing LESS than the log. It
        # must not invent that on a turn with no receipt, or it becomes the thing
        # it was written to prevent: an instrument that reports a problem where
        # there is none, until nobody reads it.
        if receipt and all(l.startswith("hook_") for l in receipt):
            continue
        log = {r[0] for r in c.execute(
            "SELECT DISTINCT lane FROM turn_events WHERE turn_id=? AND kind='inject' AND lane IS NOT NULL",
            (turn_id,)).fetchall()}
        if not log:
            continue          # no events for this turn — not a divergence, just older
        checked += 1
        # The receipt may hold MORE (hook lanes the daemon writes straight to it).
        # It must never hold LESS: that was the §26 failure this projection ended.
        missing = log - receipt
        if missing:
            short.append((turn_id[:8], sorted(missing)))
    if checked == 0:
        return "unknown", f"no turn in the last {WINDOW_HOURS}h has both a receipt and events", {"checked": 0}
    if short:
        detail = "; ".join(f"{t}: missing {', '.join(m)}" for t, m in short[:3])
        return "fail", (f"{len(short)} of {checked} receipts in the last {WINDOW_HOURS}h show FEWER "
                        f"lanes than the log holds — {detail}"), {"checked": checked, "short": len(short), "window_hours": WINDOW_HOURS}
    return "ok", f"{checked} receipts show every lane the log holds", {"checked": checked}


def q4_guest_privacy(c):
    """Did a guest turn ever store text? Any hit is a P0.

    The question is asked of the TURN, not of the row. The first version asked
    "does any row marked guest carry a payload?", and on the first real guest
    turn ever driven it answered `ok` while a row on that same turn held 973
    characters of "### Relevant Memories …". The row was written by the daemon's
    hook producer, which had never heard of the guest rule, so it carried no
    marker — and a grader that only inspects rows declaring themselves redacted
    is blind to precisely the leak that happens because the marker is missing.

    So: find the turns some component decided were guest turns, then demand that
    NOTHING on those turns kept text. That catches an unmarked producer joining
    a marked turn, which is the shape both the defect and any future one take.
    """
    guest_turns = [r[0] for r in c.execute(
        'SELECT DISTINCT turn_id FROM turn_events WHERE meta LIKE \'%"redacted":"guest"%\''
    ).fetchall()]
    if not guest_turns:
        # Never `ok`: no guest turn has been recorded, so the rule has not been
        # exercised. Saying `ok` here would report a guarantee nobody tested.
        return "unknown", "no guest turn in the log — the rule is unexercised, not proven", {"guest_turns": 0}
    marks = ",".join("?" * len(guest_turns))
    leaks = c.execute(
        f"SELECT turn_id, seq, lane, kind, length(payload) FROM turn_events "
        f"WHERE turn_id IN ({marks}) AND payload IS NOT NULL ORDER BY id LIMIT 5",
        guest_turns,
    ).fetchall()
    events = c.execute(
        f"SELECT count(*) FROM turn_events WHERE turn_id IN ({marks})", guest_turns
    ).fetchone()[0]
    nums = {"guest_turns": len(guest_turns), "guest_events": events, "leaked": len(leaks)}
    if leaks:
        where = "; ".join(f"seq {s} {l or k} ({n} chars)" for _t, s, l, k, n in leaks[:3])
        return "fail", (f"{len(leaks)} event(s) on a guest turn stored payload text — "
                        f"the log must keep hashes only — {where}"), nums
    return "ok", f"{len(guest_turns)} guest turn(s), {events} events, none carrying text", nums


def q6_world_tagged(c):
    """Does every tool call name the world it ran in? (P2b's precondition)"""
    # Windowed like q1 and q3, and for the same reason: 535 tool calls recorded
    # before `world` was ever passed will never carry it, and an unwindowed
    # grader would sit at `warn` forever over rows nobody can go back and fix.
    total = c.execute(
        "SELECT count(*) FROM turn_events WHERE kind='tool/call' AND at >= datetime('now', ?)",
        (f"-{WINDOW_HOURS} hours",)).fetchone()[0]
    if total == 0:
        return "unknown", "no tool/call events yet", {"tool_calls": 0}
    tagged = c.execute(
        "SELECT count(*) FROM turn_events WHERE kind='tool/call' AND meta LIKE '%\"world\"%' "
        "AND at >= datetime('now', ?)", (f"-{WINDOW_HOURS} hours",)).fetchone()[0]
    if tagged == 0:
        # Expected until P2b lands. Not a failure — an unbuilt phase.
        return "unknown", f"0 of {total} tool calls in the last {WINDOW_HOURS}h carry meta.world — the exec seam (P2b) is not built", {"tool_calls": total, "tagged": 0}
    if tagged < total:
        return "warn", f"{total - tagged} of {total} tool calls do not name their execution world", {"tool_calls": total, "tagged": tagged}
    return "ok", f"all {total} tool calls name their world", {"tool_calls": total, "tagged": tagged}


GRADERS = [
    ("turn-derive", q1_turn_derive),
    ("receipt-completeness", q3_receipt_completeness),
    ("guest-privacy", q4_guest_privacy),
    ("world-tagged", q6_world_tagged),
]


def main() -> int:
    as_json = "--json" in sys.argv
    c = connect()
    if c is None or not has_table(c, "turn_events"):
        out = {"schema_version": 1, "rows": [
            {"name": n, "verdict": "unknown",
             "evidence": "no turn_events table — migration 090 has not run here", "numbers": {}}
            for n, _ in GRADERS]}
        print(json.dumps(out, indent=2) if as_json else
              "turn-log: no turn_events table (migration 090 has not run) — unknown, not ok")
        return 0

    rows, failed = [], 0
    for name, fn in GRADERS:
        try:
            verdict, evidence, numbers = fn(c)
        except sqlite3.Error as e:
            verdict, evidence, numbers = "unknown", f"query failed: {e}", {}
        rows.append({"name": name, "verdict": verdict, "evidence": evidence, "numbers": numbers})
        if verdict == "fail":
            failed += 1

    if as_json:
        print(json.dumps({"schema_version": 1, "failed": failed, "rows": rows}, indent=2))
    else:
        print("Does the turn log still tell the truth?\n")
        mark = {"ok": "ok  ", "warn": "warn", "fail": "FAIL", "unknown": "?   "}
        for r in rows:
            print(f"  {mark[r['verdict']]} {r['name']:<22} {r['evidence']}")
        print()
    # Only a real failure is red. `unknown` exits 0 with its reason on the page:
    # a nightly that goes red on a quiet machine is a nightly nobody reads.
    return 2 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
