#!/usr/bin/env bash
# Hermetic tests for scripts/blog/dedash.py. No network, no DB, no LLM.
# Run: scripts/blog/test-dedash.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0

# check <name> <input> <expected-substring>
check() {
  local name="$1" input="$2" want="$3" f="$TMP/t.md"
  printf '%s\n' "$input" > "$f"
  python3 scripts/blog/dedash.py "$f" >/dev/null 2>&1
  if grep -qF -- "$want" "$f"; then
    PASS=$((PASS+1)); printf '  ok    %s\n' "$name"
  else
    FAIL=$((FAIL+1)); printf '  FAIL  %s\n        want: %s\n        got:  %s\n' \
      "$name" "$want" "$(cat "$f")"
  fi
}

# reject <name> <input> <substring-that-must-not-appear>
reject() {
  local name="$1" input="$2" nope="$3" f="$TMP/t.md"
  printf '%s\n' "$input" > "$f"
  python3 scripts/blog/dedash.py "$f" >/dev/null 2>&1
  if grep -qF -- "$nope" "$f"; then
    FAIL=$((FAIL+1)); printf '  FAIL  %s\n        must not contain: %s\n        got: %s\n' \
      "$name" "$nope" "$(cat "$f")"
  else
    PASS=$((PASS+1)); printf '  ok    %s\n' "$name"
  fi
}

echo "dedash tests"

# --- the six rules -----------------------------------------------------------
check "rule 6 default is a colon" \
  'The fix was one line: it unset the variable.' 'one line:'
check "rule 6 elaboration" \
  'It failed in the worst way — the log said the gate had blocked it.' \
  'worst way: the log'
check "rule 3 conjunction takes a comma" \
  'That is a lie — because nobody investigates that line.' \
  'a lie, because'
check "rule 4 short appositive takes a comma" \
  'It exits 127 now — not 2.' 'now, not 2.'
check "rule 2 paired dashes become commas" \
  'The slug rule — how a filename becomes a token — lived in three places.' \
  'rule, how a filename becomes a token, lived'
check "rule 1 numeric range becomes a hyphen" \
  'It ran 2026—2027 without a restart.' '2026-2027'
check "rule 4 does NOT splice an independent clause" \
  'A thing broke — the log lied.' 'broke: the log lied.'
check "rule 4 still commas a true appositive" \
  'It exits 127 now — not 2.' 'now, not 2.'
check "rule 5 avoids a second colon" \
  'One cause: the key was set — the daemon loads dotenv and a shell does not.' \
  'set. The daemon'

# --- the things it must never touch -----------------------------------------
reject "fenced code is evidence, not prose" \
  '```
BLOCKED — redaction gate rejected the draft
```' \
  'BLOCKED: redaction'
reject "inline code spans are untouched" \
  'Run `a — b` to see it.' '`a: b`'
reject "urls are untouched" \
  'See https://example.com/a—b for the log.' 'example.com/a: b'
check "frontmatter title is prose and IS scrubbed" \
  '---
title: "A silent failure — it looks like a feature"
slug: "a—b"
---
body' \
  'title: "A silent failure: it looks like a feature"'
reject "frontmatter slug is not prose" \
  '---
title: "x"
slug: "a—b"
---
body' \
  'slug: "a: b"'

# --- properties --------------------------------------------------------------
f="$TMP/idem.md"
printf 'A thing broke — the log lied about it, and it lied twice — badly.\n' > "$f"
python3 scripts/blog/dedash.py "$f" >/dev/null 2>&1
cp "$f" "$TMP/once.md"
python3 scripts/blog/dedash.py "$f" >/dev/null 2>&1
if cmp -s "$f" "$TMP/once.md"; then
  PASS=$((PASS+1)); echo "  ok    idempotent: a second pass changes nothing"
else
  FAIL=$((FAIL+1)); echo "  FAIL  idempotent: second pass differs"
fi

printf 'Clean prose with no long dash at all.\n' > "$TMP/c.md"
if python3 scripts/blog/dedash.py "$TMP/c.md" --check >/dev/null 2>&1; then
  PASS=$((PASS+1)); echo "  ok    --check exits 0 on clean prose"
else
  FAIL=$((FAIL+1)); echo "  FAIL  --check exits nonzero on clean prose"
fi

printf 'Dirty prose — it has one.\n' > "$TMP/d.md"
python3 scripts/blog/dedash.py "$TMP/d.md" --check >/dev/null 2>&1
if [[ $? -eq 1 ]]; then
  PASS=$((PASS+1)); echo "  ok    --check exits 1 on a dirty file"
else
  FAIL=$((FAIL+1)); echo "  FAIL  --check did not exit 1"
fi
if grep -qF -- '—' "$TMP/d.md"; then
  PASS=$((PASS+1)); echo "  ok    --check writes nothing"
else
  FAIL=$((FAIL+1)); echo "  FAIL  --check rewrote the file"
fi

echo
echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
