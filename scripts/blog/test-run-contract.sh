#!/usr/bin/env bash
# Hermetic tests for the blog pipeline's FAILURE contract. No network, no LLM,
# no daemon, no writes to content/blog.
#
# Every case here is a real 2026-08-26 incident:
#   1. an empty struggle file killed the feature lane silently, four slots in a row
#   2. a gate-blocked draft was destroyed with its temp dir
#   3. a slot that set BOTH failure flags reported only one of them
#
# Each case extracts the line/block under test FROM THE REAL SCRIPT and asserts
# the extraction found something first. An empty extraction "passes" everything,
# which is the absence-shaped metric this repo has been bitten by before.
set -uo pipefail
cd "$(dirname "$0")/../.."
PASS=0; FAIL=0
ok(){ echo "  ok   $*"; PASS=$((PASS+1)); }
no(){ echo "  FAIL $*"; FAIL=$((FAIL+1)); }

echo "1. an empty struggle file must not kill the feature lane"
LINE=$(grep -n '^STRUGGLE_N=' scripts/blog/write-feature-post.sh | head -1 | cut -d: -f2-)
if [[ -z "$LINE" ]]; then no "extraction found no STRUGGLE_N line"; else
  grep -q 'grep -c' <<<"$LINE" || no "extracted the wrong line"
  grep -q '| *head' <<<"$LINE" && no "still pipes into head — pipefail makes a zero count fatal"
  WORK=$(mktemp -d)
  for fixture in "(no struggle material found)" "### [a]
x
### [b]
y" ""; do
    printf '%s\n' "$fixture" > "$WORK/struggle.md"
    if ( set -euo pipefail; eval "$LINE"; echo "$STRUGGLE_N" ) >/dev/null 2>&1
      then ok "survives a ${#fixture}-char struggle file"
      else no "DIED on a ${#fixture}-char struggle file"; fi
  done
  rm -f "$WORK/struggle.md"
  ( set -euo pipefail; eval "$LINE" ) >/dev/null 2>&1 && ok "survives a missing struggle file" || no "DIED on a missing struggle file"
  rm -rf "$WORK"
fi

echo "2. a gate-blocked draft must be quarantined, never discarded"
for w in write-post.sh write-feature-post.sh; do
  B=$(awk '/^if \[\[ \$GATE_RC -eq 2 \]\]; then$/,/^  exit 2$/' "scripts/blog/$w")
  if ! grep -q 'mkdir -p .vodou/blog/blocked' <<<"$B"; then no "$w: no quarantine in the gate-block branch"; continue; fi
  T=$(mktemp -d); WORK="$T"; GATE_RC=2; log(){ :; }
  QDIR=$(mktemp -d); B=${B//.vodou\/blog\/blocked/$QDIR\/blocked}; B=${B/exit 2/:}
  printf -- '---\nslug: "t-%s"\n---\nnames src/daemon.rs\n' "$w" > "$T/body.md"
  ( set -euo pipefail; eval "$B
fi" ) >/dev/null 2>&1
  if grep -rq 'src/daemon.rs' "$QDIR/blocked" 2>/dev/null; then ok "$w: draft preserved with its body"; else no "$w: draft lost"; fi
  printf -- '---\ntitle: no slug\n---\nbody\n' > "$T/body.md"
  ( set -euo pipefail; eval "$B
fi" ) >/dev/null 2>&1
  ls "$QDIR"/blocked/*draft.md >/dev/null 2>&1 && ok "$w: a slugless draft still lands" || no "$w: slugless draft lost"
  rm -rf "$T" "$QDIR"
done

echo "3. a slot that fails BOTH ways must say so twice"
V=$(awk '/^if \[\[ -z "\$POST" && \$GATE_BLOCKED -eq 1 \]\]; then$/,0' scripts/blog/blog-run.sh)
if ! grep -q 'SLOT FAILED' <<<"$V" || ! grep -q 'SLOT BLOCKED' <<<"$V"; then
  no "extraction missed the verdict block"
else
  verdict(){ POST="$1" bash -c "POST=\"$1\"; WRITER_FAILED=$2; GATE_BLOCKED=$3; say(){ echo \"\$*\"; }; $V" 2>&1; echo "rc=$?"; }
  O=$(verdict "" 1 1)
  grep -q 'SLOT BLOCKED' <<<"$O" && grep -q 'SLOT FAILED' <<<"$O" && ok "both flags: both lines reported" || no "both flags: a line was swallowed"
  grep -q 'rc=3' <<<"$O" && ok "both flags: exit 3 (writer fault outranks)" || no "both flags: wrong exit code"
  O=$(verdict "" 0 1); grep -q 'rc=2' <<<"$O" && ok "gate only: exit 2" || no "gate only: wrong exit code"
  O=$(verdict "" 1 0); grep -q 'rc=3' <<<"$O" && ok "writer only: exit 3" || no "writer only: wrong exit code"
  O=$(verdict "content/blog/x.md" 0 0); grep -q 'rc=0' <<<"$O" && ok "a post was written: exit 0" || no "wrote a post but did not exit 0"
fi

echo "4. bt_mem_search degrades to [] and never kills its caller"
source scripts/blog/lib.sh
O=$( set -euo pipefail; BLOG_MEM_SEARCH_TRIES=1 bt_mem_search "zzz-no-such-token-qqq" 3 2>/dev/null )
[[ "$O" == "[]" ]] && ok "returns [] on no result" || no "returned '$O' instead of []"
( set -euo pipefail; BLOG_MEM_SEARCH_TRIES=1 bt_mem_search "zzz" 3 >/dev/null 2>&1; echo alive ) | grep -q alive \
  && ok "caller under set -e survives" || no "caller under set -e died"

echo; echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
