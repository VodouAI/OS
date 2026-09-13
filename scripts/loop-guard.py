#!/usr/bin/env python3
"""loop-guard — a proactive loop with no registry entry, or a fixture it does
not have, fails the commit.

PLAN-PROACTIVE-LOOPS rev 3 P0b. Sibling of `entrypoint-guard.py`, and written
to the same standard: it must be precise enough that nobody learns to
`VODOU_SKIP_` it.

WHY THIS EXISTS
The plan's evidence is one sentence from the live ledger: *"Five graders, all
false-positive, none with a must-not-fire test. The defect is the missing test
class, not the five instances."* A loop that fires on a healthy system teaches
the user to skim, and a skimmed briefing is a dead briefing. So `loops.toml`
demands three fixtures per loop — one that must fire, one that must stay quiet
on a healthy populated install, one that must stay quiet on a brand-new empty
one — and this guard is what makes the demand real rather than aspirational.

WHAT IS ENFORCED, and only this
  1. A staged file under `src/loops/` (excluding `mod.rs` and test modules)
     whose loop name has no `[loops.<name>]` entry in `loops.toml`.
  2. A staged `loops.toml` whose entries are missing a mandatory field.
  3. A staged `loops.toml` naming a `fixture_*` path that does not exist.

WHAT IS DELIBERATELY NOT ENFORCED
  Anything about a loop's behaviour. This guard reads a registry and a
  directory listing; it never imports, runs or greps loop logic. A guard that
  tries to judge whether a check is *correct* fails on the first honest
  exception and gets bypassed. Correctness is what the fixtures are for.

  It is also silent — exit 0, immediately — for any commit that stages neither
  `src/loops/` nor `loops.toml`, which is nearly every commit in this tree.
  The blast radius of a bug in this file is bounded to commits that touch the
  loop platform, which on 2026-09-10 is nobody.

Bypass a true false positive with VODOU_SKIP_LOOP_GUARD=1 — but prefer adding
the entry or the fixture, which is the registry doing its job.
"""
import os
import re
import subprocess
import sys
from pathlib import Path

try:
    import tomllib
except ImportError:  # py<3.11
    try:
        import tomli as tomllib  # type: ignore
    except ImportError:
        tomllib = None  # type: ignore

# Two roots, the same split entrypoint-guard uses and for the same reason: ROOT
# is the work tree the STAGED FILES live in; REGISTRY is where loops.toml is
# read from. Identical in a real commit, different under the harness, which
# runs this guard from the real repo against a sandbox index — so the registry
# under test is the real one and a sandbox case cannot pass vacuously.
ROOT = Path(
    subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True, text=True, check=False,
    ).stdout.strip()
    or "."
)
REGISTRY = Path.cwd() if (Path.cwd() / "loops.toml").exists() else ROOT

LOOP_DIR = "src/loops/"
# `mod.rs` declares the tree; it is not a loop. Test modules simulate loops.
# The rest are shared MACHINERY, not checks. `findings.rs` is the drain every
# loop writes into, `watches.rs` the trigger platform, `dispatcher.rs` the tick
# that decides what is due. None of them observes anything, so a stanza would
# mean inventing a fake `implementation`, `trigger` and three fixtures for code
# that has nothing to be right or wrong about. The distinction this guard
# enforces is "does this RUN on its own and reach a person?" — shared
# infrastructure is named here rather than given a stanza that lies.
#
# This list is a list, not a licence: `test-loop-guard.sh` proves a new loop
# module hiding beside them is still blocked.
NOT_A_LOOP = (
    "src/loops/mod.rs",
    "src/loops/findings.rs",
    "src/loops/watches.rs",
    "src/loops/dispatcher.rs",
)
SKIP_MARKERS = ("/tests/", "/test/", ".test.", "_test.rs", "tests.rs")

MANDATORY = (
    "implementation", "trigger", "owner", "reads", "emits", "drain",
    "audience", "budget_secs", "llm_calls", "severity_max", "kill_switch",
    "fixture_fires", "fixture_quiet", "fixture_fresh",
)
FIXTURE_FIELDS = ("fixture_fires", "fixture_quiet", "fixture_fresh")
IMPLEMENTATIONS = ("module", "automation")
TRIGGERS = ("idle", "event", "at", "scheduled")
AUDIENCES = ("user", "operator")
# A loop cannot escalate itself; `critical` needs an explicit grant, and no
# loop in the plan gets one.
SEVERITIES = ("info", "notice", "warn")


def staged_paths() -> list[str]:
    out = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
        capture_output=True, text=True, check=False,
    ).stdout
    return [p for p in out.splitlines() if p.strip()]


def loop_name_from_path(path: str) -> str:
    """`src/loops/capture_gap.rs` → `capture-gap`. Underscores in a Rust module
    name are hyphens in a registry key, the same spelling `processes.toml` and
    `stacks.toml` use for their keys."""
    stem = Path(path).stem
    return stem.replace("_", "-")


