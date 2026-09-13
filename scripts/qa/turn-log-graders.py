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
import time

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


def q7_reply_recorded(c):
    """Does every finished turn carry its reply? (PLAN-LOOPS P0a)"""
    # Every loop that grades an answer needs the answer. Before P0a the kind
    # existed and had 0 rows against 2,837 turns; this row exists so that state
    # can never again read as `ok`. Scoped to GATEWAY turns with outcome ok:
    # a hook turn is partial by construction (Cursor receives the reply, the
    # daemon never sees it), and an errored turn has no reply to record.
    ends = c.execute(
        "SELECT turn_id FROM turn_events WHERE kind='turn/end' AND source='gateway' "
        "AND at >= datetime('now', ?) AND meta LIKE '%\"outcome\":\"ok\"%' "
        "ORDER BY id DESC LIMIT ?", (f"-{WINDOW_HOURS} hours", WINDOW),
    ).fetchall()
    if not ends:
        return "unknown", f"no finished gateway turn in the last {WINDOW_HOURS}h", {"checked": 0}
    missing, doubled = [], []
    for (tid,) in ends:
        n = c.execute("SELECT count(*) FROM turn_events WHERE turn_id=? AND kind='assistant/message'", (tid,)).fetchone()[0]
        if n == 0:
            missing.append(tid[:8])
        elif n > 1:
            doubled.append(tid[:8])
    numbers = {"checked": len(ends), "missing": len(missing), "doubled": len(doubled), "window_hours": WINDOW_HOURS}
    if missing or doubled:
        parts = []
        if missing:
            parts.append(f"{len(missing)} of {len(ends)} finished turns have no assistant/message ({', '.join(missing[:3])})")
        if doubled:
            parts.append(f"{len(doubled)} carry more than one ({', '.join(doubled[:3])})")
        return "fail", "; ".join(parts), numbers
    return "ok", f"{len(ends)} finished gateway turns each carry exactly one reply", numbers


def q8_commitments_lane(c):
    """Is the promises lane alive, and is it honest about what it has seen? (PLAN-COMMITMENTS-LANE §3.5)"""
    # "0 commitments this week" is satisfied by a dead lane. The first two
    # verdicts exist so that state can never read as `ok`: `unmeasured` until
    # the lane has looked at 100 turns, `unknown` when the window had no user
    # turns at all. P1 adds the red row (a dated loop whose due passed with no
    # scheduler run) and the warn row (delivered with an empty delivered_to).
    if not has_table(c, "open_loops") or not has_table(c, "commitment_lane_state"):
        return "unknown", "no open_loops table — migration 097 has not run here", {}
    row = c.execute("SELECT turns_seen, calls, last_cycle_at FROM commitment_lane_state WHERE id = 1").fetchone()
    seen, calls, last_cycle = (row or (0, 0, None))
    if seen < 100:
        return "unmeasured", f"the lane has seen {seen} turn(s); it needs 100 before it can say anything", {"turns_seen": seen, "calls": calls}
    window_turns = c.execute(
        "SELECT count(*) FROM turn_events WHERE kind='user/message' AND at >= datetime('now', ?)",
        (f"-{WINDOW_HOURS} hours",)).fetchone()[0]
    if window_turns == 0:
        return "unknown", f"no user turns in the last {WINDOW_HOURS}h", {"turns_seen": seen, "window_turns": 0}
    extracted = c.execute(
        "SELECT count(*), sum(due_at IS NOT NULL), sum(closed_at IS NOT NULL) FROM open_loops "
        "WHERE kind='commitment' AND opened_at >= datetime('now', ?)", (f"-{WINDOW_HOURS} hours",)).fetchone()
    n, dated, closed = (extracted[0] or 0, extracted[1] or 0, extracted[2] or 0)
    numbers = {"turns_seen": seen, "calls": calls, "window_turns": window_turns, "extracted": n, "dated": dated, "closed": closed, "last_cycle_at": last_cycle}
    # P1 red row, present now so it fires the day delivery ships: a dated open
    # loop whose due has passed and no scheduler run mentions it.
    overdue_unserved = 0
    if has_table(c, "scheduled_task_runs"):
        overdue_unserved = c.execute(
            "SELECT count(*) FROM open_loops l WHERE l.kind='commitment' AND l.closed_at IS NULL "
            "AND l.due_at IS NOT NULL AND l.due_at < datetime('now') "
            "AND NOT EXISTS (SELECT 1 FROM scheduled_task_runs r WHERE r.meta LIKE '%\"loop_id\":' || l.id || '%')").fetchone()[0]
    numbers["overdue_unserved"] = overdue_unserved
    if overdue_unserved:
        return "fail", f"{overdue_unserved} dated commitment(s) passed due with no scheduler run", numbers
    return "ok", f"{n} commitment(s) extracted in {WINDOW_HOURS}h from {window_turns} user turns ({dated} dated, {closed} closed); lane has seen {seen} turns", numbers


