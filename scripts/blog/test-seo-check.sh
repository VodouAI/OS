#!/usr/bin/env bash
# Hermetic tests for seo-check.py, plus a REPORT on the live corpus.
#
# Two jobs, deliberately not the same job:
#
#   1. The selftest is a GATE. 28 hand-built cases, no filesystem, no network,
#      no LLM. If it fails, the checker is broken and this script exits 1.
#   2. The corpus run is a REPORT. It prints what the published posts actually
#      score and does NOT fail on their findings. When this file was written,
#      four posts shipped descriptions at 212/186/179/172; making that a red
#      test would have meant a file that is red on the day it lands, which is
#      how a test gets ignored. The corpus number is here to be READ.
#      (The one thing it does assert is that every post PARSES: a corpus-wide
#      'desc-missing' would look like a content problem and be a checker bug.)
#
# The exit-code contract itself is a gate though, because both writers depend
# on it: a warning must exit 0, a hard finding must exit 1, and a broken
# invocation must exit 2. If those three drift, the writers stop warning or
# start dying.
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
S="python3 $ROOT/scripts/blog/seo-check.py"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf 'pass  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (want $3, got $2)"; fi; }

# post <file> <title> <description> [tags]
post() {
  local f="$1" t="$2" d="$3" tg="${4:-[a, b]}"
  printf -- '---\ntitle: "%s"\ndescription: "%s"\nslug: "s"\ntags: %s\n---\nbody text\n' \
    "$t" "$d" "$tg" > "$f"
}
rep() { python3 -c "import sys;print(sys.argv[1]*int(sys.argv[2]))" "$1" "$2"; }

echo "== 1. selftest (the gate) =="
if $S --selftest; then ok "selftest: all cases"; else bad "selftest"; fi

echo
echo "== 2. exit-code contract (what the writers depend on) =="
mkdir -p "$TMP/c"
post "$TMP/c/clean.md" "A clean short title" "$(rep x 150)"
$S --check "$TMP/c/clean.md" >/dev/null 2>&1
check "clean post exits 0" "$?" "0"

post "$TMP/c/warnonly.md" "$(rep t 61)" "$(rep y 165)"
$S --check "$TMP/c/warnonly.md" >/dev/null 2>&1
check "warnings only still exit 0" "$?" "0"

post "$TMP/c/hard.md" "A title" "$(rep z 200)"
$S --check "$TMP/c/hard.md" >/dev/null 2>&1
check "a hard finding exits 1" "$?" "1"

$S --check "$TMP/c/does-not-exist.md" >/dev/null 2>&1
check "an unreadable file exits 2" "$?" "2"

$S --check >/dev/null 2>&1
check "no files exits 2" "$?" "2"

$S >/dev/null 2>&1
check "no mode exits 2" "$?" "2"

echo
echo "== 3. it reports, it never rewrites =="
post "$TMP/c/frozen.md" "A title" "$(rep z 200)"
cp "$TMP/c/frozen.md" "$TMP/c/frozen.orig"
$S --check "$TMP/c/frozen.md" >/dev/null 2>&1
if diff -q "$TMP/c/frozen.md" "$TMP/c/frozen.orig" >/dev/null; then
  ok "a failing post is byte-identical after --check"
else
  bad "--check MUTATED THE FILE"
fi
if $S --apply "$TMP/c/frozen.md" >/dev/null 2>&1; then
  bad "--apply exists (it must not: rewriting a published claim is out of scope)"
else
  ok "--apply does not exist"
fi

echo
echo "== 4. one line per problem, naming the file =="
# Captured ONCE into a variable rather than re-run into `grep -q`. Under
# `pipefail`, grep -q exits on the first match, the checker takes SIGPIPE, and
# the pipeline reports failure for output that was actually correct. That cost
# two false FAILs on the first run of this file.
OUT=$($S --check "$TMP/c/hard.md" 2>&1)
check "the failing file is named on its finding line" \
  "$(printf '%s\n' "$OUT" | grep -cF "$TMP/c/hard.md")" "1"
case "$OUT" in *desc-long*) ok "the finding carries its code" ;;
              *) bad "no code on the finding line" ;; esac
case "$OUT" in *"200 chars"*) ok "the finding carries the measured length" ;;
              *) bad "no measured length on the finding line" ;; esac

echo
echo "== 5. --json is parseable and agrees with the text output =="
J=$($S --check "$TMP/c/hard.md" --json 2>/dev/null)
check "json hard count" "$(printf '%s' "$J" | python3 -c 'import json,sys;print(json.load(sys.stdin)["hard"])')" "1"
check "json ok flag" "$(printf '%s' "$J" | python3 -c 'import json,sys;print(json.load(sys.stdin)["ok"])')" "False"
check "json description_len" "$(printf '%s' "$J" | python3 -c 'import json,sys;print(json.load(sys.stdin)["posts"][0]["description_len"])')" "200"
# The rendered title is the frontmatter title plus " · Chad Priest" (14 chars),
# which is the string Google actually truncates.
RT=$(printf '%s' "$J" | python3 -c 'import json,sys;d=json.load(sys.stdin)["posts"][0];print(d["title_rendered_len"]-d["title_len"])')
check "rendered title adds the site suffix" "$RT" "14"

echo
echo "== 6. duplicates need two posts to exist =="
mkdir -p "$TMP/d"
post "$TMP/d/a.md" "Title one here" "$(rep q 120)"
post "$TMP/d/b.md" "Title two here" "$(rep q 120)"
DUP=$($S --check "$TMP/d/a.md" "$TMP/d/b.md" --json | python3 -c \
  'import json,sys;print(sum(1 for p in json.load(sys.stdin)["posts"] for f in p["findings"] if f["code"]=="desc-dup"))')
check "a shared description is flagged on both posts" "$DUP" "2"
SOLO=$($S --check "$TMP/d/a.md" --json | python3 -c \
  'import json,sys;print(sum(1 for p in json.load(sys.stdin)["posts"] for f in p["findings"] if f["code"].endswith("-dup")))')
check "a post checked alone is not its own duplicate" "$SOLO" "0"

echo
echo "== 7. THE LIVE CORPUS (a report, not a gate) =="
shopt -s nullglob
CORPUS=("$ROOT"/content/blog/*.md)
shopt -u nullglob
if (( ${#CORPUS[@]} == 0 )); then
  echo "skip  no posts in content/blog"
else
  $S --check "${CORPUS[@]}"
  CRC=$?
  echo
  echo "corpus exit code: $CRC  (1 = at least one published post is over the hard limit)"
  echo "REPORTED, not enforced: rewriting a description that is already published,"
  echo "indexed and in llms-full.txt is a human's call, not a script's."
  # What IS enforced: the checker must be able to read every post. A parse
  # failure would show up as a corpus-wide 'desc-missing', which would look
  # like a content problem and be a checker bug.
  MISSING=$($S --check "${CORPUS[@]}" --json | python3 -c \
    'import json,sys;print(sum(1 for p in json.load(sys.stdin)["posts"] for f in p["findings"] if f["code"] in ("desc-missing","title-missing")))')
  check "every published post parses (0 missing title/description)" "$MISSING" "0"
fi

echo
echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
