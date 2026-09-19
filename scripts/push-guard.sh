#!/bin/sh
# push-guard — a direct push to a protected branch is refused; changes reach it
# through a pull request.
#
# Installed as `.git/hooks/pre-push`. Git runs it with the remote name and URL as
# $1/$2, and one line per ref on stdin:
#
#     <local ref> <local sha> <remote ref> <remote sha>
#
# Asked for 2026-09-16, the day a session fast-forwarded `main` and pushed 55
# commits — its own work plus four other sessions' in-flight commits — straight
# to the dev repo. Nothing was wrong with the commits; the problem is that no one
# else got to see them first, and `main` is what releases are cut from.
#
# `.git/hooks` is NOT versioned and IS shared by every worktree of this clone, so
# this file lives in `scripts/` and is installed by
# `scripts/install-push-guard.sh`. One install covers every worktree; a fresh
# clone has no hooks at all and must run the installer again (same footing as the
# pre-commit guards — see CLAUDE.md "Committing from parallel sessions").
#
# Bypass, for the rare deliberate case (a release tag push, a hotfix nobody can
# review because the repo is on fire):
#
#     VODOU_ALLOW_DIRECT_PUSH=1 git push origin main
#
# Bypassing is a decision to skip review, not a formality — say so in the PR or
# the commit that follows.

PROTECTED="refs/heads/main refs/heads/development"

if [ "${VODOU_ALLOW_DIRECT_PUSH:-0}" = "1" ]; then
    echo "push-guard: bypassed (VODOU_ALLOW_DIRECT_PUSH=1) — pushing directly." >&2
    exit 0
fi

remote_name="$1"
status=0

while read -r _local_ref local_sha remote_ref _remote_sha; do
    [ -z "$remote_ref" ] && continue
    for protected in $PROTECTED; do
        [ "$remote_ref" = "$protected" ] || continue
        branch="${remote_ref#refs/heads/}"
        current="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
        echo "" >&2
        echo "push-guard: REFUSING a direct push to '$branch' on '$remote_name'." >&2
        echo "  $branch is what releases are cut from, and several sessions share" >&2
        echo "  this clone — a direct push publishes whatever else is on the branch." >&2
        echo "" >&2
        if [ "$local_sha" = "0000000000000000000000000000000000000000" ]; then
            echo "  (this push would DELETE the remote branch)" >&2
        else
            echo "  Open a pull request instead:" >&2
            echo "    git push -u origin $current" >&2
            echo "    gh pr create --base $branch --head $current --fill" >&2
        fi
        echo "" >&2
        echo "  Deliberate exception: VODOU_ALLOW_DIRECT_PUSH=1 git push …" >&2
        echo "" >&2
        status=1
    done
done

exit $status
