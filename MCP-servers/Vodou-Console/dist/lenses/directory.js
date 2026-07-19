/**
 * Community directory client.
 *
 * PLAN-LENSES-MANAGEMENT §9 + Phase 4 — fetch a curated index of community
 * lenses from `github.com/VodouAI/lenses-directory` (the raw `_index.json`
 * blob) and cache it in-memory for 1 hour. Read-only; submissions are PRs to
 * the directory repo, not API calls here.
 *
 * The directory entry shape is the same as the manifest plus stars, git_url,
 * git_ref, sha256_lock, author, last_review fields. See lenses/_template.json
 * in the directory repo for the canonical schema.
 */
// GitHub's `api/contents` endpoint always serves the current blob (no CDN
// caching), whereas raw.githubusercontent.com can lag 5–15 min behind a
// push. The Accept header tells GitHub to return the raw file body instead
// of the base64-encoded contents wrapper. Unauthenticated requests get
// 60/hour per IP; the 1-hour client-side cache keeps us well under that.
const DIRECTORY_INDEX_URL = process.env.VODOU_LENSES_DIRECTORY_URL
    || 'https://api.github.com/repos/VodouAI/lenses-directory/contents/_index.json';
const DIRECTORY_RAW_ACCEPT = 'application/vnd.github.raw';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let cache = null;
let inflight = null;
export async function fetchDirectoryIndex(force = false) {
    const now = Date.now();
    if (!force && cache && (now - cache.fetched_at) < CACHE_TTL_MS) {
        return cache.index;
    }
    if (inflight)
        return inflight;
    inflight = (async () => {
        const r = await fetch(DIRECTORY_INDEX_URL, {
            headers: { 'Accept': DIRECTORY_RAW_ACCEPT, 'User-Agent': 'Vodou-Console/0.5.89' },
        });
        if (!r.ok)
            throw new Error(`directory fetch ${r.status}`);
        const body = (await r.json());
        if (!body || !Array.isArray(body.lenses)) {
            throw new Error('directory: malformed index (no `lenses` array)');
        }
        cache = { fetched_at: Date.now(), index: body };
        return body;
    })();
    try {
        return await inflight;
    }
    finally {
        inflight = null;
    }
}
export function getCachedIndex() {
    return cache?.index ?? null;
}
export async function searchDirectory(query) {
    const idx = await fetchDirectoryIndex();
    const q = query.trim().toLowerCase();
    if (!q)
        return idx.lenses;
    return idx.lenses.filter(e => e.id.toLowerCase().includes(q)
        || (e.manifest?.motive || '').toLowerCase().includes(q)
        || (e.manifest?.category || '').toLowerCase().includes(q)
        || (e.author || '').toLowerCase().includes(q));
}
/**
 * Given a candidate URL, find directory entries whose `url_patterns` match.
 * Mirrors the registry's pickByUrl logic but operates over the directory
 * index (community lenses not yet installed locally).
 */
export async function findDirectoryEntriesForUrl(url, urlMatch) {
    const idx = await fetchDirectoryIndex();
    return idx.lenses.filter(e => {
        const patterns = e.manifest?.url_patterns || [];
        return patterns.some(p => urlMatch(p, url));
    });
}
