#!/usr/bin/env bash
# Hermetic tests for the 1-in-3 sell rotation. No network, no LLM, no writes to
# content/blog or the real ledger.
#
# The rotation is an absence-shaped feature: if the angle never reaches a
# writer, every post is a teach post and nothing looks broken. So this checks
# the decision AND that each hop (runner -> writer -> prompt -> rubric ->
# revision -> ledger) is actually wired, not just that the helper exists.
set -uo pipefail
cd "$(dirname "$0")/../.."
source scripts/blog/lib.sh
PASS=0; FAIL=0
ok(){ echo "  ok   $*"; PASS=$((PASS+1)); }
no(){ echo "  FAIL $*"; FAIL=$((FAIL+1)); }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

ledger() {   # ledger <angles...>   ("-" = legacy entry with no angle)
  python3 - "$T/l.json" "$@" <<'PY'
import json, sys
out, angles = sys.argv[1], sys.argv[2:]
json.dump({"published": [({} if a == "-" else {"angle": a}) for a in angles]}, open(out, "w"))
PY
}
expect() {   # expect <want> <desc> <angles...>
  local want="$1" desc="$2"; shift 2
  ledger "$@"
  local got; got=$(unset BLOG_ANGLE; bt_blog_angle "$T/l.json")
  [[ "$got" == "$want" ]] && ok "$desc -> $got" || no "$desc: wanted $want, got '$got'"
}

echo "1. the cadence"
expect sell  "empty ledger"
expect sell  "only legacy posts (first post after deploy sells)" - - - -
expect teach "a sell was the last post" - sell
expect teach "one teach since the last sell" sell teach
expect sell  "two teach since the last sell" sell teach teach
expect teach "right after the 3rd-slot sell" sell teach teach sell
ledger sell teach teach
got=$(unset BLOG_ANGLE; BLOG_SELL_EVERY=0 bt_blog_angle "$T/l.json"); [[ "$got" == teach ]] && ok "BLOG_SELL_EVERY=0 disables" || no "BLOG_SELL_EVERY=0 gave $got"
got=$(unset BLOG_ANGLE; BLOG_SELL_EVERY=2 bt_blog_angle "$T/l.json"); [[ "$got" == sell ]] && ok "BLOG_SELL_EVERY=2 honoured" || no "BLOG_SELL_EVERY=2 gave $got"
got=$(BLOG_ANGLE=teach bt_blog_angle "$T/l.json"); [[ "$got" == teach ]] && ok "BLOG_ANGLE=teach forces" || no "BLOG_ANGLE=teach gave $got"
got=$(unset BLOG_ANGLE; bt_blog_angle "$T/missing.json"); [[ "$got" == sell ]] && ok "missing ledger degrades to a valid angle" || no "missing ledger gave '$got'"
printf 'not json' > "$T/bad.json"
got=$(unset BLOG_ANGLE; bt_blog_angle "$T/bad.json"); [[ "$got" =~ ^(sell|teach)$ ]] && ok "corrupt ledger still yields one word ($got)" || no "corrupt ledger gave '$got'"

echo "2. ten simulated slots produce exactly the 1-in-3 pattern"
: > "$T/seq"; ledger
for i in $(seq 1 9); do
  a=$(unset BLOG_ANGLE; bt_blog_angle "$T/l.json")
  printf '%s ' "$a" >> "$T/seq"
  python3 - "$T/l.json" "$a" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["published"].append({"angle": sys.argv[2]}); json.dump(d, open(sys.argv[1], "w"))
PY
done
[[ "$(cat "$T/seq")" == "sell teach teach sell teach teach sell teach teach " ]] && ok "$(cat "$T/seq")" || no "sequence was: $(cat "$T/seq")"

echo "3. prompt, rubric, revision and CTA helpers"
for w in write-post.sh write-feature-post.sh; do
  marker=$(grep -o 'SELL_RULES\{0,1\}_HERE' "scripts/blog/$w" | head -1)
  [[ -n "$marker" ]] || { no "$w has no sell marker"; continue; }
  printf 'before\n%s\nafter\n' "$marker" > "$T/p"
  BLOG_ANGLE=sell bt_sell_rules "$T/p" "$marker" "TEACH" && grep -q 'THIS IS A SELL POST' "$T/p" && ! grep -q "$marker" "$T/p" \
    && ok "$w: sell prompt carries the brief" || no "$w: sell brief not injected"
  printf 'before\n%s\nafter\n' "$marker" > "$T/p"
  BLOG_ANGLE=teach bt_sell_rules "$T/p" "$marker" "TEACH" && grep -q '^TEACH$' "$T/p" && ! grep -q 'SELL POST' "$T/p" \
    && ok "$w: teach prompt keeps its own rule" || no "$w: teach prompt wrong"
  c=$(grep -c 'bt_sell_rules "\$WORK/draft.prompt"\|bt_sell_rubric_note\|bt_sell_revise_rule\|bt_ensure_cta "\$WORK/body.md"\|"angle": os.environ.get("BLOG_ANGLE"' "scripts/blog/$w")
  [[ "$c" -ge 6 ]] && ok "$w: all six hops wired ($c)" || no "$w: only $c of 6 hops wired"
done
[[ -n "$(BLOG_ANGLE=sell bt_sell_rubric_note)" && -z "$(BLOG_ANGLE=teach bt_sell_rubric_note)" ]] && ok "rubric note only on sell" || no "rubric note gating wrong"
[[ -n "$(BLOG_ANGLE=sell bt_sell_revise_rule)" && -z "$(BLOG_ANGLE=teach bt_sell_revise_rule)" ]] && ok "revise rule only on sell" || no "revise rule gating wrong"
printf 'body\n' > "$T/b"; BLOG_ANGLE=teach bt_ensure_cta "$T/b" >/dev/null
grep -q vodou.ai "$T/b" && no "teach post got a CTA" || ok "teach post left alone"
BLOG_ANGLE=sell bt_ensure_cta "$T/b" >/dev/null
[[ $(grep -c '](https://vodou.ai' "$T/b") -eq 1 ]] && ok "sell post without a link gets one" || no "CTA not appended"
BLOG_ANGLE=sell bt_ensure_cta "$T/b" >/dev/null
[[ $(grep -c '](https://vodou.ai' "$T/b") -eq 1 ]] && ok "an existing link is not doubled" || no "CTA appended twice"
python3 scripts/blog/redaction-gate.py "$T/b" >/dev/null 2>&1 && ok "the appended CTA passes the redaction gate" || no "redaction gate rejects the fixed CTA"

echo "4. the runner hands the angle to the writers"
grep -q 'BLOG_ANGLE=\$(bt_blog_angle' scripts/blog/blog-run.sh && grep -q 'export BLOG_ANGLE' scripts/blog/blog-run.sh \
  && ok "blog-run.sh decides and exports" || no "blog-run.sh does not export the angle"

echo; echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
