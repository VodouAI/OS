/**
 * P2a — the provider table. One row per provider; every other place reads it.
 *
 * WHY THIS EXISTS
 *
 * Vodou talks to ~19 LLM providers, and each carries the same handful of facts:
 * a display name, an endpoint, an API key, a default model, a context window, a
 * price. Those facts were spelled out in five independent places — a type union,
 * a `CONTEXT_LIMITS` map, a display-name `switch`, a `PRICING` table in another
 * file, and a hard-coded list in the frontend — and nothing kept them in step.
 *
 * They had drifted, and not cosmetically:
 *
 *   - `vodou`, the HOSTED TIER WE BILL FOR, appeared in no PRICING row, so
 *     `resolvePricing` fell through to `{ input: 0, output: 0 }` and every
 *     hosted turn reported $0.00 COGS.
 *   - `vodou` had no `CONTEXT_LIMITS` entry either, and the three call sites
 *     fell back to two different numbers — 200_000 at two, 64_000 at the third.
 *     One provider with two context windows, depending which line asked.
 *
 * A `switch` per fact makes those omissions invisible: nothing forces the arms
 * to cover the same set. A TABLE makes them structural — a provider either has
 * a row or it does not exist, and `satisfies` proves at compile time that every
 * declared id is covered.
 *
 * WHAT BELONGS HERE: facts about a provider that do not depend on a turn.
 * WHAT DOES NOT: anything that varies per request. The effective model for a
 * turn is `resolveModel(conversationId, spec.defaultModel)` — see llm.ts, and
 * the reason it is not a global there.
 */
/**
 * The table. Ordered roughly as the settings UI lists them.
 *
 * Every `contextLimit` here was lifted from the `CONTEXT_LIMITS` map it replaces
 * rather than looked up fresh — this phase is a MOVE, not a re-verification. A
 * wrong number stays wrong until someone checks it against the vendor, and that
 * is a separate, honest piece of work.
 */
