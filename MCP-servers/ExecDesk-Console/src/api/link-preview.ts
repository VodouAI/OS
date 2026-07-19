/**
 * Link Preview API — fetches URL metadata for rich preview cards
 * GET /api/link-preview?url=https://example.com
 * Returns: { title, description, favicon, domain, image }
 */

import { Router, Request, Response } from 'express';

const router = Router();

// Simple in-memory cache with TTL
const cache = new Map<string, { data: any; expires: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

router.get('/', async (req: Request, res: Response) => {
  try {
    const url = req.query.url as string;
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'url query parameter is required' });
      return;
    }

    // Validate URL
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      res.status(400).json({ error: 'invalid URL' });
      return;
    }

    // Only allow http/https
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      res.status(400).json({ error: 'only http/https URLs allowed' });
      return;
    }

    // Check cache
    const cached = cache.get(url);
    if (cached && cached.expires > Date.now()) {
      res.json(cached.data);
      return;
    }

    // Fetch the page
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Vodou-LinkPreview/1.0',
        'Accept': 'text/html',
      },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!response.ok) {
      res.json({ domain: parsed.hostname, title: parsed.hostname, description: '', favicon: '', image: '' });
      return;
    }

    // Only parse HTML
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      res.json({ domain: parsed.hostname, title: parsed.hostname, description: '', favicon: '', image: '' });
      return;
    }

    // Read first 50KB (don't need the full page)
    const reader = response.body?.getReader();
    let html = '';
    if (reader) {
      const decoder = new TextDecoder();
      let bytesRead = 0;
      while (bytesRead < 50000) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        bytesRead += value.length;
      }
      reader.cancel().catch(() => {});
    }

    // Parse metadata from HTML
    const title = extractMeta(html, 'og:title') ||
      extractMeta(html, 'twitter:title') ||
      html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || parsed.hostname;

    const description = extractMeta(html, 'og:description') ||
      extractMeta(html, 'twitter:description') ||
      extractMeta(html, 'description') || '';

    const image = extractMeta(html, 'og:image') ||
      extractMeta(html, 'twitter:image') || '';

    // Favicon
    const faviconMatch = html.match(/<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']+)["']/i) ||
      html.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["'](?:shortcut )?icon["']/i);
    let favicon = faviconMatch?.[1] || '';
    if (favicon && !favicon.startsWith('http')) {
      favicon = new URL(favicon, url).href;
    }
    if (!favicon) {
      favicon = `${parsed.protocol}//${parsed.hostname}/favicon.ico`;
    }

    // Resolve relative image URLs
    let resolvedImage = image;
    if (image && !image.startsWith('http')) {
      try { resolvedImage = new URL(image, url).href; } catch { resolvedImage = ''; }
    }

    const data = {
      domain: parsed.hostname,
      title: decodeHtmlEntities(title).substring(0, 200),
      description: decodeHtmlEntities(description).substring(0, 300),
      favicon,
      image: resolvedImage,
    };

    // Cache it
    cache.set(url, { data, expires: Date.now() + CACHE_TTL });

    // Cleanup old cache entries periodically
    if (cache.size > 200) {
      const now = Date.now();
      for (const [key, val] of cache) {
        if (val.expires < now) cache.delete(key);
      }
    }

    res.json(data);
  } catch (err) {
    // Return minimal data on error
    try {
      const parsed = new URL(req.query.url as string);
      res.json({ domain: parsed.hostname, title: parsed.hostname, description: '', favicon: '', image: '' });
    } catch {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});

function extractMeta(html: string, name: string): string {
  // Try property="name" first, then name="name"
  const propMatch = html.match(new RegExp(`<meta[^>]*property=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i')) ||
    html.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']${name}["']`, 'i'));
  if (propMatch) return propMatch[1];

  const nameMatch = html.match(new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i')) ||
    html.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*name=["']${name}["']`, 'i'));
  return nameMatch?.[1] || '';
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));
}

export { router as linkPreviewRouter };
