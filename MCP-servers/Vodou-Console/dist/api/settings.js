/**
 * Settings API — LLM provider management
 * GET/POST /api/settings, POST /api/settings/test, GET /api/settings/models/:provider
 */
import { Router } from 'express';
import { execFileSync } from 'child_process';
import { resolveBinPath } from '../cli-portability.js';
import { getSetting, setSetting, getAllSettings, getProjectRoot } from '../db.js';
import { getAuthType, reinitAuth, hasActiveCliSession } from '../llm.js';
import { checkQuota, invalidateQuotaCache } from '../usage-tracking.js';
/** Authed billing/upgrade page on the app box. Single source for every "upgrade" link. */
function upgradeUrl() {
    const appBase = (process.env.VODOU_WEB_SERVER_URL || process.env.OI_WEB_SERVER_URL || 'https://app.vodou.ai').replace(/\/$/, '');
    return appBase + '/dashboard/billing';
}
const KIMI_BIN = process.env.KIMI_BIN || resolveBinPath('kimi') || 'kimi';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { projectEnvRouter } from './project-env.js';
import { normalizeOpenRouterApiKeyCandidate } from '../openrouter-key.js';
import { resolveOpenRouterApiKey, looksLikeOpenRouterKey, resolveProviderModels, isAutoCatalogProvider, isCuratedCatalogProvider, } from './model-catalog.js';
export const settingsRouter = Router();
/** GET/POST /api/settings/project-env — project root `.env` (see project-env.ts) */
settingsRouter.use('/project-env', projectEnvRouter);
// Provider metadata
const PROVIDERS = [
    { id: 'vodou', name: 'Vodou LLM (included in your plan)', requiresKey: false, managed: true },
    { id: 'claude-cli', name: 'Claude CLI (Max subscription)', requiresKey: false },
    { id: 'anthropic', name: 'Anthropic API', requiresKey: true },
    { id: 'kimi-cli', name: 'Kimi Code CLI (Moonshot)', requiresKey: false },
    { id: 'kimi', name: 'Kimi (Moonshot API)', requiresKey: true },
    { id: 'openai', name: 'OpenAI', requiresKey: true },
    { id: 'openrouter', name: 'OpenRouter', requiresKey: true },
    { id: 'google', name: 'Google Gemini', requiresKey: true },
    { id: 'groq', name: 'Groq', requiresKey: true },
    { id: 'deepseek', name: 'DeepSeek', requiresKey: true },
    { id: 'xai', name: 'xAI (Grok)', requiresKey: true },
    { id: 'mistral', name: 'Mistral', requiresKey: true },
    { id: 'fireworks', name: 'Fireworks.ai (Kimi K2.6)', requiresKey: true },
    { id: 'together', name: 'Together.ai (failover/EU)', requiresKey: true },
    { id: 'ollama', name: 'Ollama (Local)', requiresKey: false },
    { id: 'lmstudio', name: 'LM Studio (Local)', requiresKey: false },
    { id: 'llamacpp', name: 'Vodou Local (llama.cpp)', requiresKey: false },
    { id: 'custom', name: 'Custom (OpenAI-compatible)', requiresKey: false },
];
// Mask API keys for display
function maskKey(key) {
    if (!key || key.length < 8)
        return key ? '***' : '';
    return key.substring(0, 7) + '...' + key.substring(key.length - 4);
}
/** Read `KEY=value` from a `.env` file (no shell expansion). Used so API key edits apply without restarting Node. */
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
            const k = t.slice(0, eq).trim();
            if (k !== key)
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
/** Test / models: prefer key from the request body, then DB / .env (same as chat). */
function resolveOpenRouterApiKeyForRequest(body) {
    for (const raw of [body.api_key, body.openrouter_api_key]) {
        if (typeof raw !== 'string')
            continue;
        const n = normalizeOpenRouterApiKeyCandidate(raw.replace(/\r$/, '').trim());
        if (n)
            return n;
    }
    return resolveOpenRouterApiKey();
}
/**
 * GET /api/settings — current LLM config
 */
settingsRouter.get('/', (req, res) => {
    const settings = getAllSettings();
    const currentProvider = settings.llm_provider || getAuthType() || 'none';
    // Map auth mode names to provider IDs
    const providerMap = {
        'claude-cli': 'claude-cli',
        'api-key': 'anthropic',
        'none': 'none',
    };
    const activeProvider = settings.llm_provider || providerMap[currentProvider] || currentProvider;
    res.json({
        provider: activeProvider,
        cli_model: settings.cli_model || process.env.CLI_MODEL || 'sonnet',
        claude_model: settings.claude_model || process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
        anthropic_api_key: maskKey(settings.anthropic_api_key || process.env.ANTHROPIC_API_KEY || ''),
        openai_api_key: maskKey(settings.openai_api_key || ''),
        openai_model: settings.openai_model || 'gpt-4o',
        ollama_base_url: settings.ollama_base_url || 'http://localhost:11434',
        ollama_model: settings.ollama_model || '',
        google_api_key: maskKey(settings.google_api_key || ''),
        google_model: settings.google_model || 'gemini-2.5-flash',
        groq_api_key: maskKey(settings.groq_api_key || ''),
        groq_model: settings.groq_model || 'llama-3.3-70b-versatile',
        deepseek_api_key: maskKey(settings.deepseek_api_key || ''),
        deepseek_model: settings.deepseek_model || 'deepseek-chat',
        xai_api_key: maskKey(settings.xai_api_key || ''),
        xai_model: settings.xai_model || 'grok-3',
        mistral_api_key: maskKey(settings.mistral_api_key || ''),
        mistral_model: settings.mistral_model || 'mistral-large-latest',
        openrouter_api_key: maskKey(settings.openrouter_api_key || ''),
        openrouter_model: settings.openrouter_model || 'openai/gpt-4o',
        fireworks_api_key: maskKey(settings.fireworks_api_key || ''),
        fireworks_model: settings.fireworks_model || 'accounts/fireworks/models/kimi-k2p6',
        vodou_model: settings.vodou_model || 'accounts/fireworks/models/kimi-k2p6',
        together_api_key: maskKey(settings.together_api_key || ''),
        together_model: settings.together_model || 'moonshotai/Kimi-K2.6',
        kimi_api_key: maskKey(settings.kimi_api_key || ''),
        kimi_model: settings.kimi_model || 'kimi-k3',
        kimi_cli_model: settings.kimi_cli_model || 'kimi-k3',
        custom_llm_base_url: settings.custom_llm_base_url || '',
        custom_llm_model: settings.custom_llm_model || '',
        custom_llm_api_key: maskKey(settings.custom_llm_api_key || ''),
        lmstudio_base_url: settings.lmstudio_base_url || 'http://localhost:1234',
        lmstudio_model: settings.lmstudio_model || '',
        llamacpp_model: settings.llamacpp_model || '',
        max_tokens: parseInt(settings.max_tokens || process.env.MAX_TOKENS || '8096', 10),
        claude_cli_status: getClaudeCliStatus(),
        kimi_cli_status: getKimiCliStatus(),
        available_providers: PROVIDERS.map(p => ({
            ...p,
            configured: isProviderConfigured(p.id, settings),
            status: activeProvider === p.id ? 'active' : isProviderConfigured(p.id, settings) ? 'configured' : 'unconfigured',
        })),
    });
});
/**
 * Check Claude CLI installation and auth status.
 * Cached for 60s since the auth probe can be slow.
 */
