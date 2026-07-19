# Writing a Vodou Card

A **card** is a small, focused UI that renders inline in Vodou's chat when the
assistant talks about a specific URL or motive. Cards are MIT-licensed, run
locally on the user's machine, and use the user's real browser session
(via the Vodou Bridge extension) — not server-side scraping.

If you can extract structured data from a webpage and render it as a small UI,
you can write a card. The contract is tiny.

---

## The 4-question contract

Every card answers four questions:

1. **What URLs does it claim?** (`manifest.url_patterns`)
2. **What does the user want from those URLs?** (`manifest.motive`)
3. **How do you fetch the data?** (`card.fetch()`)
4. **How do you render it?** (`Component` — written in `public/js/lenses/renderers.js`)

That's the whole job. Everything else (caching, validation, error handling,
shell chrome, consent dialogs) is the framework's responsibility.

---

## Minimum-viable card (40 lines)

```ts
// src/lenses/my.card/index.ts
import type { LensModule } from '../types.js';

export const card: LensModule = {
  manifest: {
    type: 'my.card',
    version: 1,
    motive: 'Show the title and first paragraph of a Wikipedia article.',
    url_patterns: ['*.wikipedia.org/wiki/**'],
    ttl_seconds: 86400,
    requires: { paths: ['cheerio'] },
    icon: '📚',
    category: 'reference',
    license: 'MIT',
  },

  validate(_payload, sourceUrl) {
    return !!sourceUrl && sourceUrl.includes('wikipedia.org/wiki/');
  },

  async fetch(_payload, sourceUrl, ctx) {
    const { body } = await ctx.fetchStatic(sourceUrl);
    const $ = ctx.cheerio(body);
    return {
      title: $('h1#firstHeading').text().trim(),
      lede: $('#mw-content-text p').first().text().trim().slice(0, 500),
    };
  },
};
```

Then add the renderer in `public/js/lenses/renderers.js`:

```js
function renderMyCard(model) {
  const div = document.createElement('div');
  div.innerHTML = `<h3>${esc(model.title)}</h3><p>${esc(model.lede)}</p>`;
  return { title: `📚 ${model.title}`, body: div };
}
window.LensRenderers['my.card'] = renderMyCard;
```

Register it in `src/lenses/registry.ts` (one import + one `register()` call).

Reload the gateway → the card is live.

---

## Fields

### `manifest.type` (required)

Unique kebab-or-dot string. Convention: `<category>.<site-or-purpose>`.
Examples: `recipe.allrecipes`, `github.pr`, `linkedin.profile`, `weather.local`.

### `manifest.motive` (required, **important**)

One sentence describing what the card does. This is what the **Router-LLM
reads to match user intent to your card** (in 0.5.89). A bad motive sentence
means your card never gets routed.

Bad: *"Wikipedia card"*
Good: *"Show the title and first paragraph of a Wikipedia article for a quick reference lookup."*

### `manifest.url_patterns` (required)

Glob patterns. `*` matches one path segment (no `/`). `**` matches anything
including `/`. Use `**` when you don't care about path depth.

```ts
url_patterns: [
  '*.example.com/article/**',  // any subdomain
  'example.com/article/**',     // bare apex
]
```

### `manifest.ttl_seconds` (required)

How long the render model stays cached. Tune per content type:
- Recipes: 86400 (24h)
- News articles: 3600 (1h)
- PR status: 120 (2 min)
- Live dashboards: 30 (refresh frequently)
- Static images: 3600

Set to `0` to disable caching (debug cards only).

### `manifest.requires`

```ts
requires: {
  paths: ['cheerio'],     // or ['bridge', 'cheerio'] — falls through paths
  needs_session: false,   // true = card REQUIRES Vodou Bridge to be installed
  network_domains: ['example.com'],  // documentation; not enforced
  cookie_scope: 'ephemeral',  // 'ephemeral' | 'card-scoped' | 'user-scoped' (puppeteer-only)
}
```

`paths` controls which render path the card uses:
- `cheerio` — static HTML fetch + parse. No JS, no session. Fast.
- `bridge` — the user's real Chrome via Vodou Bridge. Carries their session.
- `puppeteer` — isolated headless Chromium (deferred from MVP).

List paths in order of preference. The framework picks the first available.

### `validate(payload, sourceUrl)` (required)

Cheap, synchronous. Reject obviously-wrong inputs before fetch. Return `false`
to bail with a structured `VALIDATION_FAILED` error.

### `synthesizeUrl(payload)` (optional)

For cards where the LLM gives a payload but no URL (e.g., `map.directions`
gets `{origin, destination}`). Return the URL the card represents — used
for "open in new tab" + cache key.

