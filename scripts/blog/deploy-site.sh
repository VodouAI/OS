#!/usr/bin/env bash
#
# Build the Astro blog and push it to S3 + CloudFront (blog.vodou.ai).
#
# There is no server. The whole site is static HTML on S3, fronted by
# CloudFront with a viewer-request function that rewrites /slug/ -> /slug/index.html.
# Nothing to patch, nothing to restart, nothing that can be down at 3am.
#
# Usage: scripts/blog/deploy-site.sh [--no-build] [--no-invalidate]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
# bt_site_hash lives here; the deploy receipt written at the bottom needs it.
source scripts/blog/lib.sh
mkdir -p .vodou/blog

BUCKET="${BLOG_S3_BUCKET:-blog-vodou-ai}"
DIST_ID="${BLOG_CF_DIST_ID:-E2BOGQFOWVOFZ9}"
SITE_DIR="$ROOT/blog-site"
OUT="$SITE_DIR/dist"

DO_BUILD=1; DO_INVALIDATE=1
for a in "$@"; do
  [[ "$a" == "--no-build" ]] && DO_BUILD=0
  [[ "$a" == "--no-invalidate" ]] && DO_INVALIDATE=0
done

say() { echo "[$(date '+%H:%M:%S')] [deploy] $*"; }

if [[ $DO_BUILD -eq 1 ]]; then
  say "building Astro site"
  ( cd "$SITE_DIR" && npm run build )
fi

# House style, checked on the BUILT output rather than on the source. dedash.py
# guards the post markdown, but a post is not the only thing that renders prose:
# page titles, the RSS channel description, the /built blurb and the diagram
# twin's caption are all template strings, and three of those had an em dash
# that no source-file check could ever see. Reported, never fatal.
DASHES=$(python3 - "$OUT" <<'PYEOF' 2>/dev/null || echo 0
import glob, re, sys
n = 0
for f in glob.glob(sys.argv[1] + '/**/*.html', recursive=True):
    h = open(f, encoding='utf-8', errors='replace').read()
    n += re.sub(r'<pre.*?</pre>|<code.*?</code>', '', h, flags=re.S).count('\u2014')
print(n)
PYEOF
)
if [[ "${DASHES:-0}" -gt 0 ]]; then
  say "STYLE: $DASHES em dash(es) in rendered prose (outside code) - grep the .astro templates"
fi

# Two records of one event: the <figure> in the page HTML and the PNG the
# syndicated copy uses are rendered from the same spec, in the same build, by
# the same function. They cannot legitimately differ. They HAVE differed --
# Astro caches rendered post HTML by content digest, so an edit to the diagram
# engine reached the PNGs and the .md twins (regenerated every build) while the
# HTML kept serving figures drawn by the previous code. Green build, stale page.
# Comparing the two dimensions catches that, and anything else that ever makes
# the page and the syndicated copy disagree about one figure.
say "checking page figures against syndication figures"
python3 - "$OUT" <<'FIGCHECK' || { echo "FATAL: page and syndication figures disagree"; exit 1; }
import glob, json, os, re, struct, sys
out = sys.argv[1]

def png_size(path):
    with open(path, 'rb') as fh:
        head = fh.read(24)
    return struct.unpack('>II', head[16:24])

SCALE = 2   # diagram-png.ts rasterizes at 2x
PAD = 16    # ...with 16 user units of padding on every side

bad, checked = [], 0
for md in sorted(glob.glob(os.path.join(out, 'syndication', '*.md'))):
    slug = os.path.basename(md)[:-3]
    html = os.path.join(out, slug, 'index.html')
    if not os.path.exists(html):
        bad.append(slug + ': no page at ' + html); continue
    # Scoped to our own <figure>, not every <svg> on the page: a layout icon
    # with a viewBox would otherwise make every deploy fail the count check.
    boxes = re.findall(r'<figure class="vodou-diagram[^"]*"[^>]*>\s*<svg[^>]*viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"',
                       open(html, encoding='utf-8').read())
    imgs = re.findall(r'!\[[^\]]*\]\(\S+/diagrams/(\S+?\.png)\)',
                      open(md, encoding='utf-8').read())
    if len(boxes) != len(imgs):
        bad.append('%s: %d figure(s) on the page, %d in the syndicated copy' % (slug, len(boxes), len(imgs)))
        continue
    for (vx, vy, vw, vh), name in zip(boxes, imgs):
        pw, ph = png_size(os.path.join(out, 'diagrams', name))
        want = (round((float(vw) + PAD * 2) * SCALE), round((float(vh) + PAD * 2) * SCALE))
        checked += 1
        if (pw, ph) != want:
            bad.append('%s/%s: page viewBox %sx%s implies %s, PNG is %dx%d' % (slug, name, vw, vh, want, pw, ph))

for b in bad:
    sys.stderr.write('  ' + b + '\n')
print('  %d figure(s) agree' % checked if not bad else '  %d mismatch(es)' % len(bad))
sys.exit(1 if bad else 0)
FIGCHECK

[[ -f "$OUT/index.html" ]] || { echo "FATAL: $OUT/index.html missing — build produced nothing"; exit 1; }

# Hashed assets are content-addressed: cache them forever.
say "syncing immutable assets"
aws s3 sync "$OUT/" "s3://$BUCKET/" \
  --delete \
  --exclude "*" --include "_astro/*" \
  --cache-control "public,max-age=31536000,immutable" \
  --only-show-errors

