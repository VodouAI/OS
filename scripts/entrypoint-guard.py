#!/usr/bin/env python3
"""entrypoint-guard — a launcher that belongs to no stack fails the commit.

PLAN-SEAMS P4 / AGENTS.md lane canon rule 3: "no new port, process, or
prompt-injection site without a registry entry. Start, stop and the updater
must all know a process."

WHY THIS EXISTS

`processes.toml` (P3) says which processes exist. `stacks.toml` (P4) says which
compositions run them and WHICH FILES START each one. Both are correct today.
Neither defends itself: nothing stops the next `nohup node thing.js &` from
landing in a script no registry mentions, and that is exactly how the census
got to seven-then-thirteen launchers with nobody deciding to have thirteen.

On 2026-08-29 two Vodou-channels servers ran orphaned for fifteen hours and a
gateway served eight-hour-old code. The pid files were accurate the whole time.
The gap was never the data — it was that nothing asked.

WHAT IS ENFORCED

  A staged line that STARTS a long-lived process, in a file that no stack in
  stacks.toml names as an entrypoint.

WHAT IS DELIBERATELY NOT ENFORCED, and why it matters more than what is

  This guard MUST NOT be a grep for `nohup`. SEAMS §45 measured it: of the
  thirteen files containing that word, FOUR are prose —

      scripts/remote-spike.sh          echoes it as an instruction to a human
      scripts/gateway-memory-shipgate.py   has it in a docstring
      MCP-servers/.../job-followup.ts  mentions it in a comment
      apps/desktop/.../backend-manager.ts  describes it in a comment

  A guard that fails on documentation gets `VODOU_SKIP_`-ed within a week, and
  a skipped guard enforces nothing. So: comment lines are stripped per language,
  and a launch verb inside a quoted string that is being ECHOED or LOGGED is
  not a launch. Precision here is not politeness — it is the difference between
  a guard that survives and one that gets turned off.

Bypass a true false positive with VODOU_SKIP_ENTRYPOINT_GUARD=1, but prefer
adding the file to a stack's `entrypoints`: that is the registry doing its job.
"""

import os
import re
import subprocess
import sys
from pathlib import Path

# Two roots, deliberately. ROOT is the git work tree the STAGED FILES live in;
# REGISTRY is where stacks.toml is read from. They are the same in a real
# commit, and different under the test harness, which runs the guard from the
# real repo (so the registry is the real one) with GIT_DIR pointing at a
# throwaway sandbox (so the diff is the case's). Conflating them made every
# sandbox case pass vacuously: no stacks.toml in the sandbox means the guard
# fails open, which is correct behaviour and a useless test.
ROOT = Path(
    subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True, text=True, check=False,
    ).stdout.strip()
    or "."
)
REGISTRY = Path.cwd() if (Path.cwd() / "stacks.toml").exists() else ROOT

# Files we never grade: documentation describes launches, tests simulate them,
# and the plans are where launches get designed before they exist.
SKIP_PREFIXES = (
    "docs/", "PLANS/", "content/", ".build/publish-assets/",
    "legal/", "memory/",
    # Not-shipped console trees, excluded on the SAME precedent coherence-guard
    # states for the same two directories: `start-vodou-services.sh` boots
    # exactly one console, `MCP-servers/Vodou-Console`, and references neither
    # of these. Guarding code nobody ships is how a rule "people learn to
    # bypass" gets made. ExecDesk-Console is 398 tracked files and carries
    # doubled `src/src/` and `scripts/scripts/` paths; that is worth a decision,
    # but it is a separate one from this guard.
    "MCP-servers/ExecDesk-Console/", "MCP-servers/Vodou-Console-NEW/",
)
SKIP_MARKERS = ("__tests__", "/test/", "/tests/", ".test.", ".spec.", "node_modules/")
# A test harness for a guard necessarily CONTAINS the thing the guard blocks.
# This one caught its own fixtures on the first commit attempt, which is the
# guard working — and the reason the naming convention has to be honoured:
# `scripts/test-*.sh` and `*-test.*` are harnesses, not launchers.
TEST_NAME = re.compile(r"(?:^|/)test-[^/]+$|(?:^|/)[^/]+-test\.[^/]+$")