### `fetch(payload, sourceUrl, ctx)` (required)

Server-side. Async. Returns the **render model** — the JSON that crosses
the wire to the browser. The original page HTML never leaves the gateway.

`ctx` provides:
- `ctx.fetchStatic(url, init?)` — native fetch with Vodou's user agent
- `ctx.cheerio` — the cheerio load function
- `ctx.extension` — BridgeApi if the bridge is connected; `null` otherwise

If your card requires the bridge and it's missing, throw
`new Error('Bridge required')` with `code: 'BRIDGE_REQUIRED'`.

### `actions` (optional)

Per-action handlers. Each action declares `requiresConsent`. The framework
prompts the user with a one-time per-domain consent dialog before the first
invocation; subsequent invocations skip the prompt.

```ts
actions: {
  archive: {
    label: 'Archive',
    requiresConsent: true,
    async run(model, ctx) {
      await ctx.extension.actInTab(ctx.sourceUrl, `(() => document.querySelector("#archive").click())()`);
      return { ok: true, message: 'Archived' };
    },
  },
}
```

The injected script runs in the user's actual tab. Be conservative — don't
do anything the user wouldn't expect from clicking "Archive" themselves.

### `extractionHealth(model)` (optional)

Verifies the render model has the fields it should. Used by the management
UI (0.5.89) to flag "selectors stale" when the site redesigns.

```ts
extractionHealth(model) {
  const missing = [];
  if (!model.title) missing.push('title');
  if (!model.items?.length) missing.push('items');
  return { ok: missing.length === 0, missing };
}
```

---

## The render model — what to return, what NOT to return

**Do return:** the structured data the user wanted. Strings, numbers, arrays
of strings, small objects.

**Don't return:**
- Source HTML (the framework's guarantee is that source never leaks)
- Anything sensitive that wasn't in the user's intent (the user asked for
  ingredients; don't include their browsing history)
- Functions, DOM nodes, or anything not JSON-serializable

Keep it small. A render model > 100KB indicates over-extraction — narrow
your selectors.

---

## Anti-patterns (don't do these)

1. **Cards that "show me the whole page."** That's a viewport, not a card.
   Pick a motive ("show the article body and metadata") and extract only that.
2. **Cards that scrape on a schedule.** Cards are user-initiated. If you
   want polling, use a background job (out of card scope).
3. **Cards that aggregate data from multiple users.** Cards run on one
   user's machine, render for that user. No cross-user aggregation.
4. **Cards that try to circumvent paywalls or auth walls.** If a site is
   gated and the user isn't logged in, return an error. Vodou should
   render what the user *would* see in their own browser — no more, no less.
5. **Cards with `runs_js: true` but no `requires.paths` declaring `'bridge'`.**
   The framework needs to know the card needs Chrome to even attempt rendering.

---

## Testing your card

Unit test the validate + URL pattern:

```ts
// src/lenses/my.card/index.test.ts
import { describe, it, expect } from 'vitest';
import { card } from './index.js';

describe('my.card', () => {
  it('matches its url pattern', () => {
    expect(card.validate({}, 'https://en.wikipedia.org/wiki/Topic')).toBe(true);
    expect(card.validate({}, 'https://nope.com/x')).toBe(false);
  });
});
```

Integration test (use a fixture URL):

```ts
import { buildFetchCtx } from '../_lib/fetch_ctx.js';
const ctx = buildFetchCtx();
const model = await card.fetch({}, 'https://en.wikipedia.org/wiki/Vodou', ctx);
expect(model.title).toContain('Vodou');
```

---

## Submitting a card to the community

(post-MVP, in `PLAN-CARDS-MANAGEMENT.md` 0.5.91+):
1. Publish your card as a public GitHub repo with `manifest.json` + `index.ts`.
2. MIT license.
3. Open a PR against `github.com/vodou/cards-directory`.
4. A maintainer reviews: manifest matches code, no exfiltration, no surprises.
5. Merged → appears in the in-app directory.

---

## Reference

- Protocol types: `src/lenses/types.ts`
- Registry: `src/lenses/registry.ts`
- Cache: `src/lenses/_lib/cache.ts`
- URL matcher: `src/lenses/_lib/urlmatch.ts`
- Backend API: `src/api/lenses.ts`
- Frontend shell: `public/js/lenses/shell.js`
- Frontend renderers: `public/js/lenses/renderers.js`
- Full architecture: `PLANS/0.5.88/PLAN-CARDS-FRAMEWORK-v4.md`
- MVP scope: `PLANS/0.5.88/PLAN-CARDS-MVP.md`
