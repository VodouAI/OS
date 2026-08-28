#!/usr/bin/env bash
# Hermetic tests for headings.py. No network, no LLM, no writes outside $TMP.
#
# The two things that must be true:
#   1. The detector agrees with a human on the real corpus (--selftest, 20 cases).
#   2. --apply rewrites heading TEXT and NOTHING else. It runs after the
#      redaction gate, so if it could touch the body it could reintroduce a
#      finding the gate already removed. This asserts byte equality outside the
#      H2 lines, not "looks fine".
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
H="python3 $ROOT/scripts/blog/headings.py"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf 'pass  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (want $3, got $2)"; fi; }

# --- 1. calibration ----------------------------------------------------------
if $H --selftest >/dev/null 2>&1; then ok "calibration: 20/20 hand-graded cases"; else bad "calibration"; fi

# --- 2. round trip on a REAL post, diagrams and all --------------------------
SRC="$(ls "$ROOT"/content/blog/*.md 2>/dev/null | head -1)"
if [[ -n "$SRC" ]]; then
  cp "$SRC" "$TMP/post.md"; cp "$SRC" "$TMP/orig.md"
  N=$(grep -c '^## ' "$TMP/post.md" || true)
  # Deliberately specific replacements so the result is CLEAN, proving the
  # checker can be satisfied and is not simply always-red.
  : > "$TMP/new.txt"
  for i in $(seq 1 "$N"); do echo "Replacement heading number $i for cache_key drift" >> "$TMP/new.txt"; done
  if $H --apply "$TMP/post.md" "$TMP/new.txt" 2>/dev/null; then ok "apply: accepted $N replacements"; else bad "apply refused a correct count"; fi

  # THE load-bearing assertion: everything that is not an H2 line is byte-identical.
  if diff -q <(grep -v '^## ' "$TMP/orig.md") <(grep -v '^## ' "$TMP/post.md") >/dev/null; then
    ok "apply: body byte-identical outside H2 lines"
  else
    bad "apply MUTATED THE BODY"
  fi
  check "apply: fence count preserved" "$(grep -c '^```' "$TMP/post.md")" "$(grep -c '^```' "$TMP/orig.md")"
  check "apply: diagram count preserved" "$(grep -c '^```vodou-diagram' "$TMP/post.md")" "$(grep -c '^```vodou-diagram' "$TMP/orig.md")"
  check "apply: frontmatter intact" "$(head -1 "$TMP/post.md")" "---"
  check "apply: heading count unchanged" "$(grep -c '^## ' "$TMP/post.md")" "$N"

  # Count mismatch must REFUSE, not partially apply. A half-reheaded post is
  # worse than an unheaded one: the headings would no longer describe their
  # own sections.
  cp "$TMP/orig.md" "$TMP/post2.md"
  echo "only one heading" > "$TMP/short.txt"
  if $H --apply "$TMP/post2.md" "$TMP/short.txt" 2>/dev/null; then bad "apply accepted a wrong count"; else ok "apply: refuses a count mismatch"; fi
  if diff -q "$TMP/orig.md" "$TMP/post2.md" >/dev/null; then ok "apply: refusal left the file untouched"; else bad "apply damaged the file while refusing"; fi
else
  echo "skip  no posts in content/blog"
fi

# --- 3. a '## ' inside a fence is not a heading ------------------------------
cat > "$TMP/fenced.md" <<'EOF'
---
title: "Fence test"
---
## Real heading about cache_key

Body.

```bash
## this is a shell comment, not a heading
echo hi
```

## Second real heading about cache_key
EOF
check "fenced '## ' is not counted" "$($H --check "$TMP/fenced.md" "$TMP" --json | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["headings"]))')" "2"

# --- 4. duplicate detection across the corpus --------------------------------
mkdir -p "$TMP/corpus"
printf -- '---\ntitle: "A"\n---\n## The struggle\nx\n' > "$TMP/corpus/a.md"
printf -- '---\ntitle: "B"\n---\n## The Struggle:\ny\n' > "$TMP/corpus/b.md"
check "dup ignores case and punctuation" "$($H --check "$TMP/corpus/b.md" "$TMP/corpus" --json | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["dup"]))')" "1"
check "a post is not its own duplicate" "$($H --check "$TMP/corpus/a.md" "$TMP/corpus" --json | python3 -c 'import json,sys;print(len([d for d in json.load(sys.stdin)["dup"] if "a.md" in d["also_in"]]))')" "0"

# --- 5. skeleton detection: rename two, keep the shape -----------------------
mkdir -p "$TMP/skel"
printf -- '---\ntitle: "Original"\n---\n## What we built\n## The struggle\n## The general lesson\n## Where the standard approach falls short\n## What is still not solved\n' > "$TMP/skel/one.md"
printf -- '---\ntitle: "Reworded"\n---\n## What we made\n## The struggle\n## The general lesson\n## Where the standard approach falls short\n## What is still not solved\n' > "$TMP/skel/two.md"
SK=$($H --check "$TMP/skel/two.md" "$TMP/skel" --json | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["skeleton"]))')
check "skeleton survives a rename" "$SK" "1"

echo
echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
