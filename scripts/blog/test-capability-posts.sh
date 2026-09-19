#!/usr/bin/env bash
# Hermetic tests for the capability list and the rule that travels with it:
# every post about a Vodou capability links to vodou.ai signup and carries custom
# graphics. No network, no LLM, no writes to content/blog or the real ledger.
#
# Both halves of the rule are absence-shaped: a post with no link and no figure
# looks exactly like a normal post, so nothing would ever look broken. So this
# checks the decisions AND that each hop is wired into the writer and runner.
set -uo pipefail
cd "$(dirname "$0")/../.."
PASS=0; FAIL=0
ok(){ echo "  ok   $*"; PASS=$((PASS+1)); }
no(){ echo "  FAIL $*"; FAIL=$((FAIL+1)); }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
CAP="python3 scripts/blog/capabilities.py"
DIA="python3 scripts/blog/diagrams.py"
TODAY=$(date +%Y-%m-%d)

echo "1. the list itself"
if python3 - > "$T/list.out" 2>&1 <<'PY'
import json, os
d = json.load(open("scripts/blog/capabilities.json"))
caps, errs = d["capabilities"], []
ids = [c["id"] for c in caps]
if len(ids) != len(set(ids)): errs.append("duplicate ids")
for c in caps:
    for k in ("id", "name", "headline", "order", "status", "eligible", "pitch", "limits",
              "docs", "public_paths", "keywords", "infographic", "cta"):
        if k not in c: errs.append(f"{c.get('id')}: missing {k}")
    for p in c.get("docs", []) + c.get("public_paths", []):
        if p.startswith("src/"): errs.append(f"{c['id']}: engine path {p} (proprietary, never listed)")
        if not os.path.exists(p): errs.append(f"{c['id']}: path does not exist: {p}")
    if c.get("eligible"):
        if not c.get("pitch") or not c.get("cta"): errs.append(f"{c['id']}: eligible without pitch/cta")
        if c.get("status") not in ("shipped", "partial"): errs.append(f"{c['id']}: eligible but {c.get('status')}")
        if len(c.get("keywords", [])) < 2: errs.append(f"{c['id']}: fewer than 2 keywords, match can never pick it")
    for k in ("pitch", "cta", "limits", "name"):
        if "\u2014" in (c.get(k) or ""): errs.append(f"{c['id']}: em dash in {k}")
    ig = c.get("infographic")
    if ig:
        if not os.path.exists("blog-site/public/img/infographics/" + ig["file"]):
            errs.append(f"{c['id']}: infographic {ig['file']} not in blog-site/public")
        if len(ig.get("alt", "")) < 20: errs.append(f"{c['id']}: infographic alt too short")
print("\n".join(errs))
print(f"{len(caps)} capabilities, {sum(1 for c in caps if c.get('headline'))} headline, "
      f"{sum(1 for c in caps if c.get('eligible'))} eligible")
raise SystemExit(1 if errs else 0)
PY
then ok "$(tail -1 "$T/list.out")"; else no "list problems:"; sed 's/^/         /' "$T/list.out"; fi
for id in cloud-teams alternate-shells; do
  python3 -c "import json;c=[x for x in json.load(open('scripts/blog/capabilities.json'))['capabilities'] if x['id']=='$id'][0];raise SystemExit(0 if not c['eligible'] else 1)" \
    && ok "$id is never eligible" || no "$id is eligible"
done

echo "2. next: headline first, skips what is covered, respects the daily cap"
mkdir -p "$T/blog"
ledger(){ python3 -c "import json,sys; json.dump({'published':[json.loads(a) for a in sys.argv[2:]]}, open(sys.argv[1],'w'))" "$T/l.json" "$@"; }
nxt(){ $CAP next --ledger "$T/l.json" --blogdir "$T/blog" --out "$T/n.json" --today "$TODAY" --per-day "${1:-1}" 2>/dev/null; }
ledger
[[ "$(nxt)" == "local-memory" ]] && ok "empty history -> local-memory" || no "empty history gave '$(nxt)'"
ledger '{"post_mode":"capability","capability_id":"local-memory"}'
[[ "$(nxt)" == "browser-bridge" ]] && ok "covered in the ledger -> next headline" || no "gave '$(nxt)'"
printf -- '---\ntitle: x\nfeature: "capability-browser-bridge"\n---\nbody\n' > "$T/blog/2020-01-01-x.md"
[[ "$(nxt)" == "auto-capture" ]] && ok "covered by a file on disk (lost ledger) -> skipped" || no "gave '$(nxt)'"
ledger '{"post_mode":"feature","capability_id":"local-memory"}'
[[ "$(nxt)" == "local-memory" ]] && ok "a mined launch post that matched does NOT cover the capability" || no "gave '$(nxt)'"
printf -- '---\ntitle: y\nfeature: "capability-skills"\n---\nbody\n' > "$T/blog/$TODAY-y.md"
[[ -z "$(nxt 1)" ]] && ok "today's quota used -> nothing" || no "quota ignored: '$(nxt 1)'"
[[ -n "$(nxt 2)" ]] && ok "BLOG_CAPABILITY_PER_DAY=2 allows a second" || no "per-day 2 gave nothing"
rm -f "$T/blog/$TODAY-y.md"
python3 - "$T/l.json" <<'PY'
import json, sys
caps = json.load(open("scripts/blog/capabilities.json"))["capabilities"]
json.dump({"published": [{"post_mode": "capability", "capability_id": c["id"]} for c in caps if c["eligible"]]},
          open(sys.argv[1], "w"))