# The launch verbs, in an EXECUTABLE position. Each is deliberately narrow.
LAUNCHERS = (
    # `nohup cmd` — not the bare word, which is what prose contains.
    (re.compile(r"(?:^|[;&|]\s*)nohup\s+[\w./$\"']"), "nohup"),
    # launchd: registering an agent IS starting a long-lived process.
    (re.compile(r"\blaunchctl\s+(?:load|bootstrap|kickstart)\b"), "launchctl"),
    # A detached child outlives its parent by design — the one shape that can
    # orphan, because it has no stdin to read EOF from (SEAMS §42 closure).
    (re.compile(r"detached\s*:\s*true"), "detached spawn"),
)

# A launch verb inside one of these is being TALKED ABOUT, not performed.
QUOTED_SPEECH = re.compile(
    r"""(?:^|\W)(?:echo|printf|print|console\.(?:log|warn|error)|info|warn|fail|die)\b"""
)

COMMENT_PREFIX = {
    ".sh": "#", ".bash": "#", ".py": "#", ".toml": "#", ".yml": "#", ".yaml": "#",
    ".js": "//", ".mjs": "//", ".cjs": "//", ".ts": "//", ".tsx": "//", ".rs": "//",
}


def is_comment(path: str, line: str) -> bool:
    """Is this line commentary rather than code?"""
    s = line.strip()
    if not s:
        return True
    ext = Path(path).suffix
    pre = COMMENT_PREFIX.get(ext)
    if pre and s.startswith(pre):
        return True
    # Block-comment interiors and docstring bodies, without parsing either:
    # a continuation line that begins with `*` or a quote is not executable.
    if s.startswith(("*", "/*", '"""', "'''", '"', "'", "#")):
        return True
    return False


def launches(path: str, line: str):
    """The launch verb this line performs, or None if it merely mentions one."""
    if is_comment(path, line):
        return None
    for pat, name in LAUNCHERS:
        if pat.search(line):
            # `echo "... nohup ..."` names a launch for a person to run.
            if QUOTED_SPEECH.search(line):
                return None
            return name
    return None


def declared_entrypoints():
    """Every file any stack names as an entrypoint.

    Parsed line-wise rather than with a TOML library, matching how
    `stack_registry.rs` and the gateway's `laneTrustOf` read their registries:
    a guard must not fail the commit because a dependency is missing.
    """
    out = set()
    try:
        text = (REGISTRY / "stacks.toml").read_text()
    except OSError:
        return out
    inside = False
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("entrypoints"):
            inside = True
        if inside:
            for m in re.finditer(r'"([^"]+)"', s):
                v = m.group(1)
                # `launchd:com.vodou.console` and `vodou-core mcp-server` name a
                # unit and a command, not a path — they cannot be file matches.
                if not v.startswith("launchd:") and " " not in v:
                    out.add(v)
            if "]" in s:
                inside = False
    return out


def is_declared(path: str, declared: set) -> bool:
    if path in declared:
        return True
    # A stack may name the directory-level launcher (`one/cli/vodou1`) while the
    # commit touches it by an equivalent path.
    return any(path.endswith("/" + d) or d.endswith("/" + path) for d in declared)


MARKDOWN = (".md", ".mdx", ".txt", ".rst")


