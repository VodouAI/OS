/**
 * Lens health checks.
 *
 * PLAN-LENSES-MANAGEMENT §8 Phase 5 — for each enabled community lens, hit a
 * sample URL from its url_patterns, validate every declared `extracts` field
 * is non-empty, write status into `installed_lenses.health_status`.
 *
 * Runs daily from `index.ts`'s scheduler. The first tick fires 60s after
 * boot to avoid piling load onto a cold start.
 */
import { getRegistry, ensureRegistryLoaded } from './registry.js';
import * as metadata from './metadata.js';
import { buildFetchCtx } from './_lib/fetch_ctx.js';
function deriveSampleUrl(patterns) {
    for (const p of patterns || []) {
        // Replace globs with literal placeholders that are syntactically valid URLs.
        let s = p
            .replace(/^\*\.\b/, '') // leading "*." → drop
            .replace(/\*\*/g, 'sample') // ** → "sample"
            .replace(/\*/g, 'sample'); // remaining * → "sample"
        if (!s)
            continue;
        if (!s.startsWith('http'))
            s = 'https://' + s;
        try {
            const u = new URL(s);
            if (u.hostname.includes('.'))
                return u.toString();
        }
        catch { /* try next */ }
    }
    return null;
}
export async function runDailyHealthChecks() {
    const summary = { checked: 0, healthy: 0, stale: 0, failing: 0 };
    await ensureRegistryLoaded();
    const registry = getRegistry();
    const rows = metadata.list();
    for (const row of rows) {
        if (!row.enabled)
            continue;
        const lens = registry.get(row.id);
        if (!lens)
            continue;
        const sample = deriveSampleUrl(lens.manifest.url_patterns || []);
        if (!sample)
            continue;
        summary.checked++;
        try {
            const ctx = buildFetchCtx();
            const fetched = await lens.fetch({}, sample, ctx);
            const expected = lens.manifest.extracts || [];
            const empty = expected.filter(k => fetched?.[k] === undefined
                || fetched?.[k] === null
                || fetched?.[k] === ''
                || (Array.isArray(fetched?.[k]) && fetched[k].length === 0));
            if (empty.length === 0) {
                metadata.setHealth(row.id, 'healthy');
                summary.healthy++;
            }
            else {
                metadata.setHealth(row.id, 'selectors_stale');
                summary.stale++;
            }
        }
        catch {
            metadata.setHealth(row.id, 'fetch_failing');
            summary.failing++;
        }
    }
    return summary;
}