let _cliStatusCache = null;
let _cliStatusCachedAt = 0;
const CLI_STATUS_TTL = 60_000;
function getClaudeCliStatus() {
    const now = Date.now();
    if (_cliStatusCache && (now - _cliStatusCachedAt) < CLI_STATUS_TTL) {
        return _cliStatusCache;
    }
    let installed = false;
    let authenticated = false;
    let version = '';
    try {
        const whichResult = (resolveBinPath('claude') || '');
        if (whichResult)
            installed = true;
    }
    catch { }
    if (installed) {
        try {
            const _cb = resolveBinPath('claude');
            const versionResult = _cb ? execFileSync(_cb, ['--version'], { stdio: 'pipe', timeout: 5000, windowsHide: true }).toString().trim() : '';
            if (versionResult)
                version = versionResult.split('\n')[0];
        }
        catch { }
        // If the gateway is already using claude-cli successfully, it's authenticated
        if (getAuthType() === 'claude-cli') {
            authenticated = true;
        }
        else {
            // Quick check: claude auth status (fast, no LLM call)
            try {
                // Shell-free (execSync = cmd.exe flash on Windows); mimic `2>&1 || true`.
                const _ab = resolveBinPath('claude');
                const _ar = _ab ? require('child_process').spawnSync(_ab, ['auth', 'status'], { stdio: 'pipe', timeout: 5000, windowsHide: true, encoding: 'utf-8' }) : null;
                const result = _ar ? ((_ar.stdout || '') + (_ar.stderr || '')) : '';
                // If it doesn't mention "not" or "no" near "authenticated/logged", assume good
                if (!result.toLowerCase().includes('not authenticated') && !result.toLowerCase().includes('not logged')) {
                    authenticated = true;
                }
            }
            catch {
                // If auth subcommand doesn't exist, assume authenticated if binary exists
                authenticated = true;
            }
        }
    }
    _cliStatusCache = { installed, authenticated, version };
    _cliStatusCachedAt = now;
    return _cliStatusCache;
}
let _kimiCliStatusCache = null;
let _kimiCliStatusCachedAt = 0;
function getKimiCliStatus() {
    const now = Date.now();
    if (_kimiCliStatusCache && (now - _kimiCliStatusCachedAt) < CLI_STATUS_TTL) {
        return _kimiCliStatusCache;
    }
    let installed = false;
    let authenticated = false;
    let version = '';
    try {
        const whichResult = (resolveBinPath(KIMI_BIN) || '');
        if (whichResult)
            installed = true;
    }
    catch { }
    if (installed) {
        try {
            const _kb = resolveBinPath(KIMI_BIN);
            const versionResult = (_kb ? execFileSync(_kb, ['--version'], { stdio: 'pipe', timeout: 5000, windowsHide: true }).toString() : '')
                .toString()
                .trim();
            if (versionResult)
                version = versionResult.split('\n')[0];
        }
        catch { }
        // Optimistic: avoid a slow subprocess on every settings page load; chat/ensure surfaces auth errors.
        authenticated = installed;
    }
    _kimiCliStatusCache = { installed, authenticated, version };
    _kimiCliStatusCachedAt = now;
    return _kimiCliStatusCache;
}
function isProviderConfigured(id, settings) {
    switch (id) {
        case 'claude':
        case 'claude-cli': {
            try {
                if (!resolveBinPath('claude'))
                    throw new Error('claude not found');
                return true;
            }
            catch {
                return false;
            }
        }
        case 'anthropic': return !!(settings.anthropic_api_key || process.env.ANTHROPIC_API_KEY);
        case 'kimi-cli': {
            try {
                if (!resolveBinPath(KIMI_BIN))
                    throw new Error('kimi not found');
                return true;
            }
            catch {
                return false;
            }
        }
        case 'kimi': return !!(settings.kimi_api_key || process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY);
        case 'openai': return !!settings.openai_api_key;
        case 'google': return !!settings.google_api_key;
        case 'groq': return !!settings.groq_api_key;
        case 'deepseek': return !!settings.deepseek_api_key;
        case 'xai': return !!settings.xai_api_key;
        case 'mistral': return !!settings.mistral_api_key;
        case 'openrouter': return !!(settings.openrouter_api_key || process.env.OPENROUTER_API_KEY ||
            readEnvFileKey(path.join(getProjectRoot(), '.env'), 'OPENROUTER_API_KEY') ||
            readEnvFileKey(path.join(getProjectRoot(), 'MCP-servers', 'Vodou-Console', '.env'), 'OPENROUTER_API_KEY'));
        case 'vodou': {
            // Managed tier is usable only when: proxy enabled AND the user has a Vodou
            // account wired (token + user id). No user key — those come from app.vodou.ai.
            const hasTok = !!(process.env.VODOU_TOKEN || process.env.OI_TOKEN || settings.vodou_token);
            const hasUid = !!(process.env.VODOU_USER_ID || process.env.OI_USER_ID);
            return !!process.env.VODOU_LLM_PROXY_URL && hasTok && hasUid;
        }
        case 'fireworks': return !!(settings.fireworks_api_key || process.env.FIREWORKS_API_KEY);
        case 'together': return !!(settings.together_api_key || process.env.TOGETHER_API_KEY);
        case 'ollama': return !!settings.ollama_base_url;
        // Local runtimes: "configured" = a model is selected (URL/port have defaults).
        case 'lmstudio': return !!settings.lmstudio_model;
        case 'llamacpp': return !!settings.llamacpp_model;
        case 'custom': return !!(settings.custom_llm_base_url && settings.custom_llm_model);
        default: return false;
    }
}
/**
 * POST /api/settings — save settings and switch provider
 */