PY
[[ -z "$(nxt)" ]] && ok "everything covered -> nothing (ineligible never picked)" || no "gave '$(nxt)' with all covered"
ledger; nxt >/dev/null
python3 - "$T/n.json" <<'PY' && ok "writer JSON: key, capability_id, commits, no engine paths" || no "writer JSON malformed"
import json, sys
f = json.load(open(sys.argv[1]))
assert f["feature_key"] == "capability-local-memory" and f["capability_id"] == "local-memory"
assert all(not p.startswith("src/") for p in f["files_touched"])
assert isinstance(f["commits"], list) and len(f["commits"]) == len(f["commit_shas"])
PY

echo "3. match: a mined feature finds its capability"
printf '{"feature_key":"router-x","scope":"router","title":"hold the auto-route when a sentence describes a workflow","commits":[{"subject":"feat(router): hold the auto-route (D1)"}],"files_touched":["src/intent_signal.rs"]}' > "$T/f.json"
[[ "$($CAP match --feature-json "$T/f.json")" == "routing" ]] && ok "router feature -> routing" || no "router feature -> '$($CAP match --feature-json "$T/f.json")'"
printf '{"feature_key":"qq","scope":"zz","title":"frobnicate the widget","commits":[],"files_touched":[]}' > "$T/f2.json"
[[ -z "$($CAP match --feature-json "$T/f2.json")" ]] && ok "unrelated feature -> no capability" || no "unrelated matched"
printf '{"feature_key":"capability-board","capability_id":"board"}' > "$T/f3.json"
[[ "$($CAP match --feature-json "$T/f3.json")" == "board" ]] && ok "capability_id wins" || no "capability_id ignored"

