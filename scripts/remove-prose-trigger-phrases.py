#!/usr/bin/env python3
"""
remove-prose-trigger-phrases.py — Lane A3 cleanup per PLAN-SKILLS-V2.md §19.

After the frontmatter migration lifted every "## Trigger Phrases" prose section
into a frontmatter `trigger_phrases:` array, the prose sections are now
duplicated. This script removes the prose section from each SKILL.md body that
has it, leaving the lifted frontmatter as the single source of truth.

Conservative behavior:
  - Only removes the "## Trigger Phrases" header + the immediately following
    bullet list (`- "..."` lines, blank lines OK between).
  - Stops at the next `##` header.
  - Idempotent: re-running on already-cleaned files is a no-op.
  - Reversible: writes .pre-prose-cleanup.bak before changes.

Usage:
  python3 scripts/remove-prose-trigger-phrases.py             # dry-run
  python3 scripts/remove-prose-trigger-phrases.py --apply
"""

import argparse
import re
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SKILLS_ROOT = REPO_ROOT / "skills"

# Captures: "## Trigger Phrases" header (case-insensitive), through end of section,
# stopping at the next "## " heading (or end of file).
SECTION_RE = re.compile(
    r"^##\s+Trigger Phrases\s*\n"          # the header
    r"(?:[ \t]*-[^\n]*\n|[ \t]*\n)*"        # bullet lines OR blank lines, in any mix
    r"(?=^##\s|\Z)",                        # stop at next ## or EOF
    re.MULTILINE,
)


def clean_one(path: Path) -> tuple[bool, str]:
    raw = path.read_text()
    if not SECTION_RE.search(raw):
        return False, "no prose section to remove"
    new_raw = SECTION_RE.sub("", raw)
    # Tidy: collapse 3+ consecutive newlines to exactly 2 around the removal site
    new_raw = re.sub(r"\n{3,}", "\n\n", new_raw)
    return True, new_raw


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    files = sorted(SKILLS_ROOT.rglob("SKILL.md"))
    changed = 0
    skipped = 0
    for path in files:
        is_changed, payload = clean_one(path)
        rel = path.relative_to(REPO_ROOT)
        if is_changed:
            changed += 1
            print(f"CLEAN  {rel}")
            if args.apply:
                bak = path.with_suffix(".md.pre-prose-cleanup.bak")
                if not bak.exists():
                    shutil.copy2(path, bak)
                path.write_text(payload)
        else:
            skipped += 1

    print()
    print(f"Cleaned: {changed}  /  Already clean or no section: {skipped}")
    if not args.apply:
        print("(dry-run; pass --apply to write)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