settingsRouter.post('/', async (req, res) => {
    const body = req.body;
    // Surfaces non-fatal but user-visible problems back to the response (e.g. the
    // settings persisted, but memory.toml write failed). Set inside the sync block.
    let memTomlWarning = null;
    // Entitlement gate: the managed Vodou LLM is a paid-plan product. Free / BYOK-only
    // users (monthly_token_limit <= 0) may not activate it. The `=== 'vodou'` guard means
    // zero added latency for every other provider save (checkQuota never runs for them).
    if (body.provider === 'vodou') {
        const uid = process.env.VODOU_USER_ID || process.env.OI_USER_ID || '';
        const tok = process.env.VODOU_TOKEN || process.env.OI_TOKEN || getSetting('vodou_token') || '';
        // Only gate a genuinely-connected account. Missing proxy/token/uid is a
        // "connect your account" state (handled downstream), not "not entitled" — fall through.
        if (process.env.VODOU_LLM_PROXY_URL && tok && uid) {
            const q = await checkQuota(uid); // reuses the 30s-cached helper from the chat path
            // Never block on a degraded (fail-open) result — a paid user mid-outage would be
            // wrongly told to upgrade. The proxy still enforces token allowance at runtime.
            if (!q.degraded && !(q.monthlyTokenLimit > 0)) {
                res.status(403).json({
                    error: "The Vodou LLM isn't included in the Free plan. Upgrade to a paid plan to use it, or keep using a BYOK provider (Claude CLI, Anthropic API, etc.).",
                    reason: 'not_entitled',
                    upgrade_url: upgradeUrl(),
                });
                return;
            }
        }
    }
    // Validate required fields per provider
    if (body.provider) {
        switch (body.provider) {
            case 'anthropic':
                if (!body.anthropic_api_key && !getSetting('anthropic_api_key') && !process.env.ANTHROPIC_API_KEY) {
                    res.status(400).json({ error: 'Anthropic API key is required' });
                    return;
                }
                break;
            case 'kimi':
                if (!body.kimi_api_key && !getSetting('kimi_api_key') && !process.env.MOONSHOT_API_KEY && !process.env.KIMI_API_KEY) {
                    res.status(400).json({ error: 'Kimi (Moonshot) API key is required' });
                    return;
                }
                break;
            case 'openai':
                if (!body.openai_api_key && !getSetting('openai_api_key')) {
                    res.status(400).json({ error: 'OpenAI API key is required' });
                    return;
                }
                break;
            case 'google':
                if (!body.google_api_key && !getSetting('google_api_key')) {
                    res.status(400).json({ error: 'Google Gemini API key is required' });
                    return;
                }
                break;
            case 'groq':
                if (!body.groq_api_key && !getSetting('groq_api_key')) {
                    res.status(400).json({ error: 'Groq API key is required' });
                    return;
                }
                break;
            case 'deepseek':
                if (!body.deepseek_api_key && !getSetting('deepseek_api_key')) {
                    res.status(400).json({ error: 'DeepSeek API key is required' });
                    return;
                }
                break;
            case 'xai':
                if (!body.xai_api_key && !getSetting('xai_api_key')) {
                    res.status(400).json({ error: 'xAI API key is required' });
                    return;
                }
                break;
            case 'mistral':
                if (!body.mistral_api_key && !getSetting('mistral_api_key')) {
                    res.status(400).json({ error: 'Mistral API key is required' });
                    return;
                }
                break;
            case 'openrouter':
                if (!body.openrouter_api_key && !getSetting('openrouter_api_key') && !process.env.OPENROUTER_API_KEY) {
                    res.status(400).json({ error: 'OpenRouter API key is required' });
                    return;
                }
                break;
            case 'fireworks':
                if (!body.fireworks_api_key && !getSetting('fireworks_api_key') && !process.env.FIREWORKS_API_KEY) {
                    res.status(400).json({ error: 'Fireworks API key is required' });
                    return;
                }
                break;
            case 'together':
                if (!body.together_api_key && !getSetting('together_api_key') && !process.env.TOGETHER_API_KEY) {
                    res.status(400).json({ error: 'Together.ai API key is required' });
                    return;
                }
                break;
            case 'custom':
                if (!body.custom_llm_base_url && !getSetting('custom_llm_base_url')) {
                    res.status(400).json({ error: 'Custom LLM base URL is required' });
                    return;
                }
                if (!body.custom_llm_model && !getSetting('custom_llm_model')) {
                    res.status(400).json({ error: 'Custom LLM model name is required' });
                    return;
                }
                break;
        }
    }
    if (body.openai_api_key?.trim() && looksLikeOpenRouterKey(body.openai_api_key)) {
        res.status(400).json({
            error: 'That value looks like an OpenRouter key (sk-or-v1-…). Save it under the OpenRouter provider, not OpenAI. ' +
                'If you already saved it by mistake, clear the OpenAI key field and try again.',
        });
        return;
    }
    if (body.openrouter_api_key != null && String(body.openrouter_api_key).trim() !== '') {
        const ok = normalizeOpenRouterApiKeyCandidate(String(body.openrouter_api_key));
        if (!ok) {
            res.status(400).json({
                error: 'OpenRouter API key looks invalid (placeholder text, masked preview like sk-or-v1…, or empty). ' +
                    'Paste the full key from https://openrouter.ai/keys — it must be the complete sk-or-v1-… string.',
            });
            return;
        }
        body.openrouter_api_key = ok;
    }
    // Save all provided settings to DB
    const settingsKeys = [
        'llm_provider', 'cli_model', 'claude_model',
        'anthropic_api_key', 'kimi_api_key', 'kimi_model', 'kimi_cli_model', 'openai_api_key', 'openai_model',
        'google_api_key', 'google_model',
        'groq_api_key', 'groq_model',
        'deepseek_api_key', 'deepseek_model',
        'xai_api_key', 'xai_model',
        'mistral_api_key', 'mistral_model',
        'openrouter_api_key', 'openrouter_model',
        'fireworks_api_key', 'fireworks_model',
        'vodou_model',
        'together_api_key', 'together_model',
        'ollama_base_url', 'ollama_model',
        'lmstudio_base_url', 'lmstudio_model',
        'llamacpp_model',
        'custom_llm_base_url', 'custom_llm_model', 'custom_llm_api_key',
        'max_tokens',
    ];
    // Map 'provider' to 'llm_provider' in storage
    if (body.provider)
        body.llm_provider = body.provider;
    for (const key of settingsKeys) {
        const val = body[key];
        if (val === undefined)
            continue; // not provided → leave existing value as-is
        if (val === '') {
            // Explicit clear: blank the DB row AND drop the live env var so the
            // `getSetting() || process.env` fallback in llm.ts can't resurface it
            // in the current process. writeToEnv strips it from the .env file below.
            setSetting(key, '');
            for (const envName of (CLEARABLE_KEY_ENV[key] ?? []))
                delete process.env[envName];
        }
        else {
            setSetting(key, String(val));
        }
    }
    // Also write key env vars to .env for persistence across restarts
    try {
        writeToEnv(body);
    }
    catch (err) {
        console.error('[Settings] Failed to update .env:', err);
    }
    // Sync memory extraction provider with LLM choice (writes to project root .env)
    if (body.provider) {
        try {
            // Gateway provider name → memory.toml extraction provider. "auto" means
            // memory extraction follows whatever the gateway is currently using
            // (per the 2026-05-06 default). Use a named provider here only if the
            // extraction backend should differ from chat.
            const memProviderMap = {
                'vodou': 'auto', // managed: extraction follows the gateway path → resolves to vodou → proxy
                'claude': 'auto', // Claude CLI (Max subscription) — extraction reuses the gateway path
                'claude-cli': 'auto', // legacy alias
                'anthropic': 'anthropic',
                'kimi-cli': 'heuristic',
                'kimi': 'heuristic',
                'ollama': 'ollama',
                'openai': 'openai',
                'google': 'google',
                'groq': 'groq',
                'deepseek': 'deepseek',
                'xai': 'xai',
                'mistral': 'mistral',
                'openrouter': 'heuristic',
                'custom': 'heuristic', // custom endpoints vary too much for auto-extraction
            };
            // Fallback to "auto" rather than "heuristic" so an unmapped provider
            // still gets a working extractor instead of silently downgrading.
            const memProvider = memProviderMap[body.provider] || 'auto';
            // Update memory.toml directly — single source of truth for extraction provider
            const tomlPath = path.resolve(getProjectRoot(), 'memory.toml');
            try {
                let toml = '';
                try {
                    toml = readFileSync(tomlPath, 'utf-8');
                }
                catch { }
                if (toml.match(/^provider\s*=\s*.*/m)) {
                    toml = toml.replace(/^provider\s*=\s*.*/m, `provider = "${memProvider}"`);
                }
                else if (toml.includes('[extraction]')) {
                    toml = toml.replace(/\[extraction\]/, `[extraction]\nprovider = "${memProvider}"`);
                }
                else {
                    toml += `\n[extraction]\nprovider = "${memProvider}"\n`;
                }
                writeFileSync(tomlPath, toml, 'utf-8');
                console.error(`[Settings] memory.toml extraction provider set to: ${memProvider}`);
                memTomlWarning = null;
            }
            catch (tomlErr) {
                const msg = tomlErr.message || String(tomlErr);
                console.error('[Settings] Failed to update memory.toml:', tomlErr);
                // Surface the failure to the caller so they don't think the provider
                // switch fully persisted. Memory extraction will keep using whatever
                // memory.toml still says — which is now out of sync with the UI.
                memTomlWarning = `Saved provider in settings, but failed to update memory.toml (${msg}). Memory extraction provider may be out of sync until the file is writable.`;
            }
        }
        catch (err) {
            console.error('[Settings] Failed to sync memory extraction provider:', err);
            memTomlWarning = `Settings saved, but memory extraction provider sync failed: ${err.message || String(err)}`;
        }
    }
    // Hot-reload the LLM config
    try {
        await reinitAuth();
    }
    catch (err) {
        console.error('[Settings] reinitAuth error:', err);
    }
    res.json({
        ok: true,
        provider: body.provider || getSetting('llm_provider'),
        ...(memTomlWarning ? { warning: memTomlWarning } : {}),
    });
});
/**
 * POST /api/settings/test — test a provider connection
 */
