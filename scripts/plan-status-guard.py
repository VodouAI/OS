#!/usr/bin/env python3
"""plan-status-guard — a step marked done must be able to prove it.

WHY THIS EXISTS

On 2026-08-30 a fresh-eyes pass checked ~320 claims across the plan set. The
PREMISES were sound. The STATUS LAYER was not: steps marked BUILT that violated
their own stated gates, and a runbook never reconciled with the rescoped builds.

Four of those were mine, written the same day:

  * P4 marked COMPLETE with three of its five numbered changes unbuilt.
  * Step 14A claimed it "stops hosts.toml calling chatgpt-web unsupported" while
    citing a commit that never touched hosts.toml.
  * The step-8 gate stated "0 currentProvider checks" — never met, and never
    should have been.
  * Nine silent lanes reported as one defect when they were three.

Every one is the same shape: an intended END STATE written as a DELIVERED one.
The instruments were audited all week; the plan that describes them was not.

WHAT THIS CAN AND CANNOT DO — stated up front, because pretending otherwise
would be the same defect one level up.

A gate written in prose ("the seam is one file", "no lane without an emitter")
cannot be machine-verified in general. What CAN be checked is whether a status
row is capable of being audited at all, and whether the concrete things it names
still exist. That is not "the gate is met". It is "the claim is checkable, and
its cited evidence has not rotted" — which is where all four failures started.

  Rule 1  Every commit SHA cited in a plan resolves in git.
          A plan that cites a SHA nobody can look up is unfalsifiable.

  Rule 2  Every repo-relative path a plan names in backticks exists.
          This is how "it points at the wrong surface" gets caught early.

  Rule 3  A row marked done cites at least one RESOLVING SHA, or says in the
          row why there is no commit (closed with cause, needs a human, N/A).
          A ✅ with no evidence and no explanation is the overclaim itself.

And one REPORT, not a rule, because it needs judgement: for each done row,
which files did its cited commits actually touch. That is what would have
caught 14A — the row named `hosts.toml`, the commit did not.

Usage:  scripts/plan-status-guard.py [--report] [--dir PLANS/0.6.29/building]
Exit:   1 if any rule fails. --report adds the claim-vs-commit listing.
"""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(
    subprocess.run(["git", "rev-parse", "--show-toplevel"],
                   capture_output=True, text=True, check=False).stdout.strip() or "."
)

DONE = re.compile(r"✅|\bCOMPLETE\b|\bCLOSED\b|\bDONE\b|\bBUILT\b")
# A 7-40 char hex run in backticks. Bare hex is too noisy — hashes, ids, colours.
SHA = re.compile(r"`([0-9a-f]{7,40})`")
# A backticked repo-relative path: has a slash and an extension, no spaces.
PATHISH = re.compile(r"`([A-Za-z0-9_.\-]+(?:/[A-Za-z0-9_.\-]+)+\.[A-Za-z0-9]{1,5})`")
# Not every hex run in backticks is a commit. Content hashes, md5s and
# fingerprints live in these plans by design — `content_hash` and a launcher's
# md5 both tripped Rule 1 on the first run. If the line SAYS what the hex is,
# believe it.
HEX_NOT_SHA = re.compile(r"content_hash|\bmd5\b|sha256|fingerprint|digest|checksum", re.I)

# A RUNBOOK proves by observation, not by commit: P9.6's evidence is "the model
# answered from the document and the log shows the lane", which is stronger than
# a SHA, not weaker. Rule 3 asks "can this be audited?" — and for these files the
# audit is the recorded result.
OBSERVATION_FILES = ("PLAN-TRUTHFUL-TURN-VERIFY.md",)

# EVIDENCE, not specifically a commit. The first draft demanded a SHA and
# flagged five rows that prove themselves better than one would:
#
#   ✅ `src/board/dispatcher.rs:36` — `ClaudeCli`, `Gateway`
#   ✅ match (47,287 chars, 3 lanes relocated)
#
# For an "it exists" claim a file:line is stronger than a SHA, and for a
# measurement the number IS the evidence. The rule is "cite something a reader
# can check", so these count.
EVIDENCE = re.compile(
    r"`[A-Za-z0-9_.\-/]+\.[A-Za-z0-9]{1,5}:\d+`"      # path.ext:123
    r"|\b\d[\d,]{2,}\b"                                 # a measured quantity
    r"|`[A-Za-z0-9_.\-]+\.[A-Za-z0-9]{1,5}`"           # a named file
    r"|`[./][A-Za-z0-9_.\-/]+`"                         # or an extensionless one
)                                                       # (`.git/hooks/pre-commit`)

# Row-level reasons a done row may legitimately cite no commit.
NO_COMMIT_OK = re.compile(
    r"CLOSED WITH CAUSE|NEEDS A HUMAN|N/A|not built|NOT BUILT|deferred|DEFERRED|"
    r"rescoped|no code|documentation|by construction", re.I)

# Paths a plan names to say they are ABSENT. Rule 2 must not fail on those.
ABSENT_OK = re.compile(r"absent|deleted|removed|does not exist|never existed|no longer|"
                       r"~~|would have|NOT BUILT|N/A", re.I)