# HTML/feeds change every run: CloudFront holds them for an hour, browsers revalidate.
say "syncing html + feeds"
aws s3 sync "$OUT/" "s3://$BUCKET/" \
  --delete \
  --exclude "_astro/*" \
  --cache-control "public,max-age=0,s-maxage=3600,must-revalidate" \
  --only-show-errors

# The machine-reader surfaces need a real Content-Type or browsers download them
# instead of showing them, and crawlers treat them as opaque blobs. `aws s3 sync`
# guesses from the extension and gets .md wrong on some CLI builds, so set it.
say "fixing content-types on machine-reader surfaces"

# botocore computes a flexible checksum over a non-seekable stream, so when it
# decides to retry a PUT it cannot rewind and dies with "Need to rewind the
# stream". Seen once mid-deploy: the HTML was already in S3 and `set -e` then
# aborted the run BEFORE the CloudFront invalidation, so the bucket held the new
# site and every reader kept getting the old one from the edge. A green exit was
# never reachable, but a half-deployed site was — which is worse than a loud
# failure, because nothing downstream knew to look.
#
# Two fixes, because either alone still strands a deploy:
#   1. Only checksum when the API requires it, which removes the rewind path.
#   2. Retry, then carry on. A wrong Content-Type on one .md twin is a bad day
#      for machine readers; a stale edge is a bad day for every reader.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
CT_FAILED=0
put_ct() {  # put_ct <file> <content-type>
  local f="$1" ct="$2" n=0
  until aws s3 cp "$f" "s3://$BUCKET/$(basename "$f")" \
      --content-type "$ct" \
      --cache-control "public,max-age=0,s-maxage=3600,must-revalidate" \
      --only-show-errors; do
    n=$((n + 1))
    if [[ $n -ge 3 ]]; then
      say "WARN: content-type PUT failed 3x for $(basename "$f") - continuing so the edge still gets invalidated"
      CT_FAILED=$((CT_FAILED + 1))
      return 0
    fi
    sleep $((n * 2))
  done
}
for f in "$OUT"/*.md; do
  [[ -e "$f" ]] || break
  put_ct "$f" "text/markdown; charset=utf-8"
done
for f in "$OUT"/llms.txt "$OUT"/llms-full.txt "$OUT"/robots.txt; do
  [[ -e "$f" ]] || continue
  put_ct "$f" "text/plain; charset=utf-8"
done
if [[ $CT_FAILED -gt 0 ]]; then say "WARN: $CT_FAILED machine-reader file(s) kept their previous Content-Type"; fi

if [[ $DO_INVALIDATE -eq 1 ]]; then
  say "invalidating CloudFront"
  aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" \
    --query 'Invalidation.{Id:Id,Status:Status}' --output json
fi

# ---------------------------------------------------------------------------
# IndexNow: push the URL list instead of waiting to be crawled.
#
# A brand-new domain with no backlinks is not on anyone's crawl schedule. Bing,
# Yandex, Seznam and Naver accept a direct submission and act on it in hours.
# This matters more than it looks for LLM reach: Bing's index is what backs
# ChatGPT search and Copilot, so IndexNow is the shortest path from "published"
# to "an assistant can cite it."
#
# Google ignores IndexNow entirely and deprecated its sitemap ping in 2023 —
# there the only lever is Search Console + <lastmod>, both of which are in place.
KEYFILE="$SITE_DIR/public"
KEY="$(ls "$KEYFILE" 2>/dev/null | grep -E '^[0-9a-f]{32}\.txt$' | head -1 || true)"
if [[ -n "$KEY" ]]; then
  KEY="${KEY%.txt}"
  URLS=$(python3 - "$OUT" <<'PYEOF'
import sys, os, json, re
out = sys.argv[1]
urls = ["https://blog.vodou.ai/"]
for name in sorted(os.listdir(out)):
    p = os.path.join(out, name)
    if os.path.isdir(p) and os.path.exists(os.path.join(p, "index.html")) and not name.startswith(("_", "tags")):
        urls.append(f"https://blog.vodou.ai/{name}/")
print(json.dumps(urls))
PYEOF
)
  BODY=$(python3 -c "import json,sys; print(json.dumps({'host':'blog.vodou.ai','key':sys.argv[1],'keyLocation':f'https://blog.vodou.ai/{sys.argv[1]}.txt','urlList':json.loads(sys.argv[2])}))" "$KEY" "$URLS")
  CODE=$(curl -s -o /tmp/indexnow.out -w '%{http_code}' -X POST 'https://api.indexnow.org/IndexNow' \
      -H 'Content-Type: application/json; charset=utf-8' -d "$BODY" || echo 000)
  # 200 = accepted, 202 = accepted pending key validation. Anything else is
  # informational only: a rejected ping must never fail a good deploy.
  if [[ "$CODE" == "200" || "$CODE" == "202" ]]; then
    say "IndexNow: submitted $(echo "$URLS" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))') urls (HTTP $CODE)"
  else
    say "IndexNow: HTTP $CODE — not fatal, site is live regardless ($(head -c 120 /tmp/indexnow.out 2>/dev/null))"
  fi
else
  say "IndexNow: no key file in $SITE_DIR/public — skipping submission"
fi

# Record WHAT we just shipped, here — in the script that actually knows a deploy
# succeeded. This used to live in blog-run.sh, which meant any deploy by another
# path (a manual run, a fix pass) left .deployed_hash pointing at an older tree.
# freshness.sh then reported drift against a site that was perfectly current, and
# would have redeployed a correct site every hour forever. The receipt belongs to
# the event, not to one of its callers.
bt_site_hash > .vodou/blog/.deployed_hash
say "recorded deployed hash $(cat .vodou/blog/.deployed_hash)"

say "live: https://blog.vodou.ai"