settingsRouter.post('/test', async (req, res) => {
    const b = req.body;
    const { provider, api_key, model, base_url, openrouter_api_key } = b;
    try {
        switch (provider) {
            case 'vodou': {
                // Test the managed tier: proxy enabled + the user's Vodou token/user-id
                // resolve to a real plan with quota. Validates against the app-box quota
                // endpoint (same gate the proxy uses) — NO Fireworks call, no spend.
                const proxy = process.env.VODOU_LLM_PROXY_URL || '';
                if (!proxy) {
                    res.json({ success: false, error: 'Vodou managed LLM is not enabled on this gateway (VODOU_LLM_PROXY_URL unset).' });
                    return;
                }
                const tok = process.env.VODOU_TOKEN || process.env.OI_TOKEN || getSetting('vodou_token') || '';
                const uid = process.env.VODOU_USER_ID || process.env.OI_USER_ID || '';
                if (!tok || !uid) {
                    res.json({ success: false, error: 'Connect your Vodou account first — missing Vodou token or user ID.' });
                    return;
                }
                const appBase = (process.env.VODOU_WEB_SERVER_URL || process.env.OI_WEB_SERVER_URL || 'https://app.vodou.ai').replace(/\/$/, '');
                try {
                    const r = await fetch(`${appBase}/api/usage/limits`, { headers: { Authorization: `Bearer ${tok}:${uid}` }, signal: AbortSignal.timeout(8000) });
                    if (r.status === 401 || r.status === 403) {
                        res.json({ success: false, error: 'Invalid Vodou token — sign in again at app.vodou.ai.' });
                        return;
                    }
                    const j = await r.json().catch(() => ({}));
                    const dq = j?.data ?? j;
                    const mdl = (getSetting('vodou_model') || 'accounts/fireworks/models/kimi-k2p6').replace('accounts/fireworks/models/', '');
                    const used = Number(dq?.tokens_used ?? 0);
                    const lim = Number(dq?.monthly_token_limit ?? 0);
                    const fmt = (n) => n >= 1_000_000 ? (n / 1_000_000).toFixed(n % 1_000_000 ? 2 : 0) + 'M' : n.toLocaleString();
                    const pct = lim > 0 ? Math.round((used / lim) * 100) : 0;
                    res.json({ success: true, model: `Vodou LLM (${mdl})`, response: `${dq?.plan_id || 'plan'} plan — ${fmt(used)} of ${fmt(lim)} monthly tokens used (${pct}%)` });
                }
                catch (e) {
                    res.json({ success: false, error: 'Could not reach Vodou billing: ' + (e?.message || String(e)) });
                }
                return;
            }
            case 'claude':
            case 'claude-cli': {
                if (!resolveBinPath('claude'))
                    throw new Error('claude not found');
                res.json({ success: true, model: 'Claude CLI', response: 'Claude CLI is available' });
                return;
            }
            case 'kimi-cli': {
                if (!resolveBinPath(KIMI_BIN))
                    throw new Error('kimi not found');
                res.json({ success: true, model: 'Kimi CLI', response: 'Kimi CLI binary is available (run kimi login if chats fail)' });
                return;
            }
            case 'anthropic': {
                const key = api_key || getSetting('anthropic_api_key') || process.env.ANTHROPIC_API_KEY;
                if (!key) {
                    res.status(400).json({ success: false, error: 'No API key provided' });
                    return;
                }
                const resp = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'x-api-key': key,
                        'content-type': 'application/json',
                        'anthropic-version': '2023-06-01',
                    },
                    body: JSON.stringify({
                        model: model || 'claude-sonnet-4-20250514',
                        max_tokens: 50,
                        messages: [{ role: 'user', content: 'Say hello in 5 words.' }],
                    }),
                });
                const data = await resp.json();
                if (data.error) {
                    res.json({ success: false, error: data.error.message });
                    return;
                }
                const text = data.content?.[0]?.text || 'OK';
                res.json({ success: true, model: model || data.model, response: text });
                return;
            }
            case 'openai': {
                const key = api_key || getSetting('openai_api_key');
                if (!key) {
                    res.status(400).json({ success: false, error: 'No API key provided' });
                    return;
                }
                if (looksLikeOpenRouterKey(key)) {
                    res.json({
                        success: false,
                        error: 'That key is an OpenRouter key (sk-or-v1-…). Use the OpenRouter card → Test Connection, not OpenAI. ' +
                            'OpenAI’s API only accepts keys from https://platform.openai.com/api-keys',
                    });
                    return;
                }
                const resp = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: model || 'gpt-4o',
                        max_tokens: 50,
                        messages: [{ role: 'user', content: 'Say hello in 5 words.' }],
                    }),
                });
                const data = await resp.json();
                if (data.error) {
                    res.json({ success: false, error: data.error.message });
                    return;
                }
                const text = data.choices?.[0]?.message?.content || 'OK';
                res.json({ success: true, model: data.model || model, response: text });
                return;
            }
            case 'ollama': {
                const url = (base_url || getSetting('ollama_base_url') || 'http://localhost:11434').replace(/\/$/, '');
                const mdl = model || getSetting('ollama_model') || 'llama3';
                const resp = await fetch(url + '/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: mdl,
                        stream: false,
                        messages: [{ role: 'user', content: 'Say hello in 5 words.' }],
                    }),
                });
                const data = await resp.json();
                if (data.error) {
                    res.json({ success: false, error: data.error });
                    return;
                }
                const text = data.message?.content || 'OK';
                res.json({ success: true, model: data.model || mdl, response: text });
                return;
            }
            case 'custom': {
                const url = (base_url || getSetting('custom_llm_base_url') || '').replace(/\/$/, '');
                if (!url) {
                    res.status(400).json({ success: false, error: 'No base URL provided' });
                    return;
                }
                const mdl = model || getSetting('custom_llm_model') || 'default';
                const key = api_key || getSetting('custom_llm_api_key') || '';
                const headers = { 'Content-Type': 'application/json' };
                if (key)
                    headers['Authorization'] = 'Bearer ' + key;
                const resp = await fetch(url + '/v1/chat/completions', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        model: mdl,
                        max_tokens: 50,
                        messages: [{ role: 'user', content: 'Say hello in 5 words.' }],
                    }),
                });
                const data = await resp.json();
                if (data.error) {
                    res.json({ success: false, error: typeof data.error === 'string' ? data.error : data.error.message });
                    return;
                }
                const text = data.choices?.[0]?.message?.content || 'OK';
                res.json({ success: true, model: data.model || mdl, response: text });
                return;
            }
            case 'lmstudio': {
                const url = (base_url || getSetting('lmstudio_base_url') || 'http://localhost:1234').replace(/\/$/, '');
                const mdl = model || getSetting('lmstudio_model') || '';
                try {
                    const resp = await fetch(url + '/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model: mdl, max_tokens: 50, messages: [{ role: 'user', content: 'Say hello in 5 words.' }] }),
                        signal: AbortSignal.timeout(30000),
                    });
                    const data = await resp.json();
                    if (data.error) {
                        res.json({ success: false, error: typeof data.error === 'string' ? data.error : data.error.message });
                        return;
                    }
                    const text = data.choices?.[0]?.message?.content || 'OK';
                    res.json({ success: true, model: data.model || mdl, response: text });
                }
                catch (err) {
                    res.json({ success: false, error: 'LM Studio not reachable at ' + url + ' — is the local server running?' });
                }
                return;
            }
            case 'llamacpp': {
                const url = 'http://127.0.0.1:' + (process.env.VODOU_LLAMACPP_PORT || '11436');
                const mdl = model || getSetting('llamacpp_model') || '';
                try {
                    const resp = await fetch(url + '/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model: mdl, max_tokens: 50, messages: [{ role: 'user', content: 'Say hello in 5 words.' }] }),
                        signal: AbortSignal.timeout(30000),
                    });
                    const data = await resp.json();
                    if (data.error) {
                        res.json({ success: false, error: typeof data.error === 'string' ? data.error : data.error.message });
                        return;
                    }
                    const text = data.choices?.[0]?.message?.content || 'OK';
                    res.json({ success: true, model: data.model || mdl, response: text });
                }
                catch (err) {
                    res.json({ success: false, error: 'Vodou Local (llama.cpp) not running — start it from the Vodou Local card first.' });
                }
                return;
            }
            // All OpenAI-compatible preset providers
            case 'google':
            case 'groq':
            case 'deepseek':
            case 'xai':
            case 'mistral':
            case 'kimi':
            case 'openrouter':
            case 'fireworks':
            case 'together': {
                const presets = {
                    google: { url: 'https://generativelanguage.googleapis.com/v1beta/openai', keyName: 'google_api_key', defaultModel: 'gemini-2.5-flash' },
                    groq: { url: 'https://api.groq.com/openai/v1', keyName: 'groq_api_key', defaultModel: 'llama-3.3-70b-versatile' },
                    deepseek: { url: 'https://api.deepseek.com/v1', keyName: 'deepseek_api_key', defaultModel: 'deepseek-chat' },
                    xai: { url: 'https://api.x.ai/v1', keyName: 'xai_api_key', defaultModel: 'grok-3' },
                    mistral: { url: 'https://api.mistral.ai/v1', keyName: 'mistral_api_key', defaultModel: 'mistral-large-latest' },
                    kimi: { url: 'https://api.moonshot.ai/v1', keyName: 'kimi_api_key', defaultModel: 'kimi-k3' },
                    openrouter: { url: 'https://openrouter.ai/api/v1', keyName: 'openrouter_api_key', defaultModel: 'openai/gpt-4o' },
                    fireworks: { url: 'https://api.fireworks.ai/inference/v1', keyName: 'fireworks_api_key', defaultModel: 'accounts/fireworks/models/kimi-k2p6' },
                    together: { url: 'https://api.together.ai/v1', keyName: 'together_api_key', defaultModel: 'moonshotai/Kimi-K2.6' },
                };
                const preset = presets[provider];
                const rawKey = provider === 'openrouter'
                    ? resolveOpenRouterApiKeyForRequest(b)
                    : (api_key || getSetting(preset.keyName));
                const key = String(rawKey ?? '').replace(/\r$/, '').trim();
                if (!key) {
                    res.status(400).json({
                        success: false,
                        error: provider === 'openrouter'
                            ? 'No OpenRouter API key detected. Paste your sk-or-v1-… key in the field (not only whitespace), click Test again, or set OPENROUTER_API_KEY in the project root .env and restart the gateway.'
                            : 'No API key provided',
                    });
                    return;
                }
                const mdl = model || getSetting(provider + '_model') || preset.defaultModel;
                const headers = {
                    Authorization: 'Bearer ' + key,
                    'Content-Type': 'application/json',
                };
                if (provider === 'openrouter') {
                    headers['HTTP-Referer'] = process.env.OPENROUTER_HTTP_REFERER || process.env.GATEWAY_BASE_URL || 'http://localhost:8765';
                    headers['X-Title'] = process.env.OPENROUTER_APP_TITLE || 'Vodou-Console';
                }
                const resp = await fetch(preset.url + '/chat/completions', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        model: mdl,
                        max_tokens: 50,
                        messages: [{ role: 'user', content: 'Say hello in 5 words.' }],
                    }),
                });
                const data = await resp.json();
                if (data.error) {
                    let errMsg = typeof data.error === 'string' ? data.error : data.error.message;
                    if (provider === 'openrouter' &&
                        typeof errMsg === 'string' &&
                        /missing authentication/i.test(errMsg)) {
                        errMsg =
                            'OpenRouter saw no valid API key (this often happens with a placeholder, masked preview text, or an empty OPENROUTER_API_KEY). ' +
                                'Paste the full sk-or-v1-… key from https://openrouter.ai/keys into the OpenRouter field, click Test, or set OPENROUTER_API_KEY in the project .env and restart the gateway.';
                    }
                    res.json({ success: false, error: errMsg });
                    return;
                }
                const text = data.choices?.[0]?.message?.content || data.content?.[0]?.text || 'OK';
                res.json({ success: true, model: data.model || mdl, response: text });
                return;
            }
            default:
                res.status(400).json({ success: false, error: 'Unknown provider: ' + provider });
        }
    }
    catch (err) {
        res.json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
});
/**
 * POST /api/settings/ensure — check if active LLM provider is ready, auto-start if possible
 *
 * Returns: { ready, provider, status, message, action? }
 *   ready: boolean — provider is reachable and can handle messages
 *   status: 'ready' | 'starting' | 'unavailable' | 'unconfigured'
 *   action: optional — what was done (e.g. 'started_ollama')
 */
