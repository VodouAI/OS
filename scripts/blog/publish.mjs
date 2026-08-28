#!/usr/bin/env node
/**
 * Vodou blog syndicator.
 *
 * Model: your own site is CANONICAL (owns the SEO), dev.to + Hashnode are
 * SYNDICATION (own the distribution). Every syndicated copy carries
 * canonical_url / originalArticleURL pointing home, so Google consolidates
 * ranking signal on your domain instead of splitting it or, worse, ranking
 * dev.to above you for your own writing.
 *
 * Usage:
 *   node scripts/blog/publish.mjs <file.md>                 # dry run (default)
 *   node scripts/blog/publish.mjs <file.md> --dry-run       # same, explicit
 *   node scripts/blog/publish.mjs <file.md> --live          # actually post
 *   node scripts/blog/publish.mjs <file.md> --live --only devto
 *
 * Env (put in .env — see scripts/blog/SETUP.md):
 *   BLOG_CANONICAL_BASE=https://blog.vodou.ai
 *   DEVTO_API_KEY=...            # dev.to → Settings → Extensions → DEV Community API Keys
 *   HASHNODE_TOKEN=...           # hashnode.com/settings/developer → Personal Access Token
 *   HASHNODE_PUBLICATION_ID=...  # ObjectId, NOT the blog host — preflight.sh prints it
 *
 * API contracts verified against live docs on 2026-08-26:
 *   dev.to   — https://developers.forem.com/api/v1
 *              POST /api/articles (create, 10 req/30s), PUT /api/articles/:id
 *              (update, 30 req/30s). Auth header is `api-key`, NOT Bearer.
 *              Accept: application/vnd.forem.api-v1+json is required by v1.
 *              Cover image field on write is `main_image` (reads back as
 *              `cover_image`). Canonical is `canonical_url`. Max 4 tags.
 *   Hashnode — https://apidocs.hashnode.com/ + github.com/hashnode/gql-skill
 *              Endpoint is https://gql-beta.hashnode.com/ . The older
 *              https://gql.hashnode.com/ now 301s to an announcement page and
 *              serves NO GraphQL (verified 2026-08-26) — pointing at it is a
 *              silent, total failure. Auth is `Authorization: Bearer <PAT>`.
 *              Canonical is `originalArticleURL`, cover is `coverImage`
 *              (a plain String on PublishPostInput — `coverImageOptions` exists
 *              only on CreateDraftInput and is rejected here). Max 15 tags.
 *              WRITE MUTATIONS REQUIRE THE PUBLICATION TO BE ON HASHNODE PRO
 *              (changelog 2026-05-13); without it every write returns FORBIDDEN.
 */
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const LIVE = args.includes('--live');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
if (!file) {
  console.error('usage: publish.mjs <file.md> [--dry-run|--live] [--only devto|hashnode]');
  process.exit(1);
}
if (ONLY && !['devto', 'hashnode'].includes(ONLY)) {
  console.error(`--only takes devto|hashnode, got ${JSON.stringify(ONLY)}`);
  process.exit(1);
}

const REDACTED = '<redacted>';
const TIMEOUT_MS = 30_000;

