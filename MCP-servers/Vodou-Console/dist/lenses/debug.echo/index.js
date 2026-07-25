/**
 * debug.echo — smoke test card.
 *
 * Returns whatever payload it was given as the render model.
 * Used during dev + integration testing to verify end-to-end:
 *   LLM emits ```card block → gateway extracts → endpoint resolves
 *   → cache writes → wire returns model → browser renders.
 *
 * Not meant for end users. Should NOT appear in the system prompt
 * card enumeration (filtered by manifest.category === 'debug').
 */
export const card = {
    manifest: {
        type: 'debug.echo',
        version: 1,
        motive: 'Smoke-test card that echoes its payload. For dev only.',
        url_patterns: [], // never URL-matched
        ttl_seconds: 0, // never cached
        requires: { paths: ['cheerio'], cookie_scope: 'ephemeral' },
        icon: '🧪',
        category: 'debug',
        author: '@vodou',
        license: 'Apache-2.0',
        extracts: [],
    },
    validate(payload) {
        return payload !== undefined;
    },
    synthesizeUrl(payload) {
        return `vodou://debug-echo/${encodeURIComponent(JSON.stringify(payload || {}))}`;
    },
    async fetch(payload) {
        return {
            kind: 'echo',
            received_at: new Date().toISOString(),
            payload,
        };
    },
};
