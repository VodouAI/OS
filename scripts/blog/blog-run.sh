#!/usr/bin/env bash
#
# Vodou daily blog runner — the thing cron calls.
#
#   pick a lane  →  write the post  →  deploy the canonical site
#   →  syndicate  →  verify it is actually live.
#
# Usage: scripts/blog/blog-run.sh [morning|midday|evening] [--live]
#        scripts/blog/blog-run.sh feature            # force the feature lane
#        BLOG_LANE=incident scripts/blog/blog-run.sh morning
#
# TWO LANES, AND THE ORDER BETWEEN THEM IS THE POINT
#
#   feature lane   one post per major capability Vodou ships. Event-driven:
#                  it fires when something actually shipped, and produces
#                  NOTHING when nothing did. A launch post about a launch that
#                  did not happen is the single worst thing this pipeline could
#                  emit — it destroys exactly the credibility the blog exists to
#                  build. So the feature lane is allowed to return empty, and
#                  the runner treats that as a normal outcome, not a failure.
#
#   incident lane  the debugging war story mined from memory.db. Always has
#                  material (52k chunks and counting), so it is the fallback
#                  that keeps the cadence up between ships.
#
# FEATURE FIRST, ALWAYS. Features are perishable — a capability is interesting
# the week it lands and is a changelog entry a month later. Incidents keep. So
# every slot asks "did we ship something unposted?" before it asks "what broke?"
# The alternative (a separate cron for features) was rejected: it would double
# the number of runs that can race for the lock, and a feature that shipped at
# 14:00 would sit unposted until its own slot came round anyway.
#
# Without --live the post is drafted and the exact dev.to/Hashnode payloads are
# printed rather than sent. That is the safe default: a bad post is cheap, a bad
# PUBLISHED post is not. The SITE deploys either way — the canonical domain is
# always kept current; syndication is what waits on your trust.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source scripts/blog/lib.sh

SLOT="${1:-morning}"
LANE="${BLOG_LANE:-auto}"
# `blog-run.sh feature` is a lane request, not a slot name. Normalise it so cron
# entries and humans can both say the obvious thing.
if [[ "$SLOT" == "feature" ]]; then LANE="feature"; SLOT="feature"; fi

# The daemon loads .env ONCE at startup, so a flag flipped in .env does not reach
# a scheduled run until the daemon restarts. That turns "syndication is held" into
# a belief rather than a fact -- the file says 0, the run publishes anyway. Read
# the file, which is the thing a human edits. An explicit BLOG_AUTOPUBLISH= in the
# environment still wins, for one-off runs that want to override the file.
if [[ -z "${BLOG_AUTOPUBLISH_ENV_WINS:-}" && -f .env ]]; then
  _ap=$(sed -nE 's/^BLOG_AUTOPUBLISH=[\"'"'"']?([^\"'"'"'[:space:]#]*).*/\1/p' .env | tail -1)
  [[ -n "$_ap" ]] && BLOG_AUTOPUBLISH="$_ap"
fi

LIVE_FLAG=""
[[ "${2:-}" == "--live" || "${BLOG_AUTOPUBLISH:-0}" == "1" ]] && LIVE_FLAG="--live"

LOG=".vodou/blog/runs.log"
LOCK=".vodou/blog/.run.lock"
WRITE_TIMEOUT="${BLOG_WRITE_TIMEOUT:-900}"
mkdir -p .vodou/blog content/blog
say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$SLOT] $*" | tee -a "$LOG"; }

# One run at a time. Two morning runs raced on 2026-08-26, mined the same chunk
# before either wrote its ledger entry, and shipped two posts about one bug.
# Near-duplicate content is exactly what Google demotes, so this is an SEO guard
# as much as a correctness one. It matters MORE now that there are two lanes:
# without it, a feature run and an incident run could both be mid-flight and
# neither would see the other's ledger entry.
if ! bt_lock_acquire "$LOCK" 1800; then
  say "another blog run holds the lock (pid $(cat "$LOCK/pid" 2>/dev/null)) — exiting"
  # 4, not 0. Five manual fires on 2026-08-27 collided with a live run and each
  # returned 0 in under a second, indistinguishable from "quiet slot" to every
  # consumer of the exit code. Stepping aside is its own outcome.
  exit 4
fi
trap 'bt_lock_release "$LOCK"' EXIT

POST=""
WROTE_LANE=""

