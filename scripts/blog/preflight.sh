#!/usr/bin/env bash
#
# Read-only go/no-go check for the blog syndication pipeline.
#
# Run this BEFORE setting BLOG_AUTOPUBLISH=1. It writes nothing anywhere — no
# drafts, no articles, no ledger — it only makes the cheapest authenticated read
# each API offers and reports who the credential belongs to. That last part is
# the point: a token that authenticates successfully to the WRONG account is the
# failure mode a status code cannot catch, so every PASS prints the owner.
#
# Usage:  bash scripts/blog/preflight.sh
# Exit:   0 = every check passed, 1 = at least one FAIL.
#
# Never prints key material. Failures print the API's own response body, which
# is what you need to tell "revoked" from "typo" from "not on Pro".
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

FAILED=0
pass() { printf '  \033[32mPASS\033[0m  %-26s %s\n' "$1" "${2:-}"; }
fail() { printf '  \033[31mFAIL\033[0m  %-26s %s\n' "$1" "${2:-}"; FAILED=1; }
warn() { printf '  \033[33mWARN\033[0m  %-26s %s\n' "$1" "${2:-}"; }
# An OPTIONAL target that is deliberately not configured is not a failure. Before
# 2026-08-26 an unset HASHNODE_TOKEN made preflight exit 1 forever, so the one
# command whose whole job is to say go/no-go said NO-GO permanently -- which
# trains you to ignore it, and a red light nobody reads cannot warn you about
# the real thing. FAIL is reserved for configured-but-broken.
skip() { printf '  \033[90mSKIP\033[0m  %-26s %s\n' "$1" "${2:-}"; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

# --- .env ---------------------------------------------------------------------
# Same loader publish.mjs uses: shell environment wins, .env fills the gaps.
if [[ -f .env ]]; then
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*([A-Z0-9_]+)[[:space:]]*=(.*)$ ]] || continue
    k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"
    v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
    [[ -n "${!k:-}" ]] || export "$k=$v"
  done < .env
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
CURL=(curl -s --max-time 25 -o "$TMP/body" -w '%{http_code}')

# jq is not guaranteed on a stock mac; python3 is.
jget() { python3 -c '
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: sys.exit(1)
for k in sys.argv[2].split("."):
    if isinstance(d,list):
        try: d=d[int(k)]
        except Exception: sys.exit(1)
    elif isinstance(d,dict) and k in d: d=d[k]
    else: sys.exit(1)
print(d if d is not None else "")
' "$1" "$2" 2>/dev/null; }

bodysnip() { tr -d '\r' < "$TMP/body" | head -c 300 | tr '\n' ' '; }

echo "blog syndication preflight — $(date '+%Y-%m-%d %H:%M:%S')"
echo "repo: $ROOT"

# --- config -------------------------------------------------------------------
hdr "config"

BASE="${BLOG_CANONICAL_BASE:-}"
if [[ -z "$BASE" ]]; then
  fail "BLOG_CANONICAL_BASE" "not set. Add BLOG_CANONICAL_BASE=https://blog.vodou.ai to .env — publish.mjs builds every canonical_url from it."
else
  BASE="${BASE%/}"
  CODE=$("${CURL[@]}" -L "$BASE/" || echo 000)
  if [[ "$CODE" == "200" ]]; then
    pass "BLOG_CANONICAL_BASE" "$BASE (HTTP 200)"
  else
    fail "BLOG_CANONICAL_BASE" "$BASE/ returned HTTP $CODE — the canonical host must be live before anything is syndicated."
  fi
fi

case "${BLOG_AUTOPUBLISH:-0}" in
  1) pass "BLOG_AUTOPUBLISH" "1 — blog-run.sh WILL syndicate for real on its next slot." ;;
  0|"") warn "BLOG_AUTOPUBLISH" "0/unset — blog-run.sh stays in dry run. Set to 1 only after a successful manual --live run." ;;
  *) fail "BLOG_AUTOPUBLISH" "value ${BLOG_AUTOPUBLISH@Q} is neither 0 nor 1; blog-run.sh only treats the literal 1 as on." ;;
esac

# --- dev.to -------------------------------------------------------------------
hdr "dev.to"

