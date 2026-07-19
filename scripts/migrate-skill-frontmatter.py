#!/usr/bin/env python3
"""
migrate-skill-frontmatter.py — bring all 103 SKILL.md frontmatter to the
canonical schema (schemas/skill.schema.json).

§0.7d Gap 5 Step 2 from PLAN-SKILLS-V2.md. Stand-in for the future Rust binary
`vodou-core skill migrate-frontmatter`.

For each SKILL.md (excluding the §0.1 preservation list):
  - version: "1.0.0" if missing
  - kind: "subagent" if path under skills/agents/, else "workflow"
  - required_tools: [] if missing
  - trigger_phrases: lift from "## Trigger Phrases" section if missing in frontmatter;
                     leaves the prose section in place (the canonical migrator removes it,
                     but here we keep it for revertibility on this first migration)
  - stopping_points: "required" if body contains "STOPPING POINT", else "optional"
  - actions: "actions.json" if sidecar exists; "inline" if body has AGENT_ACTIONS comments;
             else "none"
  - imported_from: { source: "hand-written" } if missing
  - metadata.vodou.preservation_reason: set on preserved skills (audit trail)

Idempotent: re-running on already-migrated files is a no-op (only adds keys that are missing).
Reversible: writes .pre-migrate.bak alongside each modified file.

Usage:
  python3 scripts/migrate-skill-frontmatter.py             # dry-run
  python3 scripts/migrate-skill-frontmatter.py --apply     # write changes
"""

import argparse
import re
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SKILLS_ROOT = REPO_ROOT / "skills"

PRESERVATION_LIST = {
    "oi-mcp-builder",
    "new-user-walkthrough",
    "oi-deep-thinking",
    "oi-skill-development",
    "create-a-skill",
    "install-mcp-server",
}

FRONTMATTER_RE = re.compile(r"^(---\n)(.*?)(\n---\n)(.*)", re.DOTALL)
TRIGGER_SECTION_RE = re.compile(
    r"##\s*Trigger Phrases\s*\n(.*?)(?=\n##|\Z)",
    re.DOTALL | re.IGNORECASE,
)
TRIGGER_ITEM_RE = re.compile(r'^\s*-\s*["\']?(.+?)["\']?\s*$', re.MULTILINE)
AGENT_ACTIONS_RE = re.compile(r"<!--\s*AGENT_ACTIONS", re.IGNORECASE)
STOPPING_POINT_RE = re.compile(r"\bSTOPPING\s+POINT\b", re.IGNORECASE)


def parse_frontmatter_keys(fm_text: str) -> set[str]:
    """Return the set of top-level keys present in frontmatter. No need for a full YAML parse."""
    keys = set()
    for line in fm_text.split("\n"):
        if not line or line.startswith(" ") or line.startswith("#"):
            continue
        if ":" in line:
            keys.add(line.split(":", 1)[0].strip())
    return keys


def detect_actions_mode(skill_dir: Path, body: str) -> str:
    if (skill_dir / "actions.json").exists():
        return "actions.json"
    if AGENT_ACTIONS_RE.search(body):
        return "inline"
    return "none"


def detect_stopping_points(body: str) -> str:
    return "required" if STOPPING_POINT_RE.search(body) else "optional"


def detect_kind(skill_md_path: Path) -> str:
    rel = skill_md_path.relative_to(SKILLS_ROOT)
    return "subagent" if str(rel).startswith("agents/") else "workflow"


def lift_trigger_phrases(body: str) -> list[str]:
    m = TRIGGER_SECTION_RE.search(body)
    if not m:
        return []
    section = m.group(1)
    phrases = []
    for line_match in TRIGGER_ITEM_RE.finditer(section):
        phrase = line_match.group(1).strip()
        # filter out non-phrase lines (markdown headers, empty etc)
        if phrase and not phrase.startswith("#") and len(phrase) <= 80:
            phrases.append(phrase)
    return phrases


def emit_yaml_value(key: str, value, indent: int = 0) -> str:
    pad = " " * indent
    if isinstance(value, list):
        if not value:
            return f"{pad}{key}: []"
        lines = [f"{pad}{key}:"]
        for item in value:
            # JSON-style quote handles special chars safely
            lines.append(f'{pad}  - "{item}"')
        return "\n".join(lines)
    if isinstance(value, dict):
        lines = [f"{pad}{key}:"]
        for k, v in value.items():
            lines.append(emit_yaml_value(k, v, indent + 2))
        return "\n".join(lines)
    if isinstance(value, str):
        # quote if it contains special chars; otherwise bare
        needs_quote = any(c in value for c in ":#'\"\n") or value.lower() in {"yes", "no", "true", "false", "null"}
        if needs_quote:
            return f'{pad}{key}: "{value}"'
        return f"{pad}{key}: {value}"
    return f"{pad}{key}: {value}"


