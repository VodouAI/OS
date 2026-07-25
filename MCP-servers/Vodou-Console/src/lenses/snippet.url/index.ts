/**
 * snippet.url — the generic LLM-snippet card.
 *
 * Fetches any URL (with the user's UA), extracts the readable body, asks the
 * gateway's LLM to produce a 2-3 sentence snippet, and renders it inline.
 *
 * This is the "scrapable component" wedge: for the long tail of sites
 * without a custom card, snippet.url provides a sane default — local fetch
 * + local LLM summary. No central scraper, no aggregation. Same legal
 * posture as a reader-mode extension that calls an LLM.
 */
import type { LensModule, RenderModel } from '../types.js';

const MAX_BODY_CHARS = 12000;

export const card: LensModule = {
  manifest: {
    type: 'snippet.url',
    version: 1,
    motive: 'Generate a 2-3 sentence LLM snippet of any URL — generic fallback when no purpose-built card exists for the site.',
    url_patterns: ['*'],
    ttl_seconds: 3600,
    requires: {
      runs_js: false,
      paths: ['cheerio'],
      cookie_scope: 'ephemeral',
    },
    icon: '📝',
    category: 'general',
    author: '@vodou',
    license: 'Apache-2.0',
    extracts: ['title', 'snippet', 'domain', 'image'],
  },

  validate(_payload, sourceUrl) {
    if (!sourceUrl) return false;
    try {
      const u = new URL(sourceUrl);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch { return false; }
  },

  async fetch(_payload: any, sourceUrl: string, ctx): Promise<RenderModel> {
    const { body, status } = await ctx.fetchStatic(sourceUrl);
    if (status >= 400) {
      throw Object.assign(new Error(`Source returned ${status}`), { code: 'FETCH_FAILED' });
    }
    const $ = ctx.cheerio(body);

    const title =
      $('meta[property="og:title"]').attr('content') ||
      $('title').first().text().trim() ||
      '';
    const description =
      $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') ||
      '';
    const image =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      '';

    // Readable body — strip script, style, nav, footer, then grab paragraph text.
    $('script, style, nav, footer, header, aside, noscript, .ad, .ads, [aria-hidden="true"]').remove();
    let articleText = '';
    const article = $('article').first();
    if (article.length) {
      articleText = article.text();
    } else {
      articleText = $('main').first().text() || $('body').text();
    }
    articleText = articleText.replace(/\s+/g, ' ').trim().slice(0, MAX_BODY_CHARS);

    // LLM-derived snippet (skipped silently if no LLM configured)
    let snippet = description.slice(0, 480);
    if (articleText.length > 200) {
      try {
        const prompt = `Source URL: ${sourceUrl}\nTitle: ${title}\n\nArticle text (truncated):\n${articleText}\n\nWrite 2-3 sentences summarizing this page for someone who hasn't read it. Be specific. No preamble.`;
        const llmText = await ctx.llmSnippet(prompt, { max_tokens: 300 });
        if (llmText && llmText.length > 30) snippet = llmText.trim();
      } catch {
        // Silent fallback to og:description
      }
    }

    let domain = '';
    try { domain = new URL(sourceUrl).hostname.replace(/^www\./, ''); } catch { /* ignore */ }

    return {
      title,
      domain,
      description,
      snippet,
      image,
      source_url: sourceUrl,
    };
  },

  extractionHealth(model: RenderModel) {
    const missing: string[] = [];
    if (!model.title && !model.snippet) missing.push('title_or_snippet');
    return { ok: missing.length === 0, missing };
  },
};