settingsRouter.post('/ensure', async (req, res) => {
    const settings = getAllSettings();
    const provider = settings.llm_provider || getAuthType() || 'none';
    if (provider === 'none') {
        res.json({ ready: false, provider: 'none', status: 'unconfigured', message: 'No LLM provider configured. Go to Settings to set one up.' });
        return;
    }
    try {
        switch (provider) {
            case 'claude':
            case 'claude-cli': {
                // Check binary exists
                let cliBin = '';
                try {
                    cliBin = (resolveBinPath('claude') || '');
                }
                catch { }
                if (!cliBin) {
                    res.json({ ready: false, provider, status: 'unavailable', message: process.platform === 'win32' ? 'Claude CLI not found. Install it in PowerShell: irm https://claude.ai/install.ps1 | iex (then open a new window)' : 'Claude CLI not found. Install it: curl -fsSL https://claude.ai/install.sh | bash' });
                    return;
                }
                // Check auth status (cached)
                const cliStatus = getClaudeCliStatus();
                if (!cliStatus.authenticated) {
                    res.json({ ready: false, provider, status: 'unavailable', message: 'Claude CLI not authenticated. Run: claude auth login' });
                    return;
                }
                // Fast path: if a warm CLI session is already running (pre-spawned by warmup),
                // skip the blocking live test — the process is alive and ready.
                if (hasActiveCliSession()) {
                    res.json({ ready: true, provider, status: 'ready', message: `Claude CLI ready (${cliStatus.version || getSetting('cli_model') || 'sonnet'})`, action: 'pool_warm' });
                    return;
                }
                // Slow path: no warm session yet — do a blocking live test to verify connectivity
                try {
                    const cliModel = getSetting('cli_model') || 'sonnet';
                    const testEnv = { ...process.env };
                    delete testEnv.ANTHROPIC_API_KEY; // CLI must use Max subscription OAuth
                    const _cb2 = resolveBinPath('claude') || 'claude';
                    const result = execFileSync(_cb2, ['-p', '--model', cliModel, '--output-format', 'text', 'Reply with only the word OK'], { stdio: 'pipe', timeout: 30_000, cwd: getProjectRoot(), env: testEnv, encoding: 'utf-8', windowsHide: true }).trim();
                    if (result) {
                        res.json({ ready: true, provider, status: 'ready', message: `Claude CLI verified (${cliStatus.version || cliModel})`, action: 'warmup' });
                        return;
                    }
                }
                catch (testErr) {
                    const errMsg = testErr instanceof Error ? testErr.message : String(testErr);
                    // Common failures: auth expired, network, credit balance
                    if (errMsg.includes('credit') || errMsg.includes('balance')) {
                        res.json({ ready: false, provider, status: 'unavailable', message: 'Claude CLI auth issue — check your Max subscription. Run: claude auth login' });
                    }
                    else if (errMsg.includes('ETIMEDOUT') || errMsg.includes('timeout')) {
                        res.json({ ready: false, provider, status: 'unavailable', message: 'Claude CLI timed out — check network connection' });
                    }
                    else {
                        res.json({ ready: false, provider, status: 'unavailable', message: 'Claude CLI test failed: ' + errMsg.substring(0, 200) });
                    }
                    return;
                }
                res.json({ ready: true, provider, status: 'ready', message: `Claude CLI ready (${cliStatus.version || 'installed'})` });
                return;
            }
            case 'kimi-cli': {
                let kimiBin = '';
                try {
                    kimiBin = (resolveBinPath(KIMI_BIN) || '');
                }
                catch { }
                if (!kimiBin) {
                    res.json({
                        ready: false,
                        provider,
                        status: 'unavailable',
                        message: process.platform === 'win32' ? 'Kimi CLI is not yet available on Windows — use Kimi (Moonshot API) instead.' : `Kimi CLI not found. Install: curl -LsSf https://code.kimi.com/install.sh | bash`,
                    });
                    return;
                }
                const st = getKimiCliStatus();
                if (!st.authenticated) {
                    res.json({
                        ready: false,
                        provider,
                        status: 'unavailable',
                        message: 'Kimi CLI not authenticated. Run: kimi login',
                    });
                    return;
                }
                res.json({
                    ready: true,
                    provider,
                    status: 'ready',
                    message: `Kimi CLI ready (${st.version || getSetting('kimi_cli_model') || 'kimi'})`,
                });
                return;
            }
            case 'vodou': {
                // Managed tier readiness = proxy enabled on this gateway + the user's
                // Vodou token + user id present. No Fireworks call, no spend (matches
                // isProviderConfigured('vodou')). Without this case the switch fell to
                // default → "Unknown provider: vodou" surfaced as the model label.
                if (!process.env.VODOU_LLM_PROXY_URL) {
                    res.json({ ready: false, provider, status: 'unavailable', message: 'Vodou managed LLM is not enabled on this gateway.' });
                    return;
                }
                const tok = process.env.VODOU_TOKEN || process.env.OI_TOKEN || settings.vodou_token;
                const uid = process.env.VODOU_USER_ID || process.env.OI_USER_ID;
                if (!tok || !uid) {
                    res.json({ ready: false, provider, status: 'unconfigured', message: 'Connect your Vodou account first (missing Vodou token or user ID).' });
                    return;
                }
                const mdl = (settings.vodou_model || 'accounts/fireworks/models/kimi-k2p6').replace('accounts/fireworks/models/', '');
                res.json({ ready: true, provider, status: 'ready', message: `Vodou LLM (${mdl})` });
                return;
            }
            case 'anthropic': {
                const key = settings.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
                if (!key) {
                    res.json({ ready: false, provider, status: 'unconfigured', message: 'Anthropic API key not set. Add it in Settings.' });
                    return;
                }
                // Lightweight check — just verify the key format, don't burn tokens
                res.json({ ready: true, provider, status: 'ready', message: 'Anthropic API configured' });
                return;
            }
            case 'openai': {
                if (!settings.openai_api_key) {
                    res.json({ ready: false, provider, status: 'unconfigured', message: 'OpenAI API key not set. Add it in Settings.' });
                    return;
                }
                res.json({ ready: true, provider, status: 'ready', message: 'OpenAI API configured' });
                return;
            }
            case 'ollama': {
                const url = (settings.ollama_base_url || 'http://localhost:11434').replace(/\/$/, '');
                // Try to reach Ollama
                try {
                    const resp = await fetch(url + '/api/tags', { signal: AbortSignal.timeout(3000) });
                    if (resp.ok) {
                        res.json({ ready: true, provider, status: 'ready', message: 'Ollama is running' });
                        return;
                    }
                }
                catch { }
                // Not reachable — try to start it
                try {
                    const { spawn: spawnProcess } = await import('child_process');
                    const child = spawnProcess('ollama', ['serve'], {
                        stdio: 'ignore',
                        detached: true,
                    });
                    child.unref();
                    // Give it a moment to start, then re-check
                    await new Promise(r => setTimeout(r, 2000));
                    try {
                        const resp = await fetch(url + '/api/tags', { signal: AbortSignal.timeout(3000) });
                        if (resp.ok) {
                            res.json({ ready: true, provider, status: 'ready', message: 'Ollama started successfully', action: 'started_ollama' });
                            return;
                        }
                    }
                    catch { }
                    res.json({ ready: false, provider, status: 'starting', message: 'Ollama is starting up... refresh in a few seconds', action: 'started_ollama' });
                    return;
                }
                catch {
                    res.json({ ready: false, provider, status: 'unavailable', message: 'Ollama not found. Install it: https://ollama.com/download' });
                    return;
                }
            }
            case 'lmstudio': {
                const url = (settings.lmstudio_base_url || 'http://localhost:1234').replace(/\/$/, '');
                // 1. Already reachable?
                try {
                    const resp = await fetch(url + '/v1/models', { signal: AbortSignal.timeout(3000) });
                    if (resp.ok) {
                        res.json({ ready: true, provider, status: 'ready', message: 'LM Studio server is running' });
                        return;
                    }
                }
                catch { }
                // 2. Not reachable — try to start it via the `lms` CLI (only exists after
                // LM Studio has been launched once; resolve ~/.lmstudio/bin/lms then PATH).
                const os = await import('os');
                const fsMod = await import('fs');
                const lmsHome = path.join(os.homedir(), '.lmstudio', 'bin', 'lms');
                let lmsBin = fsMod.existsSync(lmsHome) ? lmsHome : '';
                if (!lmsBin) {
                    try {
                        lmsBin = (resolveBinPath('lms') || '');
                    }
                    catch { }
                }
                if (lmsBin) {
                    try {
                        const { spawn: spawnProcess } = await import('child_process');
                        const child = spawnProcess(lmsBin, ['server', 'start'], { stdio: 'ignore', detached: true });
                        child.unref();
                        await new Promise(r => setTimeout(r, 2000));
                        try {
                            const resp = await fetch(url + '/v1/models', { signal: AbortSignal.timeout(3000) });
                            if (resp.ok) {
                                res.json({ ready: true, provider, status: 'ready', message: 'LM Studio started', action: 'started_lmstudio' });
                                return;
                            }
                        }
                        catch { }
                        res.json({ ready: false, provider, status: 'starting', message: 'LM Studio is starting up... refresh in a few seconds', action: 'started_lmstudio' });
                        return;
                    }
                    catch { }
                }
                // 3. App installed but never launched (no `lms` yet) → needs one GUI launch.
                if (fsMod.existsSync('/Applications/LM Studio.app')) {
                    res.json({ ready: false, provider, status: 'installed_not_running', message: 'Open LM Studio once and enable the local server (Developer tab → Start Server), then refresh.' });
                    return;
                }
                // 4. Nothing found.
                res.json({ ready: false, provider, status: 'unavailable', message: 'LM Studio not found. Install it: https://lmstudio.ai/download' });
                return;
            }
            case 'llamacpp': {
                // Bundled llama.cpp — lifecycle owned by src/api/llamacpp.ts.
                const { llamacppReadiness } = await import('./llamacpp.js');
                await llamacppReadiness(settings, provider, res);
                return;
            }
            // API-key providers — just check key exists
            case 'google':
            case 'groq':
            case 'deepseek':
            case 'xai':
            case 'mistral':
            case 'kimi':
            case 'openrouter':
            case 'fireworks':
            case 'together': {
                const keyMap = {
                    google: 'google_api_key', groq: 'groq_api_key', deepseek: 'deepseek_api_key',
                    xai: 'xai_api_key', mistral: 'mistral_api_key', kimi: 'kimi_api_key',
                    openrouter: 'openrouter_api_key', fireworks: 'fireworks_api_key', together: 'together_api_key',
                };
                const nameMap = {
                    google: 'Google Gemini', groq: 'Groq', deepseek: 'DeepSeek',
                    xai: 'xAI (Grok)', mistral: 'Mistral', kimi: 'Kimi (Moonshot)',
                    openrouter: 'OpenRouter', fireworks: 'Fireworks.ai', together: 'Together.ai',
                };
                const key = settings[keyMap[provider]] || (provider === 'openrouter' ? process.env.OPENROUTER_API_KEY : provider === 'fireworks' ? process.env.FIREWORKS_API_KEY : provider === 'together' ? process.env.TOGETHER_API_KEY : undefined);
                if (!key) {
                    res.json({ ready: false, provider, status: 'unconfigured', message: `${nameMap[provider]} API key not set. Add it in Settings.` });
                    return;
                }
                res.json({ ready: true, provider, status: 'ready', message: `${nameMap[provider]} API configured` });
                return;
            }
            case 'custom': {
                const url = (settings.custom_llm_base_url || '').replace(/\/$/, '');
                if (!url) {
                    res.json({ ready: false, provider, status: 'unconfigured', message: 'Custom LLM base URL not set. Configure it in Settings.' });
                    return;
                }
                // Quick reachability check
                try {
                    const resp = await fetch(url + '/v1/models', { signal: AbortSignal.timeout(3000) });
                    if (resp.ok) {
                        res.json({ ready: true, provider, status: 'ready', message: 'Custom LLM endpoint reachable' });
                        return;
                    }
                }
                catch { }
                res.json({ ready: false, provider, status: 'unavailable', message: 'Custom LLM endpoint not reachable at ' + url });
                return;
            }
            default:
                res.json({ ready: false, provider, status: 'unconfigured', message: 'Unknown provider: ' + provider });
        }
    }
    catch (err) {
        res.json({ ready: false, provider, status: 'unavailable', message: err instanceof Error ? err.message : String(err) });
    }
});
/**
 * POST /api/settings/llamacpp/stop — stop the bundled llama-server (card stop button).
 */
