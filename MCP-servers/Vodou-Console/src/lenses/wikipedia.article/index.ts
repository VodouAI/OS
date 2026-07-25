/**
 * wikipedia.article — title + lede + thumbnail for any Wikipedia article.
 *
 * Uses the public Wikipedia REST API (`/api/rest_v1/page/summary/<title>`)
 * which returns clean JSON — no scraping required. The user's browser
 * would hit the same endpoint to render the standard mobile preview.
 */
import type { LensModule, RenderModel } from '../types.js';

const WP_URL_RE = /^https?:\/\/([a-z]{2,3})\.wikipedia\.org\/wiki\/([^?#]+)/i;

function parseWp(url: string): { lang: string; title: string } | null {
  const m = WP_URL_RE.exec(url);
  if (!m) return null;
  return { lang: m[1].toLowerCase(), title: decodeURIComponent(m[2]) };
}

export const card: LensModule = {
  manifest: {
    type: 'wikipedia.article',
    version: 1,
    motive: 'Show the title, lede paragraph, and thumbnail of any Wikipedia article — a quick reference lookup.',
    url_patterns: ['*.wikipedia.org/wiki/**'],
    ttl_seconds: 86400,
    requires: {
      network_domains: ['wikipedia.org'],
      runs_js: false,
      paths: ['cheerio'],
      cookie_scope: 'ephemeral',
    },
    icon: '📚',
    category: 'reference',
    author: '@vodou',
    license: 'Apache-2.0',
    extracts: ['title', 'description', 'extract', 'thumbnail_url'],
  },

  validate(_payload, sourceUrl) {
    return !!sourceUrl && WP_URL_RE.test(sourceUrl);
  },

  async fetch(_payload: any, sourceUrl: string, ctx): Promise<RenderModel> {
    const parsed = parseWp(sourceUrl);
    if (!parsed) throw Object.assign(new Error('not a wikipedia URL'), { code: 'VALIDATION_FAILED' });

    const apiUrl = `https://${parsed.lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(parsed.title)}`;
    const { body, status } = await ctx.fetchStatic(apiUrl, {
      headers: { accept: 'application/json' },
    });
    if (status === 404) {
      throw Object.assign(new Error('Wikipedia article not found'), { code: 'FETCH_FAILED' });
    }
    if (status >= 400) {
      throw Object.assign(new Error(`Wikipedia API returned ${status}`), { code: 'FETCH_FAILED' });
    }
    const data = JSON.parse(body);
    return {
      title: data.title || '',
      description: data.description || '',
      extract: data.extract || '',
      thumbnail_url: data.thumbnail?.source || '',
      thumbnail_width: data.thumbnail?.width,
      thumbnail_height: data.thumbnail?.height,
      lang: parsed.lang,
      page_url: data.content_urls?.desktop?.page || sourceUrl,
    };
  },

  extractionHealth(model: RenderModel) {
    const missing: string[] = [];
    if (!model.title) missing.push('title');
    if (!model.extract) missing.push('extract');
    return { ok: missing.length === 0, missing };
  },
};