echo "4. ensure and check"
post(){ printf -- '---\ntitle: "t"\ndescription: "d"\nslug: "s"\n---\n\nOpening paragraph.\n\n## What the thing does\n\nFirst paragraph of the section,\nstill the same paragraph.\n\n%s\n\nSecond paragraph.\n' "$1" > "$2"; }
DIAG=$'```vodou-diagram\n{"type":"timeline","alt":"Three stages of the build","events":[{"when":"d1","label":"start"}]}\n```'
post "" "$T/p0.md"
$CAP check "$T/p0.md" --mode feature > "$T/c0" 2>&1; rc=$?
[[ $rc -ne 0 ]] && grep -q 'signup' "$T/c0" && grep -q 'figure' "$T/c0" && ok "no link and no figure -> refused, both named" || no "check passed a bare post: $(cat "$T/c0")"
post "$DIAG" "$T/p1.md"
$CAP check "$T/p1.md" --mode feature >/dev/null 2>&1 && no "a post with no signup link passed" || ok "figure but no signup link -> refused"
$CAP ensure "$T/p1.md" --mode feature --id routing --campaign routing >/dev/null
$CAP ensure "$T/p1.md" --mode feature --id routing --campaign routing >/dev/null
[[ $(grep -c 'vodou.ai/register' "$T/p1.md") -eq 1 ]] && ok "ensure appends the link once, and only once" || no "link count $(grep -c 'vodou.ai/register' "$T/p1.md")"
grep -q 'utm_medium=feature&utm_campaign=routing' "$T/p1.md" && ok "link carries utm source/medium/campaign" || no "utm missing"
grep -q '^## Try\|^## .*Vodou' "$T/p1.md" && no "CTA added a heading (headings.py would flag it on every post)" || ok "CTA is a paragraph, not a heading"
grep -q $'\u2014' "$T/p1.md" && no "CTA contains an em dash" || ok "CTA has no em dash"
$CAP check "$T/p1.md" --mode feature >/dev/null 2>&1 && ok "after ensure the post passes" || no "still refused after ensure"
grep -q '^infographics' "$T/p1.md"; ! grep -q 'img/infographics' "$T/p1.md" && ok "feature mode never forces an infographic" || no "feature mode inserted an infographic"
post "$DIAG" "$T/p2.md"
$CAP ensure "$T/p2.md" --mode capability --id local-memory --campaign local-memory >/dev/null
$CAP ensure "$T/p2.md" --mode capability --id local-memory --campaign local-memory >/dev/null
[[ $(grep -c 'img/infographics/vodou-owns-your-memory.jpg' "$T/p2.md") -eq 1 ]] && ok "capability mode inserts its infographic exactly once" || no "infographic count wrong"
python3 - "$T/p2.md" <<'PY' && ok "infographic lands under the section's first paragraph, not between heading and text" || no "infographic placed wrong"
import sys
L = open(sys.argv[1]).read().split("\n")
i = next(n for n, l in enumerate(L) if "img/infographics" in l)
h = next(n for n, l in enumerate(L) if l.startswith("## "))
assert i > h + 2 and "still the same paragraph." in L[i - 2], L[h:i + 1]
PY
$CAP check "$T/p2.md" --mode capability --id local-memory >/dev/null 2>&1 && ok "capability post passes" || no "capability post refused"
post "$DIAG" "$T/p3.md"; $CAP ensure "$T/p3.md" --mode capability --id local-memory --campaign x >/dev/null
python3 -c "import sys;p=sys.argv[1];s=open(p).read().replace('![Infographic','![Infographix');open(p,'w').write(s.replace('vodou-owns-your-memory.jpg','nope.jpg'))" "$T/p3.md"
$CAP check "$T/p3.md" --mode capability --id local-memory > "$T/c3" 2>&1
grep -q 'would 404' "$T/c3" && grep -q 'infographic .* missing' "$T/c3" && ok "a hallucinated /img URL and a missing infographic are both refused" || no "$(cat "$T/c3")"
post "$DIAG"$'\n\n![A stock photo of a robot brain](https://example.com/robot.png)' "$T/p4.md"; $CAP ensure "$T/p4.md" --mode feature >/dev/null
$CAP check "$T/p4.md" --mode feature > "$T/c4" 2>&1 && no "foreign image passed" || { grep -q 'not one of ours' "$T/c4" && ok "an outside image is refused" || no "$(cat "$T/c4")"; }
post $'```md\n[x](https://vodou.ai/register)\n```\n\n'"$DIAG" "$T/p5.md"
$CAP check "$T/p5.md" --mode feature >/dev/null 2>&1 && no "a link inside a code fence counted" || ok "a link inside a code fence does not count"
GATEFAIL=""
for id in $(python3 -c "import json;print(' '.join(c['id'] for c in json.load(open('scripts/blog/capabilities.json'))['capabilities'] if c['eligible']))"); do
  post "$DIAG" "$T/g.md"; $CAP ensure "$T/g.md" --mode capability --id "$id" --campaign "$id" >/dev/null
  python3 scripts/blog/redaction-gate.py "$T/g.md" >/dev/null 2>&1 || GATEFAIL="$GATEFAIL $id"
done
[[ -z "$GATEFAIL" ]] && ok "every capability's fixed CTA and infographic pass the redaction gate" || no "redaction gate rejects the fixed text for:$GATEFAIL"

