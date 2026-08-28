#!/usr/bin/env bash
#
# Vodou blog topic miner.
# Reads memory.db for blog-worthy engineering material, filters out anything
# already published, and prints ranked candidates as JSON.
#
# Usage: scripts/blog/mine-topics.sh [--limit N] [--days N] [--json] [--explain]
#
# Signal model — which chunk_tags make a good dev post, and why:
#   GOTCHA    the "I lost 3 hours to this" post. Highest CTR on dev.to/HN.
#   DEAD_END  "we tried X, it didn't work, here's the measurement." Rare + trusted.
#   METRIC    before/after numbers. SEO gold, ages well, gets cited.
#   DECISION  architecture rationale. Long-tail search traffic.
#   PATTERN   reusable technique. Best evergreen/canonical performance.
# DONE/PLANNED/RESEARCH are excluded: internal status, not reader value.
#
# THREE FILTERS RUN, IN ORDER. Each exists because of a specific observed failure:
#
#   1. chunk-id dedupe (SQL)        — never mine the same chunk twice.
#   2. incident-cluster dedupe      — the chunk-id filter is necessary but NOT
#      (semantic, below)              sufficient. Two DIFFERENT chunks can describe
#                                     one incident, and on 2026-08-26 they did:
#                                     "prompt-caching-froze-my-system-prompt" and
#                                     "why-my-llm-agent-fabricated-numbers" are the
#                                     same bug, published as two posts. Near-duplicate
#                                     content is precisely what Google demotes, so
#                                     this is a ranking bug, not a tidiness one.
#                                     Fix: ask the retrieval pipeline itself. If a
#                                     candidate's own nearest neighbours include a
#                                     chunk we already published, it is the same story.
#   3. pillar rotation (scoring)    — a small domain cannot outrank anyone on scattered
#                                     one-offs. It ranks by TOPICAL AUTHORITY: many
#                                     posts clustered on few subjects. So the miner
#                                     boosts whichever pillar has been covered least
#                                     recently instead of letting one topic run away.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

LIMIT=12
DAYS=45
EXPLAIN=0
# Set BLOG_SIMILARITY_DEDUPE=0 to skip filter 2 (it costs one mem-search per candidate).
SIM_DEDUPE="${BLOG_SIMILARITY_DEDUPE:-1}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit)   LIMIT="$2"; shift 2 ;;
    --days)    DAYS="$2";  shift 2 ;;
    --explain) EXPLAIN=1; shift ;;
    --json)    shift ;;
    *) shift ;;
  esac
done

LEDGER=".vodou/blog/ledger.json"
mkdir -p "$(dirname "$LEDGER")"
[[ -f "$LEDGER" ]] || echo '{"published":[]}' > "$LEDGER"