# WHY A SLOT NEEDS TWO KINDS OF "no post" (2026-08-26)
# On 2026-08-26 the 08:00 slot ran both writers, both exited rc=1 in ~20s, and
# this script still exited 0 — because "produced nothing" is a legitimate
# outcome here (the feature lane is allowed to be empty). script_jobs recorded
# `completed`, the scheduler recorded `did_the_job`, and a crashed writer was
# rendered identically to a quiet day at every layer above.
#
# The two cases are genuinely different and now carry different exit codes:
#   0  nothing to publish (no unposted feature, no unmined chunk) — normal
#   0  a post shipped
#   2  a draft existed and the redaction gate blocked it — the gate WORKING
#   3  a writer we invoked FAILED or timed out — the slot lost work
#   1  infra: deploy or verify failed (pre-existing meaning, unchanged)
#   4  another run held the lock — this fire stepped aside, nothing was attempted
# Anything reading this script's status can now tell "quiet" from "broken".
WRITER_FAILED=0
GATE_BLOCKED=0

# --- lane 1: did we ship a feature nobody has written about? -----------------
#
# mine-features.sh is ledger-aware and returns [] when every shipped feature
# already has a post. Empty is the EXPECTED case most days — most days nothing
# major ships. Treat a miner failure the same as empty and fall through to the
# incident lane, because a broken feature miner must never be able to take the
# whole daily cadence down with it.
if [[ "$LANE" == "auto" || "$LANE" == "feature" ]]; then
  say "checking for unposted shipped features"
  FEATURES=$(bt_timeout 180 ./scripts/blog/mine-features.sh --limit 4 2>>"$LOG" || echo '[]')
  FEATURE_JSON=".vodou/blog/.feature.json"
  FEATURE_KEY=$(printf '%s' "$FEATURES" | python3 -c "
import json,sys
try: c = json.load(sys.stdin)
except Exception: c = []
if c:
    json.dump(c[0], open('$FEATURE_JSON','w'), indent=2)
    print(c[0].get('feature_key',''))
" 2>/dev/null || echo "")

  if [[ -n "$FEATURE_KEY" ]]; then
    say "feature: $FEATURE_KEY — writing launch post (timeout ${WRITE_TIMEOUT}s)"
    # stderr -> runs.log: on 2026-08-26 08:01 both writers exited rc=1 in 20s and
    # the reason went to the void, so a cron slot that produced nothing looked
    # identical to a slot with nothing to say.
    if POST=$(bt_timeout "$WRITE_TIMEOUT" ./scripts/blog/write-feature-post.sh \
                --feature-json "$FEATURE_JSON" --slot "$SLOT" 2>>"$LOG"); then
      WROTE_LANE="feature"
      say "drafted (feature): $POST"
    else
      rc=$?
      POST=""
      # rc 2 is reserved by write-feature-post.sh for "redaction gate blocked
      # this draft". That is the gate WORKING, not a pipeline fault, and it must
      # be loud in the log — a silently-dropped feature post looks identical to
      # "nothing shipped" and we would never investigate.
      if [[ $rc -eq 2 ]]; then
        GATE_BLOCKED=1
        say "BLOCKED: redaction gate rejected the $FEATURE_KEY draft — not published, see log above"
      else
        WRITER_FAILED=1
        say "WARN: feature writer failed/timed out (rc=$rc) — falling back to the incident lane"
      fi
    fi
  else
    say "no unposted shipped features — this is normal; falling through"
  fi
fi

# --- lane 2: the incident war story ------------------------------------------
if [[ -z "$POST" && "$LANE" != "feature" ]]; then
  say "mining topics"
  CANDIDATES=$(./scripts/blog/mine-topics.sh --limit 8)
  CHUNK=$(printf '%s' "$CANDIDATES" | python3 -c "
import json,sys
try: c = json.load(sys.stdin)
except Exception: c = []
print(c[0]['id'] if c else '')
")

  if [[ -z "$CHUNK" ]]; then
    say "no unpublished material in the window — no new post this slot"
  else
    say "spine chunk: $CHUNK"
    say "writing post (timeout ${WRITE_TIMEOUT}s)"
    # The writer shells out to an LLM. On 2026-08-26 two runs hung there with no
    # ceiling and the site went stale for hours. A hung writer must never be able
    # to block the deploy.
    if POST=$(bt_timeout "$WRITE_TIMEOUT" ./scripts/blog/write-post.sh "$CHUNK" --slot "$SLOT" 2>>"$LOG"); then
      WROTE_LANE="incident"
      say "drafted: $POST"
    else
      rc=$?
      POST=""
      # The message must discriminate the same way the FLAG does. It used to
      # say "writer failed/timed out" for every rc including 2, so the 19:00
      # slot on 2026-08-26 logged a writer fault when what actually happened
      # was a finished, rubric-passing draft stopped by the redaction gate --
      # the far more actionable half, thrown away at the only surface anyone
      # reads. The feature lane above already discriminated; this one did not.
      if [[ $rc -eq 2 ]]; then
        GATE_BLOCKED=1
        say "BLOCKED: redaction gate rejected the incident draft — not published, see the findings above"
      else
        WRITER_FAILED=1
        say "WARN: writer failed/timed out (rc=$rc) — continuing to deploy whatever is on disk"
      fi
    fi
  fi
fi

# Canonical first, syndication second. If dev.to gets indexed before
# blog.vodou.ai serves the canonical URL, Google attributes the piece to dev.to
# and you are permanently the copy of your own post.
#
# This runs UNCONDITIONALLY when content changed — including when this slot
# produced no new post. The old version returned early on an empty mine, which
# meant any post that reached disk by another path never shipped.
AFTER_HASH=$(bt_site_hash)
LAST_DEPLOYED=$(cat .vodou/blog/.deployed_hash 2>/dev/null || echo "")

if [[ "$AFTER_HASH" == "$LAST_DEPLOYED" && "${BLOG_FORCE_DEPLOY:-0}" != "1" ]]; then
  say "site already matches content ($AFTER_HASH) — skipping deploy"
else
  say "deploying canonical site"
  if ./scripts/blog/deploy-site.sh >>"$LOG" 2>&1; then
    printf '%s' "$AFTER_HASH" > .vodou/blog/.deployed_hash
    say "canonical live: https://blog.vodou.ai"
  else
    say "FATAL: site deploy failed — skipping syndication so we do not orphan the canonical URL"
    exit 1
  fi
fi

# Prove it. A deploy that reports success and serves a 403 is the failure mode
# we already hit once; asserting the home page AND this post's own URL is the
# only thing that distinguishes "shipped" from "said it shipped".
verify() {
  local url="$1" code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$url" || echo 000)
  say "verify $url -> $code"
  [[ "$code" == "200" ]]
}
verify "https://blog.vodou.ai/" || { say "FATAL: home page not 200 after deploy"; exit 1; }

# /built is the capability hub — the page that makes the individual feature
# posts rank, and the one Chad sends people to. A feature post that ships while
# its own index 404s is worse than not shipping it.
if [[ "$WROTE_LANE" == "feature" ]]; then
  verify "https://blog.vodou.ai/built/" || say "WARN: /built not 200 after a feature post shipped"
fi

if [[ -n "$POST" ]]; then
  # Defence in depth: a writer is contracted to print ONE line (the post path),
  # but a stray stdout write upstream turned $POST into "8\ncontent/blog/...",
  # sed failed on the bogus filename, $SLUG came back empty, and the per-post
  # live-URL check quietly did nothing while the run still exited 0. Take the
  # last line, and treat an unreadable path as a hard failure rather than as an
  # absent post — the whole point of this block is that it cannot no-op.
  POST=$(printf '%s\n' "$POST" | tail -1)
  if [[ ! -f "$POST" ]]; then
    say "FATAL: writer returned a path that is not a file: '$POST'"
    exit 1
  fi
  SLUG=$(sed -n 's/^slug: *"\{0,1\}\([a-z0-9-]*\)"\{0,1\}.*/\1/p' "$POST" | head -1)
  if [[ -z "$SLUG" ]]; then
    say "FATAL: no slug in frontmatter of $POST — the post cannot be verified or syndicated"
    exit 1
  fi
  verify "https://blog.vodou.ai/$SLUG/" \
    || say "WARN: new post URL not yet 200 (CloudFront invalidation may still be in flight)"

  say "publishing ${LIVE_FLAG:-(dry run)}"
  node scripts/blog/publish.mjs "$POST" $LIVE_FLAG | tee -a "$LOG"

  sqlite3 vodou-core.db "INSERT INTO work_logs (message, category, source)
    VALUES ('blog: $SLOT $WROTE_LANE post -> $POST', 'content', 'blog-run');" 2>/dev/null || true
else
  say "no new post to syndicate this slot"
fi

say "done"

# The deploy and the verify above already exit 1 on their own faults. What is
# left is the writer's verdict, and it is reported LAST so that a failed writer
# never stops the site from being deployed and proven — a broken slot must not
# also leave the canonical domain stale.
#
# BOTH conditions are reported, then one exit code is chosen. A slot can set
# both flags -- on 2026-08-26 the feature writer crashed AND the incident
# writer's draft was gate-blocked -- and the first version returned on
# WRITER_FAILED, so the exit code and the last log line together said "a writer
# crashed" and never mentioned that 703 rubric-passing words had been stopped
# for naming src/daemon.rs. An exit code can only carry one number; the log
# does not have that excuse.
if [[ -z "$POST" && $GATE_BLOCKED -eq 1 ]]; then
  say "SLOT BLOCKED: a draft existed and the redaction gate rejected it — quarantined under .vodou/blog/blocked/"
fi
if [[ -z "$POST" && $WRITER_FAILED -eq 1 ]]; then
  say "SLOT FAILED: a writer was invoked and did not produce a post — this slot lost work"
  exit 3
fi
if [[ -z "$POST" && $GATE_BLOCKED -eq 1 ]]; then
  exit 2
fi
exit 0
