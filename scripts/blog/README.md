# Vodou build-in-public blog pipeline

**Decision (2026-08-26):** own site is canonical, dev.to + Hashnode are syndication.
Every syndicated copy carries `canonical_url` / `originalArticleURL` back to
`BLOG_CANONICAL_BASE`, so Google consolidates ranking on Chad's domain instead of
ranking dev.to above him for his own writing.

## Pieces

| File | Does |
|---|---|
| `mine-topics.sh` | Ranks unpublished `GOTCHA/DEAD_END/METRIC/PATTERN/DECISION` chunks from `memory.db`. Skips any chunk already used as a post spine. |
| `write-post.sh` | Takes one chunk id, pulls related evidence through the daemon's hybrid search, drives the LLM to a full post in Chad's voice. Slot sets length. |
| `publish.mjs` | Posts to dev.to (REST) + Hashnode (GraphQL) with canonical back-links. Dry run unless `--live`. |
| `blog-run.sh` | mine → write → publish → work_log. What cron calls. |

## Schedule (cron is UTC)

| Task | Cron | Local (EDT) | Slot |
|---|---|---|---|
| `blog-morning` | `0 12 * * *` | 8:00am | anchor, 1100–1600 words |
| `blog-midday` | `0 17 * * *` | 1:00pm | build log, 500–800 |
| `blog-evening` | `0 23 * * *` | 7:00pm | TIL, 300–500 |

Registered in `script_registry` under server `vodou-blog`; scheduled in
`scheduled_tasks` as `mcp_tool` → `Vodou-script-executor.execute_script`.

## Going live

Drafts only until these are in `.env`:

```
BLOG_CANONICAL_BASE=https://blog.vodou.ai
BLOG_AUTOPUBLISH=1
DEVTO_API_KEY=...              # dev.to → Settings → Extensions → DEV API Keys
HASHNODE_TOKEN=...             # hashnode.com/settings/developer
HASHNODE_PUBLICATION_ID=...
```

Ledger: `.vodou/blog/ledger.json` — one entry per post, records the source chunk
ids so a story is never mined twice, and the live URLs so a rerun never
double-posts. Run log: `.vodou/blog/runs.log`.

## Manual

```bash
./scripts/blog/mine-topics.sh --limit 15        # what's in the queue
./scripts/blog/blog-run.sh morning              # draft now, dry-run publish
./scripts/blog/blog-run.sh morning --live       # draft + actually post
node scripts/blog/publish.mjs content/blog/<f>.md --live --only devto
```

## Hosting: blog.vodou.ai (S3 + CloudFront, no server)

Provisioned 2026-08-26. **Deliberately not EC2.** A blog is static HTML; an EC2
box would add an OS to patch, a web server to configure, a disk to fill, and a
single point of failure — in exchange for worse global TTFB than a CDN gives for
free. Core Web Vitals are a ranking signal, and a one-region t4g.nano loses that
fight to CloudFront's edge on every request.

| Piece | Value |
|---|---|
| S3 bucket | `blog-vodou-ai` (private, no public access, SSE-S3) |
| CloudFront | `E2BOGQFOWVOFZ9` → `d36vf24vh96txc.cloudfront.net` |
| Origin auth | Origin Access Control `ETYOROE3A8O75` (bucket is not public) |
| TLS | existing ACM wildcard `*.vodou.ai`, expires 2027-02-18 |
| Clean URLs | CloudFront Function `blog-vodou-ai-rewrite` (viewer-request) |
| DNS | Route53 `Z02723672K73VJI9AKM2T`, A + AAAA alias |
| Site source | `blog-site/` (Astro 5, static, zero client JS) |

The rewrite function exists because an S3 **REST** origin has no index-document
behavior on subpaths — `/some-post/` 403s without it. Astro is configured with
`build.format: 'directory'` so every post is a real `index.html`.

Running cost: pennies a month at low traffic, and the free tier covers the CDN.

### Deploy

```bash
scripts/blog/deploy-site.sh          # build → sync → invalidate
scripts/blog/deploy-site.sh --no-build
```

`blog-run.sh` calls it automatically **before** syndicating, and aborts the
syndication if it fails. That order is not cosmetic: if dev.to is indexed before
`blog.vodou.ai` serves the canonical URL, Google attributes the post to dev.to
and you become the copy of your own writing.

---

## Freshness guarantees (added 2026-08-26)

The three writer slots deploy the site themselves, but "the pipeline ran" and
"the site is current" are different claims, and they came apart on day one: four
posts sat in `content/blog` while the S3 bucket was empty and `blog.vodou.ai`
served `AccessDenied`. Four changes close that gap.

**1. One run at a time — `.vodou/blog/.run.lock`**
`mkdir` is atomic; the PID inside distinguishes "another run is working" from "a
run died holding the lock". Two morning runs raced on 2026-08-26, both mined the
same chunk before either wrote its ledger entry, and shipped two posts about one
incident. The chunk-id dedupe was correct — it just ran after the race. This is
an SEO guard as much as a correctness one: near-duplicate content gets demoted.

**2. A ceiling on the writer — `BLOG_WRITE_TIMEOUT` (default 900s)**
`write-post.sh` shells out to an LLM. With no timeout, two runs hung there and
the site went stale for hours. A hung writer must never block the deploy, so on
timeout the run logs a WARN and continues to the deploy step.

**3. Deploy is no longer conditional on producing a post**
The old runner returned early when the miner found nothing, which meant any post
that reached disk by another path never shipped. Now the run compares a content
fingerprint (`bt_content_hash`) against `.vodou/blog/.deployed_hash` and deploys
whenever they differ — regardless of what this slot wrote. `BLOG_FORCE_DEPLOY=1`
overrides.

**4. Deploys are verified, not assumed**
Every run curls `/` and the new post's own URL after deploying. A deploy that
reports success and serves a 403 is a failure mode we have already hit.

### `freshness.sh` — the watchdog

```
scripts/blog/freshness.sh          # report drift, exit 2 if drifted
scripts/blog/freshness.sh --fix    # redeploy on drift
```

Three checks, in order: the home page returns 200; every non-draft post on disk
has a live URL; the content fingerprint matches what was last shipped. It takes
the same lock as the writers, so it will never redeploy underneath a run in
progress — if a writer holds the lock, the watchdog stands down and lets that run
do the deploy.

Registered as `vodou-blog/blog-freshness` and scheduled `30 * * * *` (hourly, UTC,
offset from the writers). Worst case, the site is stale for one hour.

### Schedule

| Task | Cron (UTC) | Local | What it does |
|---|---|---|---|
| `blog-morning` | `0 12 * * *` | 8:00am | anchor post, 1100–1600w |
| `blog-midday` | `0 17 * * *` | 1:00pm | build log, 500–800w |
| `blog-evening` | `0 23 * * *` | 7:00pm | TIL, 300–500w |
| `blog-freshness` | `30 * * * *` | hourly | verify live site, redeploy on drift |

### Known gap

The ledger dedupes on **source chunk id**, not on incident. Two chunks describing
one bug still produce two posts — which is how
`prompt-caching-froze-my-system-prompt-so-my-edit-vanished` and
`why-my-llm-agent-fabricated-numbers-from-stale-context` both exist. The lock
prevents the concurrent case; the semantic case is still open.
