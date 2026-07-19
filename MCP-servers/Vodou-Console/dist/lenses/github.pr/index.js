/**
 * github.pr — the killer-demo card.
 *
 * Renders a GitHub PR's title/author/status/diff-stats/top-comments inline.
 * Three paths:
 *   - Bridge (preferred): uses user's real GitHub session — works for private repos.
 *   - Cheerio (fallback): scrapes the public PR page from github.com.
 *
 * Actions:
 *   - approve              → submit an "Approve" review (consent-gated)
 *   - request_changes      → submit a "Request changes" review (consent-gated)
 *
 * Action handlers dispatch via ctx.extension.actInTab — requires Bridge.
 */
const PR_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;
function parsePrUrl(url) {
    const m = PR_URL_RE.exec(url);
    if (!m)
        return null;
    return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) };
}
export const card = {
    manifest: {
        type: 'github.pr',
        version: 1,
        motive: 'Show a GitHub pull request summary: title, author, status, diff stats, and unresolved review comments. Supports Approve and Request-Changes actions via your real GitHub session.',
        url_patterns: ['github.com/*/*/pull/**'],
        ttl_seconds: 120, // PR state changes — short TTL
        requires: {
            network_domains: ['github.com', 'api.github.com'],
            runs_js: false,
            paths: ['bridge', 'cheerio'],
            cookie_scope: 'ephemeral', // public path uses no cookies; Bridge path uses user's session
        },
        icon: '🔀',
        category: 'dev',
        author: '@vodou',
        license: 'MIT',
        extracts: ['title', 'author', 'state', 'merged', 'draft', 'additions', 'deletions', 'changed_files', 'comments', 'top_reviews'],
    },
    validate(_payload, sourceUrl) {
        return !!sourceUrl && PR_URL_RE.test(sourceUrl);
    },
    async fetch(_payload, sourceUrl, ctx) {
        const parsed = parsePrUrl(sourceUrl);
        if (!parsed)
            throw Object.assign(new Error('not a PR URL'), { code: 'VALIDATION_FAILED' });
        // Prefer Bridge — works for private repos, faster, uses user's real session.
        if (ctx.extension) {
            try {
                return await fetchViaBridge(parsed, sourceUrl, ctx);
            }
            catch (e) {
                console.warn('[github.pr] bridge fetch failed, falling back to cheerio:', e);
            }
        }
        return await fetchViaCheerio(parsed, sourceUrl, ctx);
    },
    actions: {
        approve: {
            label: 'Approve',
            requiresConsent: true,
            async run(model, ctx) {
                if (!ctx.extension) {
                    return { ok: false, message: 'Approve requires the Vodou Bridge extension.' };
                }
                const script = `(() => {
          // GitHub's review form: pick "Approve" radio, optionally write a body, submit.
          const reviewBtn = document.querySelector('[data-target="review-controls.reviewButton"], button[aria-label*="Review changes"]');
          if (reviewBtn && reviewBtn.getAttribute('aria-expanded') === 'false') reviewBtn.click();
          // Wait a tick for the dropdown to appear, then click Approve
          setTimeout(() => {
            const approveRadio = document.querySelector('input[name="pull_request_review[event]"][value="approve"]');
            if (approveRadio) { approveRadio.checked = true; approveRadio.dispatchEvent(new Event('change', { bubbles: true })); }
            const submitBtn = document.querySelector('button[name="commit"][value="submit"], button[type="submit"][value="approve"]');
            if (submitBtn) submitBtn.click();
          }, 250);
          return { dispatched: true };
        })()`;
                await ctx.extension.actInTab(ctx.sourceUrl, script);
                return { ok: true, message: 'Approve submitted in your tab.' };
            },
        },
        request_changes: {
            label: 'Request changes',
            requiresConsent: true,
            async run(_model, ctx) {
                if (!ctx.extension) {
                    return { ok: false, message: 'Request-changes requires the Vodou Bridge extension.' };
                }
                const script = `(() => {
          const reviewBtn = document.querySelector('[data-target="review-controls.reviewButton"], button[aria-label*="Review changes"]');
          if (reviewBtn && reviewBtn.getAttribute('aria-expanded') === 'false') reviewBtn.click();
          setTimeout(() => {
            const radio = document.querySelector('input[name="pull_request_review[event]"][value="reject"]');
            if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
            const submit = document.querySelector('button[name="commit"][value="submit"]');
            if (submit) submit.click();
          }, 250);
          return { dispatched: true };
        })()`;
                await ctx.extension.actInTab(ctx.sourceUrl, script);
                return { ok: true, message: 'Request-changes submitted in your tab.' };
            },
        },
    },
    extractionHealth(model) {
        const missing = [];
        if (!model.title)
            missing.push('title');
        if (!model.author)
            missing.push('author');
        return { ok: missing.length === 0, missing };
    },
};
async function fetchViaBridge(parsed, sourceUrl, ctx) {
    // Use GitHub's REST API via the user's real session (cookies + user-token).
    const apiUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`;
    const res = await ctx.extension.fetch(apiUrl, {
        headers: { accept: 'application/vnd.github+json' },
    });
    if (res.status >= 400) {
        throw new Error(`GitHub API returned ${res.status}`);
    }
    const pr = JSON.parse(res.body);
    // Fetch top review comments (separate endpoint).
    let reviewComments = [];
    try {
        const cmtRes = await ctx.extension.fetch(`${apiUrl}/reviews`, {
            headers: { accept: 'application/vnd.github+json' },
        });
        if (cmtRes.status < 400)
            reviewComments = JSON.parse(cmtRes.body).slice(0, 3);
    }
    catch { /* ignore */ }
    return {
        title: pr.title,
        number: pr.number,
        author: pr.user?.login || '',
        author_avatar: pr.user?.avatar_url || '',
        state: pr.state, // open | closed
        merged: pr.merged === true,
        draft: pr.draft === true,
        base: pr.base?.ref || '',
        head: pr.head?.ref || '',
        additions: pr.additions || 0,
        deletions: pr.deletions || 0,
        changed_files: pr.changed_files || 0,
        comments: pr.comments || 0,
        review_comments_count: pr.review_comments || 0,
        top_reviews: reviewComments.map((r) => ({
            author: r.user?.login || '',
            state: r.state,
            body: (r.body || '').slice(0, 240),
        })),
        repo: `${parsed.owner}/${parsed.repo}`,
        html_url: pr.html_url || sourceUrl,
        source: 'bridge',
    };
}
async function fetchViaCheerio(parsed, sourceUrl, ctx) {
    const { body, status } = await ctx.fetchStatic(sourceUrl);
    if (status >= 400) {
        throw Object.assign(new Error(`GitHub returned ${status}`), { code: 'FETCH_FAILED' });
    }
    const $ = ctx.cheerio(body);
    const title = $('.gh-header-title bdi.js-issue-title').first().text().trim() ||
        $('bdi.js-issue-title').first().text().trim() ||
        $('h1 bdi').first().text().trim() ||
        $('meta[property="og:title"]').attr('content') ||
        '';
    const author = $('.gh-header-meta a.author').first().text().trim() ||
        $('a.author').first().text().trim() ||
        '';
    // Status pill
    let state = 'open';
    if ($('.State.State--merged, [title*="Merged"]').length)
        state = 'merged';
    else if ($('.State.State--closed, [title*="Closed"]').length)
        state = 'closed';
    const draft = /\bDraft\b/.test($('.State').first().text());
    // Diff stats — these vary by markup
    const additionsTxt = $('.diffstat .color-fg-success, .diff-stats .color-fg-success').first().text().trim();
    const deletionsTxt = $('.diffstat .color-fg-danger, .diff-stats .color-fg-danger').first().text().trim();
    const additions = parseInt(additionsTxt.replace(/\D/g, ''), 10) || 0;
    const deletions = parseInt(deletionsTxt.replace(/\D/g, ''), 10) || 0;
    return {
        title,
        number: parsed.number,
        author,
        author_avatar: '',
        state,
        merged: state === 'merged',
        draft,
        base: '',
        head: '',
        additions,
        deletions,
        changed_files: 0,
        comments: 0,
        review_comments_count: 0,
        top_reviews: [],
        repo: `${parsed.owner}/${parsed.repo}`,
        html_url: sourceUrl,
        source: 'cheerio',
    };
}
