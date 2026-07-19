#!/usr/bin/env python3
"""commit-guard — pre-commit integrity check for parallel-session commits.

Why this exists (2026-07-04): multiple agent sessions work in this ONE
worktree concurrently. A session that stages a shared hot file (src/main.rs,
llm.ts) can sweep ANOTHER session's in-flight edits into its commit — commit
1b449cb captured src/main.rs with `mod context_truth;` before the module file
was committed, so HEAD didn't compile from a fresh checkout until a1127bf.

This guard checks that the COMMIT BEING BUILT (the index, not the worktree) is
internally consistent:

  1. Rust: every `mod foo;` declared in a staged .rs file must resolve to a
     file present in the index (staged or already tracked). If the file exists
     only in the worktree, that's the collision signature — another session's
     uncommitted module — and the commit is blocked.
  2. TypeScript (gateway): every relative `./x.js` import in a staged .ts file
     under MCP-servers/*/src must resolve to a .ts/.tsx source in the index.

Fast: index listings only, no compiler. Bypass for emergencies:
  VODOU_SKIP_COMMIT_GUARD=1 git commit ...   (or git commit --no-verify)

Installed as .git/hooks/pre-commit (shim). Source of truth: scripts/commit-guard.py.
"""

import os
import re
import subprocess
import sys


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], capture_output=True, text=True, check=False
    ).stdout


def main() -> int:
    if os.environ.get("VODOU_SKIP_COMMIT_GUARD") == "1":
        return 0

    staged = [f for f in git("diff", "--cached", "--name-only", "--diff-filter=ACMR").splitlines() if f]
    if not staged:
        return 0

    # Full index (tracked + staged-new) — the file set the commit's tree can rely on.
    index = set(git("ls-files", "--cached").splitlines())

    problems: list[str] = []

    # ── 1. Rust module integrity ─────────────────────────────────────────────
    mod_re = re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([a-z0-9_]+)\s*;", re.M)
    for f in staged:
        if not f.endswith(".rs"):
            continue
        content = git("show", f":{f}")  # staged version, not worktree
        base = os.path.dirname(f)
        # main.rs / lib.rs / mod.rs resolve siblings in their own dir;
        # a non-mod.rs file foo.rs resolves children in foo/.
        stem = os.path.splitext(os.path.basename(f))[0]
        if stem in ("main", "lib", "mod"):
            child_dir = base
        else:
            child_dir = os.path.join(base, stem)
        for mod in mod_re.findall(content):
            candidates = [
                os.path.join(child_dir, f"{mod}.rs"),
                os.path.join(child_dir, mod, "mod.rs"),
            ]
            if any(c in index for c in candidates):
                continue
            in_worktree = any(os.path.exists(c) for c in candidates)
            if in_worktree:
                problems.append(
                    f"{f}: declares `mod {mod};` but {candidates[0]} is not staged/tracked "
                    f"— it EXISTS in the worktree (another session's in-flight file?). "
                    f"Stage it too, or don't commit this declaration."
                )
            else:
                problems.append(
                    f"{f}: declares `mod {mod};` but no {candidates[0]} exists anywhere — "
                    f"this commit cannot compile."
                )

    # ── 2. Gateway TS relative-import integrity ──────────────────────────────
    import_re = re.compile(r"""from\s+['"](\.{1,2}/[^'"]+)\.js['"]""")
    for f in staged:
        if not (f.endswith(".ts") and "/src/" in f and f.startswith("MCP-servers/")):
            continue
        content = git("show", f":{f}")
        base = os.path.dirname(f)
        for rel in import_re.findall(content):
            target = os.path.normpath(os.path.join(base, rel))
            candidates = [f"{target}.ts", f"{target}.tsx", os.path.join(target, "index.ts")]
            if any(c in index for c in candidates):
                continue
            in_worktree = any(os.path.exists(c) for c in candidates)
            where = (
                "exists in the worktree but is not staged/tracked (parallel-session sweep?)"
                if in_worktree
                else "does not exist"
            )
            problems.append(f"{f}: imports '{rel}.js' but {candidates[0]} {where}.")

    if problems:
        sys.stderr.write(
            "\ncommit-guard: this commit's tree is not self-consistent — refusing.\n"
            "(Parallel sessions share this worktree; see CLAUDE.md 'Committing from parallel sessions'.)\n\n"
        )
        for p in problems:
            sys.stderr.write(f"  ✗ {p}\n")
        sys.stderr.write(
            "\nFix: stage the missing file(s) as part of this commit, or unstage the sweep.\n"
            "Bypass (emergencies only): VODOU_SKIP_COMMIT_GUARD=1 git commit ... or --no-verify\n\n"
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
