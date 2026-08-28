#!/usr/bin/env python3
"""rules-guard — the fifth pre-commit guard.

PLAN-SESSION-CONTRACT P3 / PLAN-HOST-RULES-ONE-SOURCE P3. CLAUDE.md,
.cursorrules and .cursor/rules/vodou-policy.mdc are GENERATED from
templates/rules/ by `vodou-core rules render`. This guard blocks a commit that
would leave a generated file out of step with its source — in either direction:

  * a generated file is staged but does not match the renderer's output
    (someone hand-edited the output instead of the source);
  * templates/rules/* is staged but the generated files were not regenerated
    (someone edited the source and forgot to render);
  * AGENTS.md is staged and one of its `<!-- rules:begin … -->` regions no longer
    matches its block (the manual is hand-written; only those regions are not).

It only fires when one of those paths is staged, so unrelated commits pay
nothing. Bypass a true emergency with VODOU_SKIP_RULES_GUARD=1 — but the fix is
almost always `./vodou-core rules render` and staging the result.

Mirrors coherence-guard.py: reads the index, never the working tree, exits 1 on
a block with a message that says what to run.
"""
import os
import subprocess
import sys

ROOT = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
GENERATED = ("CLAUDE.md", ".cursorrules", ".cursor/rules/vodou-policy.mdc", "GEMINI.md", ".github/copilot-instructions.md", "AGENTS.md")  # AGENTS.md: spliced regions only
SOURCE_PREFIX = "templates/rules/"


def staged_paths():
    out = subprocess.run(["git", "diff", "--cached", "--name-only"], capture_output=True, text=True, cwd=ROOT)
    return [p.strip() for p in out.stdout.splitlines() if p.strip()]


def main() -> int:
    if os.environ.get("VODOU_SKIP_RULES_GUARD") == "1":
        return 0
    staged = staged_paths()
    touches_generated = [p for p in staged if p in GENERATED]
    touches_source = [p for p in staged if p.startswith(SOURCE_PREFIX)]
    if not touches_generated and not touches_source:
        return 0

    binary = os.path.join(ROOT, "vodou-core")
    if not os.path.exists(binary):
        # No renderer available — cannot verify, and refusing every commit on a
        # fresh clone would be worse than the drift. Say so and let it through.
        print("rules-guard: ./vodou-core not built; cannot verify generated rules files (letting commit through)")
        return 0

    r = subprocess.run([binary, "rules", "render", "--check"], capture_output=True, text=True, cwd=ROOT)
    if r.returncode == 0:
        return 0
    if "unrecognized subcommand" in r.stderr or "unexpected argument" in r.stderr:
        # The installed binary predates `rules render`. Blocking every commit that
        # touches these files until someone swaps the binary would be the guard
        # causing the outage it exists to prevent. Say so; let it through.
        print("rules-guard: installed ./vodou-core has no `rules render` (predates P3) — cannot verify; "
              "swap the binary (scripts/swap-binary.sh) to enable this guard")
        return 0

    print("rules-guard: a generated rules file is out of step with templates/rules/ "
          "(PLAN-SESSION-CONTRACT P3):\n")
    for line in (r.stdout + r.stderr).splitlines():
        if line.strip():
            print("  " + line)
    print("\nThe fix is almost always:\n"
          "    ./vodou-core rules render\n"
          "    git add CLAUDE.md .cursorrules .cursor/rules/vodou-policy.mdc GEMINI.md .github/copilot-instructions.md AGENTS.md\n"
          "Edit templates/rules/*, never the generated files. Bypass a true emergency with "
          "VODOU_SKIP_RULES_GUARD=1.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
