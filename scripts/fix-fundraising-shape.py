#!/usr/bin/env python3
"""
fix-fundraising-shape.py — one-time fix for the 12 broken fundraising skills.

PLAN-SKILLS-V2.md §0.7b: 12 actions.json files in skills/agents/fundraising/
share an identical wrong shape (single-file manifest with options as a list of
strings instead of the engine's expected keyed-object). Result: workflow loads
but renders empty options.

This script applies the canonical conversion for all 12:
  1. actions.json: convert stopping_points[*].options from [str] to {N: {label, vars, steps}};
     add default title + type; strip non-canonical top-level fields (skill, category,
     description); add schema_version.
  2. SKILL.md: lift the old actions.json `intents` array into frontmatter as `trigger_phrases`
     (preserves data the migrator wouldn't pick up from prose alone).

Idempotent: re-running on already-fixed files is a no-op.
Reversible: writes .broken.bak alongside each modified file before changes.

Usage:
  python3 scripts/fix-fundraising-shape.py             # dry-run (default)
  python3 scripts/fix-fundraising-shape.py --apply     # write changes
"""

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
FUNDRAISING_DIR = REPO_ROOT / "skills" / "agents" / "fundraising"

DEFAULT_TITLE = "What do you need help with?"
SCHEMA_VERSION = "1.0"
NON_CANONICAL_TOP_FIELDS = {"skill", "category", "description"}


def fix_actions_json(path: Path) -> tuple[bool, dict | None, list[str]]:
    """Returns (changed, new_payload_or_None, intents_lifted)."""
    raw = json.loads(path.read_text())
    changed = False
    intents = list(raw.get("intents", []))

    # Already-fixed detection: if stopping_points[0].options is dict, treat as done.
    sps = raw.get("stopping_points") or []
    if sps and isinstance(sps[0].get("options"), dict) and "schema_version" in raw:
        return False, None, intents

    new_sps = []
    for sp in sps:
        new_sp = dict(sp)
        opts = sp.get("options")
        if isinstance(opts, list):
            new_sp["options"] = {
                str(i + 1): {"label": label, "vars": {}, "steps": []}
                for i, label in enumerate(opts)
            }
            changed = True
        new_sp.setdefault("title", DEFAULT_TITLE)
        new_sp.setdefault("type", "menu")
        new_sps.append(new_sp)

    new_payload = {"schema_version": SCHEMA_VERSION, "stopping_points": new_sps}
    if any(k in raw for k in NON_CANONICAL_TOP_FIELDS) or "intents" in raw:
        changed = True

    return changed, new_payload, intents


FRONTMATTER_RE = re.compile(r"^(---\n)(.*?)(\n---\n)", re.DOTALL)


def lift_intents_to_frontmatter(skill_md_path: Path, intents: list[str]) -> bool:
    """Add `trigger_phrases:` array to frontmatter if missing. Returns True if changed."""
    if not intents:
        return False
    raw = skill_md_path.read_text()
    m = FRONTMATTER_RE.match(raw)
    if not m:
        return False  # malformed — bail rather than corrupt

    fm_body = m.group(2)
    if re.search(r"^trigger_phrases\s*:", fm_body, re.MULTILINE):
        return False  # already has trigger_phrases

    yaml_lines = ["trigger_phrases:"]
    for phrase in intents:
        yaml_lines.append(f"  - {json.dumps(phrase)}")  # JSON-quote handles special chars
    new_fm = fm_body.rstrip() + "\n" + "\n".join(yaml_lines)
    new_raw = raw[: m.start(2)] + new_fm + raw[m.end(2) :]
    skill_md_path.write_text(new_raw)
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Actually write changes")
    args = parser.parse_args()
    apply_mode = args.apply

    if not FUNDRAISING_DIR.is_dir():
        print(f"ERROR: {FUNDRAISING_DIR} not found", file=sys.stderr)
        return 2

    skill_dirs = sorted(d for d in FUNDRAISING_DIR.iterdir() if d.is_dir())
    if len(skill_dirs) != 12:
        print(f"WARN: expected 12 fundraising skills, found {len(skill_dirs)}", file=sys.stderr)

    summary = {"actions_changed": 0, "skill_md_changed": 0, "skipped": 0}

    for skill_dir in skill_dirs:
        actions_path = skill_dir / "actions.json"
        skill_md_path = skill_dir / "SKILL.md"
        if not actions_path.exists() or not skill_md_path.exists():
            print(f"SKIP {skill_dir.name}: missing actions.json or SKILL.md")
            summary["skipped"] += 1
            continue

        changed, new_payload, intents = fix_actions_json(actions_path)
        if not changed:
            print(f"OK   {skill_dir.name}: actions.json already canonical")
            continue

        opts_count = sum(len(sp["options"]) for sp in new_payload["stopping_points"])
        print(f"FIX  {skill_dir.name}: actions.json shape "
              f"({len(new_payload['stopping_points'])} stopping point(s), "
              f"{opts_count} options); intents to lift: {len(intents)}")

        if apply_mode:
            backup = actions_path.with_suffix(".json.broken.bak")
            if not backup.exists():
                shutil.copy2(actions_path, backup)
            actions_path.write_text(json.dumps(new_payload, indent=2) + "\n")
            summary["actions_changed"] += 1

            md_backup = skill_md_path.with_suffix(".md.pre-fix.bak")
            if not md_backup.exists():
                shutil.copy2(skill_md_path, md_backup)
            if lift_intents_to_frontmatter(skill_md_path, intents):
                summary["skill_md_changed"] += 1
                print(f"     ↳ SKILL.md: lifted {len(intents)} trigger_phrases to frontmatter")
            else:
                print(f"     ↳ SKILL.md: trigger_phrases already present or no intents — left alone")

    print()
    print(f"Summary: actions.json changed={summary['actions_changed']}, "
          f"SKILL.md changed={summary['skill_md_changed']}, skipped={summary['skipped']}")
    if not apply_mode:
        print("(dry-run; pass --apply to write)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