if [[ -z "${DEVTO_API_KEY:-}" ]]; then
  fail "DEVTO_API_KEY" "not set. dev.to → Settings → Extensions → DEV Community API Keys → Generate API Key."
else
  # GET /api/users/me is the cheapest authenticated read Forem has: no writes,
  # no rate-limit class of its own, and it returns the account identity.
  CODE=$("${CURL[@]}" https://dev.to/api/users/me \
        -H "api-key: ${DEVTO_API_KEY}" \
        -H 'Accept: application/vnd.forem.api-v1+json' || echo 000)
  case "$CODE" in
    200)
      USERNAME=$(jget "$TMP/body" username || echo '?')
      NAME=$(jget "$TMP/body" name || echo '?')
      pass "DEVTO_API_KEY" "authenticates as @${USERNAME} (${NAME}) — confirm this is the account you want posts under."
      ;;
    401) fail "DEVTO_API_KEY" "HTTP 401 — key is wrong, revoked, or has a stray space/newline. Regenerate it. Body: $(bodysnip)" ;;
    000) fail "DEVTO_API_KEY" "no response from dev.to within 25s (network or outage)." ;;
    *)   fail "DEVTO_API_KEY" "HTTP $CODE. Body: $(bodysnip)" ;;
  esac
fi

# --- Hashnode -----------------------------------------------------------------
hdr "hashnode"

HN_EP="${HASHNODE_GQL_ENDPOINT:-https://gql-beta.hashnode.com/}"
# The old https://gql.hashnode.com/ now 301s to an announcement page and serves
# no GraphQL. Catching that here is the whole reason this check exists.
CODE=$("${CURL[@]}" -X POST "$HN_EP" -H 'Content-Type: application/json' \
      -d '{"query":"{ tag(slug:\"javascript\"){ id } }"}' || echo 000)
if [[ "$CODE" == "200" ]] && grep -q '"tag"' "$TMP/body"; then
  pass "hashnode endpoint" "$HN_EP answers GraphQL"
else
  fail "hashnode endpoint" "$HN_EP returned HTTP $CODE and no GraphQL data. The current production endpoint is https://gql-beta.hashnode.com/ . Body: $(bodysnip)"
fi

HN_USER=""
if [[ -z "${HASHNODE_TOKEN:-}" ]]; then
  skip "HASHNODE_TOKEN" "not set — hashnode is OFF by choice, not broken. Enabling it costs \$5/mo (Pro gates every GraphQL mutation). dev.to alone is a valid backlink."
else
  CODE=$("${CURL[@]}" -X POST "$HN_EP" \
        -H "Authorization: Bearer ${HASHNODE_TOKEN}" -H 'Content-Type: application/json' \
        -d '{"query":"{ me { id username name } }"}' || echo 000)
  if [[ "$CODE" == "200" ]] && grep -q '"username"' "$TMP/body"; then
    HN_USER=$(jget "$TMP/body" data.me.username || echo '?')
    HN_NAME=$(jget "$TMP/body" data.me.name || echo '?')
    pass "HASHNODE_TOKEN" "authenticates as @${HN_USER} (${HN_NAME}) — confirm this is the account you want posts under."
  elif grep -q 'UNAUTHENTICATED' "$TMP/body" 2>/dev/null; then
    fail "HASHNODE_TOKEN" "UNAUTHENTICATED — token is wrong, expired, or revoked. Body: $(bodysnip)"
  else
    fail "HASHNODE_TOKEN" "HTTP $CODE. Body: $(bodysnip)"
  fi
fi

if [[ -z "${HASHNODE_PUBLICATION_ID:-}" ]]; then
  skip "HASHNODE_PUBLICATION_ID" "not set — only needed if HASHNODE_TOKEN is. It is a 24-char ObjectId, NOT your blog URL (scripts/blog/SETUP.md step 4)."
elif [[ ! "$HASHNODE_PUBLICATION_ID" =~ ^[0-9a-f]{24}$ ]]; then
  fail "HASHNODE_PUBLICATION_ID" "value is not a 24-character hex ObjectId. A host like chad.hashnode.dev will be rejected as BAD_USER_INPUT."
