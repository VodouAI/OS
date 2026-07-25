/**
 * LLM model catalogs for Settings dropdowns.
 *
 * Resolution (auto providers): fresh cache → live (if key) → stale cache → bundled JSON → stub.
 * Curated (vodou, claude-cli, kimi-cli): bundled only — never live-expanded.
 * Chat paths in llm.ts must NOT import this for model selection — list UI only.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { getProjectRoot, getSetting, setSetting } from '../db.js';
import { normalizeOpenRouterApiKeyCandidate } from '../openrouter-key.js';
const CURATED = new Set(['vodou', 'claude-cli', 'kimi-cli', 'claude']);
const TTL_SECS = Math.max(60, Number(process.env.VODOU_MODEL_CATALOG_TTL_SECS || 86400) || 86400);
const inflight = new Map();
const STUBS = {
    openrouter: [
        'openai/gpt-4o',
        'openai/gpt-4o-mini',
        'anthropic/claude-3.5-sonnet',
        'google/gemini-2.0-flash-001',
        'meta-llama/llama-3.3-70b-instruct',
        'deepseek/deepseek-chat',
    ],
    openai: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'],
};
function catalogDir() {
    return path.join(getProjectRoot(), 'MCP-servers', 'Vodou-Console', 'public', 'data', 'llm-models');
}
function readEnvFileKey(envPath, key) {
    try {
        const raw = readFileSync(envPath, 'utf-8');
        for (const line of raw.split('\n')) {
            const t = line.trim();
            if (!t || t.startsWith('#'))
                continue;
            const eq = t.indexOf('=');
            if (eq <= 0)
                continue;
            if (t.slice(0, eq).trim() !== key)
                continue;
            let v = t.slice(eq + 1).trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
                v = v.slice(1, -1);
            return v.replace(/\r$/, '').trim();
        }
    }
    catch { }
    return '';
}
export function resolveOpenRouterApiKey() {
    const root = getProjectRoot();
    const pick = (s) => normalizeOpenRouterApiKeyCandidate(String(s ?? '').replace(/\r$/, '').trim());
    return (pick(getSetting('openrouter_api_key')) ||
        pick(process.env.OPENROUTER_API_KEY) ||
        pick(readEnvFileKey(path.join(root, '.env'), 'OPENROUTER_API_KEY')) ||
        pick(readEnvFileKey(path.join(root, 'MCP-servers', 'Vodou-Console', '.env'), 'OPENROUTER_API_KEY')) ||
        '');
}
export function looksLikeOpenRouterKey(k) {
    if (!k || typeof k !== 'string')
        return false;
    return /^sk-or-v1-/i.test(k.trim());
}
function asEntries(models) {
    if (!Array.isArray(models) || models.length === 0)
        return [];
    return models.filter(Boolean);
}
/** Load shipped catalog JSON (and one-release OpenRouter legacy path). */
export function loadBundledModels(provider) {
    const fileProvider = provider === 'claude' ? 'claude-cli' : provider;
    try {
        const p = path.join(catalogDir(), `${fileProvider}.json`);
        const j = JSON.parse(readFileSync(p, 'utf-8'));
        const m = asEntries(j.models);
        if (m.length)
            return m;
    }
    catch { }
    if (fileProvider === 'openrouter') {
        try {
            const p = path.join(getProjectRoot(), 'MCP-servers', 'Vodou-Console', 'public', 'data', 'openrouter-models.json');
            const j = JSON.parse(readFileSync(p, 'utf-8'));
            return asEntries(j.models);
        }
        catch { }
    }
    return [];
}
function cacheKeys(provider) {
    return {
        models: `model_catalog.${provider}`,
        fetchedAt: `model_catalog.${provider}.fetched_at`,
        source: `model_catalog.${provider}.source`,
    };
}
function readCache(provider) {
    const k = cacheKeys(provider);
    const raw = getSetting(k.models);
    const fetchedAt = getSetting(k.fetchedAt);
    if (!raw || !fetchedAt)
        return null;
    try {
        const models = asEntries(JSON.parse(raw));
        if (!models.length)
            return null;
        const t = Date.parse(fetchedAt);
        if (!Number.isFinite(t))
            return null;
        return { models, fetched_at: fetchedAt, ageMs: Date.now() - t };
    }
    catch {
        return null;
    }
}
function writeCache(provider, models, source) {
    if (!models.length)
        return '';
    const k = cacheKeys(provider);
    const fetchedAt = new Date().toISOString();
    setSetting(k.models, JSON.stringify(models));
    setSetting(k.fetchedAt, fetchedAt);
    setSetting(k.source, source);
    return fetchedAt;
}
function providerKey(provider) {
    switch (provider) {
        case 'openai':
            return getSetting('openai_api_key') || process.env.OPENAI_API_KEY || '';
        case 'anthropic':
            return getSetting('anthropic_api_key') || process.env.ANTHROPIC_API_KEY || '';
        case 'google':
            return getSetting('google_api_key') || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
        case 'groq':
            return getSetting('groq_api_key') || process.env.GROQ_API_KEY || '';
        case 'deepseek':
            return getSetting('deepseek_api_key') || process.env.DEEPSEEK_API_KEY || '';
        case 'xai':
            return getSetting('xai_api_key') || process.env.XAI_API_KEY || '';
        case 'mistral':
            return getSetting('mistral_api_key') || process.env.MISTRAL_API_KEY || '';
        case 'kimi':
            return getSetting('kimi_api_key') || process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || '';
        case 'fireworks':
            return getSetting('fireworks_api_key') || process.env.FIREWORKS_API_KEY || '';
        case 'together':
            return getSetting('together_api_key') || process.env.TOGETHER_API_KEY || '';
        case 'openrouter':
            return resolveOpenRouterApiKey();
        default:
            return '';
    }
}
function openaiishIds(data, filter) {
    const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    let ids = rows
        .map((m) => (typeof m === 'string' ? m : m?.id || m?.name))
        .filter((x) => typeof x === 'string' && !!x);
    if (filter)
        ids = ids.filter(filter);
    return [...new Set(ids)].sort();
}
async function fetchLive(provider, key) {
    const timeout = AbortSignal.timeout(15_000);
    switch (provider) {
        case 'openai': {
            if (looksLikeOpenRouterKey(key))
                return [];
            const resp = await fetch('https://api.openai.com/v1/models', {
                headers: { Authorization: 'Bearer ' + key },
                signal: timeout,
            });
            if (!resp.ok)
                return [];
            return openaiishIds(await resp.json(), (id) => /^(gpt-|o\d|chatgpt-|o1|o3|o4)/i.test(id) &&
                !/image|realtime|audio|transcribe|tts|whisper|search|instruct/i.test(id));
        }
        case 'anthropic': {
            const resp = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
                headers: {
                    'x-api-key': key,
                    'anthropic-version': '2023-06-01',
                    Accept: 'application/json',
                },
                signal: timeout,
            });
            if (!resp.ok)
                return [];
            return openaiishIds(await resp.json());
        }
        case 'google': {
            const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/models', {
                headers: { Authorization: 'Bearer ' + key },
                signal: timeout,
            });
            if (!resp.ok)
                return [];
            return openaiishIds(await resp.json(), (id) => {
                const bare = id.replace(/^models\//, '');
                return (/^gemini-/i.test(bare) &&
                    !/embedding|imagen|aqa|tts|image|computer-use|native-audio/i.test(bare));
            }).map((id) => id.replace(/^models\//, ''));
        }
        case 'groq': {
            const resp = await fetch('https://api.groq.com/openai/v1/models', {
                headers: { Authorization: 'Bearer ' + key },
                signal: timeout,
            });
            if (!resp.ok)
                return [];
            return openaiishIds(await resp.json(), (id) => !/whisper|tts|guard/i.test(id));
        }
        case 'deepseek': {
            const resp = await fetch('https://api.deepseek.com/v1/models', {
                headers: { Authorization: 'Bearer ' + key },
                signal: timeout,
            });
            if (!resp.ok)
                return [];
            return openaiishIds(await resp.json());
        }
        case 'xai': {
            const resp = await fetch('https://api.x.ai/v1/models', {
                headers: { Authorization: 'Bearer ' + key },
                signal: timeout,
            });
            if (!resp.ok)
                return [];
            return openaiishIds(await resp.json(), (id) => /^grok-/i.test(id));
        }
        case 'mistral': {
            const resp = await fetch('https://api.mistral.ai/v1/models', {
                headers: { Authorization: 'Bearer ' + key },
                signal: timeout,
            });
            if (!resp.ok)
                return [];
            return openaiishIds(await resp.json(), (id) => !/embed|moderation/i.test(id));
        }
        case 'kimi': {
            const resp = await fetch('https://api.moonshot.ai/v1/models', {
                headers: { Authorization: 'Bearer ' + key },
                signal: timeout,
            });
            if (!resp.ok)
                return [];
            return openaiishIds(await resp.json());
        }
        case 'fireworks': {
            const resp = await fetch('https://api.fireworks.ai/inference/v1/models', {
                headers: { Authorization: 'Bearer ' + key },
                signal: timeout,
            });
            if (!resp.ok)
                return [];
            return openaiishIds(await resp.json(), (id) => id.includes('accounts/fireworks/models/') &&
                !/(embed|bge-|e5-|asr|whisper|flux|ssd-|controlnet|firesearch-ocr|rerank|clip|stable-diffusion|sdxl|imagen)/i.test(id));
        }
        case 'together': {
            const resp = await fetch('https://api.together.ai/v1/models', {
                headers: { Authorization: 'Bearer ' + key },
                signal: timeout,
            });
            if (!resp.ok)
                return [];
            const data = await resp.json();
            return openaiishIds(Array.isArray(data) ? { data } : data);
        }
        case 'openrouter': {
            const h = { Authorization: 'Bearer ' + key };
            h['HTTP-Referer'] =
                process.env.OPENROUTER_HTTP_REFERER || process.env.GATEWAY_BASE_URL || 'http://localhost:8765';
            h['X-Title'] = process.env.OPENROUTER_APP_TITLE || 'Vodou-Console';
            const resp = await fetch('https://openrouter.ai/api/v1/models?output_modalities=all', {
                headers: h,
                signal: timeout,
            });
            if (!resp.ok)
                return [];
            return openaiishIds(await resp.json());
        }
        default:
            return [];
    }
}
const AUTO_PROVIDERS = new Set([
    'openai',
    'anthropic',
    'google',
    'groq',
    'deepseek',
    'xai',
    'mistral',
    'kimi',
    'openrouter',
    'fireworks',
    'together',
]);
async function fetchFireworksSitemap() {
    const resp = await fetch('https://fireworks.ai/sitemap.xml', {
        headers: { Accept: 'application/xml', 'User-Agent': 'Vodou-Console-model-catalog' },
        signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok)
        return [];
    const xml = await resp.text();
    const slugs = [...new Set([...xml.matchAll(/models\/fireworks\/([a-zA-Z0-9._-]+)/g)].map((m) => m[1]))];
    const excl = /(embed|bge-|e5-|asr|whisper|flux|ssd-|controlnet|firesearch-ocr|rerank|clip|stable-diffusion|sdxl|imagen)/i;
    return slugs.filter((s) => !excl.test(s)).map((s) => `accounts/fireworks/models/${s}`).sort();
}
async function resolveAuto(provider, refresh) {
    const cached = readCache(provider);
    if (!refresh && cached && cached.ageMs <= TTL_SECS * 1000) {
        return { models: cached.models, source: 'cache', fetched_at: cached.fetched_at };
    }
    const key = providerKey(provider);
    if (key) {
        try {
            const live = await fetchLive(provider, key);
            if (live.length) {
                const fetched_at = writeCache(provider, live, 'live');
                return { models: live, source: 'live', fetched_at };
            }
        }
        catch {
            /* soft-fail */
        }
    }
    // Fireworks: public sitemap works without a key (and when Settings key is stale)
    if (provider === 'fireworks' && refresh) {
        try {
            const live = await fetchFireworksSitemap();
            if (live.length) {
                const fetched_at = writeCache(provider, live, 'sitemap');
                return { models: live, source: 'live', fetched_at };
            }
        }
        catch {
            /* soft-fail to bundled */
        }
    }
    if (cached?.models.length) {
        return {
            models: cached.models,
            source: 'cache_stale',
            fetched_at: cached.fetched_at,
            error: key ? undefined : 'Add an API key to refresh live',
        };
    }
    const bundled = loadBundledModels(provider);
    if (bundled.length) {
        return {
            models: bundled,
            source: 'bundled',
            error: refresh && !key ? 'Add an API key to refresh live' : undefined,
        };
    }
    const stub = STUBS[provider] || [];
    return {
        models: stub,
        source: 'stub',
        error: refresh && !key ? 'Add an API key to refresh live' : undefined,
    };
}
/**
 * Resolve model list for Settings. Local providers (ollama/lmstudio/llamacpp) are handled by the caller.
 */
export async function resolveProviderModels(provider, opts = {}) {
    const refresh = !!opts.refresh;
    const normalized = provider === 'claude' ? 'claude-cli' : provider;
    if (CURATED.has(provider) || CURATED.has(normalized)) {
        const models = loadBundledModels(normalized);
        return { models, source: 'curated' };
    }
    if (!AUTO_PROVIDERS.has(provider)) {
        return { models: [], source: 'stub', error: 'Unknown provider' };
    }
    const inflightKey = `${provider}:${refresh ? '1' : '0'}`;
    const existing = inflight.get(inflightKey);
    if (existing)
        return existing;
    const p = resolveAuto(provider, refresh).finally(() => {
        inflight.delete(inflightKey);
    });
    inflight.set(inflightKey, p);
    return p;
}
export function isAutoCatalogProvider(provider) {
    return AUTO_PROVIDERS.has(provider);
}
export function isCuratedCatalogProvider(provider) {
    return CURATED.has(provider) || provider === 'claude';
}