def staged_registry_text() -> str | None:
    """The registry AS COMMITTED, when it is part of this commit.

    Reading the working tree instead was this guard's first bug and it is worth
    naming: a commit is judged on what it contains, not on what happens to be
    on disk beside it. Staging a loops.toml that deletes a fixture, then
    reverting the file in the editor, would otherwise pass."""
    out = subprocess.run(
        ["git", "show", ":loops.toml"], capture_output=True, text=True, check=False,
    )
    return out.stdout if out.returncode == 0 else None


def read_registry(text: str | None = None) -> tuple[dict, str | None]:
    """Returns (loops table, error). A missing registry is an error only when a
    loop file is staged — a repo with no loops needs no loops.toml."""
    if tomllib is None:
        return {}, "python has no tomllib and tomli is not installed"
    if text is None:
        text = staged_registry_text()
    if text is None:
        p = REGISTRY / "loops.toml"
        if not p.exists():
            return {}, "loops.toml not found"
        text = p.read_text(encoding="utf-8")
    try:
        doc = tomllib.loads(text)
    except Exception as e:  # a malformed registry is a failed commit, not a pass
        return {}, f"loops.toml does not parse: {e}"
    return doc.get("loops", {}) or {}, None


def check_entry(name: str, entry: dict, root: Path, staged: set[str] | None = None) -> list[str]:
    problems = []
    if not isinstance(entry, dict):
        return [f"[loops.{name}] is not a table"]
    for field in MANDATORY:
        if field not in entry:
            problems.append(f"[loops.{name}] is missing `{field}`")
    impl = entry.get("implementation")
    if impl is not None and impl not in IMPLEMENTATIONS:
        problems.append(f"[loops.{name}] implementation `{impl}` is not one of {IMPLEMENTATIONS}")
    trig = entry.get("trigger")
    if trig is not None and trig not in TRIGGERS:
        problems.append(f"[loops.{name}] trigger `{trig}` is not one of {TRIGGERS}")
    aud = entry.get("audience")
    if aud is not None and aud not in AUDIENCES:
        problems.append(f"[loops.{name}] audience `{aud}` is not one of {AUDIENCES} (§6.2: operator findings never reach a user briefing)")
    sev = entry.get("severity_max")
    if sev is not None and sev not in SEVERITIES:
        problems.append(f"[loops.{name}] severity_max `{sev}` is not one of {SEVERITIES} — a loop cannot escalate itself")
    emits = entry.get("emits")
    if emits is not None and emits != "loop_findings":
        problems.append(f"[loops.{name}] emits `{emits}` — the whole point of the contract is one drain: loop_findings")
    for field in FIXTURE_FIELDS:
        rel = entry.get(field)
        if not rel:
            continue
        if str(rel) in (staged or set()):
            continue
        if not (root / str(rel)).exists():
            problems.append(f"[loops.{name}] {field} names `{rel}`, which does not exist")
    return problems


def main() -> int:
    if os.environ.get("VODOU_SKIP_LOOP_GUARD") == "1":
        return 0

    audit = "--audit" in sys.argv
    if audit:
        # An audit grades what is ON DISK — it answers "is the tree healthy",
        # not "is this commit healthy".
        p = REGISTRY / "loops.toml"
        loops, err = read_registry(p.read_text(encoding="utf-8") if p.exists() else None)
        if err:
            print(f"loop-guard --audit: {err}", file=sys.stderr)
            return 2
        if not loops:
            print("loop-guard --audit: no loops registered yet.")
            return 0
        problems: list[str] = []
        for name, entry in loops.items():
            problems += check_entry(name, entry, REGISTRY)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        print(f"loop-guard --audit: {len(loops)} loop(s), {len(problems)} problem(s).")
        return 2 if problems else 0

    staged = staged_paths()
    loop_files = [
        p for p in staged
        if p.startswith(LOOP_DIR)
        and p.endswith(".rs")
        and p not in NOT_A_LOOP
        and not any(m in p for m in SKIP_MARKERS)
    ]
    registry_staged = "loops.toml" in staged
    # Nearly every commit in this tree ends here.
    if not loop_files and not registry_staged:
        return 0

    loops, err = read_registry()
    if err:
        print(f"loop-guard: {err}", file=sys.stderr)
        print("A loop without a registry is the thing this guard exists to prevent.", file=sys.stderr)
        return 1

    problems: list[str] = []
    # Fixtures may themselves be part of this commit; a path staged now exists
    # as far as the commit is concerned.
    staged_set = set(staged)
    for path in loop_files:
        name = loop_name_from_path(path)
        if name not in loops:
            problems.append(
                f"{path} has no [loops.{name}] entry in loops.toml — declare its "
                f"trigger, drain, budget and three fixtures, or it is a check nobody can grade"
            )
    # A staged registry is checked whole: an entry whose fixture was deleted is
    # as broken as one that never had it.
    if registry_staged:
        for name, entry in loops.items():
            problems += check_entry(name, entry, REGISTRY, staged_set)

    if not problems:
        return 0
    print("loop-guard: refusing this commit.\n", file=sys.stderr)
    for p in problems:
        print(f"  {p}", file=sys.stderr)
    print(
        "\nEvery field is mandatory, and fixture_quiet/fixture_fresh are the point:\n"
        "five graders shipped false-positive because none had a must-not-fire test.\n"
        "Bypass a true false positive with VODOU_SKIP_LOOP_GUARD=1.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
