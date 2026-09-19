#!/usr/bin/env bash
# test-push-guard.sh — proves scripts/push-guard.sh fires in BOTH directions.
#
# A guard that only ever says "no" is as useless as one that only says "yes", so
# the must-NOT-fire controls are half this file: a feature branch, a tag, and an
# empty ref list all have to pass through untouched.
#
# The empty-stdin case is here because of a real false pass on 2026-09-16: the
# first attempt to prove the guard ran `git push --dry-run origin main` while
# main was already up to date. Git had no refs to push, handed the hook an empty
# stdin, the loop read nothing, and the hook exited 0 — which read exactly like
# "the guard allowed a push to main". It had not been asked anything.
#
# Usage: bash scripts/test-push-guard.sh   (exit 0 = both directions proven)

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$ROOT/scripts/push-guard.sh"
SHA=1111111111111111111111111111111111111111
OLD=2222222222222222222222222222222222222222
ZERO=0000000000000000000000000000000000000000

pass=0; fail=0

# check <name> <expected-exit> <stdin> [env-assignment]
check() {
    local name="$1" want="$2" input="$3" envset="${4:-}"
    local got
    if [ -n "$envset" ]; then
        got=$(env "$envset" sh "$GUARD" origin https://example.invalid/repo.git <<<"$input" >/dev/null 2>&1; echo $?)
    else
        got=$(sh "$GUARD" origin https://example.invalid/repo.git <<<"$input" >/dev/null 2>&1; echo $?)
    fi
    if [ "$got" = "$want" ]; then
        echo "  ok    $name (exit $got)"
        pass=$((pass + 1))
    else
        echo "  FAIL  $name — wanted exit $want, got $got"
        fail=$((fail + 1))
    fi
}

echo "must FIRE (a direct push to a protected branch):"
check "push to main"                  1 "refs/heads/work $SHA refs/heads/main $OLD"
check "push to development"           1 "refs/heads/work $SHA refs/heads/development $OLD"
check "DELETE of main"                1 "(delete) $ZERO refs/heads/main $OLD"
check "feature + main in one push"    1 "refs/heads/work $SHA refs/heads/work $OLD
refs/heads/work $SHA refs/heads/main $OLD"

echo "must NOT fire (the intended paths):"
check "push to a feature branch"      0 "refs/heads/feat/x $SHA refs/heads/feat/x $OLD"
check "push to a fix branch"          0 "refs/heads/fix/y $SHA refs/heads/fix/y $OLD"
check "push a tag"                    0 "refs/tags/v0.6.31 $SHA refs/tags/v0.6.31 $ZERO"
check "nothing to push (empty stdin)" 0 ""
check "a branch merely NAMED main-ish" 0 "refs/heads/maintenance $SHA refs/heads/maintenance $OLD"

echo "deliberate bypass:"
check "bypass on main"                0 "refs/heads/work $SHA refs/heads/main $OLD" "VODOU_ALLOW_DIRECT_PUSH=1"

echo
echo "push-guard: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