def is_executable_script(path: str) -> bool:
    """Is this a script a person or launchd RUNS, as opposed to module code?

    This is the whole precision of the guard, and getting it wrong in either
    direction breaks it. The first draft graded any file containing a launch
    verb and flagged 35, most of them legitimately: `Vodou-Console/src/api/
    llamacpp.ts` starts llama-server, but the CONSOLE is the entrypoint and it
    is already in the `web` stack. That child is governed by processes.toml,
    where `llamacpp` is declared — a different registry answering a different
    question.

    So an entrypoint is a file something EXECUTES: a shebang, or an executable
    bit, or a `.sh`. Module code inside a declared process is not one.
    """
    if path.endswith((".sh", ".bash", ".command")):
        return True
    f = ROOT / path
    try:
        if os.access(f, os.X_OK) and f.is_file():
            return True
        with f.open("rb") as fh:
            return fh.read(2) == b"#!"
    except OSError:
        return False


def graded(path: str) -> bool:
    if path.startswith(SKIP_PREFIXES):
        return False
    if any(m in path for m in SKIP_MARKERS):
        return False
    if TEST_NAME.search(path):
        return False
    if path.endswith(MARKDOWN):
        return False
    # A README naming a launch command is documentation wherever it lives.
    if not is_executable_script(path):
        return False
    return True


def staged_added():
    """Yield (path, line) for every added line in the staged diff."""
    out = subprocess.run(
        ["git", "diff", "--cached", "--no-color", "-U0"],
        capture_output=True, text=True, check=False,
    ).stdout
    path = None
    for line in out.splitlines():
        if line.startswith("+++ b/"):
            path = line[6:]
        elif line.startswith("+") and not line.startswith("+++") and path:
            yield path, line[1:]


def tracked_files():
    out = subprocess.run(
        ["git", "ls-files"], capture_output=True, text=True, check=False, cwd=ROOT
    ).stdout
    return [p for p in out.splitlines() if p]


def report(hits, declared) -> int:
    if not hits:
        return 0
    print("entrypoint-guard: a launcher that belongs to no stack (PLAN-SEAMS P4):\n", file=sys.stderr)
    for path, line, verb in hits:
        print(f"  {path}", file=sys.stderr)
        print(f"    {line.strip()[:100]}", file=sys.stderr)
        print(f"    ^ starts a long-lived process ({verb}), and no stack in "
              f"stacks.toml names this file as an entrypoint.\n", file=sys.stderr)
    print("Add the file to the `entrypoints` list of the stack it belongs to, or", file=sys.stderr)
    print("declare a new stack. Start, stop and the updater must all know a process", file=sys.stderr)
    print("(AGENTS.md lane canon rule 3) — a launcher no registry mentions is how", file=sys.stderr)
    print("two channels servers ran orphaned for fifteen hours.\n", file=sys.stderr)
    print(f"Declared entrypoints today: {', '.join(sorted(declared)) or '(none)'}", file=sys.stderr)
    print("Bypass a true false positive with VODOU_SKIP_ENTRYPOINT_GUARD=1.", file=sys.stderr)
    return 1


def main() -> int:
    if os.environ.get("VODOU_SKIP_ENTRYPOINT_GUARD") == "1":
        return 0
    declared = declared_entrypoints()
    if not declared:
        # Fail OPEN, loudly. A guard whose registry is missing must not block
        # every commit; but silence would let the registry stay missing.
        print("entrypoint-guard: stacks.toml declares no entrypoints — not grading.",
              file=sys.stderr)
        return 0

    audit = "--audit" in sys.argv
    hits = []
    if audit:
        for path in tracked_files():
            if not graded(path):
                continue
            try:
                text = (ROOT / path).read_text(errors="ignore")
            except OSError:
                continue
            for line in text.splitlines():
                verb = launches(path, line)
                if verb and not is_declared(path, declared):
                    hits.append((path, line, verb))
                    break
    else:
        seen = set()
        for path, line in staged_added():
            if not graded(path) or path in seen:
                continue
            verb = launches(path, line)
            if verb and not is_declared(path, declared):
                hits.append((path, line, verb))
                seen.add(path)
    return report(hits, declared)


if __name__ == "__main__":
    sys.exit(main())