# Chunk ids already used as a post's spine — filter 1.
USED=$(python3 -c "
import json
d = json.load(open('$LEDGER'))
ids = set()
for p in d.get('published', []):
    ids.update(p.get('source_chunk_ids', []))
print(','.join(\"'\"+i.replace(\"'\",'')+\"'\" for i in ids) or \"''\")
")

# Over-fetch: filters 2 and 3 run in Python and will discard some rows.
FETCH=$(( LIMIT * 4 ))

RAW=$(sqlite3 -json memory.db "
SELECT
  id,
  chunk_tag AS tag,
  date(created_at, 'localtime') AS day,
  path,
  replace(text, char(10), ' ') AS text,
  CASE chunk_tag
    WHEN 'GOTCHA'   THEN 100
    WHEN 'DEAD_END' THEN 95
    WHEN 'METRIC'   THEN 85
    WHEN 'PATTERN'  THEN 80
    WHEN 'DECISION' THEN 70
    ELSE 0 END
  + CASE WHEN length(text) > 400 THEN 25 WHEN length(text) > 200 THEN 12 ELSE 0 END
  + CASE WHEN julianday('now') - julianday(created_at) < 7 THEN 20 ELSE 0 END
  AS score
FROM memory_chunks
WHERE archived = 0
  AND invalid_at IS NULL
  AND chunk_tag IN ('GOTCHA','DEAD_END','METRIC','PATTERN','DECISION')
  AND created_at >= date('now', '-$DAYS days')
  AND length(text) > 160
  AND id NOT IN ($USED)
ORDER BY score DESC, created_at DESC
LIMIT $FETCH;
")

export MINE_RAW="$RAW" MINE_LIMIT="$LIMIT" MINE_EXPLAIN="$EXPLAIN" MINE_SIM="$SIM_DEDUPE"
python3 <<'PYEOF'
import json, os, subprocess, sys, re

raw     = json.loads(os.environ["MINE_RAW"] or "[]")
limit   = int(os.environ["MINE_LIMIT"])
explain = os.environ["MINE_EXPLAIN"] == "1"
do_sim  = os.environ["MINE_SIM"] == "1"

ledger = json.load(open(".vodou/blog/ledger.json"))
pub    = ledger.get("published", [])
used   = set()
for p in pub:
    used.update(p.get("source_chunk_ids", []))

def note(msg):
    if explain:
        print(f"[mine] {msg}", file=sys.stderr)

# --- pillars -----------------------------------------------------------------
# The table itself lives in scripts/blog/pillars.py so the miner and the writer
# cannot drift apart. If they did, rotation would silently stop working and
# nothing would report it.
sys.path.insert(0, "scripts/blog")
from pillars import pillar_of

# Recency of coverage per pillar: index 0 = most recently published.
recent = [p.get("pillar") for p in reversed(pub) if p.get("pillar")]
def staleness_boost(pillar):
    """Least-recently-covered pillar wins. Never covered wins biggest.

    'unsorted' is explicitly NOT rewarded. It is the absence of a pillar, and
    treating absence as 'never covered, therefore overdue' would hand the top
    boost to exactly the candidates that fit the blog's subject worst — the
    classic bug where a null sorts first.
    """
    if pillar == "unsorted":
        return -20
    try:
        return max(0, 40 - 10 * recent.index(pillar))
    except ValueError:
        return 45
    
# --- feature awareness -------------------------------------------------------
# Chad's ask: posts should showcase what Vodou can actually do and what it cost
# to build. If a candidate maps onto a documented feature, prefer it — that post
# has a home to link to and a capability to demonstrate, not just a war story.
feat_terms = []
fdir = "content/features"
if os.path.isdir(fdir):
    for fn in sorted(os.listdir(fdir)):
        if not fn.endswith(".md"):
            continue
        head = open(os.path.join(fdir, fn), encoding="utf-8").read(1200)
        slug = re.search(r'^slug:\s*"?([\w-]+)"?', head, re.M)
        title = re.search(r'^title:\s*"?(.+?)"?\s*$', head, re.M)
        if slug:
            words = [w for w in re.split(r"[-\s]+", (title.group(1) if title else slug.group(1)).lower())
                     if len(w) > 4]
            if words:
                feat_terms.append((slug.group(1), words))
note(f"{len(feat_terms)} feature page(s) available for matching")

def feature_match(text):
    t = text.lower()
    for slug, words in feat_terms:
        if sum(1 for w in words if w in t) >= 2:
            return slug
    return None

# --- filter 2: incident-cluster dedupe ---------------------------------------
def same_incident_as_published(chunk):
    """True if this chunk's own neighbourhood contains something we already shipped.

    We do not re-implement similarity here — we ask the daemon's hybrid pipeline,
    the same one that serves retrieval, so the notion of 'related' is the product's
    own and stays correct as the pipeline improves.
    """
    if not used:
        return False
    probe = " ".join(chunk["text"].split()[:28])
    try:
        out = subprocess.run(
            ["./vodou-core", "mem", "search", probe, "--top-k", "8", "--json"],
            capture_output=True, text=True, timeout=45,
        )
        if out.returncode != 0 or not out.stdout.strip():
            return False   # never let a search failure silently starve the queue
        hits = json.loads(out.stdout).get("results", [])
    except Exception:
        return False
    for h in hits[:6]:
        if h.get("chunk_id") in used:
            return True
    return False

out = []
for c in raw:
    text = c.get("text", "")
    pillar = pillar_of(text)
    feat = feature_match(text)
    c["pillar"] = pillar
    if feat:
        c["feature"] = feat
    c["score"] = int(c.get("score", 0)) + staleness_boost(pillar) + (30 if feat else 0)
    out.append(c)

out.sort(key=lambda c: -c["score"])

kept, checked = [], 0
for c in out:
    if len(kept) >= limit:
        break
    if do_sim and checked < limit * 2:
        checked += 1
        if same_incident_as_published(c):
            note(f"skip {c['id']} — same incident as a published post")
            continue
    kept.append(c)

note("pillar mix: " + json.dumps({p: sum(1 for k in kept if k["pillar"] == p) for p in
                                  sorted({k["pillar"] for k in kept})}))
print(json.dumps(kept, indent=2))
PYEOF
