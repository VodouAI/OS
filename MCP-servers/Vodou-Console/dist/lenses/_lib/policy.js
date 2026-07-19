/**
 * Fetch policy — the "good citizen" layer.
 *
 * Vodou is local to one user. We're not a crawler. But we still want to
 * behave like a polite browser would:
 *
 *   - Cap concurrent fetches globally (don't slam the user's network)
 *   - Per-host rate limit (don't slam one site)
 *   - Max response size (don't pull 100MB pages into memory)
 *   - Timeout (don't hang)
 *   - Follow redirects up to a limit (5)
 *
 * This wraps native fetch and is the path cards use via FetchCtx.
 */
import { assertEgressAllowed } from './ssrf.js';
const MAX_BODY_BYTES_DEFAULT = 4 * 1024 * 1024; // 4 MB
const MAX_REDIRECTS_DEFAULT = 5;
const TIMEOUT_MS_DEFAULT = 15000;
const GLOBAL_CONCURRENCY = 6;
const PER_HOST_MIN_INTERVAL_MS = 250;
const hostLastFetchedAt = new Map();
let activeFetches = 0;
const waiters = [];
async function acquireSlot() {
    if (activeFetches < GLOBAL_CONCURRENCY) {
        activeFetches++;
        return;
    }
    await new Promise(resolve => waiters.push(resolve));
    activeFetches++;
}
function releaseSlot() {
    activeFetches--;
    const next = waiters.shift();
    if (next)
        next();
}
async function perHostThrottle(url) {
    let host = '';
    try {
        host = new URL(url).hostname;
    }
    catch {
        return;
    }
    const now = Date.now();
    const last = hostLastFetchedAt.get(host) || 0;
    const delta = now - last;
    if (delta < PER_HOST_MIN_INTERVAL_MS) {
        await new Promise(r => setTimeout(r, PER_HOST_MIN_INTERVAL_MS - delta));
    }
    hostLastFetchedAt.set(host, Date.now());
}
/**
 * fetch with policy enforcement. Use instead of native fetch in cards
 * that want the safety net.
 */
export async function policyFetch(url, init = {}, opts = {}) {
    const maxBytes = opts.max_body_bytes ?? MAX_BODY_BYTES_DEFAULT;
    const timeoutMs = opts.timeout_ms ?? TIMEOUT_MS_DEFAULT;
    const maxRedirects = opts.max_redirects ?? MAX_REDIRECTS_DEFAULT;
    await acquireSlot();
    try {
        let currentUrl = url;
        let redirects = 0;
        while (true) {
            // SSRF guard — validate the destination before every fetch, including
            // each redirect hop (a public host can 302 to a private IP / metadata).
            await assertEgressAllowed(currentUrl);
            await perHostThrottle(currentUrl);
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), timeoutMs);
            let res;
            try {
                res = await fetch(currentUrl, {
                    ...init,
                    redirect: 'manual',
                    signal: ctrl.signal,
                });
            }
            catch (err) {
                clearTimeout(t);
                if (err?.name === 'AbortError') {
                    throw Object.assign(new Error(`fetch timeout after ${timeoutMs}ms`), { code: 'TIMEOUT' });
                }
                throw err;
            }
            clearTimeout(t);
            // Follow redirects manually
            if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
                if (++redirects > maxRedirects) {
                    throw Object.assign(new Error(`too many redirects (>${maxRedirects})`), { code: 'TOO_MANY_REDIRECTS' });
                }
                const loc = res.headers.get('location');
                currentUrl = new URL(loc, currentUrl).toString();
                continue;
            }
            // Truncate body at maxBytes
            const reader = res.body?.getReader();
            const chunks = [];
            let totalBytes = 0;
            let truncated = false;
            if (reader) {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done)
                        break;
                    if (totalBytes + value.byteLength > maxBytes) {
                        chunks.push(value.subarray(0, maxBytes - totalBytes));
                        totalBytes = maxBytes;
                        truncated = true;
                        try {
                            await reader.cancel();
                        }
                        catch { /* ignore */ }
                        break;
                    }
                    chunks.push(value);
                    totalBytes += value.byteLength;
                }
            }
            const body = Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8');
            const headers = {};
            res.headers.forEach((v, k) => { headers[k] = v; });
            return {
                status: res.status,
                body,
                headers,
                final_url: currentUrl,
                truncated,
            };
        }
    }
    finally {
        releaseSlot();
    }
}
/** Test hook — reset internal state between tests. */
export function _resetPolicyForTests() {
    hostLastFetchedAt.clear();
    activeFetches = 0;
    waiters.length = 0;
}
/** Diagnostic accessor — used by tests + status endpoints. */
export function getPolicyState() {
    return {
        active: activeFetches,
        waiting: waiters.length,
        known_hosts: hostLastFetchedAt.size,
    };
}