def q9_use_ledger(c):
    """Do injected facts get a use row? (PLAN-LOOPS P1)"""
    # The ledger lives in memory.db, not the turn log, so this grader opens it
    # separately — and says `unknown` rather than `ok` when it cannot.
    mem = os.path.join(ROOT, "memory.db")
    if not os.path.exists(mem):
        return "unknown", "no memory.db here", {}
    try:
        m = sqlite3.connect(f"file:{mem}?mode=ro", uri=True)
    except sqlite3.Error as e:
        return "unknown", f"could not open memory.db read-only: {e}", {}
    try:
        if not has_table(m, "memory_chunk_use"):
            return "unknown", "no memory_chunk_use table — the lane has never run here", {}
        seen = m.execute("SELECT injects_seen, last_cycle_at FROM use_ledger_state WHERE id = 1").fetchone()
        injects_seen, last_cycle = (seen or (0, None))
        if not last_cycle:
            return "unmeasured", "the use ledger has never completed a pass", {"injects_seen": injects_seen}
        if injects_seen < 200:
            return "unmeasured", (f"the ledger has read {injects_seen} inject(s); it needs 200 before its "
                                  f"counters mean anything"), {"injects_seen": injects_seen}
        # The real question: an inject the LOG holds that the LEDGER does not.
        # A lane that silently stopped looks exactly like a quiet week without
        # this row, which is the shape this whole plan is about.
        logged = c.execute(
            "SELECT count(*) FROM turn_events WHERE kind='inject' AND meta LIKE '%chunk_ids%' "
            "AND at >= datetime('now', '-7 days')").fetchone()[0]
        rows = m.execute(
            "SELECT count(DISTINCT turn_id) FROM memory_chunk_use WHERE at >= datetime('now', '-7 days')").fetchone()[0]
        cited, corrected, total = m.execute(
            "SELECT COALESCE(SUM(cited),0), COALESCE(SUM(corrected),0), COUNT(*) FROM memory_chunk_use "
            "WHERE at >= datetime('now', '-7 days')").fetchone()
        numbers = {"injects_seen": injects_seen, "logged_7d": logged, "turns_in_ledger_7d": rows,
                   "rows_7d": total, "cited_7d": cited, "corrected_7d": corrected}
        if logged == 0:
            return "unknown", "no inject carried chunk_ids in the last 7 days", numbers
        if rows == 0:
            return "fail", (f"{logged} inject(s) in the last 7d carry chunk_ids and the ledger has none of "
                            f"them — the lane is not running"), numbers
        return "ok", (f"{total} use row(s) over {rows} turn(s) in 7d ({cited} cited, {corrected} corrected); "
                      f"ledger has read {injects_seen} injects"), numbers
    finally:
        m.close()


