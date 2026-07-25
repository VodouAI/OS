/**
 * image.preview — render a URL as an inline image card.
 *
 * No fetch logic — the renderer just constructs an <img> tag with
 * the URL. We do a HEAD-equivalent ping during fetch() to confirm the
 * URL is actually an image (not HTML), so broken cards fail fast.
 */
const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|avif)(\?|#|$)/i;
const IMAGE_MIME = /^image\//i;
export const card = {
    manifest: {
        type: 'image.preview',
        version: 1,
        motive: 'Display an image from a URL as an inline card.',
        // Empty URL patterns — image.preview is invoked explicitly by the LLM when
        // a payload URL is image-like. pickByUrl never auto-routes to this card.
        // snippet.url is the sole universal-fallback wildcard.
        url_patterns: [],
        ttl_seconds: 3600,
        requires: { paths: ['cheerio'], cookie_scope: 'ephemeral' },
        icon: '🖼️',
        category: 'media',
        author: '@vodou',
        license: 'Apache-2.0',
        extracts: ['url', 'alt', 'caption', 'width', 'height'],
    },
    validate(_payload, sourceUrl) {
        if (!sourceUrl)
            return false;
        try {
            new URL(sourceUrl);
            return true;
        }
        catch {
            return false;
        }
    },
    async fetch(payload, sourceUrl, ctx) {
        // Quick HEAD-style check via small range GET (some servers reject HEAD).
        let widthHint;
        let heightHint;
        let isImage = IMAGE_EXT.test(sourceUrl);
        try {
            const res = await ctx.fetchStatic(sourceUrl, {
                method: 'GET',
                headers: { range: 'bytes=0-2047' },
            });
            const ct = res.headers['content-type'] || '';
            if (IMAGE_MIME.test(ct))
                isImage = true;
        }
        catch { /* fall through */ }
        if (!isImage) {
            throw Object.assign(new Error('not an image URL'), { code: 'VALIDATION_FAILED' });
        }
        return {
            url: sourceUrl,
            alt: payload?.alt || 'image',
            caption: payload?.caption || '',
            width: widthHint,
            height: heightHint,
        };
    },
};
