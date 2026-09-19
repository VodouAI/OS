#!/usr/bin/env node
// reddit-thread-scan — read-only scan of promo-permitted subreddits (SOCIAL/channels.md §4)
// for threads Vodou could honestly reply to, plus competitor launches (read-only).
//
// Why RSS: Exa returns nothing for site:reddit.com and web_fetch_exa gets SOURCE_NOT_AVAILABLE;
// the Reddit data API 403s without OAuth. The public /new/.rss feed answers 200.
// Limits: titles + snippets only — no scores, comment counts, or removed/locked status.
//
// Usage: node scripts/reddit-thread-scan.mjs [--days 14] [--json] [--subs a,b,c]
// Posts nothing, writes nothing except stdout.

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const AS_JSON = args.includes('--json');
const MAX_DAYS = Number(flag('days', '14'));
const SUBS = flag('subs', 'ClaudeCode,ClaudeAI,claude,mcp,modelcontextprotocol,aiagents,AI_Agents,automation')
  .split(',').map((s) => s.trim()).filter(Boolean);

const UA = 'vodou-thread-scan/0.1 (read-only RSS; contact chad)';

// Topic: the problem Vodou solves. A post must hit at least one.
const TOPIC = [
  /\bmemor(y|ies)\b/i, /\bcontext\b/i, /\bcompact(ion|ed|ing)?\b/i, /\bcontinuity\b/i,
  /\bforget(s|ting)?\b/i, /\bremember(s|ing)?\b/i, /re-?explain/i, /\bpersist(ent|ence)?\b/i,
  /\bhandoff\b/i, /\bacross (sessions|tools|agents|models|chats)\b/i, /\bnew session\b/i,
  /\bclaude\.md\b/i, /\bagents\.md\b/i, /\blocal[- ]first\b/i, /\bself[- ]hosted\b/i,
];
// Launch/competitor shape.
const LAUNCH = [/\bi (built|made|created|wrote)\b/i, /\bjust (launched|released|shipped)\b/i,
  /\bwe (built|launched|released)\b/i, /\bintroducing\b/i, /\bopen[- ]?sourc(e|ed)\b/i,
  /\bshow(case)?\b/i, /\bmy (tool|project|app|mcp|server)\b/i];
// Ask shape.
const ASK = [/\?/, /\bhow (do|does|can|should) (you|i|people|teams)\b/i, /\bany(one)? (tips|recommend)/i,
  /\blooking for\b/i, /\bwhat('s| is) your\b/i, /\bis there\b/i, /\bstruggl/i, /\bkeep(s)? losing\b/i];
// Off-limits: don't pitch into these even if keywords match.
const SENSITIVE = [/\b(grief|suicid|depress|therap|emotion|mental health|breakup|abuse)/i];

const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const strip = (html) => decode(decode(html)).replace(/<[^>]+>/g, ' ')
  .replace(/submitted by\s+\/u\/\S+/i, '').replace(/\[link\]|\[comments\]/g, '')
  .replace(/\s+/g, ' ').trim();
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : '';
};

async function fetchSub(sub) {
  const url = `https://www.reddit.com/r/${sub}/new/.rss?limit=100`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res, xml;
    const t0 = Date.now();
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
      // Reddit's unauthenticated quota is tiny; it says exactly when it resets.
      const reset = Number(res.headers.get('x-ratelimit-reset')) || 30;
      const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? 1);
      if (res.status === 429) {
        console.error(`[reddit-scan] r/${sub} 429, waiting ${reset + 2}s (retry ${attempt + 1})`);
        await new Promise((r) => setTimeout(r, (reset + 2) * 1000));
        continue;
      }
      if (!res.ok) return { sub, error: `HTTP ${res.status}`, entries: [] };
      xml = await res.text();
      if (remaining < 1) {
        console.error(`[reddit-scan] quota spent after r/${sub}, waiting ${reset + 2}s`);
        await new Promise((r) => setTimeout(r, (reset + 2) * 1000));
      }
    } catch (err) {
      console.error(`[reddit-scan] r/${sub} ${err.name} after ${Date.now() - t0}ms, attempt ${attempt + 1}`);
      if (attempt === 2) return { sub, error: `${err.name}: ${err.message}`, entries: [] };
      continue;
    }
    console.error(`[reddit-scan] r/${sub} ${res.status} in ${Date.now() - t0}ms`);
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
      const e = m[1];
      const link = (e.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
      return {
        sub,
        title: strip(tag(e, 'title')),
        link: decode(link),
        published: tag(e, 'published') || tag(e, 'updated'),
        author: strip(tag(tag(e, 'author'), 'name')),
        snippet: strip(tag(e, 'content')).slice(0, 400),
      };
    });
    return { sub, entries };
  }
  return { sub, error: 'rate-limited (429 x3)', entries: [] };
}