echo "5. diagrams.py"
printf -- '---\ntitle: t\n---\n\n## A\n\npara\n\n```vodou-diagram\n{"type":"flow","alt":"ghost edge here","nodes":[{"id":"a","label":"A"}],"edges":[{"from":"a","to":"zz"}]}\n```\n\n```vodou-diagram\nnot json\n```\n\n%s\n' "$DIAG" > "$T/d.md"
[[ "$($DIA validate "$T/d.md" 2>/dev/null)" == "1" && "$($DIA count "$T/d.md")" == "1" ]] && ok "validate drops a ghost edge and bad JSON, keeps the good one" || no "validate kept $($DIA count "$T/d.md")"
printf -- '---\ntitle: t\n---\n\n## First\n\none\n\n## Second section\n\ntwo\n' > "$T/i.md"
printf 'AFTER: Second section\n```vodou-diagram\n{"type":"beforeafter","alt":"before and after the change","before":{"lines":["x"]},"after":{"lines":["y"]}}\n```\nAFTER: First\n```vodou-diagram\n{"type":"bars","alt":"invalid bars here","bars":[{"label":"a","value":"n/a"}]}\n```\n' > "$T/raw"
[[ "$($DIA insert "$T/i.md" "$T/raw" 2>/dev/null)" == "1" ]] && ok "insert takes the valid spec, rejects the invalid one" || no "insert count wrong"
python3 - "$T/i.md" <<'PY' && ok "inserted under the named heading, frontmatter intact" || no "insert placement wrong: $(cat "$T/i.md")"
import sys
s = open(sys.argv[1]).read()
assert s.startswith("---\ntitle: t\n---")
assert s.index("## Second section") < s.index("vodou-diagram") and s.index("two") < s.index("vodou-diagram")
PY

echo "6. the prompt brief"
printf 'a\nCAPABILITY_RULES_HERE\nb\n' > "$T/pr"
$CAP inject "$T/pr" CAPABILITY_RULES_HERE --mode capability --id local-memory --campaign local-memory
grep -q 'utm_campaign=local-memory' "$T/pr" && grep -q 'vodou-owns-your-memory.jpg' "$T/pr" && grep -q 'CAPABILITY POST, NOT A LAUNCH POST' "$T/pr" \
  && grep -q 'NOT shipped' "$T/pr" && ! grep -q CAPABILITY_RULES_HERE "$T/pr" && ok "capability brief: link, infographic, framing, limits" || no "capability brief incomplete"
printf 'a\nCAPABILITY_RULES_HERE\nb\n' > "$T/pr2"
$CAP inject "$T/pr2" CAPABILITY_RULES_HERE --mode feature --id routing --campaign router-x
grep -q 'ONLY if it genuinely supports' "$T/pr2" && ! grep -q 'NOT A LAUNCH POST' "$T/pr2" && ok "feature brief: infographic optional, launch framing kept" || no "feature brief wrong"
printf 'a\nb\n' > "$T/pr3"
$CAP inject "$T/pr3" CAPABILITY_RULES_HERE --mode feature 2>/dev/null && no "missing marker was silent" || ok "a missing marker is an error, not a silent no-op"

echo "7. wiring"
W=scripts/blog/write-feature-post.sh; R=scripts/blog/blog-run.sh
bash -n "$W" && bash -n "$R" && ok "both scripts parse" || no "syntax error"
for pat in '^CAPABILITY_RULES_HERE$' 'capabilities.py inject "\$WORK/draft.prompt" CAPABILITY_RULES_HERE' 'capabilities.py rubric-note' \
           'capabilities.py revise-rule' 'capabilities.py ensure "\$WORK/body.md"' 'capabilities.py check "\$WORK/body.md"' \
           '"post_mode": os.environ.get("POST_MODE"' 'capabilities.py match --feature-json'; do
  grep -q "$pat" "$W" && ok "writer: $pat" || no "writer missing: $pat"
done
[[ $(grep -c 'diagrams.py validate "\$WORK/body.md"' "$W") -ge 3 ]] && ok "writer validates diagrams on draft, revision and final" || no "diagram validation not on every path"
grep -q "python3 - \"\$WORK/body.md\" <<'PY'" "$W" && grep -q 'TYPES = {' "$W" && no "the old inline validator is still there (two owners)" || ok "one diagram validator (diagrams.py)"
# The check must run AFTER the revision and BEFORE the file is copied out.
awk '/capabilities.py check "\$WORK\/body.md"/{c=NR} /mv "\$WORK\/revised.md"/{r=NR} /^cp "\$WORK\/body.md" "\$OUT"/{o=NR} END{exit !(r<c && c<o)}' "$W" \
  && ok "writer: check sits between the revision and the write" || no "writer: check is in the wrong place"
grep -q 'capabilities.py next --out' "$R" && ok "runner: capability lane calls next" || no "runner: no capability lane"
grep -q '"\$LANE" != "capability"' "$R" && ok "runner: forcing the capability lane skips the incident lane" || no "runner: incident lane not excluded"
awk '/lane 1b:/{b=NR} /lane 2: the incident/{i=NR} /lane 1: did we ship/{f=NR} END{exit !(f<b && b<i)}' "$R" \
  && ok "runner: order is feature, capability, incident" || no "runner: lane order wrong"

echo; echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
