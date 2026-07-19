#!/usr/bin/env python3
"""
validate-skills.py — validate every SKILL.md frontmatter and actions.json
in the repo against the canonical schemas at schemas/.

Stand-in for the future `vodou-core skill validate --all --strict` (Phase 1).
Phase 0a deliverable per PLAN-SKILLS-V2.md §4.

Usage:
  python3 scripts/validate-skills.py                  # all skills, summary
  python3 scripts/validate-skills.py --strict         # exit non-zero on any failure
  python3 scripts/validate-skills.py --frontmatter    # SKILL.md frontmatter only
  python3 scripts/validate-skills.py --actions        # actions.json only
  python3 scripts/validate-skills.py --skill <name>   # one skill
"""

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMAS_DIR = REPO_ROOT / "schemas"
SKILL_SCHEMA = SCHEMAS_DIR / "skill.schema.json"
ACTIONS_SCHEMA = SCHEMAS_DIR / "actions.schema.json"
SKILLS_ROOT = REPO_ROOT / "skills"

FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)


def _import_draft7():
    """Import Draft7Validator, auto-discovering the repo-local `.venv-tools`
    venv if the system interpreter (Homebrew py3.14 is PEP-668 externally
    managed, so `pip install jsonschema` fails there) doesn't have it. Returns
    the class or None — callers degrade to a structural check rather than
    hard-exiting on a fresh clone / CI."""
    try:
        from jsonschema import Draft7Validator
        return Draft7Validator
    except ImportError:
        pass
    # Look for a repo-local tool venv (created via: python3 -m venv .venv-tools
    # && .venv-tools/bin/pip install jsonschema).
    repo_root = Path(__file__).resolve().parent.parent
    for pat in ("lib/python*/site-packages", "Lib/site-packages"):
        for sp in (repo_root / ".venv-tools").glob(pat):
            if sp.is_dir():
                sys.path.insert(0, str(sp))
                try:
                    from jsonschema import Draft7Validator
                    return Draft7Validator
                except ImportError:
                    sys.path.pop(0)
    return None


class _StructuralValidator:
    """Minimal stand-in exposing the same `iter_errors` surface as jsonschema's
    Draft7Validator, used when jsonschema isn't installed. Checks the schema's
    top-level `required` keys and each property's declared scalar `type` — enough
    to catch the common breakage (missing/mistyped frontmatter fields) without a
    dep. NOT a full Draft-7 implementation; the venv path gives that."""
    _PY = {"string": str, "number": (int, float), "integer": int,
           "boolean": bool, "array": list, "object": dict}

    def __init__(self, schema: dict):
        self.required = schema.get("required", []) or []
        self.props = schema.get("properties", {}) or {}

    def iter_errors(self, obj):
        class _E:
            def __init__(self, msg): self.message = msg; self.path = []
        if not isinstance(obj, dict):
            yield _E("expected an object"); return
        for key in self.required:
            if key not in obj:
                yield _E(f"'{key}' is a required property")
        for key, spec in self.props.items():
            if key in obj and isinstance(spec, dict) and "type" in spec:
                py = self._PY.get(spec["type"])
                if py and not isinstance(obj[key], py):
                    yield _E(f"'{key}' should be {spec['type']}")


def load_schemas():
    Draft7Validator = _import_draft7()
    if Draft7Validator is None:
        # Graceful degrade — no jsonschema anywhere (fresh clone / CI). Use the
        # structural stand-in instead of hard-exiting.
        print(
            "validate-skills: jsonschema not found — using structural checks only "
            "(required keys + scalar types).\n"
            "  For full schema validation: python3 -m venv .venv-tools && "
            ".venv-tools/bin/pip install jsonschema",
            file=sys.stderr,
        )
        skill_v = _StructuralValidator(json.loads(SKILL_SCHEMA.read_text()))
        actions_v = _StructuralValidator(json.loads(ACTIONS_SCHEMA.read_text()))
        return skill_v, actions_v
    skill_v = Draft7Validator(json.loads(SKILL_SCHEMA.read_text()))
    actions_v = Draft7Validator(json.loads(ACTIONS_SCHEMA.read_text()))
    return skill_v, actions_v