def migrate_one(skill_md_path: Path) -> tuple[bool, list[str], dict | None]:
    """Returns (changed, additions_summary, raw_for_write)."""
    raw = skill_md_path.read_text()
    m = FRONTMATTER_RE.match(raw)
    if not m:
        return False, ["no frontmatter; skipped"], None

    fm_open, fm_text, fm_close, body = m.group(1), m.group(2), m.group(3), m.group(4)
    skill_name = skill_md_path.parent.name
    is_preserved = skill_name in PRESERVATION_LIST

    keys = parse_frontmatter_keys(fm_text)
    additions: list[tuple[str, str]] = []  # (key, rendered)
    summary: list[str] = []

    if "version" not in keys:
        additions.append(("version", emit_yaml_value("version", "1.0.0")))
        summary.append("version=1.0.0")

    if "kind" not in keys:
        kind = detect_kind(skill_md_path)
        additions.append(("kind", emit_yaml_value("kind", kind)))
        summary.append(f"kind={kind}")
    else:
        kind = None  # preserved as-is

    if "required_tools" not in keys:
        additions.append(("required_tools", emit_yaml_value("required_tools", [])))
        summary.append("required_tools=[]")

    # workflow-kind fields (skip for subagents per §0.3)
    actual_kind = kind if kind else ("subagent" if str(skill_md_path.relative_to(SKILLS_ROOT)).startswith("agents/") else "workflow")
    if actual_kind == "workflow":
        if "trigger_phrases" not in keys:
            phrases = lift_trigger_phrases(body)
            additions.append(("trigger_phrases", emit_yaml_value("trigger_phrases", phrases)))
            summary.append(f"trigger_phrases lifted ({len(phrases)})")
        if "stopping_points" not in keys:
            sp = detect_stopping_points(body)
            additions.append(("stopping_points", emit_yaml_value("stopping_points", sp)))
            summary.append(f"stopping_points={sp}")
        if "actions" not in keys:
            ac = detect_actions_mode(skill_md_path.parent, body)
            additions.append(("actions", emit_yaml_value("actions", ac)))
            summary.append(f"actions={ac}")

    if "imported_from" not in keys:
        additions.append((
            "imported_from",
            emit_yaml_value("imported_from", {"source": "hand-written"}),
        ))
        summary.append("imported_from.source=hand-written")

    if is_preserved:
        # add metadata.vodou.preservation_reason if not already there
        if "metadata" not in keys:
            additions.append((
                "metadata",
                emit_yaml_value("metadata", {"vodou": {"preservation_reason": "user-preserved 2026-04-25"}}),
            ))
            summary.append("metadata.vodou.preservation_reason added")

    if not additions:
        return False, ["already canonical"], None

    new_fm_text = fm_text.rstrip()
    for _, rendered in additions:
        new_fm_text += "\n" + rendered
    new_raw = fm_open + new_fm_text + fm_close + body
    return True, summary, {"new_raw": new_raw, "preserved": is_preserved}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--skill", help="migrate one skill by name")
    args = ap.parse_args()

    skill_md_files = sorted(SKILLS_ROOT.rglob("SKILL.md"))
    if args.skill:
        skill_md_files = [f for f in skill_md_files if f.parent.name == args.skill]

    changed = 0
    no_change = 0
    preserved_processed = 0
    for path in skill_md_files:
        is_changed, summary, payload = migrate_one(path)
        rel = path.relative_to(REPO_ROOT)
        if is_changed:
            changed += 1
            if payload and payload["preserved"]:
                preserved_processed += 1
            print(f"MIGRATE {rel}")
            for s in summary:
                print(f"        + {s}")
            if args.apply and payload:
                bak = path.with_suffix(".md.pre-migrate.bak")
                if not bak.exists():
                    shutil.copy2(path, bak)
                path.write_text(payload["new_raw"])
        else:
            no_change += 1

    print()
    print(f"Migrated: {changed} ({preserved_processed} preserved-list skills got minimal migration)")
    print(f"Already canonical: {no_change}")
    if not args.apply:
        print("(dry-run; pass --apply to write)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