settingsRouter.post('/llamacpp/stop', async (_req, res) => {
    try {
        const { stopLlamaServer } = await import('./llamacpp.js');
        const wasRunning = await stopLlamaServer();
        res.json({ stopped: wasRunning });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
/** GET /api/settings/llamacpp/cache — size + list of downloaded GGUF models. */
settingsRouter.get('/llamacpp/cache', async (_req, res) => {
    try {
        const { getModelCacheInfo } = await import('./llamacpp.js');
        res.json(getModelCacheInfo());
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
/** POST /api/settings/llamacpp/cache/clear — delete downloaded GGUF weights (stops server first). */
settingsRouter.post('/llamacpp/cache/clear', async (_req, res) => {
    try {
        const { clearModelCache } = await import('./llamacpp.js');
        const result = await clearModelCache();
        res.json(result);
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
/**
 * GET /api/settings/models/:provider — list available models
 */
// GET /api/settings/vodou-usage — live managed-tier usage for the settings card.
// No Fireworks call; pulls plan + tokens from the app-box quota endpoint.
settingsRouter.get('/vodou-usage', async (_req, res) => {
    try {
        const tok = process.env.VODOU_TOKEN || process.env.OI_TOKEN || getSetting('vodou_token') || '';
        const uid = process.env.VODOU_USER_ID || process.env.OI_USER_ID || '';
        if (!process.env.VODOU_LLM_PROXY_URL) {
            res.json({ ok: false, reason: 'disabled' });
            return;
        }
        if (!tok || !uid) {
            res.json({ ok: false, reason: 'not_connected' });
            return;
        }
        const appBase = (process.env.VODOU_WEB_SERVER_URL || process.env.OI_WEB_SERVER_URL || 'https://app.vodou.ai').replace(/\/$/, '');
        const r = await fetch(`${appBase}/api/usage/limits`, { headers: { Authorization: `Bearer ${tok}:${uid}` }, signal: AbortSignal.timeout(8000) });
        if (r.status === 401 || r.status === 403) {
            res.json({ ok: false, reason: 'invalid_token' });
            return;
        }
        const j = await r.json().catch(() => ({}));
        const d = j?.data ?? j;
        const used = Number(d?.tokens_used ?? 0);
        const limit = Number(d?.monthly_token_limit ?? 0);
        // This endpoint already fetched fresh limits. The settings page is where a user
        // lands right after upgrading, so drop the 30s checkQuota cache here too — the next
        // activation gate / chat pre-flight then sees the new plan instantly, not in ≤30s.
        invalidateQuotaCache(uid);
        res.json({
            ok: true,
            plan_id: d?.plan_id || 'free',
            tokens_used: used,
            monthly_token_limit: limit,
            pct: limit > 0 ? Math.round((used / limit) * 100) : 0,
            status: d?.status || 'ok',
            // Single source of truth for the UI: a plan includes the managed LLM iff it
            // carries a token allowance (matches the cloud's is_token_plan = limit > 0).
            entitled: limit > 0,
            upgrade_url: upgradeUrl(),
        });
    }
    catch (e) {
        res.json({ ok: false, reason: 'error', error: e?.message || String(e) });
    }
});
settingsRouter.get('/models/:provider', async (req, res) => {
    const provider = req.params.provider;
    const refresh = req.query.refresh === '1' ||
        req.query.refresh === 'true' ||
        String(req.query.refresh || '').toLowerCase() === 'yes';
    try {
        // Catalog-backed providers (curated + auto BYOK) — see model-catalog.ts
        if (isCuratedCatalogProvider(provider) || isAutoCatalogProvider(provider)) {
            const result = await resolveProviderModels(provider, { refresh });
            res.json({
                models: result.models,
                source: result.source,
                fetched_at: result.fetched_at,
                ...(result.error ? { error: result.error } : {}),
            });
            return;
        }
        switch (provider) {
            case 'ollama': {
                const url = (getSetting('ollama_base_url') || 'http://localhost:11434').replace(/\/$/, '');
                try {
                    const resp = await fetch(url + '/api/tags');
                    const data = await resp.json();
                    const models = (data.models || []).map((m) => m.name);
                    res.json({ models, source: 'local' });
                }
                catch (err) {
                    res.json({ models: [], error: 'Could not reach Ollama at ' + url });
                }
                return;
            }
            case 'lmstudio': {
                const url = (getSetting('lmstudio_base_url') || 'http://localhost:1234').replace(/\/$/, '');
                try {
                    const resp = await fetch(url + '/api/v0/models', { signal: AbortSignal.timeout(3000) });
                    if (resp.ok) {
                        const data = await resp.json();
                        const rows = (data.data || data.models || []);
                        const models = rows.map((m) => m.id || m.key || m.name).filter(Boolean);
                        const details = rows.map((m) => ({
                            id: m.id || m.key || m.name,
                            state: m.state,
                            quantization: m.quantization,
                            max_context_length: m.max_context_length,
                        }));
                        res.json({ models, details, source: 'local' });
                        return;
                    }
                }
                catch { }
                try {
                    const resp = await fetch(url + '/v1/models', { signal: AbortSignal.timeout(3000) });
                    const data = await resp.json();
                    const models = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
                    res.json({ models, source: 'local' });
                }
                catch (err) {
                    res.json({ models: [], error: 'Could not reach LM Studio at ' + url });
                }
                return;
            }
            case 'llamacpp': {
                const url = ('http://127.0.0.1:' + (process.env.VODOU_LLAMACPP_PORT || '11436'));
                const configured = getSetting('llamacpp_model') || '';
                const models = new Set();
                if (configured)
                    models.add(configured);
                try {
                    const resp = await fetch(url + '/v1/models', { signal: AbortSignal.timeout(3000) });
                    if (resp.ok) {
                        const data = await resp.json();
                        for (const m of (data.data || data.models || [])) {
                            const id = m.id || m.name;
                            if (id)
                                models.add(id);
                        }
                    }
                }
                catch { }
                res.json({ models: Array.from(models), source: 'local' });
                return;
            }
            case 'custom':
                res.json({ models: [], source: 'stub' });
                return;
            default:
                res.status(400).json({ error: 'Unknown provider' });
        }
    }
    catch (err) {
        res.json({ models: [], error: err instanceof Error ? err.message : String(err) });
    }
});
/**
 * Write key settings to .env for persistence across gateway restarts
 */
// Settings keys whose credential lives in .env / process.env under one or more
// env var names. Used to fully clear a key (DB + live process.env + .env file)
// when the user explicitly empties the field, since llm.ts resolves keys as
// `getSetting(k) || process.env.K` — clearing only the DB would let the env
// fallback resurface a "deleted" key.
const CLEARABLE_KEY_ENV = {
    anthropic_api_key: ['ANTHROPIC_API_KEY'],
    openai_api_key: ['OPENAI_API_KEY'],
    google_api_key: ['GEMINI_API_KEY'],
    groq_api_key: ['GROQ_API_KEY'],
    deepseek_api_key: ['DEEPSEEK_API_KEY'],
    xai_api_key: ['XAI_API_KEY'],
    mistral_api_key: ['MISTRAL_API_KEY'],
    openrouter_api_key: ['OPENROUTER_API_KEY'],
    fireworks_api_key: ['FIREWORKS_API_KEY'],
    together_api_key: ['TOGETHER_API_KEY'],
    kimi_api_key: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    custom_llm_api_key: ['CUSTOM_LLM_API_KEY'],
};
function writeToEnv(settings) {
    const envPath = path.resolve(getProjectRoot(), 'MCP-servers', 'Vodou-Console', '.env');
    // Read existing .env or start fresh
    let envContent = '';
    try {
        envContent = readFileSync(envPath, 'utf-8');
    }
    catch { }
    const updates = {};
    if (settings.provider)
        updates['LLM_PROVIDER'] = settings.provider;
    // Only write ANTHROPIC_API_KEY when Anthropic is the active provider.
    // Having it in .env when Claude CLI is active causes CLI to use API key auth
    // instead of Max subscription OAuth → "credit balance too low" error.
    if (settings.anthropic_api_key && settings.provider !== 'claude-cli')
        updates['ANTHROPIC_API_KEY'] = settings.anthropic_api_key;
    if (settings.cli_model)
        updates['CLI_MODEL'] = settings.cli_model;
    if (settings.claude_model)
        updates['CLAUDE_MODEL'] = settings.claude_model;
    if (settings.openai_api_key)
        updates['OPENAI_API_KEY'] = settings.openai_api_key;
    if (settings.openai_model)
        updates['OPENAI_MODEL'] = settings.openai_model;
    if (settings.google_api_key)
        updates['GEMINI_API_KEY'] = settings.google_api_key;
    if (settings.google_model)
        updates['GOOGLE_MODEL'] = settings.google_model;
    if (settings.groq_api_key)
        updates['GROQ_API_KEY'] = settings.groq_api_key;
    if (settings.groq_model)
        updates['GROQ_MODEL'] = settings.groq_model;
    if (settings.deepseek_api_key)
        updates['DEEPSEEK_API_KEY'] = settings.deepseek_api_key;
    if (settings.deepseek_model)
        updates['DEEPSEEK_MODEL'] = settings.deepseek_model;
    if (settings.xai_api_key)
        updates['XAI_API_KEY'] = settings.xai_api_key;
    if (settings.xai_model)
        updates['XAI_MODEL'] = settings.xai_model;
    if (settings.mistral_api_key)
        updates['MISTRAL_API_KEY'] = settings.mistral_api_key;
    if (settings.mistral_model)
        updates['MISTRAL_MODEL'] = settings.mistral_model;
    if (settings.openrouter_api_key)
        updates['OPENROUTER_API_KEY'] = settings.openrouter_api_key;
    if (settings.openrouter_model)
        updates['OPENROUTER_MODEL'] = settings.openrouter_model;
    if (settings.fireworks_api_key)
        updates['FIREWORKS_API_KEY'] = settings.fireworks_api_key;
    if (settings.fireworks_model)
        updates['FIREWORKS_MODEL'] = settings.fireworks_model;
    if (settings.together_api_key)
        updates['TOGETHER_API_KEY'] = settings.together_api_key;
    if (settings.together_model)
        updates['TOGETHER_MODEL'] = settings.together_model;
    if (settings.kimi_api_key) {
        updates['MOONSHOT_API_KEY'] = settings.kimi_api_key;
        updates['KIMI_API_KEY'] = settings.kimi_api_key;
    }
    if (settings.kimi_model) {
        updates['MOONSHOT_MODEL'] = settings.kimi_model;
        updates['KIMI_MODEL'] = settings.kimi_model;
    }
    if (settings.kimi_cli_model)
        updates['KIMI_CLI_MODEL'] = settings.kimi_cli_model;
    if (settings.ollama_base_url)
        updates['OLLAMA_BASE_URL'] = settings.ollama_base_url;
    if (settings.ollama_model)
        updates['OLLAMA_MODEL'] = settings.ollama_model;
    if (settings.lmstudio_base_url)
        updates['LMSTUDIO_BASE_URL'] = settings.lmstudio_base_url;
    if (settings.lmstudio_model)
        updates['LMSTUDIO_MODEL'] = settings.lmstudio_model;
    if (settings.llamacpp_model)
        updates['LLAMACPP_MODEL'] = settings.llamacpp_model;
    if (settings.custom_llm_base_url)
        updates['CUSTOM_LLM_BASE_URL'] = settings.custom_llm_base_url;
    if (settings.custom_llm_model)
        updates['CUSTOM_LLM_MODEL'] = settings.custom_llm_model;
    if (settings.custom_llm_api_key)
        updates['CUSTOM_LLM_API_KEY'] = settings.custom_llm_api_key;
    if (settings.max_tokens)
        updates['MAX_TOKENS'] = settings.max_tokens;
    // When switching to claude-cli, remove ANTHROPIC_API_KEY from .env
    // to prevent CLI from using API key auth instead of Max subscription OAuth.
    // Commented out (not deleted) so re-activating Anthropic can restore it.
    const keysToRemove = new Set();
    if (settings.provider === 'claude-cli') {
        keysToRemove.add('ANTHROPIC_API_KEY');
    }
    // Explicitly-cleared credentials (empty string in the request) → delete the
    // line outright. Commenting it out would leave the secret readable in .env,
    // which defeats the purpose of "Clear key".
    const keysToDelete = new Set();
    for (const [sk, envNames] of Object.entries(CLEARABLE_KEY_ENV)) {
        if (settings[sk] === '')
            for (const en of envNames)
                keysToDelete.add(en);
    }
    // Update existing lines or append new ones. `null` marks a line for deletion.
    const lines = envContent.split('\n');
    const seen = new Set();
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === null)
            continue;
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0)
            continue;
        const key = trimmed.substring(0, eq);
        if (keysToDelete.has(key)) {
            lines[i] = null; // drop the line entirely (don't leave the secret behind)
            continue;
        }
        if (keysToRemove.has(key)) {
            lines[i] = '# ' + line; // Comment out instead of delete
            continue;
        }
        if (updates[key] !== undefined) {
            lines[i] = key + '=' + updates[key];
            seen.add(key);
        }
    }
    // Append new keys
    for (const [key, val] of Object.entries(updates)) {
        if (!seen.has(key)) {
            lines.push(key + '=' + val);
        }
    }
    writeFileSync(envPath, lines.filter((l) => l !== null).join('\n'));
}
