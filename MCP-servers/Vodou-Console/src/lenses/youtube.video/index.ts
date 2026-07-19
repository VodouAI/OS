/**
 * youtube.video — embedded player + title from any YouTube URL.
 *
 * Uses YouTube's public oEmbed endpoint (no API key required) plus
 * the standard `/embed/<videoId>` iframe URL. No scraping; YouTube
 * sanctions both endpoints for exactly this use case.
 */
import type { LensModule, RenderModel } from '../types.js';

// Supports: youtube.com/watch?v=ID, youtu.be/ID, youtube.com/shorts/ID, youtube.com/embed/ID
const YT_URL_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/i;

function extractVideoId(url: string): string | null {
  const m = YT_URL_RE.exec(url);
  return m ? m[1] : null;
}

export const card: LensModule = {
  manifest: {
    type: 'youtube.video',
    version: 1,
    motive: 'Embed a YouTube video inline with its title — playable directly in the chat without leaving Vodou.',
    url_patterns: ['*.youtube.com/watch**', 'youtube.com/watch**', 'youtu.be/**', '*.youtube.com/shorts/**', 'youtube.com/shorts/**'],
    ttl_seconds: 86400 * 7,
    requires: {
      network_domains: ['youtube.com', 'youtu.be'],
      runs_js: false,
      paths: ['cheerio'],
      cookie_scope: 'ephemeral',
    },
    icon: '▶️',
    category: 'media',
    author: '@vodou',
    license: 'MIT',
    extracts: ['title', 'author', 'embed_url'],
  },

  validate(_payload, sourceUrl) {
    return !!sourceUrl && !!extractVideoId(sourceUrl);
  },

  async fetch(_payload: any, sourceUrl: string, ctx): Promise<RenderModel> {
    const videoId = extractVideoId(sourceUrl);
    if (!videoId) throw Object.assign(new Error('not a YouTube URL'), { code: 'VALIDATION_FAILED' });

    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
    let title = '';
    let author = '';
    let thumbnail = '';
    try {
      const { body, status } = await ctx.fetchStatic(oembedUrl, { headers: { accept: 'application/json' } });
      if (status < 400) {
        const data = JSON.parse(body);
        title = data.title || '';
        author = data.author_name || '';
        thumbnail = data.thumbnail_url || '';
      }
    } catch { /* oembed sometimes flaky — fall back to thumbnail-only */ }

    if (!thumbnail) {
      thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    }

    return {
      video_id: videoId,
      title,
      author,
      thumbnail,
      embed_url: `https://www.youtube.com/embed/${videoId}`,
      watch_url: `https://www.youtube.com/watch?v=${videoId}`,
    };
  },

  extractionHealth(model: RenderModel) {
    const missing: string[] = [];
    if (!model.video_id) missing.push('video_id');
    return { ok: missing.length === 0, missing };
  },
};