// .env loader — the repo keeps secrets there, not in the shell.
const envPath = path.resolve('.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ---------------------------------------------------------------------------
// post
// ---------------------------------------------------------------------------
const raw = fs.readFileSync(file, 'utf8');
const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
if (!fm) { console.error('no frontmatter in ' + file); process.exit(1); }
const meta = {};
for (const line of fm[1].split('\n')) {
  const m = line.match(/^(\w+):\s*(.*)$/);
  if (!m) continue;
  let v = m[2].trim().replace(/^["']|["']$/g, '');
  if (v.startsWith('[')) v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  meta[m[1]] = v;
}
const sourceBody = fm[2].trim();

// ---------------------------------------------------------------------------
// body: the built SYNDICATION twin, /syndication/<slug>.md
//
// A post body may contain ```vodou-diagram fences. Those are a SPEC, not
// content: the remark plugin renders them to inline SVG for the page. dev.to
// has no such plugin, so syndicating the source body ships walls of raw JSON
// where the figures should be, on the exact posts we most want read.
//
// The syndication twin is that same spec rendered to a markdown image pointing
// at the build-time PNG of the figure (src/pages/diagrams/[id].png.ts). One
// geometry engine, three outputs: inline SVG for the page, ASCII for the
// machine twin at /<slug>.md, PNG here, because a dev.to reader is a human
// looking at a page with none of our CSS. The twin also carries the canonical
// attribution footer, which the source markdown does not.
//
// It must be FRESH. A dist/ older than the source would silently syndicate a
// previous draft, and "published something I didn't write" is unrecoverable in
// a way a failed publish is not. So a stale or missing twin is fatal, never a
// silent fallback to the source body.
// ---------------------------------------------------------------------------
const TWIN_PATH = path.resolve('blog-site/dist/syndication', `${meta.slug}.md`);
const hasDiagrams = /^```vodou-diagram\s*$/m.test(sourceBody);

function twinBody() {
  if (!fs.existsSync(TWIN_PATH)) return { ok: false, why: `no built twin at ${TWIN_PATH}` };
  const srcMtime = fs.statSync(file).mtimeMs;
  const twinMtime = fs.statSync(TWIN_PATH).mtimeMs;
  if (twinMtime < srcMtime) {
    return { ok: false, why: `${TWIN_PATH} is older than ${file} (twin ${new Date(twinMtime).toISOString()} < source ${new Date(srcMtime).toISOString()})` };
  }
  const t = fs.readFileSync(TWIN_PATH, 'utf8');
  const sep = t.indexOf('\n---\n');
  if (sep < 0) return { ok: false, why: `${TWIN_PATH} has no header separator — cannot locate its body` };
  const b = t.slice(sep + 5).trim();
  if (!b) return { ok: false, why: `${TWIN_PATH} body is empty` };
  return { ok: true, body: b };
}

const twin = twinBody();
if (!twin.ok && hasDiagrams) {
  console.error(
    `REFUSING TO SYNDICATE: ${meta.slug} contains vodou-diagram specs but the built .md twin is unusable.\n` +
    `  ${twin.why}\n\n` +
    `Without the twin, dev.to/Hashnode would receive the raw diagram JSON instead of the figures.\n` +
    `Run: (cd blog-site && npm run build)   then re-run this command.`,
  );
  process.exit(5);
}
if (!twin.ok) {
  console.error(`note: using source body — ${twin.why} (no diagrams in this post, so nothing renders wrong)`);
}
const body = twin.ok ? twin.body : sourceBody;

for (const req of ['title', 'slug', 'description']) {
  if (!meta[req]) { console.error(`frontmatter is missing required field \`${req}\` in ${file}`); process.exit(1); }
}

// Forem treats YAML front matter at the top of body_markdown as the source of
// truth and then silently IGNORES the API fields for title/tags/cover on every
// subsequent update — a 200 that changes nothing. We always send the body with
// frontmatter stripped; this asserts that stayed true.
if (/^---\s*$/.test(body.split('\n')[0] ?? '')) {
  console.error('body starts with `---`: dev.to would parse it as front matter and ignore the API fields. Refusing.');
  process.exit(1);
}

const base = (process.env.BLOG_CANONICAL_BASE || 'https://blog.vodou.ai').replace(/\/$/, '');
const canonical = `${base}/${meta.slug}`;

// Tags: dev.to caps at 4 and requires lowercase alphanumeric; Hashnode allows 15.
const allTags = (Array.isArray(meta.tags) ? meta.tags : [])
  .map((t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, ''))
  .filter(Boolean);
const devtoTags = [...new Set(allTags)].slice(0, 4);
const hashnodeTags = [...new Set(allTags)].slice(0, 15);

// Cover image. Every post has a build-time OG card, and the frontmatter
// `cover_image` is written empty by the pipeline, so relying on it meant every
// syndicated post shipped with no image, which is most of the reach on both
// platforms.
//
// The filename is NOT spelled here. It used to be `/og/<slug>.png`, and when
// the cards became content-addressed to defeat dev.to's re-host cache that
// path started 404ing at origin while all ten published covers kept serving
// 200 from dev.to's own bucket. Two records of one image, disagreeing, with a
// green publish: the redraw simply never reached a reader. So the path is read
// from /og/manifest.json, the same registry the pages render from, and an
// unknown slug is fatal rather than a guess.
async function resolveCover() {
  const explicit = typeof meta.cover_image === 'string' && meta.cover_image.trim();
  if (explicit) return meta.cover_image.trim();
  const url = `${base}/og/manifest.json`;
  let j;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    j = await r.json();
  } catch (e) {
    console.error(`FATAL: cannot read the OG card registry at ${url}: ${e.message || e}`);
    console.error('Deploy the site before syndicating; the cover path has no second source.');
    process.exit(3);
  }
  const entry = j?.og?.[meta.slug];
  if (!entry?.path) {
    console.error(`FATAL: no OG card registered for slug "${meta.slug}" in ${url}.`);
    console.error(`Registered: ${Object.keys(j?.og || {}).length} card(s). Rebuild and redeploy the site.`);
    process.exit(3);
  }
  return `${base}${entry.path}`;
}
const coverImage = await resolveCover();