export const PROVIDERS = [
    { id: 'claude-cli', label: 'Claude CLI ({model})', kind: 'cli', contextLimit: 200_000,
        modelSetting: 'cli_model', modelEnv: ['CLI_MODEL'], defaultModel: 'sonnet' },
    { id: 'anthropic', label: 'Anthropic API ({model})', kind: 'sdk', contextLimit: 200_000,
        modelSetting: 'claude_model', modelEnv: ['CLAUDE_MODEL'], defaultModel: 'claude-sonnet-4-20250514',
        keyLabel: 'Anthropic',
        keySetting: 'anthropic_api_key', keyEnv: ['ANTHROPIC_API_KEY'] },
    { id: 'kimi-cli', label: 'Kimi CLI ({model})', kind: 'cli', contextLimit: 131_072,
        modelSetting: 'kimi_cli_model', modelEnv: ['KIMI_CLI_MODEL'], defaultModel: 'kimi-k3' },
    { id: 'vodou', label: 'Vodou LLM ({model})', kind: 'openai-compat', contextLimit: 131_072,
        hostedTier: true, pricingAlias: 'fireworks', labelTrimPrefix: 'accounts/fireworks/models/',
        modelSetting: 'vodou_model', defaultModel: 'accounts/fireworks/models/kimi-k2p6' },
    { id: 'openai', label: 'OpenAI ({model})', kind: 'openai-compat', contextLimit: 128_000,
        // Chat goes through `chatWithOpenAI`, but the one-shot `rawLLMCall` path
        // needs the compat endpoint — it was in `getOpenAICompatConfig` and nowhere
        // else, which made the table quietly incomplete for exactly one provider.
        endpoint: 'https://api.openai.com/v1/chat/completions',
        modelSetting: 'openai_model', modelEnv: ['OPENAI_MODEL'], defaultModel: 'gpt-4o',
        keyLabel: 'OpenAI',
        keySetting: 'openai_api_key', keyEnv: ['OPENAI_API_KEY'] },
    { id: 'google', label: 'Google Gemini ({model})', kind: 'openai-compat', contextLimit: 1_000_000,
        endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        modelSetting: 'google_model', defaultModel: 'gemini-2.5-flash',
        // NB: GEMINI_API_KEY, not GOOGLE_API_KEY. Written down because it is the
        // kind of asymmetry that gets "tidied" into a bug.
        keyLabel: 'Google Gemini',
        // GEMINI_API_KEY first (what the loader has always used), then
        // GOOGLE_API_KEY — which the model catalog accepted and the loader did not.
        // A user with only GOOGLE_API_KEY exported got a populated model list for a
        // provider that could not answer a single call.
        keySetting: 'google_api_key', keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
    { id: 'groq', label: 'Groq ({model})', kind: 'openai-compat', contextLimit: 32_000,
        endpoint: 'https://api.groq.com/openai/v1/chat/completions',
        modelSetting: 'groq_model', defaultModel: 'llama-3.3-70b-versatile',
        keyLabel: 'Groq',
        keySetting: 'groq_api_key', keyEnv: ['GROQ_API_KEY'] },
    { id: 'deepseek', label: 'DeepSeek ({model})', kind: 'openai-compat', contextLimit: 64_000,
        endpoint: 'https://api.deepseek.com/v1/chat/completions',
        modelSetting: 'deepseek_model', defaultModel: 'deepseek-chat',
        keyLabel: 'DeepSeek',
        keySetting: 'deepseek_api_key', keyEnv: ['DEEPSEEK_API_KEY'] },
    { id: 'xai', label: 'xAI Grok ({model})', kind: 'openai-compat', contextLimit: 128_000,
        endpoint: 'https://api.x.ai/v1/chat/completions',
        modelSetting: 'xai_model', defaultModel: 'grok-3',
        keyLabel: 'xAI',
        keySetting: 'xai_api_key', keyEnv: ['XAI_API_KEY'] },
    { id: 'mistral', label: 'Mistral ({model})', kind: 'openai-compat', contextLimit: 32_000,
        endpoint: 'https://api.mistral.ai/v1/chat/completions',
        modelSetting: 'mistral_model', defaultModel: 'mistral-large-latest',
        keyLabel: 'Mistral',
        keySetting: 'mistral_api_key', keyEnv: ['MISTRAL_API_KEY'] },
    { id: 'kimi', label: 'Kimi API ({model})', kind: 'openai-compat', contextLimit: 131_072,
        endpoint: 'https://api.moonshot.ai/v1/chat/completions',
        modelSetting: 'kimi_model', modelEnv: ['MOONSHOT_MODEL'], defaultModel: 'kimi-k3',
        keyLabel: 'Kimi (Moonshot)',
        keySetting: 'kimi_api_key', keyEnv: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'] },
    { id: 'openrouter', label: 'OpenRouter ({model})', kind: 'openai-compat', contextLimit: 128_000,
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        modelSetting: 'openrouter_model', modelEnv: ['OPENROUTER_MODEL'], defaultModel: 'openai/gpt-4o',
        // the key runs through `normalizeOpenRouterApiKeyCandidate` first
        keyLabel: 'OpenRouter', keySetting: 'openrouter_api_key', keyEnv: ['OPENROUTER_API_KEY'],
        irregular: ['key'] },
    { id: 'fireworks', label: 'Fireworks ({model})', kind: 'openai-compat', contextLimit: 131_072,
        endpoint: 'https://api.fireworks.ai/inference/v1/chat/completions',
        modelSetting: 'fireworks_model', modelEnv: ['FIREWORKS_MODEL'],
        defaultModel: 'accounts/fireworks/models/kimi-k2p6',
        // composed: user key OR the managed key that backs the hosted tier
        keyLabel: 'Fireworks', keySetting: 'fireworks_api_key', keyEnv: ['VODOU_FIREWORKS_KEY', 'FIREWORKS_API_KEY'],
        irregular: ['key'] },
    { id: 'together', label: 'Together ({model})', kind: 'openai-compat', contextLimit: 131_072,
        endpoint: 'https://api.together.ai/v1/chat/completions',
        modelSetting: 'together_model', modelEnv: ['TOGETHER_MODEL'], defaultModel: 'moonshotai/Kimi-K2.6',
        keyLabel: 'Together.ai',
        keySetting: 'together_api_key', keyEnv: ['TOGETHER_API_KEY'] },
    { id: 'ollama', label: 'Ollama ({model})', kind: 'local', contextLimit: 32_000, localOnly: true,
        modelSetting: 'ollama_model', modelEnv: ['OLLAMA_MODEL'], defaultModel: '',
        baseUrlSetting: 'ollama_base_url', baseUrlEnv: ['OLLAMA_BASE_URL'], defaultBaseUrl: 'http://localhost:11434' },
    { id: 'lmstudio', label: 'LM Studio ({model})', kind: 'local', contextLimit: 32_000, localOnly: true,
        modelSetting: 'lmstudio_model', modelEnv: ['LMSTUDIO_MODEL'], defaultModel: '',
        baseUrlSetting: 'lmstudio_base_url', baseUrlEnv: ['LMSTUDIO_BASE_URL'], defaultBaseUrl: 'http://localhost:1234' },
    { id: 'llamacpp', label: 'Vodou Local ({model})', kind: 'local', contextLimit: 32_000, localOnly: true,
        modelSetting: 'llamacpp_model', modelEnv: ['LLAMACPP_MODEL'], defaultModel: '',
        // base URL is derived from VODOU_LLAMACPP_PORT — the port is ours, not a setting
        irregular: ['baseUrl'] },
    { id: 'custom', label: 'Custom ({model})', kind: 'openai-compat', contextLimit: 64_000,
        modelSetting: 'custom_llm_model', modelEnv: ['CUSTOM_LLM_MODEL'], defaultModel: '',
        keySetting: 'custom_llm_api_key', keyEnv: ['CUSTOM_LLM_API_KEY'],
        baseUrlSetting: 'custom_llm_base_url', baseUrlEnv: ['CUSTOM_LLM_BASE_URL'], defaultBaseUrl: '' },
    { id: 'none', label: 'None', kind: 'none' },
];
const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));
/** The spec for an id, or undefined. Callers decide what an unknown id means. */
export function providerSpec(id) {
    return BY_ID.get(id);
}
/** Every declared id. The one list — the frontend and the gates read this. */
export function providerIds() {
    return PROVIDERS.map((p) => p.id);
}
/**
 * ONE fallback for a provider with no declared window.
 *
 * There were two — 200_000 at two call sites and 64_000 at a third — which meant
 * an unlisted provider had two different context limits depending on which line
 * asked. The conservative number wins: over-estimating the window truncates the
 * prompt at the vendor, which is the failure that does not announce itself.
 */
