/**
 * OpenRouter rejects some non-empty Bearer values with "Missing Authentication header"
 * (e.g. the literal strings "undefined", "[object Object]", or UI-masked previews).
 */
export function normalizeOpenRouterApiKeyCandidate(raw) {
    const t = String(raw ?? '')
        .replace(/\r/g, '')
        .trim();
    if (!t)
        return '';
    const lower = t.toLowerCase();
    if (lower === 'undefined' || lower === 'null' || lower === '[object object]')
        return '';
    if (lower === 'your-api-key-here' || lower === 'changeme' || lower === 'none')
        return '';
    if (t === '***')
        return '';
    // maskKey() in settings: first 7 chars + "..." + last 4 — not a real key
    if (/^sk-or-v1\.\.\./i.test(t))
        return '';
    return t;
}