// ---------------------------------------------------------------------------
// http helpers
// ---------------------------------------------------------------------------
class SyndicationError extends Error {}

/** Retry-After is documented as seconds but dev.to also sends an HTTP-date. */
function retryAfterMs(header, fallback = 30_000) {
  if (!header) return fallback;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  const at = Date.parse(header);
  if (Number.isFinite(at) && at - Date.now() > 0) return at - Date.now();
  return fallback;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(label, url, init, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new SyndicationError(`${label}: network error calling ${url}: ${e.message || e}`);
    }
    const text = await r.text();
    if (r.status === 429 && attempt < retries) {
      const wait = retryAfterMs(r.headers.get('retry-after'));
      console.error(`[${label}] 429 rate limited, waiting ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${retries})`);
      await sleep(wait);
      continue;
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body, keep the text */ }
    return { ok: r.ok, status: r.status, json, text };
  }
}

/** Body is printed on failure. Never contains the key — headers are separate. */
function fail(label, res, hint) {
  const snippet = (res.text || '').trim().slice(0, 800) || '(empty response body)';
  throw new SyndicationError(
    `${label}: HTTP ${res.status}\n--- response body ---\n${snippet}\n---------------------` +
    (hint ? `\nhint: ${hint}` : ''),
  );
}

// ---------------------------------------------------------------------------
// canonical gate
//
// This is a HARD gate, not a warning. If the canonical URL is not live when a
// syndicated copy appears, Google attributes the piece to dev.to/Hashnode and
// that attribution does not come back when the canonical shows up later. There
// is no undo, so we refuse to write anything until the origin answers 200.
// ---------------------------------------------------------------------------
async function checkCanonical() {
  let last = { ok: false, url: canonical, status: 0, error: 'not probed' };
  for (const url of [canonical, `${canonical}/`]) {
    try {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
      const ct = r.headers.get('content-type') || '';
      if (r.status === 200 && ct.includes('text/html')) return { ok: true, url, status: 200, content_type: ct };
      last = { ok: false, url, status: r.status, content_type: ct };
    } catch (e) {
      last = { ok: false, url, status: 0, error: String(e.message || e) };
    }
  }
  return last;
}

// ---------------------------------------------------------------------------
// image gate
//
// dev.to does not hotlink. It FETCHES every image in the body at publish time
// and re-hosts it on its own bucket, so a URL that 404s in that instant becomes
// a permanently broken figure in the syndicated copy — the write still returns
// 200 and reports success. The site deploy runs before syndication precisely so
// this cannot happen, but "cannot happen" is what the last four bugs said, and
// the cost of checking is one HEAD per figure.
//
// Only our own host is checked: a 404 on someone else's image is their problem
// and not worth failing a publish over.
// ---------------------------------------------------------------------------
async function checkBodyImages() {
  // The cover is checked here too. It was the ONE image on our host the gate
  // did not look at, and it is the one every reader sees first — which is
  // exactly how a 404ing cover path survived ten publishes reporting `ok`.
  const urls = [coverImage, ...[...body.matchAll(/!\[[^\]]*\]\((\S+?)\)/g)].map((m) => m[1])]
    .filter((u) => typeof u === 'string' && u.startsWith(base));
  const bad = [];
  for (const u of [...new Set(urls)]) {
    try {
      const r = await fetch(u, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
      const ct = r.headers.get('content-type') || '';
      if (r.status !== 200 || !ct.startsWith('image/')) bad.push(`${u} -> ${r.status} ${ct || '(no content-type)'}`);
    } catch (e) {
      bad.push(`${u} -> ${String(e.message || e)}`);
    }
  }
  return { checked: urls.length, bad };
}

// ---------------------------------------------------------------------------
// dev.to
// ---------------------------------------------------------------------------
const DEVTO_API = 'https://dev.to/api';
const devtoHeaders = (key) => ({
  'api-key': key,
  'Content-Type': 'application/json',
  // v1 is selected by the Accept header. Without it Forem may answer with a
  // different (v0) representation, which is how "the field I sent vanished" bugs start.
  Accept: 'application/vnd.forem.api-v1+json',
  'User-Agent': 'vodou-blog-syndicator/1.0 (+https://blog.vodou.ai)',
});

