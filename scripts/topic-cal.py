#!/usr/bin/env python3
"""
topic-cal — the library topic lane's calibration harness.

PLAN-TOPIC-LANE-DISCRIMINATOR (PLANS/0.6.23) P0.4: "a harness that prints the full
table in §1 in one command. The measurement in 5d292f4a took three release builds
and a hand-written socket client; it should take one invocation."

    python3 scripts/topic-cal.py                 # live library
    python3 scripts/topic-cal.py --veto v1,v3    # score candidate vetoes too
    python3 scripts/topic-cal.py --json          # machine-readable

WHAT IT MEASURES, and why that is not "does the test pass":
per §3.4 a veto is only real if, on the labelled set, it REJECTS EVERY FALSE POSITIVE
AND REJECTS NO TRUE HIT, with the margin stated. So this prints a confusion matrix
per veto, not a pass/fail — a veto that fixes the two known FPs by a hair is the same
luck the 0.70 floor was.

MEASUREMENT HYGIENE (plan §7 — three traps that cost a build each):
  1. The gateway's matchCache has no TTL, so it will happily serve scores computed by
     the PREVIOUS binary. This harness therefore drives `vodou-core mem library match`
     directly and never goes through the gateway.
  2. reranker_logit is frequently absent (skipped_short_query / skipped_high_cosine /
     skipped_caller / disabled, and the tail is never scored). Any veto keyed on it
     silently dies for whole query classes — so a missing verdict is printed as `-`
     and counted, never coerced to 0.
  3. §7 says the cold CLI path is silent for this lane. RE-MEASURED 2026-08-17: it is
     not — `mem library match` returns topic hits (MSA at 0.758). That trap is stale.

  4. A FOURTH TRAP THE PLAN DOES NOT LIST, and it is the one that wasted this round:
     `main.rs:3270` REDIRECTS STDERR INTO `.vodou/system.log`. Every eprintln! in this
     lane — including the VODOU_TOPIC_TELEMETRY output the plan tells you to read —
     is invisible at the terminal on the CLI path. Anyone measuring by capturing
     stderr sees an empty stream and concludes the instrumentation is broken. So this
     harness records the log's size BEFORE each run and reads only what was appended.

WHAT COUNTS AS A LEAK: `via` in {topic, subject, card}. NOT `weak` — that is the
deliberate "closest match" fallback (cards.rs), returned only when neither real lane
fired, and library-e2e ignores it for the same reason. Counting it makes every noise
query look like a 5-document leak and hides the real signal.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FIXTURE = REPO / "fixtures" / "topic-lane-labelled.json"
BIN = REPO / "vodou-core"

# Query words that carry no topical content. Kept deliberately SHORT: a long
# stoplist is a hidden tuning knob, and this plan is about not tuning things.
STOP = {
    "a", "an", "and", "the", "for", "of", "to", "in", "on", "with", "how", "what",
    "is", "are", "my", "me", "i", "it", "this", "that", "or", "at", "by", "from",
    "com", "org", "io", "dev", "net", "www", "co", "uk", "so",
}


def content_terms(query):
    """Content words of a query, minus hosts and stopwords.

    Hosts are stripped whole rather than tokenized: the panel's query shape is
    "<tab title> <host>", so `doc.rust-lang.org` would otherwise donate the tokens
    `doc`, `rust`, `lang` and `org` to the overlap test and let a veto be satisfied
    by the URL alone.
    """
    q = re.sub(r"\b[\w-]+\.(com|org|net|io|dev|co\.uk|so|ai|gov|edu)\b", " ", query.lower())
    words = re.findall(r"[a-z][a-z0-9+#-]{2,}", q)
    return [w for w in words if w not in STOP]


def card_field(card, name):
    """Pull one rendered field out of a card's text (cards.rs:227-231)."""
    if not card:
        return ""
    m = re.search(rf"^{name}:\s*(.*?)(?=\n\n|\Z)", card, re.M | re.S)
    return m.group(1).strip() if m else ""


SYSTEM_LOG = REPO / ".vodou" / "system.log"