export const DEFAULT_CONTEXT_LIMIT = 64_000;
export function contextLimitFor(id) {
    return providerSpec(id)?.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
}
/** The id to price a turn under — the alias when one is declared. */
export function pricingIdFor(id) {
    return providerSpec(id)?.pricingAlias ?? id;
}
/** `Claude CLI (opus)`. Unknown ids render as themselves rather than "None". */
export function providerLabel(id, model) {
    const spec = providerSpec(id);
    if (!spec)
        return id;
    const shown = spec.labelTrimPrefix ? model.replace(spec.labelTrimPrefix, '') : model;
    return spec.label.replace('{model}', shown);
}
/**
 * Resolve one provider's runtime config from the table.
 *
 * Precedence is settings → each env var in order → default, which is the shape
 * every one of the 32 hand-written assignments already had. Stating it once
 * means a new provider cannot accidentally get a different order — the failure
 * lane canon rule 2 names ("a script that reads `.env` after the environment is
 * a bug, not a convention"), one level down.
 *
 * Returns empty strings for anything the row does not declare, including the
 * fields marked `irregular` — those are composed by their owner and this
 * deliberately does not guess at them.
 */
export function resolveProviderRuntime(id, getSetting, env = process.env) {
    const spec = providerSpec(id);
    if (!spec)
        return { model: '', apiKey: '', baseUrl: '' };
    const pick = (setting, envKeys, dflt = '') => {
        const fromSetting = setting ? getSetting(setting) : '';
        if (fromSetting)
            return fromSetting;
        for (const k of envKeys ?? []) {
            const v = env[k];
            if (v)
                return v;
        }
        return dflt;
    };
    const irregular = new Set(spec.irregular ?? []);
    const baseUrl = irregular.has('baseUrl')
        ? ''
        : pick(spec.baseUrlSetting, spec.baseUrlEnv, spec.defaultBaseUrl ?? '').replace(/\/$/, '');
    return {
        model: pick(spec.modelSetting, spec.modelEnv, spec.defaultModel ?? ''),
        apiKey: irregular.has('key') ? '' : pick(spec.keySetting, spec.keyEnv, ''),
        baseUrl,
    };
}
/**
 * Is this the managed tier — the one Vodou pays for and meters?
 *
 * Named because six sites were asking it as `currentProvider === 'vodou'`, which
 * conflates an identity with a property. Quota enforcement, prompt-cache
 * stability and the rolling summary are all consequences of "someone else is
 * paying", not of "this provider happens to be called vodou".
 */