function devtoPayload() {
  return {
    article: {
      title: meta.title,
      body_markdown: body,
      published: true,
      tags: devtoTags,
      description: meta.description,
      canonical_url: canonical,
      main_image: coverImage,
      // Explicitly NOT in a series. Omitting the field means "leave whatever
      // is already there", so dropping it from the payload would have left the
      // ten already-grouped posts grouped forever. `null` is the only value
      // that detaches an article from its collection, and sending it on every
      // write means a series can never be acquired by accident either.
      series: null,
    },
  };
}

async function devto(existingId) {
  const key = process.env.DEVTO_API_KEY;
  if (!key) return { skipped: 'DEVTO_API_KEY not set' };

  const payload = devtoPayload();
  const create = !existingId;
  const url = create ? `${DEVTO_API}/articles` : `${DEVTO_API}/articles/${existingId}`;
  const method = create ? 'POST' : 'PUT';

  if (!LIVE) {
    return {
      dry_run: true,
      action: create ? 'create' : `update id=${existingId}`,
      endpoint: `${method} ${url}`,
      headers: devtoHeaders(REDACTED),
      payload,
    };
  }

  const res = await request('dev.to', url, { method, headers: devtoHeaders(key), body: JSON.stringify(payload) });
  if (!res.ok) {
    fail('dev.to', res,
      res.status === 401 ? 'DEVTO_API_KEY is missing, revoked, or wrong — regenerate at dev.to → Settings → Extensions.'
      : res.status === 404 && !create ? `article id ${existingId} does not exist on this account — clear targets.devto in .vodou/blog/ledger.json to re-create.`
      : res.status === 422 ? 'unprocessable: usually a duplicate title, a bad tag, or an unreachable main_image URL.'
      : undefined);
  }
  const a = res.json || {};
  if (!a.id) fail('dev.to', res, 'response had no article id — treating as a failure rather than reporting success.');

  // Read the article back and assert the one field that is unrecoverable if it
  // did not stick. Forem returns 200 for writes it silently ignored.
  const back = await request('dev.to readback', `${DEVTO_API}/articles/${a.id}`, { headers: devtoHeaders(key) });
  const stored = back.json?.canonical_url ?? null;
  if (create && stored !== canonical) {
    fail('dev.to', back, `canonical_url did not stick: sent ${canonical}, stored ${JSON.stringify(stored)}. Unpublish the dev.to copy before Google crawls it.`);
  }

  return {
    action: create ? 'created' : 'updated',
    id: a.id,
    url: a.url,
    canonical_url: stored,
    cover_image: back.json?.cover_image ?? null,
    tags: back.json?.tag_list ?? null,
  };
}

// ---------------------------------------------------------------------------
// Hashnode
// ---------------------------------------------------------------------------
const HASHNODE_API = (process.env.HASHNODE_GQL_ENDPOINT || 'https://gql-beta.hashnode.com/').replace(/\/?$/, '/');
const hashnodeHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  'User-Agent': 'vodou-blog-syndicator/1.0 (+https://blog.vodou.ai)',
});

const PUBLISH_MUTATION = `mutation Publish($input: PublishPostInput!) {
  publishPost(input: $input) { post { id slug url canonicalUrl } }
}`;
const UPDATE_MUTATION = `mutation Update($input: UpdatePostInput!) {
  updatePost(input: $input) { post { id slug url canonicalUrl } }
}`;

function hashnodeInput(existingId) {
  const shared = {
    title: meta.title,
    contentMarkdown: body,
    slug: meta.slug,
    tags: hashnodeTags.map((t) => ({ slug: t, name: t })),
    originalArticleURL: canonical,
    coverImage,
    metaTitle: meta.title,
    metaDescription: meta.description,
    ogImage: coverImage,
  };
  return existingId
    ? { id: existingId, ...shared }
    : { publicationId: process.env.HASHNODE_PUBLICATION_ID, ...shared };
}