def run_match(query, top_k=5, telemetry=True):
    """One `mem library match`. Returns (hits, subject_pool, log_tail).

    Telemetry comes from `.vodou/system.log`, not from the child's stderr — see
    trap 4 in the module docstring. The log offset is taken before the run so a
    previous query's pool is never misread as this one's.
    """
    env = dict(os.environ)
    if telemetry:
        env["VODOU_TOPIC_TELEMETRY"] = "1"
    offset = SYSTEM_LOG.stat().st_size if SYSTEM_LOG.exists() else 0
    p = subprocess.run(
        [str(BIN), "mem", "library", "match", query, "--top-k", str(top_k), "--json"],
        capture_output=True, text=True, env=env, cwd=str(REPO), timeout=300,
    )
    try:
        hits = json.loads(p.stdout)
    except json.JSONDecodeError:
        hits = []
    tail = ""
    if SYSTEM_LOG.exists():
        with SYSTEM_LOG.open("r", errors="replace") as fh:
            fh.seek(offset)
            tail = fh.read()
    pool = []
    for line in tail.splitlines():
        if "[topic-cal] subject-pool" in line:
            # Names contain spaces ("Get Started with Vodou | Notion"), so split on
            # the `=<score>` boundary rather than on whitespace.
            body = line.split("carded:", 1)[-1].strip()
            pool = [m.group(1).strip() for m in
                    re.finditer(r"([^=]+?)=(\d\.\d+)(?=\s|$)", body)]
    return hits, pool, tail


# ---------------------------------------------------------------------------
# The four candidate vetoes (plan §3.3). Each returns (reject: bool, reason: str).
# A veto may ONLY reject. Silence from the card is consent.
# ---------------------------------------------------------------------------

def veto_v1(hit, query, pool):
    """Entity overlap: reject when no content term of the query appears in the
    card's `entities` + `what`."""
    card = hit.get("card") or ""
    if not card.strip():
        return False, "no card — consent"
    hay = (card_field(card, "what") + " " + card_field(card, "entities")).lower()
    terms = content_terms(query)
    hit_terms = [t for t in terms if t in hay]
    if not hit_terms:
        return True, f"none of {terms} in what+entities"
    return False, f"matched {hit_terms}"


def veto_v2(hit, query, pool):
    """`not_about` as negative evidence: reject when the query overlaps `not about`
    more than `what`."""
    card = hit.get("card") or ""
    if not card.strip():
        return False, "no card — consent"
    na = card_field(card, "not about").lower()
    what = card_field(card, "what").lower()
    if not na:
        return False, "no not_about — consent"
    terms = set(content_terms(query))
    n_na = len([t for t in terms if t in na])
    n_what = len([t for t in terms if t in what])
    if n_na > n_what:
        return True, f"not_about {n_na} > what {n_what}"
    return False, f"not_about {n_na} <= what {n_what}"


def veto_v3(hit, query, pool):
    """Subject-lane corroboration: require the document to appear ANYWHERE in the
    subject candidate list, however weakly.

    Note what that list IS: `lookup` truncates to RERANK_POOL = 5, so "anywhere"
    means the top 5 CARDED documents by cosine. That is a much narrower thing than
    the plan's wording implies, and it is why v3a exists below.
    """
    if not pool:
        return False, "no pool telemetry — consent"
    name = hit.get("display_name", "")
    if name in pool:
        return False, "in subject pool"
    return True, f"absent from subject pool (n={len(pool)})"


def veto_v3a(hit, query, pool):
    """V3's degenerate reading, isolated so it cannot be mistaken for V3.

    The subject lane's universe is `WHERE c.scope = 'doc:card'` (cards.rs:506) —
    ONLY carded documents. So "require subject corroboration" collapses, for any
    uncarded document, into "require a card". Measured separately because a veto
    that rejects on CARD ABSENCE rather than on TOPIC is not a discriminator: it
    would reject a true interior hit in an uncarded document just as eagerly.
    """
    if (hit.get("card") or "").strip():
        return False, "carded — consent"
    return True, "uncarded — cannot be corroborated"


def veto_v5(hit, query, pool):
    """V5 — EVIDENCE CORROBORATION. Not in the plan; the measurement suggested it.

    §2 makes the observation without drawing the conclusion: the false positives
    render as `mentions: Rust core` and `mentions: Basic Information`, while the
    true hits render `mentions: 12. Limitation of Liability`. Both are literally
    true; only one is worth opening.

    The lane already computes `evidence` — the first line of the winning passage,
    which for a structured document is its HEADING — and already ships it to the
    caller. So: reject when the cited evidence shares no content term with the
    query. It costs nothing, it reads a field that already exists, and unlike V1 it
    asks about WHERE the document matched rather than whether the document
    happens to contain the word anywhere.

    Honest limitation, stated before the numbers: this is a passage-level signal
    wearing a document-level hat. It tests the STRUCTURAL position of the match,
    not the document's aboutness, so §1.1's argument does not obviously spare it.
    """
    ev = (hit.get("evidence") or "").lower()
    if not ev.strip():
        return False, "no evidence — consent"
    terms = content_terms(query)
    matched = [t for t in terms if t in ev]
    if not matched:
        return True, f"evidence {ev[:34]!r} shares nothing with {terms}"
    return False, f"evidence matched {matched}"


