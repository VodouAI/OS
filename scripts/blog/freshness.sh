#!/usr/bin/env bash
#
# Freshness watchdog for blog.vodou.ai.
#
# The scheduled writers only deploy when THEY produce something. This closes the
# gap: it compares what is on disk with what is actually being served, and
# redeploys when they disagree. It is the difference between "the pipeline ran"
# and "the site is current" — those came apart on 2026-08-26, when four posts
# sat in content/blog while the bucket was empty and the domain served
# AccessDenied for hours.
#
# Usage: scripts/blog/freshness.sh [--fix]     (--fix redeploys on drift)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source scripts/blog/lib.sh

FIX=0; [[ "${1:-}" == "--fix" ]] && FIX=1
LOG=".vodou/blog/runs.log"
LOCK=".vodou/blog/.run.lock"
BASE="${BLOG_CANONICAL_BASE:-https://blog.vodou.ai}"
mkdir -p .vodou/blog
say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [fresh] $*" | tee -a "$LOG"; }

code() { curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$1" 2>/dev/null || echo 000; }
# Where a URL actually sends you. Needed because "live" is not a synonym for
# "200": a merged duplicate is SUPPOSED to 301.
loc() { curl -sS -o /dev/null -w '%{redirect_url}' --max-time 20 "$1" 2>/dev/null || echo ""; }

# Slugs we deliberately retired, read from the same redirects.json the edge
# function is compiled from. Without this the merge of a duplicate post looks
# exactly like a broken deploy: the source file still sits in content/blog, its
# URL answers 301, and a 200-or-bust check calls that drift — forever, once an
# hour, redeploying a site that was already correct.
REDIRECTED_SLUGS=$(python3 - <<'PYEOF' 2>/dev/null || echo ""
import json
try:
    j = json.load(open("blog-site/redirects.json"))
    print("\n".join(k.strip("/") + "\t" + v for k, v in (j.get("redirects") or {}).items()))
except Exception:
    pass
PYEOF
)

DRIFT=0

# 1. Is the domain serving at all?
HOME_CODE=$(code "$BASE/")
[[ "$HOME_CODE" == "200" ]] || { say "DRIFT: home page $HOME_CODE"; DRIFT=1; }

# 2. Does every non-draft post on disk have a live URL? This is the check that
#    would have caught the empty bucket: the pipeline said "4 posts", the site
#    said 403, and nothing was comparing the two.
MISSING=0
while IFS= read -r f; do
  grep -qi '^draft: *true' "$f" && continue
  slug=$(sed -n 's/^slug: *"\{0,1\}\([a-z0-9-]*\)"\{0,1\}.*/\1/p' "$f" | head -1)
  [[ -z "$slug" ]] && continue
  want=$(printf '%s\n' "$REDIRECTED_SLUGS" | awk -F'\t' -v s="$slug" '$1==s {print $2; exit}')
  c=$(code "$BASE/$slug/")
  if [[ -n "$want" ]]; then
    # Retired slug: assert the redirect exists AND points where redirects.json
    # says. A 301 to the wrong place is worse than no redirect — it launders
    # link equity into a 404.
    if [[ "$c" != "301" ]]; then
      say "DRIFT: retired $slug -> $c (expected 301 to $want)"
      MISSING=$((MISSING+1)); DRIFT=1
    else
      got=$(loc "$BASE/$slug/")
      case "$got" in
        *"$want") : ;;
        *) say "DRIFT: retired $slug 301s to '$got', redirects.json says '$want'"
           MISSING=$((MISSING+1)); DRIFT=1 ;;
      esac
    fi
  elif [[ "$c" != "200" ]]; then
    say "DRIFT: $slug -> $c (on disk, not live)"
    MISSING=$((MISSING+1)); DRIFT=1
  fi
done < <(find content/blog -name '*.md' -type f 2>/dev/null | sort)

