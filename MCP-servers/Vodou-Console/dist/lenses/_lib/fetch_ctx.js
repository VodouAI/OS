/**
 * FetchCtx builder — supplies card.fetch() with the helpers it needs.
 *
 * For MVP, only the cheerio + native-fetch path is implemented.
 * BridgeApi is null when the extension isn't connected; cards that
 * require it should refuse to fetch with a BRIDGE_REQUIRED error.
 */
import * as cheerio from 'cheerio';
import { getBridge } from '../../vbb/bridge.js';
import { policyFetch } from './policy.js';
// Default to a real Chrome UA — many sites (allrecipes, Cloudflare-protected,
// etc.) serve a 404 or challenge to "compatible; Bot/version" UAs even when
// the request itself is benign. Vodou's posture is "Vodou IS your browser"
// — so we identify as the same Chrome the user is running. Cards can
// override via init.headers if they want to identify differently.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
async function fetchStatic(url, init) {
    const headers = new Headers(init?.headers);
    if (!headers.has('user-agent'))
        headers.set('user-agent', USER_AGENT);
    if (!headers.has('accept'))
        headers.set('accept', 'text/html,application/json');
    // Route via policyFetch for concurrency + per-host throttle + size/timeout caps.
    const res = await policyFetch(url, { ...init, headers });
    return { status: res.status, body: res.body, headers: res.headers };
}
async function llmSnippet(prompt, opts) {
    // Lazy import to avoid pulling the whole llm.ts dependency tree at module-load time.
    const { rawLLMCall, isConfigured } = await import('../../llm.js');
    if (!isConfigured()) {
        throw Object.assign(new Error('No LLM configured for snippet calls'), { code: 'LLM_NOT_CONFIGURED' });
    }
    const sys = opts?.system ||
        'You are extracting a concise snippet from web content. Reply with just the snippet — no preamble, no markdown, no quotation marks. Be terse.';
    // TURNLESS: a lens helper invoked from lens scripts, outside any turn.
    return rawLLMCall(prompt, sys);
}
export function buildFetchCtx() {
    return {
        fetchStatic,
        cheerio: cheerio.load,
        extension: getBridge(),
        llmSnippet,
    };
}
/** Convenience for tests + cards that only need cheerio over a URL. */
export async function fetchAndLoad(url) {
    const { body } = await fetchStatic(url);
    return cheerio.load(body);
}