def passage_headings(path_like, evidence):
    """Every heading-ish line of the winning passage, read back from memory.db.

    `evidence` is `first_line(chunk)` (cards.rs:1004) — the FIRST non-empty line,
    truncated at 120 chars — so it identifies the chunk but does not describe it.
    """
    import sqlite3
    con = sqlite3.connect(f"file:{REPO / 'memory.db'}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT text FROM memory_chunks WHERE path LIKE ? AND text LIKE ? LIMIT 1",
            (f"%{path_like}%", f"%{evidence[:60]}%"),
        ).fetchall()
    finally:
        con.close()
    if not rows:
        return []
    out = []
    for line in rows[0][0].splitlines():
        s = line.strip()
        if not s:
            continue
        # Markdown headings, bolded clause labels ("**16.5 Governing Law; Venue.**"),
        # and numbered section titles — the structural labels of a document.
        if s.startswith("#") or re.match(r"^\*\*[\d.]+\s", s) or re.match(r"^[\d.]+\s+[A-Z]", s):
            out.append(s.strip("#* ").strip())
    return out


def veto_v6(hit, query, pool):
    """V6 — V5's non-circular form: does ANY heading of the winning passage share a
    content term with the query?

    V5 failed on exactly one true hit, and the cause was an artifact rather than a
    disagreement: the winning MSA passage opens `## 16. General` and its NEXT line
    is `**16.5 Governing Law; Venue.**`, so `first_line` handed the veto the least
    informative line in the passage and the veto duly rejected it.

    Asking "does such a line EXIST" instead of "does the chosen line match" keeps
    the test honest. Selecting the display line by query relevance and then vetoing
    on that same line would be circular and would pass everything.
    """
    ev = (hit.get("evidence") or "").strip()
    if not ev:
        return False, "no evidence — consent"
    name = hit.get("display_name", "")
    heads = passage_headings(name.replace(".md", ""), ev)
    if not heads:
        return False, "no headings recovered — consent"
    terms = content_terms(query)
    hay = " | ".join(heads).lower()
    matched = [t for t in terms if t in hay]
    if not matched:
        return True, f"no heading of {heads[:3]} mentions {terms}"
    return False, f"heading matched {matched}"