async function hashnode(existingId) {
  const token = process.env.HASHNODE_TOKEN;
  const pub = process.env.HASHNODE_PUBLICATION_ID;
  if (!token) return { skipped: 'HASHNODE_TOKEN not set' };
  if (!pub && !existingId) return { skipped: 'HASHNODE_PUBLICATION_ID not set' };

  const create = !existingId;
  const query = create ? PUBLISH_MUTATION : UPDATE_MUTATION;
  const variables = { input: hashnodeInput(existingId) };
  const bodyJson = JSON.stringify({ query, variables });

  // gql-beta rejects request bodies over 100 KB outright.
  const bytes = Buffer.byteLength(bodyJson, 'utf8');
  if (bytes > 100_000) {
    throw new SyndicationError(`hashnode: request body is ${bytes} bytes, over the documented 100 KB limit. Post is too long to syndicate as-is.`);
  }

  if (!LIVE) {
    return {
      dry_run: true,
      action: create ? 'publishPost' : `updatePost id=${existingId}`,
      endpoint: `POST ${HASHNODE_API}`,
      headers: { ...hashnodeHeaders(REDACTED), Authorization: `Bearer ${REDACTED}` },
      request_bytes: bytes,
      payload: { query, variables },
    };
  }

  const res = await request('hashnode', HASHNODE_API, { method: 'POST', headers: hashnodeHeaders(token), body: bodyJson });
  if (!res.ok) {
    fail('hashnode', res, res.status === 301 || res.status === 302
      ? `endpoint redirected — ${HASHNODE_API} is not a GraphQL endpoint. The current one is https://gql-beta.hashnode.com/ .`
      : undefined);
  }
  const j = res.json;
  if (!j) fail('hashnode', res, 'response was not JSON.');
  if (j.errors?.length) {
    const codes = j.errors.map((e) => e?.extensions?.code).filter(Boolean).join(',');
    const msgs = j.errors.map((e) => e?.message).join(' | ');
    const pro = /active Pro plan/i.test(msgs);
    throw new SyndicationError(
      `hashnode: GraphQL errors [${codes || 'no code'}]\n--- response body ---\n${res.text.slice(0, 800)}\n---------------------\n` +
      `hint: ${pro
        ? 'this publication is not on Hashnode Pro. Since 2026-05-13 every write mutation is Pro-gated; retrying will not help. Upgrade the publication or run with --only devto.'
        : codes.includes('UNAUTHENTICATED') ? 'HASHNODE_TOKEN is missing, expired, or revoked.'
        : codes.includes('BAD_USER_INPUT') ? 'check HASHNODE_PUBLICATION_ID (an ObjectId, not the blog host) and the tag slugs.'
        : 'see message above.'}`,
    );
  }
  const post = create ? j.data?.publishPost?.post : j.data?.updatePost?.post;
  if (!post?.id) fail('hashnode', res, 'mutation returned no post — treating as a failure rather than reporting success.');
  if (create && post.canonicalUrl && post.canonicalUrl !== canonical) {
    throw new SyndicationError(`hashnode: originalArticleURL did not stick: sent ${canonical}, stored ${post.canonicalUrl}. Delete the Hashnode copy before it is crawled.`);
  }
  return { action: create ? 'created' : 'updated', id: post.id, url: post.url, canonical_url: post.canonicalUrl ?? null };
}

