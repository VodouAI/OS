#!/usr/bin/env python3
"""workspace-guard — GATE 16 of PLAN-CONTEXT-THAT-MAINTAINS-ITSELF.

    No live path reads or writes a hand-maintained workspace file.

Why this exists. The plan's target is "zero hand-maintained files", and for
bundles 1–6 it was gated on the PACKET only (`FILES_ORDER`). Then, after the
build, four files that had left the packet turned out to still have live
readers — the console scraped names out of USER.md and IDENTITY.md with a
regex, the planner concatenated USER.md + SOUL.md, and the wizard WROTE all
four at first run — and the plan's own text said "nothing reads them". That
claim shipped unexamined because nothing checked it. This does.

WHAT IS ENFORCED. A staged (or, with --audit, tracked) line in live source that
builds a path to, reads, or writes `.vodou/workspace/<NAME>.md` where NAME is
not in the GENERATED set. The generated set is what the daemon regenerates on a
clock — MEMORY.md, TOOLS.md, HEARTBEAT.md — plus AGENTS.md, the rules mirror.
Reading a generated file is fine: it is a receipt of a renderer. Reading a
hand-maintained one is a dependency on prose nobody maintains.

The escape is explicit and on the line:  // WORKSPACE-MIGRATION-SOURCE
It exists for exactly one shape — a one-time carry of an old file's values into
their new owner — and it must say so where it is used.

Usage:   scripts/workspace-guard.py            (pre-commit: staged lines)
         scripts/workspace-guard.py --audit    (whole tree)
         scripts/workspace-guard.py --audit --json   (for `vodou-core workspace retire`)
Bypass:  VODOU_SKIP_WORKSPACE_GUARD=1
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(subprocess.run(["git", "rev-parse", "--show-toplevel"],
                           capture_output=True, text=True).stdout.strip() or ".")

GENERATED = {"MEMORY.md", "TOOLS.md", "HEARTBEAT.md", "AGENTS.md"}
MARKER = "WORKSPACE-MIGRATION-SOURCE"

# Live source only. Not templates (seeds), not dist (compiled), not tests, not
# docs/JSON. (A 64-file duplicate `ExecDesk-Console/src/src/` tree that tsconfig
# excluded used to be carved out here; it was deleted on 2026-09-10.)
GRADED = ("src/", "vodou-hook/src/", "MCP-servers/Vodou-Console/src/", "MCP-servers/ExecDesk-Console/src/")
EXCLUDE = ("/__tests__/", ".test.", "/dist/", "templates/")
CODE_EXT = {".rs", ".ts", ".js", ".mjs"}
COMMENT_PREFIX = {".rs": "//", ".ts": "//", ".js": "//", ".mjs": "//"}

# A workspace file specifically — NOT any .md this tree joins a path to
# (SKILL.md, role.md and company-brief.md are not workspace files). Two idioms:
#   the literal directory:            ".vodou/workspace/USER.md"
#   a path built off the workspace:   path.join(wsDir, 'USER.md')  ws.join("USER.md")
#     where the base is one of the names this tree uses for that directory.
WS_LITERAL_RE = re.compile(r"""['"]\.vodou/workspace/([A-Za-z_][A-Za-z0-9_-]*\.md)['"]""")
# The Rust idiom: root.join(".vodou").join("workspace").join("USER.md") — the
# chained form the daemon and scheduler use. Missed by the first two patterns
# and caught by the gate-22 proof, not by review.
WS_CHAIN_RE = re.compile(r"""\.join\(\s*['"]workspace['"]\s*\)(?:\s*\.join\(\s*['"][^'"]*['"]\s*\))*?\s*\.join\(\s*['"]([A-Za-z_][A-Za-z0-9_-]*\.md)['"]\s*\)""")
WS_BASE_RE = re.compile(
    r"""\b(?:ws|wsDir|ws_root|wsRoot|workspace|workspaceDir|workspace_root|getWorkspacePath\(\))\b"""
    r"""[^'"\n]{0,60}['"]([A-Za-z_][A-Za-z0-9_-]*\.md)['"]"""
)
# The line must be DOING something with it — building a path or touching the
# file. Deleting one (unlink / remove_file) is retiring it, not depending on it.
VERB_RE = re.compile(r"\.join\(|read_to_string|readFileSync|readMd|writeFileSync|fs::write|existsSync|metadata\(|readFile\(|writeFile\(")


