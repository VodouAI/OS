#!/usr/bin/env bash
# install-push-guard.sh — install scripts/push-guard.sh as .git/hooks/pre-push.
#
# `.git/hooks` is NOT versioned and IS shared by every worktree of this clone, so
# one install covers every worktree — and a fresh clone has none and must run
# this again. Same footing as the pre-commit guards (CLAUDE.md "Committing from
# parallel sessions").
#
# Usage:
#   bash scripts/install-push-guard.sh          # install (refuses to clobber a
#                                               # pre-push hook it did not write)
#   bash scripts/install-push-guard.sh --force  # overwrite whatever is there
#   bash scripts/install-push-guard.sh --check  # exit 1 if not installed

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_DIR="$(git -C "$ROOT" rev-parse --git-common-dir)/hooks"
HOOK="$HOOK_DIR/pre-push"
MARKER="# installed by scripts/install-push-guard.sh"

mode="${1:-install}"

if [ "$mode" = "--check" ]; then
    if [ -f "$HOOK" ] && grep -q "push-guard.sh" "$HOOK"; then
        echo "push-guard: installed at $HOOK"
        exit 0
    fi
    echo "push-guard: NOT installed — run: bash scripts/install-push-guard.sh" >&2
    exit 1
fi

if [ -f "$HOOK" ] && ! grep -q "$MARKER" "$HOOK" && [ "$mode" != "--force" ]; then
    echo "A pre-push hook already exists and this script did not write it:" >&2
    echo "  $HOOK" >&2
    echo "Inspect it, then re-run with --force to replace it." >&2
    exit 1
fi

mkdir -p "$HOOK_DIR"
cat > "$HOOK" <<EOF
#!/bin/sh
$MARKER
ROOT="\$(git rev-parse --show-toplevel)"
# The guard lives in scripts/ so it is versioned and reviewable; the hook is a
# two-line shim that finds it. A worktree whose checkout predates the guard
# simply has nothing to run — never block a push over a missing file.
[ -f "\$ROOT/scripts/push-guard.sh" ] || exit 0
exec sh "\$ROOT/scripts/push-guard.sh" "\$@"
EOF
chmod +x "$HOOK"
echo "push-guard installed → $HOOK"
echo "  protected: main, development   bypass: VODOU_ALLOW_DIRECT_PUSH=1"
