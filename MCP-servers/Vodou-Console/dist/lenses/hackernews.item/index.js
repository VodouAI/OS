const HN_URL_RE = /^https?:\/\/news\.ycombinator\.com\/item\?id=(\d+)/i;
export const card = {
    manifest: {
        type: 'hackernews.item',
        version: 1,
        motive: 'Show a Hacker News item: title, score, comment count, and top 3 comments.',
        url_patterns: ['news.ycombinator.com/item**'],
        ttl_seconds: 300,
        requires: {
            network_domains: ['news.ycombinator.com', 'hacker-news.firebaseio.com'],
            runs_js: false,
            paths: ['cheerio'],
            cookie_scope: 'ephemeral',
        },
        icon: '🟠',
        category: 'news',
        author: '@vodou',
        license: 'Apache-2.0',
        extracts: ['title', 'score', 'author', 'url', 'comment_count', 'top_comments'],
    },
    validate(_payload, sourceUrl) {
        return !!sourceUrl && HN_URL_RE.test(sourceUrl);
    },
    async fetch(_payload, sourceUrl, ctx) {
        const m = HN_URL_RE.exec(sourceUrl);
        if (!m)
            throw Object.assign(new Error('not an HN URL'), { code: 'VALIDATION_FAILED' });
        const id = m[1];
        const api = (n) => `https://hacker-news.firebaseio.com/v0/item/${n}.json`;
        const { body, status } = await ctx.fetchStatic(api(id));
        if (status >= 400)
            throw Object.assign(new Error(`HN API ${status}`), { code: 'FETCH_FAILED' });
        const item = JSON.parse(body);
        if (!item)
            throw Object.assign(new Error('HN item not found'), { code: 'FETCH_FAILED' });
        // Fetch up to 3 top comments
        const topKids = (item.kids || []).slice(0, 3);
        const comments = await Promise.all(topKids.map(async (kid) => {
            try {
                const { body: kb, status: ks } = await ctx.fetchStatic(api(String(kid)));
                if (ks >= 400)
                    return null;
                const c = JSON.parse(kb);
                return c && !c.deleted && !c.dead
                    ? { by: c.by, text: (c.text || '').replace(/<[^>]+>/g, '').slice(0, 280) }
                    : null;
            }
            catch {
                return null;
            }
        }));
        return {
            id,
            title: item.title || '',
            url: item.url || '',
            author: item.by || '',
            score: item.score || 0,
            comment_count: item.descendants || 0,
            time_iso: item.time ? new Date(item.time * 1000).toISOString() : '',
            top_comments: comments.filter(Boolean),
            hn_url: `https://news.ycombinator.com/item?id=${id}`,
        };
    },
    extractionHealth(model) {
        const missing = [];
        if (!model.title)
            missing.push('title');
        return { ok: missing.length === 0, missing };
    },
};
