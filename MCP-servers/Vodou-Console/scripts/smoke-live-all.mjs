#!/usr/bin/env node
/**
 * Hit every cheerio/API-path card against a live URL and report health.
 * Run sparingly — actual network calls.
 *
 *   node scripts/smoke-live-all.mjs
 *
 * Set BAIL=1 to exit non-zero on the first unhealthy card.
 */
import { ensureRegistryLoaded, getRegistry } from '../dist/lenses/registry.js';
import { buildFetchCtx } from '../dist/lenses/_lib/fetch_ctx.js';

const SAMPLES = {
  'recipe.allrecipes': 'https://www.allrecipes.com/recipe/202463/shoyu-chicken/',
  'wikipedia.article': 'https://en.wikipedia.org/wiki/Vodou',
  'youtube.video': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'hackernews.item': 'https://news.ycombinator.com/item?id=1',
  'arxiv.paper': 'https://arxiv.org/abs/1706.03762',
  'github.pr': 'https://github.com/anthropics/claude-code/pull/1',
};

await ensureRegistryLoaded();
const reg = getRegistry();
const ctx = buildFetchCtx();

let failed = 0;
for (const [type, url] of Object.entries(SAMPLES)) {
  const card = reg.get(type);
  if (!card) { console.log(`SKIP ${type} (not registered)`); continue; }
  const t0 = Date.now();
  try {
    if (!card.validate({}, url)) {
      console.log(`SKIP ${type} (URL pattern rejected)`);
      continue;
    }
    const model = await card.fetch({}, url, ctx);
    const health = card.extractionHealth ? card.extractionHealth(model) : { ok: true };
    const ms = Date.now() - t0;
    if (health.ok) {
      console.log(`✓ ${type.padEnd(22)} ${ms}ms`);
    } else {
      console.log(`⚠ ${type.padEnd(22)} ${ms}ms — missing: ${health.missing?.join(', ')}`);
      failed++;
    }
  } catch (err) {
    const ms = Date.now() - t0;
    console.log(`✗ ${type.padEnd(22)} ${ms}ms — ${err.message}`);
    failed++;
  }
}

if (failed > 0 && process.env.BAIL === '1') {
  console.log(`\n${failed} card(s) unhealthy — bailing`);
  process.exit(1);
}
console.log(failed > 0 ? `\n${failed} card(s) need selector updates` : '\n✅ all cards healthy');