def parse_frontmatter(skill_md_path: Path) -> dict | None:
    """Tiny YAML parser for the subset of YAML that SKILL.md frontmatter actually uses.
    Stdlib only — avoids the PyYAML dep. Handles: name, description, version, kind,
    string scalars, list of strings (- "..."), nested metadata.vodou.* objects."""
    raw = skill_md_path.read_text()
    m = FRONTMATTER_RE.match(raw)
    if not m:
        return None
    fm_text = m.group(1)
    try:
        import yaml  # if available, use it
        try:
            return yaml.safe_load(fm_text)
        except yaml.YAMLError:
            # Malformed frontmatter → report as unparseable, don't crash the run.
            return None
    except ImportError:
        pass
    # fallback: tiny parser, no deps
    out: dict = {}
    stack: list[tuple[int, dict | list]] = [(0, out)]
    cur_key: str | None = None
    for line in fm_text.split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        # pop stack to current indent
        while len(stack) > 1 and indent < stack[-1][0]:
            stack.pop()
        container = stack[-1][1]
        stripped = line[indent:]
        if stripped.startswith("- "):
            value = stripped[2:].strip().strip('"').strip("'")
            if isinstance(container, list):
                container.append(value)
            elif cur_key is not None and isinstance(container, dict):
                if not isinstance(container.get(cur_key), list):
                    container[cur_key] = []
                container[cur_key].append(value)
        elif ":" in stripped:
            k, _, v = stripped.partition(":")
            k = k.strip()
            v = v.strip()
            if v == "":
                # nested
                new_container: dict | list = {}
                container[k] = new_container
                stack.append((indent + 2, new_container))
                cur_key = k
            else:
                v_clean = v.strip('"').strip("'")
                if v_clean.lower() == "true":
                    container[k] = True
                elif v_clean.lower() == "false":
                    container[k] = False
                elif v_clean.lstrip("-").isdigit():
                    container[k] = int(v_clean)
                else:
                    container[k] = v_clean
                cur_key = k
    return out


def fmt_errors(errors, max_n=3):
    msgs = [e.message for e in errors[:max_n]]
    if len(errors) > max_n:
        msgs.append(f"...and {len(errors) - max_n} more")
    return "; ".join(msgs)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--strict", action="store_true")
    ap.add_argument("--frontmatter", action="store_true", help="only validate SKILL.md frontmatter")
    ap.add_argument("--actions", action="store_true", help="only validate actions.json")
    ap.add_argument("--skill", help="validate one skill by name (parent dir name)")
    args = ap.parse_args()

    do_fm = args.frontmatter or not (args.frontmatter or args.actions)
    do_actions = args.actions or not (args.frontmatter or args.actions)

    skill_v, actions_v = load_schemas()

    skill_md_files = sorted(SKILLS_ROOT.rglob("SKILL.md"))
    actions_files = sorted(SKILLS_ROOT.rglob("actions.json"))
    actions_files = [f for f in actions_files if ".bak" not in f.name and ".disabled" not in f.name]

    if args.skill:
        skill_md_files = [f for f in skill_md_files if f.parent.name == args.skill]
        actions_files = [f for f in actions_files if f.parent.name == args.skill]

    fm_pass, fm_fail, fm_unparseable = 0, 0, 0
    fm_failures: list[tuple[Path, str]] = []
    if do_fm:
        for path in skill_md_files:
            fm = parse_frontmatter(path)
            if fm is None:
                fm_unparseable += 1
                fm_failures.append((path, "no frontmatter or unparseable"))
                continue
            errors = list(skill_v.iter_errors(fm))
            if errors:
                fm_fail += 1
                fm_failures.append((path, fmt_errors(errors)))
            else:
                fm_pass += 1

    a_pass, a_fail = 0, 0
    a_failures: list[tuple[Path, str]] = []
    if do_actions:
        for path in actions_files:
            try:
                data = json.loads(path.read_text())
            except Exception as e:
                a_fail += 1
                a_failures.append((path, f"JSON parse error: {e}"))
                continue
            errors = list(actions_v.iter_errors(data))
            if errors:
                a_fail += 1
                a_failures.append((path, fmt_errors(errors)))
            else:
                a_pass += 1

    rel = lambda p: str(p).replace(str(REPO_ROOT) + "/", "")
    if do_fm:
        print(f"SKILL.md frontmatter:  PASS={fm_pass}/{len(skill_md_files)}  "
              f"FAIL={fm_fail}  UNPARSEABLE={fm_unparseable}")
    if do_actions:
        print(f"actions.json:          PASS={a_pass}/{len(actions_files)}  FAIL={a_fail}")
    print()
    if fm_failures:
        print("Frontmatter failures:")
        for path, err in fm_failures:
            print(f"  {rel(path)}\n    {err}")
        print()
    if a_failures:
        print("actions.json failures:")
        for path, err in a_failures:
            print(f"  {rel(path)}\n    {err}")

    if args.strict and (fm_fail + fm_unparseable + a_fail) > 0:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