const hits = (res, text) => res.filter((r) => r.test(text)).length;

const now = Date.now();
const feeds = [];
for (const sub of SUBS) {
  feeds.push(await fetchSub(sub));
  await new Promise((r) => setTimeout(r, 1200)); // be polite; avoids 429
}

const seen = new Set();
const results = { asks: [], rivals: [], skipped_sensitive: [] };
const perSub = [];
for (const f of feeds) {
  const oldest = f.entries.reduce((a, e) => Math.min(a, Date.parse(e.published) || now), now);
  perSub.push({ sub: f.sub, fetched: f.entries.length, error: f.error || null,
    window_days: f.entries.length ? +((now - oldest) / 86400000).toFixed(1) : 0 });
  for (const e of f.entries) {
    if (seen.has(e.link)) continue;
    seen.add(e.link);
    const ageDays = (now - (Date.parse(e.published) || now)) / 86400000;
    if (ageDays > MAX_DAYS) continue;
    // "Model Context Protocol" is a product name, not the context problem; SYSTEM context is Windows.
    const denoise = (s) => s.replace(/model context protocol/gi, 'MCP').replace(/system context/gi, '');
    const text = denoise(`${e.title} ${e.snippet}`);
    const topic = hits(TOPIC, text);
    if (!topic) continue;
    const titleTopic = hits(TOPIC, denoise(e.title));
    const row = { ...e, age_days: +ageDays.toFixed(1), topic_hits: topic, title_topic_hits: titleTopic };
    if (hits(SENSITIVE, text)) { results.skipped_sensitive.push(row); continue; }
    const launch = hits(LAUNCH, e.title) * 2 + hits(LAUNCH, e.snippet);
    const ask = hits(ASK, e.title) * 2 + hits(ASK, e.snippet);
    // score: title-level topic matters most; recency breaks ties
    row.score = +(titleTopic * 3 + topic + Math.max(0, 3 - ageDays / 3)).toFixed(2);
    if (launch >= 2 && launch >= ask) results.rivals.push(row);
    else if (titleTopic >= 1 || (topic >= 2 && ask >= 2)) results.asks.push(row);
  }
}
results.asks.sort((a, b) => b.score - a.score);
results.rivals.sort((a, b) => b.score - a.score);

const out = { generated_at: new Date().toISOString(), max_days: MAX_DAYS, subs: perSub,
  counts: { asks: results.asks.length, rivals: results.rivals.length,
    skipped_sensitive: results.skipped_sensitive.length }, ...results };

if (AS_JSON) {
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} else {
  const d = (e) => (e.published || '').slice(0, 10);
  const lines = [`# Reddit thread scan — ${out.generated_at.slice(0, 10)} (last ${MAX_DAYS}d)`, '', '## Feeds'];
  for (const s of perSub) lines.push(`- r/${s.sub}: ${s.error ? `ERROR ${s.error}` : `${s.fetched} posts, covers ${s.window_days}d`}`);
  lines.push('', `## Reply targets (${results.asks.length})`);
  for (const e of results.asks) lines.push(`- [${e.score}] r/${e.sub} · ${d(e)} · ${e.title}\n  ${e.link}\n  > ${e.snippet.slice(0, 200)}`);
  lines.push('', `## Competitors — read only (${results.rivals.length})`);
  for (const e of results.rivals) lines.push(`- r/${e.sub} · ${d(e)} · ${e.title}\n  ${e.link}`);
  lines.push('', `## Skipped as sensitive (${results.skipped_sensitive.length})`);
  for (const e of results.skipped_sensitive) lines.push(`- r/${e.sub} · ${e.title}`);
  process.stdout.write(lines.join('\n') + '\n');
}
const failed = perSub.filter((s) => s.error).length;
process.exitCode = failed === perSub.length ? 2 : 0;