export function isHostedTier(id) {
    return providerSpec(id)?.hostedTier === true;
}
/**
 * Is an API key available for this provider, from ANY of its declared sources?
 *
 * The settings validator and the config loader disagreed about this, and the
 * disagreement was user-facing. Five of twelve validation arms consulted
 * `process.env`; seven did not. So with `OPENAI_API_KEY` (or GROQ, XAI, MISTRAL,
 * DEEPSEEK, GOOGLE) exported — a key `loadProviderConfig` would happily use —
 * saving that provider was REJECTED as "API key is required".
 *
 * One question, one answer, same precedence as the loader. `irregular: ['key']`
 * marks providers whose key the loader COMPOSES (openrouter normalises, fireworks
 * picks user-over-managed); their sources are still declared, because "where can
 * a key come from" and "how is it assembled" are different questions.
 */
/**
 * The API key from a provider's DECLARED sources, in order.
 *
 * Separate from `resolveProviderRuntime().apiKey`, which returns '' for rows
 * marked `irregular: ['key']` because the loader composes those. This answers
 * the other question — "where may a key come from" — which is what the settings
 * validator and the model catalog need.
 *
 * The model catalog kept its own copy of this and disagreed four ways: it read
 * GOOGLE_API_KEY (the loader did not), ordered kimi's two vars the opposite way,
 * missed fireworks' canonical VODOU_FIREWORKS_KEY, and had no openrouter case at
 * all. Every one of those is a user-visible difference between "the UI lists
 * models" and "a call actually works".
 */
export function declaredKeyFor(id, getSetting, env = process.env) {
    const spec = providerSpec(id);
    if (!spec?.keySetting)
        return '';
    const fromSetting = getSetting(spec.keySetting);
    if (fromSetting)
        return fromSetting;
    for (const k of spec.keyEnv ?? []) {
        const v = env[k];
        if (v)
            return v;
    }
    return '';
}
export function hasConfiguredKey(id, getSetting, fromRequest, env = process.env) {
    if (fromRequest)
        return true;
    if (!providerSpec(id)?.keySetting)
        return true; // this provider needs no key
    return !!declaredKeyFor(id, getSetting, env);
}
/** The name to use when telling an operator a key is missing. */
export function providerKeyLabel(id) {
    return providerSpec(id)?.keyLabel ?? id;
}
