/**
 * arxiv.paper — title, authors, abstract for any arXiv paper.
 *
 * Uses the public arXiv API (Atom XML response). No key, no auth.
 * URLs: arxiv.org/abs/<id>, arxiv.org/pdf/<id>, arxiv.org/abs/<cat>/<id>.
 */
import type { LensModule, RenderModel } from '../types.js';

const ARXIV_URL_RE = /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/([\w\.\-\/]+?)(?:v\d+)?(?:\.pdf)?(?:[?#]|$)/i;

export const card: LensModule = {
  manifest: {
    type: 'arxiv.paper',
    version: 1,
    motive: 'Show an arXiv paper: title, authors, abstract, and primary category.',
    url_patterns: ['arxiv.org/abs/**', 'arxiv.org/pdf/**', '*.arxiv.org/abs/**', '*.arxiv.org/pdf/**'],
    ttl_seconds: 86400 * 30,
    requires: {
      network_domains: ['arxiv.org', 'export.arxiv.org'],
      runs_js: false,
      paths: ['cheerio'],
      cookie_scope: 'ephemeral',
    },
    icon: '📄',
    category: 'research',
    author: '@vodou',
    license: 'MIT',
    extracts: ['title', 'authors', 'abstract', 'primary_category', 'published', 'pdf_url'],
  },

  validate(_payload, sourceUrl) {
    return !!sourceUrl && ARXIV_URL_RE.test(sourceUrl);
  },

  async fetch(_payload: any, sourceUrl: string, ctx): Promise<RenderModel> {
    const m = ARXIV_URL_RE.exec(sourceUrl);
    if (!m) throw Object.assign(new Error('not an arxiv URL'), { code: 'VALIDATION_FAILED' });
    const arxivId = m[1];
    const api = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`;
    const { body, status } = await ctx.fetchStatic(api, { headers: { accept: 'application/atom+xml' } });
    if (status >= 400) throw Object.assign(new Error(`arXiv API ${status}`), { code: 'FETCH_FAILED' });

    const $ = ctx.cheerio(body, { xmlMode: true });
    const entry = $('entry').first();
    if (!entry.length) throw Object.assign(new Error('arXiv paper not found'), { code: 'FETCH_FAILED' });

    const authors: string[] = [];
    entry.find('author > name').each((_: any, el: any) => {
      const name = $(el).text().trim();
      if (name) authors.push(name);
    });

    const primary_category =
      entry.find('arxiv\\:primary_category, primary_category').first().attr('term') || '';

    return {
      id: arxivId,
      title: entry.find('title').first().text().replace(/\s+/g, ' ').trim(),
      authors,
      abstract: entry.find('summary').first().text().replace(/\s+/g, ' ').trim(),
      primary_category,
      published: entry.find('published').first().text().trim(),
      arxiv_url: `https://arxiv.org/abs/${arxivId}`,
      pdf_url: `https://arxiv.org/pdf/${arxivId}.pdf`,
    };
  },

  extractionHealth(model: RenderModel) {
    const missing: string[] = [];
    if (!model.title) missing.push('title');
    if (!model.abstract) missing.push('abstract');
    return { ok: missing.length === 0, missing };
  },
};