def graded(path: str) -> bool:
    if Path(path).suffix not in CODE_EXT:
        return False
    if not path.startswith(GRADED):
        return False
    return not any(x in path for x in EXCLUDE)


def is_comment(path: str, line: str) -> bool:
    s = line.strip()
    if not s:
        return True
    pre = COMMENT_PREFIX.get(Path(path).suffix)
    if pre and s.startswith(pre):
        return True
    return s.startswith(("*", "/*", "///", "//!", "#"))


def offending_name(path: str, line: str):
    """The hand-maintained file this line touches, or None."""
    if is_comment(path, line) or MARKER in line:
        return None
    # A pure string-list entry (`"USER.md",` in a const array) is a NAME, not a
    # read — LEGACY_FILES_ORDER and the hook's stale list live in that shape.
    if re.fullmatch(r'\s*(?:"[A-Za-z_.-]+"\s*,?\s*)+', line):
        return None
    if "include_str!" in line:      # a seed, written once at install
        return None
    if not VERB_RE.search(line):
        return None
    # Deleting a retired file is retiring it, not depending on it.
    if re.search(r"unlinkSync|remove_file|\brm\(|rmSync", line):
        return None
    for name in WS_LITERAL_RE.findall(line) + WS_BASE_RE.findall(line) + WS_CHAIN_RE.findall(line):
        if name not in GENERATED:
            return name
    return None


def staged_added():
    out = subprocess.run(["git", "diff", "--cached", "--no-color", "-U0"],
                         capture_output=True, text=True, check=False).stdout
    path = None
    for line in out.splitlines():
        if line.startswith("+++ b/"):
            path = line[6:]
        elif line.startswith("+") and not line.startswith("+++") and path:
            yield path, line[1:]


def tracked_files():
    out = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=False).stdout
    return [p for p in out.splitlines() if p]


def scan_tree():
    hits = []
    for path in tracked_files():
        if not graded(path):
            continue
        try:
            text = (ROOT / path).read_text(errors="ignore")
        except OSError:
            continue
        for n, line in enumerate(text.splitlines(), 1):
            # Rust keeps its tests inline; by this tree's convention `mod tests`
            # sits at the bottom (another test asserts it). Everything after the
            # first `#[cfg(test)]` is a fixture, not a live path.
            if path.endswith(".rs") and line.strip() == "#[cfg(test)]":
                break
            name = offending_name(path, line)
            if name:
                hits.append({"path": path, "line": n, "file": name, "text": line.strip()[:110]})
    return hits


def report(hits) -> int:
    if not hits:
        return 0
    print("workspace-guard: live code depends on a hand-maintained workspace file (GATE 16):\n", file=sys.stderr)
    for h in hits:
        print(f"  {h['path']}:{h.get('line', '?')}  → {h['file']}", file=sys.stderr)
        print(f"    {h['text']}\n", file=sys.stderr)
    print("Generated files (MEMORY.md, TOOLS.md, HEARTBEAT.md, AGENTS.md) are fine to read —", file=sys.stderr)
    print("they are receipts of a renderer. A hand-maintained one is a dependency on prose", file=sys.stderr)
    print("nobody maintains: read its OWNER instead (a setting, a pin, render()). If this is", file=sys.stderr)
    print(f"a one-time carry into that owner, say so on the line: // {MARKER}", file=sys.stderr)
    print("Bypass a true false positive with VODOU_SKIP_WORKSPACE_GUARD=1.", file=sys.stderr)
    return 1


def main() -> int:
    if os.environ.get("VODOU_SKIP_WORKSPACE_GUARD") == "1":
        return 0
    audit = "--audit" in sys.argv
    if audit:
        hits = scan_tree()
        if "--json" in sys.argv:
            print(json.dumps({"hits": hits, "generated": sorted(GENERATED)}))
            return 0
        return report(hits)
    hits = []
    for path, line in staged_added():
        if not graded(path):
            continue
        name = offending_name(path, line)
        if name:
            hits.append({"path": path, "file": name, "text": line.strip()[:110]})
    return report(hits)


if __name__ == "__main__":
    sys.exit(main())
