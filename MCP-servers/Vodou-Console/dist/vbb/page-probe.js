/**
 * page_probe — PLAN-MEMORY-ON-EVERY-PAGE P3, "suggest everywhere".
 *
 * The badge on the toolbar icon: does the tab the user just switched to have
 * memory behind it? Two sources, both cheap and both already built:
 *   • the exact tiers — `page_match` over the daemon socket (indexed
 *     membership on source_url / source_host, plus saved documents; no
 *     embedding, no reranker), and
 *   • the semantic hit — `probeTitle` (title-only, 0.72 floor, its own
 *     10-minute LRU), the same anticipation dot Console Two already uses.
 *
 * Input is tab METADATA only (url + title from the `tabs` permission), sent by
 * the extension only while the page-memory setting is on — the same consent
 * the panel's lane runs under (see sidepanel.js initPageMem). Never page text.
 *
 * Cached here per page key (30 s) so a tab-switching burst costs one daemon
 * round-trip, and so a looping client can never hammer the daemon.
 */
import { askDaemon } from '../api/page-match.js';
import { normalizeUrl } from '../page-id.js';
import { probeTitle } from './title-probe.js';
import { getSiteMode } from '../page-site-mode.js';
const TTL_MS = 30_000;
const MAX = 200;
const cache = new Map();
const EMPTY = { hit: false, exact: 0, site: 0, docs: 0, pageDocs: 0, about: false };
export async function probePage(url, title, deps = {}) {
    const pid = normalizeUrl(url);
    if (!pid)
        return EMPTY;
    // P4 — 'off' sites are never looked at, not even for the icon.
    let modeOff = false;
    try {
        modeOff = getSiteMode(pid.host).mode === 'off';
    }
    catch {
        modeOff = false;
    }
    if (modeOff)
        return EMPTY;
    const key = pid.pageKey + '|' + (title || '').slice(0, 120);
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && now - cached.at < TTL_MS)
        return cached.r;
    const match = deps.match ?? ((u) => askDaemon(u, 10));
    const titleProbe = deps.title ?? ((h, t) => probeTitle(h, t));
    const noHit = { hit: false };
    const [m, t] = await Promise.all([
        match(url).catch(() => null),
        (title || '').trim() ? titleProbe(pid.host, title).catch(() => noHit) : Promise.resolve(noHit),
    ]);
    const exact = m && m.ok === true && Array.isArray(m.page) ? m.page.length : 0;
    const site = m && m.ok === true && Array.isArray(m.site) ? m.site.length : 0;
    const docs = m && m.ok === true
        ? ((Array.isArray(m.docs) ? m.docs.length : 0) + (Array.isArray(m.site_docs) ? m.site_docs.length : 0))
        : 0;
    const pageDocs = m && m.ok === true && Array.isArray(m.docs) ? m.docs.length : 0;
    const about = !!(t && t.hit);
    const first = (arr) => (Array.isArray(arr) && arr[0] && typeof arr[0].text === 'string')
        ? String(arr[0].text).replace(/^-\s*/, '').replace(/^.*?\|\s*/, '').slice(0, 80)
        : undefined;
    const label = first(m?.page) || m?.docs?.[0]?.name || first(m?.site) || (t && t.label) || undefined;
    const r = { hit: exact + site + docs > 0 || about, exact, site, docs, pageDocs, about, label };
    cache.set(key, { at: now, r });
    while (cache.size > MAX) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined)
            break;
        cache.delete(oldest);
    }
    return r;
}
/** Test hook. */
export function _resetPageProbeCache() { cache.clear(); }