def q10_graph_runs_ledger(c):
    """Is the run ledger still there? (PLAN-LOOPS P0b precondition)"""
    # This row exists because of what happened on 2026-09-04: gateway.db was
    # corrupted and rebuilt, `graph_runs` went from 5,087 rows to 0, and NOTHING
    # noticed for six days. P0b is about to record a lap per cycle into that
    # table; a ledger that can be silently emptied is not a ledger.
    #
    # The check is deliberately about DISAPPEARANCE, not health: it compares the
    # count against the high-water mark it last saw, kept in the same file it
    # writes nothing else to.
    gw = os.path.join(ROOT, "MCP-servers", "Vodou-Console", "gateway.db")
    if not os.path.exists(gw):
        return "unknown", "no gateway.db here", {}
    try:
        g = sqlite3.connect(f"file:{gw}?mode=ro", uri=True)
    except sqlite3.Error as e:
        return "unknown", f"could not open gateway.db read-only: {e}", {}
    try:
        if not has_table(g, "graph_runs"):
            return "unknown", "no graph_runs table", {}
        n = g.execute("SELECT count(*) FROM graph_runs").fetchone()[0]
    finally:
        g.close()
    mark_path = os.path.join(ROOT, ".vodou", "workspace", "graph-runs-highwater.json")
    prev = 0
    try:
        with open(mark_path) as f:
            prev = int(json.load(f).get("rows", 0))
    except Exception:
        prev = 0
    numbers = {"rows": n, "high_water": max(prev, n)}
    try:
        os.makedirs(os.path.dirname(mark_path), exist_ok=True)
        with open(mark_path, "w") as f:
            json.dump({"rows": max(prev, n), "checked_at": time.strftime("%Y-%m-%d %H:%M:%S")}, f)
    except Exception:
        pass
    if prev == 0 and n == 0:
        # Never seen rows and none now: a fresh install, or the 09-04 wipe with
        # no runs since. Not a claim either way.
        return "unmeasured", "graph_runs is empty and this grader has never seen it otherwise", numbers
    if n == 0 and prev > 0:
        return "fail", (f"graph_runs held {prev} row(s) and now holds none — the run ledger was emptied "
                        f"(this happened on 2026-09-04 and nothing noticed for six days)"), numbers
    if n < prev // 2:
        return "fail", f"graph_runs fell from {prev} to {n} rows — more than half the ledger is gone", numbers
    return "ok", f"{n} run(s) recorded (high-water {max(prev, n)})", numbers


def q11_replay(c):
    """Is the counterfactual honest about how little it knows? (PLAN-LOOPS P3)"""
    # The row exists to stop ONE thing: a weekly worth-number built from four
    # samples. Under 30 replays there is no honest number and the receipt says
    # so, and a lane nobody opted into is `unmeasured`, never `ok`.
    if not has_table(c, "turn_replays"):
        return "unknown", "no turn_replays table — migration 098 has not run here", {}
    total, changed, unknown = c.execute(
        "SELECT count(*), COALESCE(SUM(changed='yes'),0), COALESCE(SUM(changed='unknown'),0) "
        "FROM turn_replays WHERE at >= datetime('now','-7 days')").fetchone()
    eligible = c.execute(
        "SELECT count(DISTINCT r.turn_id) FROM turn_events r "
        "JOIN turn_events a ON a.turn_id=r.turn_id AND a.kind='assistant/message' AND a.payload IS NOT NULL "
        "JOIN turn_events m ON m.turn_id=r.turn_id AND m.kind='inject' AND m.lane='memory' "
        "JOIN turn_event_blobs b ON b.ref=m.payload_ref AND b.payload IS NOT NULL "
        "WHERE r.kind='request' AND r.payload IS NOT NULL").fetchone()[0]
    numbers = {"replays_7d": total, "changed_7d": changed, "unknown_7d": unknown, "eligible_turns": eligible}
    if total == 0:
        return "unmeasured", (f"no replays yet ({eligible} turn(s) are replayable) — the lane is opt-in "
                              f"(VODOU_REPLAY_ENABLED=1)"), numbers
    if total < 30:
        return "unmeasured", f"{total} replay(s) in 7d — under 30, so there is no honest number yet", numbers
    # The dishonesty this row is really for: every replay coming back `unknown`
    # reads as "memory changes nothing" unless somebody says otherwise.
    if unknown >= total:
        return "fail", f"all {total} replays are `unknown` — the judge is not answering, so the number means nothing", numbers
    return "ok", f"memory changed {changed} of {total} answers in 7d ({unknown} unknown)", numbers


GRADERS = [
    ("turn-derive", q1_turn_derive),
    ("receipt-completeness", q3_receipt_completeness),
    ("guest-privacy", q4_guest_privacy),
    ("world-tagged", q6_world_tagged),
    ("reply-recorded", q7_reply_recorded),
    ("commitments-lane", q8_commitments_lane),
    ("use-ledger", q9_use_ledger),
    ("graph-runs-ledger", q10_graph_runs_ledger),
    ("replay", q11_replay),
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
        # `unmeasured` is distinct from `unknown`: the instrument exists but has
        # not yet looked at enough to say anything (PLAN-COMMITMENTS-LANE §3.5).
        mark = {"ok": "ok  ", "warn": "warn", "fail": "FAIL", "unknown": "?   ", "unmeasured": "n/m "}
        for r in rows:
            print(f"  {mark.get(r['verdict'], '?   ')} {r['name']:<22} {r['evidence']}")
        print()
    # Only a real failure is red. `unknown` exits 0 with its reason on the page:
    # a nightly that goes red on a quiet machine is a nightly nobody reads.
    return 2 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