elif [[ -z "$HN_USER" ]]; then
  warn "HASHNODE_PUBLICATION_ID" "shape looks right, but it cannot be verified without a working HASHNODE_TOKEN."
else
  # me.publications enumerates what this token may actually write to. Matching
  # the configured id against that list is what catches "right token, someone
  # else's publication id" — which would publish into a blog you don't own.
  CODE=$("${CURL[@]}" -X POST "$HN_EP" \
        -H "Authorization: Bearer ${HASHNODE_TOKEN}" -H 'Content-Type: application/json' \
        -d '{"query":"{ me { publications(first: 25) { edges { node { id title url } } } } }"}' || echo 000)
  MATCH=$(python3 - "$TMP/body" "$HASHNODE_PUBLICATION_ID" <<'PY' 2>/dev/null || true
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: sys.exit(0)
edges=(((d.get("data") or {}).get("me") or {}).get("publications") or {}).get("edges") or []
for e in edges:
    n=e.get("node") or {}
    if n.get("id")==sys.argv[2]:
        print(f'{n.get("title","?")} — {n.get("url","?")}'); break
else:
    if edges:
        print("NOMATCH::" + "; ".join(f'{(e.get("node") or {}).get("id")} = {(e.get("node") or {}).get("title")}' for e in edges))
PY
)
  if [[ -n "$MATCH" && "$MATCH" != NOMATCH::* ]]; then
    pass "HASHNODE_PUBLICATION_ID" "$MATCH"
  elif [[ "$MATCH" == NOMATCH::* ]]; then
    fail "HASHNODE_PUBLICATION_ID" "not one of @${HN_USER}'s publications. Yours are: ${MATCH#NOMATCH::}"
  else
    warn "HASHNODE_PUBLICATION_ID" "could not enumerate publications (HTTP $CODE); shape is valid. Body: $(bodysnip)"
  fi

  # Pro gate. Since 2026-05-13 every Hashnode WRITE mutation requires the target
  # publication to be on Pro. A non-Pro publication authenticates fine and then
  # fails on the first publishPost, so probe it here with a read, not a write.
  CODE=$("${CURL[@]}" -X POST "$HN_EP" \
        -H "Authorization: Bearer ${HASHNODE_TOKEN}" -H 'Content-Type: application/json' \
        -d "{\"query\":\"query(\$id: ObjectId!){ publication(id: \$id){ id title } }\",\"variables\":{\"id\":\"${HASHNODE_PUBLICATION_ID}\"}}" || echo 000)
  if grep -q 'active Pro plan' "$TMP/body" 2>/dev/null; then
    fail "hashnode Pro plan" "publication is NOT on Hashnode Pro. Every write mutation (publishPost/updatePost) is Pro-gated since 2026-05-13 and will return FORBIDDEN. Upgrade the publication, or run publish.mjs with --only devto."
  elif grep -q '"publication"' "$TMP/body" 2>/dev/null && [[ "$CODE" == "200" ]]; then
    pass "hashnode Pro plan" "publication-scoped read succeeded — writes are not Pro-blocked."
  else
    warn "hashnode Pro plan" "inconclusive (HTTP $CODE). Body: $(bodysnip)"
  fi
fi

# --- AWS ----------------------------------------------------------------------
hdr "aws (deploy target)"

if ! command -v aws >/dev/null 2>&1; then
  fail "aws cli" "not on PATH — scripts/blog/deploy-site.sh cannot publish the canonical site."
elif OUT=$(aws sts get-caller-identity --output json 2>&1); then
  ARN=$(printf '%s' "$OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Arn"])' 2>/dev/null || echo '?')
  pass "aws sts" "$ARN"
else
  fail "aws sts" "get-caller-identity failed: $(printf '%s' "$OUT" | head -c 250 | tr '\n' ' ')"
fi

# --- verdict ------------------------------------------------------------------
echo
if [[ $FAILED -eq 0 ]]; then
  printf '\033[32mPREFLIGHT PASSED\033[0m — safe to do a manual live run:\n'
  printf '  node scripts/blog/publish.mjs content/blog/<file>.md --live\n'
else
  printf '\033[31mPREFLIGHT FAILED\033[0m — a CONFIGURED target is broken. SKIP lines are off by choice and are not failures.\n'
fi
exit $FAILED