# 2b. Machine-reader surfaces. These have no human visiting them, so a
#     regression here is invisible until months of LLM/answer-engine reach have
#     already been lost. Checked against the newest post so the check moves with
#     the corpus instead of pinning a slug that will eventually be deleted.
NEWEST=$(find content/blog -name '*.md' -type f 2>/dev/null | sort | tail -1)
if [[ -n "$NEWEST" ]]; then
  nslug=$(sed -n 's/^slug: *"\{0,1\}\([a-z0-9-]*\)"\{0,1\}.*/\1/p' "$NEWEST" | head -1)
  # /built is the capability hub every feature post links into. A feature post
  # whose own index 404s is worse than not shipping it.
  for surface in "llms.txt" "llms-full.txt" "robots.txt" "built/" "${nslug}.md"; do
    c=$(code "$BASE/$surface")
    if [[ "$c" != "200" ]]; then
      say "DRIFT: machine-reader surface /$surface -> $c"
      DRIFT=1
    fi
  done

  # The OG card path is NOT spelled here. Cards are content-addressed
  # (/og/<slug>-<hash8>.png) so a redraw reaches the caches that re-host them,
  # which means the old literal `og/<slug>.png` now 404s at origin -- this check
  # started reporting DRIFT once an hour for a file that was never supposed to
  # exist. A permanently-red check is a check nobody reads, and this one runs
  # hourly. Read the registry the pages render from, same as publish.mjs.
  OGPATH=$(curl -sS --max-time 20 "$BASE/og/manifest.json" 2>/dev/null \
    | python3 -c "import json,sys;print((json.load(sys.stdin).get('og',{}).get('$nslug') or {}).get('path',''))" 2>/dev/null || echo "")
  if [[ -z "$OGPATH" ]]; then
    say "DRIFT: no og card registered for $nslug in /og/manifest.json"
    DRIFT=1
  else
    c=$(code "$BASE$OGPATH")
    if [[ "$c" != "200" ]]; then
      say "DRIFT: og card $OGPATH -> $c"
      DRIFT=1
    fi
    # An OG card that 200s but is a few hundred bytes is a blank render, which
    # looks fine to a status-code check and renders as an empty grey box on
    # every social platform. Size is the cheapest proxy for "it has glyphs".
    OGBYTES=$(curl -sS --max-time 20 -o /dev/null -w '%{size_download}' "$BASE$OGPATH" 2>/dev/null || echo 0)
    if [[ "$OGBYTES" -lt 8000 ]]; then
      say "DRIFT: og card $OGPATH is only ${OGBYTES}B - probable blank render"
      DRIFT=1
    fi
  fi
fi

# 3. Content fingerprint vs what we last shipped.
NOW_HASH=$(bt_site_hash)
LAST=$(cat .vodou/blog/.deployed_hash 2>/dev/null || echo "")
if [[ "$NOW_HASH" != "$LAST" ]]; then
  say "DRIFT: content hash $NOW_HASH != deployed $LAST"
  DRIFT=1
fi

# 2c. House style: no em dash in prose. dedash.py runs inside both writers, so
#     a hit here means the guarantee leaked (a hand-edited post, a writer that
#     bypassed normalize(), or a bug in the scrubber). Reported, never fixed
#     from here: rewriting a published post behind the author's back is a
#     bigger surprise than the dash. --check writes nothing.
DASHY=0
for f in content/blog/*.md; do
  [[ -e "$f" ]] || continue
  python3 scripts/blog/dedash.py "$f" --check >/dev/null 2>&1 || {
    say "STYLE: em dash in prose -> $(basename "$f") (run: python3 scripts/blog/dedash.py '$f')"
    DASHY=$((DASHY+1))
  }
done
# Deliberately an if-block, not `(( ... )) && say`: this script is set -uo
# today, but that idiom returns 1 when the count is zero and would silently
# end the run the day someone adds set -e.
if (( DASHY > 0 )); then say "STYLE: $DASHY post(s) carry an em dash in prose"; fi

# 2d. House style: headings must be specific to their own post. Same doctrine
#     as the dash check above: headings.py runs inside both writers, so a hit
#     here means a post shipped before the check existed, or was hand-edited,
#     or the re-heading pass ran out of budget and shipped as drafted. Four
#     posts once shared a byte-identical H2 skeleton, which Google reads as
#     duplicate content and a human reads as generated.
#     Reported, never fixed from here. The fix is a command a person runs:
#     scripts/blog/backfill-headings.sh --live <file>
HEADY=0
for f in content/blog/*.md; do
  [[ -e "$f" ]] || continue
  python3 scripts/blog/headings.py --check "$f" content/blog >/dev/null 2>&1 || {
    say "STYLE: reused or generic headings -> $(basename "$f") (run: scripts/blog/backfill-headings.sh --live '$f')"
    HEADY=$((HEADY+1))
  }
done
if (( HEADY > 0 )); then say "STYLE: $HEADY post(s) carry a reused or generic heading"; fi

if [[ $DRIFT -eq 0 ]]; then
  say "fresh — home 200, all posts live, hash $NOW_HASH"
  exit 0
fi

if [[ $FIX -ne 1 ]]; then
  say "drift detected ($MISSING post(s) missing) — rerun with --fix to redeploy"
  exit 2
fi

# Never redeploy underneath a writer that is mid-run.
if ! bt_lock_acquire "$LOCK" 1800; then
  say "a blog run holds the lock — it will deploy; standing down"
  exit 0
fi
trap 'bt_lock_release "$LOCK"' EXIT

say "redeploying"
if ./scripts/blog/deploy-site.sh >>"$LOG" 2>&1; then
  printf '%s' "$NOW_HASH" > .vodou/blog/.deployed_hash
  say "redeployed; home -> $(code "$BASE/")"
else
  say "FATAL: redeploy failed"
  exit 1
fi