VETOES = {"v1": veto_v1, "v2": veto_v2, "v3": veto_v3, "v3a": veto_v3a,
          "v5": veto_v5, "v6": veto_v6}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--veto", default="", help="comma-separated: v1,v2,v3")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--top-k", type=int, default=5)
    args = ap.parse_args()

    vetoes = [v.strip() for v in args.veto.split(",") if v.strip()]
    for v in vetoes:
        if v not in VETOES:
            sys.exit(f"unknown veto {v!r} — have {sorted(VETOES)}")

    cases = json.loads(FIXTURE.read_text())["cases"]
    rows, results = [], []

    for case in cases:
        q, lane, want = case["query"], case["lane"], case.get("expect")
        hits, pool, _ = run_match(q, args.top_k)
        # `weak` is the sub-floor "closest match" fallback, not a claim either lane
        # made — library-e2e ignores it and so must this. Counting it turns every
        # noise query into a 5-document leak and buries the signal.
        claims = [h for h in hits if (h.get("via") or "subject") != "weak"]
        considered = [h for h in claims if lane == "any" or (h.get("via") or "subject") == lane]

        for h in considered:
            name = h.get("display_name", "?")
            is_true = bool(want and re.search(want, name, re.I))
            row = {
                "query": q,
                "document": name,
                "verdict": "true" if is_true else "false",
                "cosine": h.get("cosine"),
                "via": h.get("via") or "subject",
                "carded": bool((h.get("card") or "").strip()),
                "vetoes": {},
            }
            for v in vetoes:
                rejected, why = VETOES[v](h, q, pool)
                row["vetoes"][v] = {"reject": rejected, "why": why}
            rows.append(row)
        results.append({"query": q, "lane": lane, "expect": want, "hits": len(considered),
                        "pool": len(pool)})
        # A true hit that returned NOTHING is a miss, and it must be counted as a
        # true hit the lane already loses — otherwise a veto gets credit for
        # recall the lane never had.
        if want and not considered:
            rows.append({"query": q, "document": "(silent)", "verdict": "true",
                         "cosine": None, "via": lane, "carded": False,
                         "vetoes": {v: {"reject": True, "why": "lane returned nothing"}
                                    for v in vetoes}})

    if args.json:
        print(json.dumps({"rows": rows, "queries": results}, indent=2))
        return

    print(f"\n=== topic-cal — {len(cases)} labelled queries, live library\n")
    hdr = f"{'query':<48} {'document':<38} {'verdict':<8} {'cos':>6} {'card':>5}"
    for v in vetoes:
        hdr += f" {v:>6}"
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        cos = f"{r['cosine']:.3f}" if isinstance(r["cosine"], float) else "  -  "
        line = (f"{r['query'][:47]:<48} {r['document'][:37]:<38} "
                f"{r['verdict']:<8} {cos:>6} {'yes' if r['carded'] else 'NO':>5}")
        for v in vetoes:
            line += f" {'REJECT' if r['vetoes'][v]['reject'] else '  ok  ':>6}"
        print(line)

    # The populations, which is what §1's table is actually for.
    trues = [r for r in rows if r["verdict"] == "true" and isinstance(r["cosine"], float)]
    falses = [r for r in rows if r["verdict"] == "false" and isinstance(r["cosine"], float)]
    print(f"\ncosine populations:")
    if trues:
        print(f"  true  n={len(trues):<3} {min(r['cosine'] for r in trues):.3f} - {max(r['cosine'] for r in trues):.3f}")
    if falses:
        print(f"  false n={len(falses):<3} {min(r['cosine'] for r in falses):.3f} - {max(r['cosine'] for r in falses):.3f}")
    if trues and falses:
        sep = min(r["cosine"] for r in trues) - max(r["cosine"] for r in falses)
        print(f"  separation: {sep:+.3f}   ({'SEPARABLE' if sep > 0 else 'INTERLEAVED — no threshold exists'})")

    # Card coverage, because every card-reading veto is capped by it.
    n_card = sum(1 for r in rows if r["carded"])
    print(f"\ncard coverage among matched documents: {n_card}/{len(rows)}")

    # §3.4's bar, per veto — graded ON THE TOPIC LANE ONLY, and here is why that
    # is scoping rather than fudging: these are TOPIC-lane vetoes. A subject-lane
    # false positive is a different defect with a different owner, and counting it
    # against a topic veto marks a veto down for a leak it was never able to touch.
    # Rows where the lane returned NOTHING are excluded for the mirror-image
    # reason: no veto rejected them, so neither crediting nor blaming a veto for a
    # pre-existing recall miss tells the truth. Both exclusions are printed.
    graded = [r for r in rows if r["via"] == "topic" and r["document"] != "(silent)"]
    skipped = [r for r in rows if r not in graded]
    if skipped:
        print(f"\nnot graded ({len(skipped)}): "
              + ", ".join(f"{r['document'][:24]}[{r['via']}]" for r in skipped))
    for v in vetoes:
        killed_true = [r for r in graded if r["verdict"] == "true" and r["vetoes"][v]["reject"]]
        killed_false = [r for r in graded if r["verdict"] == "false" and r["vetoes"][v]["reject"]]
        n_false = sum(1 for r in graded if r["verdict"] == "false")
        n_true = sum(1 for r in graded if r["verdict"] == "true")
        ok = not killed_true and len(killed_false) == n_false and n_false > 0
        print(f"\n{v}: rejects {len(killed_false)}/{n_false} false, kills {len(killed_true)}/{n_true} true"
              f"  -> {'MEETS §3.4' if ok else 'FAILS §3.4'}")
        for r in killed_true:
            print(f"     killed a TRUE hit: {r['query'][:44]!r} -> {r['document']} ({r['vetoes'][v]['why']})")
        for r in graded:
            if r["verdict"] == "false" and not r["vetoes"][v]["reject"]:
                print(f"     survived as FALSE: {r['query'][:44]!r} -> {r['document']} ({r['vetoes'][v]['why']})")


if __name__ == "__main__":
    main()
