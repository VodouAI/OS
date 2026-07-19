#!/usr/bin/env python3
"""
archive-install-scripts.py — §0.7d Gap 5 Step 7 / §5 Step 5 of PLAN-SKILLS-V2.md.

Move 65 of 71 install-*.sh scripts to archive/old-install-scripts/, preserving
the relative path for revertibility. The 6 scripts on §0.1's PRESERVATION_LIST
stay in place until the user explicitly opts each one into the new pattern.

The intent_mappings rows these scripts originally INSERTed are NOT touched —
they live in vodou-core.db and continue routing requests until Phase 1's
`skill sync` reconciles them against the new `trigger_phrases` frontmatter
(at which point old rows can be re-tagged or replaced cleanly).

Usage:
  python3 scripts/archive-install-scripts.py             # dry-run
  python3 scripts/archive-install-scripts.py --apply     # actually move files
"""

import argparse
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SKILLS_ROOT = REPO_ROOT / "skills"
ARCHIVE_ROOT = REPO_ROOT / "archive" / "old-install-scripts"

PRESERVATION_LIST = {
    "oi-mcp-builder",
    "new-user-walkthrough",
    "oi-deep-thinking",
    "oi-skill-development",
    "create-a-skill",
    "install-mcp-server",
}


def is_preserved(install_script: Path) -> bool:
    """A script is preserved if its parent skill directory name is in PRESERVATION_LIST."""
    parent_dir = install_script.parent.name
    return parent_dir in PRESERVATION_LIST


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    install_scripts = sorted(SKILLS_ROOT.rglob("install-*.sh"))
    if not install_scripts:
        print("No install-*.sh scripts found — already archived?")
        return 0

    to_archive: list[Path] = []
    preserved: list[Path] = []
    for path in install_scripts:
        if is_preserved(path):
            preserved.append(path)
        else:
            to_archive.append(path)

    print(f"Found {len(install_scripts)} install-*.sh scripts")
    print(f"  Preserved (per §0.1): {len(preserved)}")
    print(f"  To archive: {len(to_archive)}")
    print()

    if preserved:
        print("PRESERVED — staying in place:")
        for p in preserved:
            print(f"  {p.relative_to(REPO_ROOT)}")
        print()

    print("TO ARCHIVE:")
    for p in to_archive:
        rel = p.relative_to(SKILLS_ROOT)
        dest = ARCHIVE_ROOT / rel
        print(f"  {p.relative_to(REPO_ROOT)}")
        print(f"  → archive/old-install-scripts/{rel}")
        if args.apply:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(p), str(dest))

    print()
    print(f"{'Archived' if args.apply else 'Would archive'}: {len(to_archive)} files")
    if not args.apply:
        print("(dry-run; pass --apply to move)")
    else:
        print(f"  Files now under: {ARCHIVE_ROOT.relative_to(REPO_ROOT)}/")
        print(f"  intent_mappings rows previously inserted by these scripts remain in vodou-core.db")
        print(f"  and continue routing — Phase 1 `skill sync` will reconcile them later.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