// ---------------------------------------------------------------------------
// ledger — the idempotency key. targets.<name>.id is what turns a re-run into
// an UPDATE instead of a second copy competing with the first for the same query.
// ---------------------------------------------------------------------------
const LEDGER_PATH = '.vodou/blog/ledger.json';
function loadLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return { published: [] };
  try { return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')); }
  catch (e) { throw new SyndicationError(`ledger ${LEDGER_PATH} is not valid JSON (${e.message}). Refusing to run — a bad ledger means duplicate posts.`); }
}
function saveLedger(l) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  const tmp = `${LEDGER_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(l, null, 2) + '\n');
  fs.renameSync(tmp, LEDGER_PATH);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const ledger = loadLedger();
let entry = ledger.published.find((p) => p.file === file);
if (!entry) { entry = { file, source_chunk_ids: [] }; ledger.published.push(entry); }
entry.title = meta.title;
entry.canonical = canonical;
entry.targets = entry.targets || {};

const want = (t) => !ONLY || ONLY === t;
const results = {};

// ---------------------------------------------------------------------------
// retired-slug gate
//
// checkCanonical() follows redirects, so a post that has been merged away and
// now 301s would sail through it: the fetch lands on the SURVIVING post, sees
// 200 text/html, and reports the canonical live. Syndicating that slug ships a
// canonical_url that immediately redirects, and — worse — publishes a near
// duplicate of the surviving post, which is the exact thing the merge removed.
//
// redirects.json is the one source of truth the sitemap, llms.txt and
// src/lib/posts.ts already read. This is the fourth reader, not a fifth copy.
// Reading it must FAIL LOUD: a silently-empty redirect map is how the home page
// ended up linking a 301 for a whole morning.
// ---------------------------------------------------------------------------
const REDIRECTS_PATH = path.resolve('blog-site/redirects.json');
function retiredSlugs() {
  if (!fs.existsSync(REDIRECTS_PATH)) {
    throw new SyndicationError(`redirects.json not found at ${REDIRECTS_PATH} — refusing to syndicate without the redirect map, because a retired slug would look healthy.`);
  }
  const parsed = JSON.parse(fs.readFileSync(REDIRECTS_PATH, 'utf8'));
  const map = parsed.redirects;
  if (!map || typeof map !== 'object') {
    throw new SyndicationError('redirects.json has no `redirects` object — refusing to syndicate against an unreadable redirect map.');
  }
  return new Set(Object.keys(map).map((k) => k.replace(/^\/|\/$/g, '')));
}

const retired = retiredSlugs();
if (retired.has(meta.slug)) {
  console.error(
    `REFUSING TO SYNDICATE: ${meta.slug} is a retired slug — blog-site/redirects.json 301s it to ` +
    `${JSON.stringify(Object.entries(JSON.parse(fs.readFileSync(REDIRECTS_PATH, 'utf8')).redirects).find(([k]) => k.replace(/^\/|\/$/g, '') === meta.slug)?.[1])}.\n` +
    `Syndicate the surviving post instead. The canonical probe passes for this slug only because it follows the redirect.`,
  );
  process.exit(4);
}

const canonicalCheck = await checkCanonical();
results._canonical_check = canonicalCheck;
if (!canonicalCheck.ok) {
  const detail = canonicalCheck.error
    ? `${canonicalCheck.url} → ${canonicalCheck.error}`
    : `${canonicalCheck.url} → HTTP ${canonicalCheck.status} (content-type ${canonicalCheck.content_type || 'none'})`;
  if (LIVE) {
    console.error(
      `REFUSING TO SYNDICATE: canonical URL is not live.\n  ${detail}\n\n` +
      `Syndicating before the canonical exists hands Google the attribution to dev.to/Hashnode permanently.\n` +
      `Deploy the site first (scripts/blog/deploy-site.sh), confirm the URL returns 200, then re-run.`,
    );
    process.exit(2);
  }
  console.error(`WARNING (dry run, not fatal): canonical URL is not live yet — ${detail}\n  A --live run would refuse here.\n`);
}

const imageCheck = await checkBodyImages();
results._image_check = imageCheck;
if (imageCheck.bad.length) {
  const detail = imageCheck.bad.map((b) => `  ${b}`).join('\n');
  if (LIVE) {
    console.error(
      `REFUSING TO SYNDICATE: ${imageCheck.bad.length} of ${imageCheck.checked} figure(s) are not live.\n${detail}\n\n` +
      `dev.to re-hosts every image at publish time, so these would become permanently broken figures ` +
      `in a copy that still reports success. Deploy the site first, then re-run.`,
    );
    process.exit(3);
  }
  console.error(`WARNING (dry run, not fatal): ${imageCheck.bad.length} figure(s) are not live —\n${detail}\n  A --live run would refuse here.\n`);
}

let hadError = false;
for (const [name, fn] of [['devto', devto], ['hashnode', hashnode]]) {
  if (!want(name)) continue;
  const existingId = entry.targets?.[name]?.id ?? null;
  try {
    results[name] = await fn(existingId);
  } catch (e) {
    hadError = true;
    results[name] = { error: String(e.message || e) };
    console.error(`\n[FAIL] ${name}\n${e.message || e}\n`);
  }
}

if (LIVE) {
  entry.status = 'published';
  for (const name of ['devto', 'hashnode']) {
    const r = results[name];
    if (r && r.id) entry.targets[name] = { id: r.id, url: r.url, canonical_url: r.canonical_url ?? null, updated_at: new Date().toISOString() };
  }
}
saveLedger(ledger);

console.log(JSON.stringify({
  file,
  title: meta.title,
  canonical,
  cover_image: coverImage,
  tags: { devto: devtoTags, hashnode: hashnodeTags },
  mode: LIVE ? 'live' : 'dry-run',
  results,
}, null, 2));

if (hadError) {
  console.error('\none or more targets FAILED — see the errors above. Nothing was reported as published for them.');
  process.exit(1);
}
