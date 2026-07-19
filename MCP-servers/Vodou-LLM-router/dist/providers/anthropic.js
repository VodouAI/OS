const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-3-5-haiku-20241022';
const MAX_RETRIES = process.env.VODOU_LLM_RETRY === '1' ? 2 : 0;
async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
export async function completeAnthropic(prompt, system, modelOverride, maxTokens, timeoutMs) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey)
        throw new Error('ANTHROPIC_API_KEY not set');
    const model = modelOverride || process.env.LLM_MODEL || DEFAULT_MODEL;
    const body = {
        model,
        max_tokens: maxTokens,
        system: system ?? '',
        messages: [{ role: 'user', content: prompt }],
    };
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(ANTHROPIC_API, {
                method: 'POST',
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (res.ok) {
                const json = (await res.json());
                const block = json.content?.find((b) => b.type === 'text');
                return block && 'text' in block ? String(block.text ?? '') : '';
            }
            const text = await res.text();
            if (attempt < MAX_RETRIES && res.status >= 500) {
                await sleep(1000 * (attempt + 1));
                lastErr = new Error(`Anthropic API error: ${text}`);
                continue;
            }
            throw new Error(`Anthropic API error: ${text}`);
        }
        catch (e) {
            clearTimeout(timeoutId);
            if (e.name === 'AbortError') {
                throw new Error(`anthropic timed out after ${timeoutMs / 1000}s`);
            }
            if (attempt < MAX_RETRIES) {
                lastErr = e;
                await sleep(1000 * (attempt + 1));
                continue;
            }
            throw e;
        }
    }
    throw lastErr;
}
//# sourceMappingURL=anthropic.js.map