# A path in SOMEBODY ELSE'S repo is not ours to have. The dsh phase quotes
# `docs/user/guide/mcp-memory.md` from deepseek-harness; demanding it exist here
# is the guard misreading whose tree it is looking at.
FOREIGN_TREE = re.compile(r"deepseek-harness|dsh|upstream|their repo|github\.com/", re.I)


# A plan names paths relative to whichever tree it is discussing. Resolving only
# against the repo root reported `public/js/views/chat.js` as missing — it lives
# under the console. A guard that fires on a real file is one people disable.
PATH_ROOTS = ("", "MCP-servers/Vodou-Console", "MCP-servers/Vodou-Console/src",
              "extension/vodou-bridge", "extension/Store-vodou-bridge",
              "MCP-servers/Vodou-Board", "PLANS/0.6.29")


def path_exists(rel: str) -> bool:
    return any((ROOT / r / rel).exists() for r in PATH_ROOTS)


def sha_resolves(sha: str) -> bool:
    r = subprocess.run(["git", "cat-file", "-e", f"{sha}^{{commit}}"],
                       cwd=ROOT, capture_output=True)
    return r.returncode == 0


def files_of(sha: str):
    r = subprocess.run(["git", "show", "--name-only", "--format=", sha],
                       cwd=ROOT, capture_output=True, text=True)
    return [l for l in r.stdout.splitlines() if l.strip()]


def rows(path: Path):
    """Yield (lineno, text) for table rows and status lines worth grading."""
    for i, line in enumerate(path.read_text(errors="ignore").splitlines(), 1):
        s = line.strip()
        if s.startswith("|") or s.startswith("**Status:**"):
            yield i, line


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--dir", default="PLANS/0.6.29/building")
    args = ap.parse_args()
    if os.environ.get("VODOU_SKIP_PLAN_STATUS_GUARD") == "1":
        return 0

    base = ROOT / args.dir
    if not base.is_dir():
        print(f"plan-status-guard: {args.dir} not found — nothing to grade")
        return 0

    fails: list[str] = []
    report: list[str] = []
    seen_sha: dict[str, bool] = {}

    for md in sorted(base.glob("*.md")):
        for ln, line in rows(md):
            here = f"{md.name}:{ln}"
            shas = [] if HEX_NOT_SHA.search(line) else SHA.findall(line)
            good = []
            for sha in shas:
                if sha not in seen_sha:
                    seen_sha[sha] = sha_resolves(sha)
                if seen_sha[sha]:
                    good.append(sha)
                else:
                    fails.append(f"{here}  Rule 1 — cites `{sha}`, which does not resolve")

            for p in PATHISH.findall(line):
                if path_exists(p) or ABSENT_OK.search(line) or FOREIGN_TREE.search(line):
                    continue
                fails.append(f"{here}  Rule 2 — names `{p}`, which does not exist")

            # A STATUS row, not a matrix cell. `| fn | ✅ strip @5437 | ✅ @5474 |`
            # is a per-function matrix — several markers, almost no prose — and
            # grading it as an unevidenced status claim is noise. A real status
            # row carries one verdict and explains itself.
            # The verdict must be in the RESULT cell — the last one. `| P0 |
            # `turn --derive` prints ✅ on a real turn | …` describes EXPECTED
            # OUTPUT; the ✅ is part of the criterion, not a claim that it holds.
            cells = [c for c in line.split("|") if c.strip()]
            in_result_cell = bool(cells) and bool(DONE.search(cells[-1]))
            # A MATRIX row marks several CELLS done (`| fn | ✅ | ✅ | ✅ |`).
            # A STATUS row marks one. Counting MARKERS instead of cells was the
            # first draft's bug and it hid the exact shape this rule exists for:
            # `✅ **COMPLETE**` is two markers in one cell, so the row was
            # skipped — which is how P4 got marked complete unevidenced.
            marked_cells = sum(1 for c in cells if DONE.search(c))
            is_status_row = (
                marked_cells == 1
                and len(line) > 90
                and line.count("|") <= 6
                and in_result_cell
            )
            if (is_status_row and not shas
                    and md.name not in OBSERVATION_FILES
                    and not EVIDENCE.search(line)
                    and not NO_COMMIT_OK.search(line)):
                fails.append(
                    f"{here}  Rule 3 — marked done with NO EVIDENCE of any kind. Cite a "
                    "commit, a file:line, a measurement, or say why there is none.")

            if args.report and good:
                touched = sorted({f for s in good for f in files_of(s)})
                named = [p for p in PATHISH.findall(line) if p not in touched]
                if named:
                    report.append(
                        f"{here}\n    cites: {', '.join(good)}\n"
                        f"    names files those commits did NOT touch: {', '.join(named)}")

    if report:
        print("── claim vs. commit (judgement required, not a failure) ──\n")
        for r in report:
            print(r + "\n")

    if fails:
        print("plan-status-guard: a step marked done cannot prove it:\n", file=sys.stderr)
        for f in fails:
            print("  " + f, file=sys.stderr)
        print(f"\n  {len(fails)} problem(s). Bypass: VODOU_SKIP_PLAN_STATUS_GUARD=1",
              file=sys.stderr)
        return 1

    print(f"plan-status-guard: {len(seen_sha)} cited commits resolve; "
          "every done row carries evidence or a reason.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
