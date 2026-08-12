/**
 * title_probe — the anticipation dot's gateway half (PLAN-CONSOLE-TWO §4.5.2).
 *
 * Input is tab METADATA only (host + title, from the `tabs` permission) —
 * never page content; §6.1 rule 1 holds. We ask the daemon's reranked memory
 * search (the same pipeline BrainLoader uses — NOT raw FTS5) whether anything
 * the user already knows overlaps this page, and answer with a boolean + label.
 *
 * The cache lives HERE, not in the client, so a misbehaving/looping shell can
 * never hammer the daemon: LRU keyed host|title, 10-minute TTL, 200 entries.
 *
 * Dependency-injected runner so tests drive the cache/threshold logic without
 * a daemon (same pattern as vbb/chat.ts deps).
 */
import { execFile } from 'child_process';
import * as path from 'path';
import { getProjectRoot } from '../db.js';
const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 200;
const SCORE_FLOOR = 0.72; // same floor as inject/stage-1 — one number everywhere
const cache = new Map();
/** Default runner: `./vodou-core mem search "<title>" --top-k 3 --json`. */
function daemonSearch(query) {
    return new Promise((resolve) => {
        const root = getProjectRoot();
        execFile(path.join(root, 'vodou-core'), ['mem', 'search', query, '--top-k', '3', '--json'], { cwd: root, timeout: 8000 }, (err, stdout) => {
            if (err) {
                resolve([]);
                return;
            }
            try {
                const parsed = JSON.parse(stdout);
                resolve(Array.isArray(parsed) ? parsed : parsed.results || []);
            }
            catch {
                resolve([]);
            }
        });
    });
}
export async function probeTitle(host, title, runner = daemonSearch) {
    const cleanTitle = (title || '').trim().slice(0, 256);
    const cleanHost = (host || '').trim().slice(0, 256);
    if (!cleanTitle)
        return { hit: false };
    const key = `${cleanHost}|${cleanTitle}`;
    const now = Date.now();
    const hitCached = cache.get(key);
    if (hitCached && now - hitCached.at < TTL_MS) {
        // LRU touch.
        cache.delete(key);
        cache.set(key, hitCached);
        return hitCached.result;
    }
    let result = { hit: false };
    try {
        const chunks = await runner(cleanTitle);
        const best = chunks.find((c) => typeof c.score === 'number' && c.score >= SCORE_FLOOR);
        if (best) {
            result = {
                hit: true,
                kind: 'memory',
                // One short label for the strip tooltip — never the chunk body.
                label: String(best.text || '').slice(0, 80),
            };
        }
    }
    catch { /* daemon down — a miss, not an error */ }
    cache.set(key, { at: now, result });
    while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined)
            break;
        cache.delete(oldest);
    }
    return result;
}
/** Test hook. */
export function _clearTitleProbeCache() {
    cache.clear();
}
