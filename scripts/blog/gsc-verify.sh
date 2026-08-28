#!/usr/bin/env bash
#
# Publish the Google Search Console DNS verification TXT record for vodou.ai.
#
# WHY THIS EXISTS: Google is the one search engine we cannot push to. IndexNow
# reaches Bing/Yandex/Seznam/Naver in hours, and Google deprecated its sitemap
# ping endpoint in 2023 — so for Google the ONLY levers are Search Console plus
# <lastmod>. Both are needed; only one of them requires Chad.
#
# DOMAIN vs URL-PREFIX property: use a *Domain* property (DNS verification).
# It covers blog.vodou.ai, app.vodou.ai, policy.vodou.ai and every future
# subdomain with one record, and unlike the HTML-file method it cannot be broken
# by a deploy that rewrites the bucket.
#
# Usage:
#   scripts/blog/gsc-verify.sh "google-site-verification=XXXXXXXXXXXXXXXXXX"
#   scripts/blog/gsc-verify.sh --check
set -euo pipefail
ZONE_ID="Z02723672K73VJI9AKM2T"     # vodou.ai.
DOMAIN="vodou.ai"

if [[ "${1:-}" == "--check" || $# -eq 0 ]]; then
  echo "Existing TXT records on $DOMAIN:"
  dig +short TXT "$DOMAIN" | sed 's/^/  /'
  [[ $# -eq 0 ]] && { echo; echo "usage: $0 \"google-site-verification=...\""; exit 0; }
  exit 0
fi

TOKEN="$1"
[[ "$TOKEN" == google-site-verification=* ]] || {
  echo "FATAL: token must start with 'google-site-verification='." >&2
  echo "Paste the whole TXT value Search Console shows, not just the hash." >&2
  exit 1
}

# Preserve any TXT records already on the apex. An UPSERT replaces the entire
# record set, so blindly writing one value would silently delete SPF/DMARC and
# break mail. Read first, merge, then write.
EXISTING=$(aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" \
  --query "ResourceRecordSets[?Name=='${DOMAIN}.'&&Type=='TXT'].ResourceRecords[].Value" \
  --output json)

BATCH=$(python3 - "$EXISTING" "$TOKEN" "$DOMAIN" <<'PY'
import json, sys
existing, token, domain = json.loads(sys.argv[1]), sys.argv[2], sys.argv[3]
values = [v for v in existing if "google-site-verification=" not in v]
values.append(f'"{token}"')
print(json.dumps({
  "Comment": "GSC domain verification for blog.vodou.ai",
  "Changes": [{"Action": "UPSERT", "ResourceRecordSet": {
      "Name": f"{domain}.", "Type": "TXT", "TTL": 300,
      "ResourceRecords": [{"Value": v} for v in values]}}]
}))
PY
)

echo "Writing TXT set:"
echo "$BATCH" | python3 -m json.tool | sed 's/^/  /'
aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" \
  --change-batch "$BATCH" --query 'ChangeInfo.{Id:Id,Status:Status}' --output json

echo
echo "Propagating (TTL 300s). Poll with:  dig +short TXT $DOMAIN"
echo "Then click Verify in Search Console, add the sitemap:"
echo "  https://blog.vodou.ai/sitemap-index.xml"
