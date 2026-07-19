/**
 * Settings API — LLM provider management
 * GET/POST /api/settings, POST /api/settings/test, GET /api/settings/models/:provider
 */
import { Router } from 'express';
import { execSync } from 'child_process';
import { getSetting, setSetting, getAllSettings, getProjectRoot } from '../db.js';
import { getAuthType, reinitAuth, hasActiveCliSession } from '../llm.js';
const KIMI_BIN = process.env.KIMI_BIN || 'kimi';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { projectEnvRouter } from './project-env.js';
import { normalizeOpenRouterApiKeyCandidate } from '../openrouter-key.js';
export const settingsRouter = Router();
/** GET/POST /api/settings/project-env — project root `.env` (see project-env.ts) */
settingsRouter.use('/project-env', projectEnvRouter);
// Provider metadata
const PROVIDERS = [
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
    { id: 'ollama', name: 'Ollama (Local)', requiresKey: false },
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
function resolveOpenRouterApiKey() {
    const root = getProjectRoot();
    const pick = (s) => normalizeOpenRouterApiKeyCandidate(String(s ?? '').replace(/\r$/, '').trim());
    return (pick(getSetting('openrouter_api_key')) ||
        pick(process.env.OPENROUTER_API_KEY) ||
        pick(readEnvFileKey(path.join(root, '.env'), 'OPENROUTER_API_KEY')) ||
        pick(readEnvFileKey(path.join(root, 'MCP-servers', 'Vodou-Console', '.env'), 'OPENROUTER_API_KEY')) ||
        '');
}
/** OpenRouter keys are sent to openrouter.ai — if one lands on OpenAI's API you get a misleading OpenAI error. */
function looksLikeOpenRouterKey(k) {
    if (!k || typeof k !== 'string')
        return false;
    return /^sk-or-v1-/i.test(k.trim());
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
/** Shipped catalog from `npm run vendor:openrouter-models` — full list without calling OpenRouter at runtime. */
function loadBundledOpenRouterModels() {
    try {
        const p = path.join(getProjectRoot(), 'MCP-servers', 'Vodou-Console', 'public', 'data', 'openrouter-models.json');
        const j = JSON.parse(readFileSync(p, 'utf-8'));
        const m = j.models;
        if (Array.isArray(m) && m.length > 0)
            return m;
    }
    catch { }
    return [];
}
const OPENROUTER_MODEL_STUB = [
    'openai/gpt-4o',
    'openai/gpt-4o-mini',
    'anthropic/claude-3.5-sonnet',
    'google/gemini-2.0-flash-001',
    'meta-llama/llama-3.3-70b-instruct',
    'deepseek/deepseek-chat',
];
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
        kimi_api_key: maskKey(settings.kimi_api_key || ''),
        kimi_model: settings.kimi_model || 'kimi-k2.6',
        kimi_cli_model: settings.kimi_cli_model || 'kimi-k2.6',
        custom_llm_base_url: settings.custom_llm_base_url || '',
        custom_llm_model: settings.custom_llm_model || '',
        custom_llm_api_key: maskKey(settings.custom_llm_api_key || ''),
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
        const whichResult = execSync('which claude', { stdio: 'pipe', timeout: 3000 }).toString().trim();
        if (whichResult)
            installed = true;
    }
    catch { }
    if (installed) {
        try {
            const versionResult = execSync('claude --version 2>/dev/null || echo ""', { stdio: 'pipe', timeout: 5000 }).toString().trim();
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
                const result = execSync('claude auth status 2>&1 || true', { stdio: 'pipe', timeout: 5000 }).toString();
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
        const whichResult = execSync(`which ${KIMI_BIN}`, { stdio: 'pipe', timeout: 3000 }).toString().trim();
        if (whichResult)
            installed = true;
    }
    catch { }
    if (installed) {
        try {
            const versionResult = execSync(`${KIMI_BIN} --version 2>/dev/null || echo ""`, { stdio: 'pipe', timeout: 5000 })
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
        case 'claude-cli': {
            try {
                execSync('which claude', { stdio: 'pipe', timeout: 3000 });
                return true;
            }
            catch {
                return false;
            }
        }
        case 'anthropic': return !!(settings.anthropic_api_key || process.env.ANTHROPIC_API_KEY);
        case 'kimi-cli': {
            try {
                execSync(`which ${KIMI_BIN}`, { stdio: 'pipe', timeout: 3000 });
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
        case 'ollama': return !!settings.ollama_base_url;
        case 'custom': return !!(settings.custom_llm_base_url && settings.custom_llm_model);
        default: return false;
    }
}
/**
 * POST /api/settings — save settings and switch provider
 */
settingsRouter.post('/', async (req, res) => {
    const body = req.body;
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
        'ollama_base_url', 'ollama_model',
        'custom_llm_base_url', 'custom_llm_model', 'custom_llm_api_key',
        'max_tokens',
    ];
    // Map 'provider' to 'llm_provider' in storage
    if (body.provider)
        body.llm_provider = body.provider;
    for (const key of settingsKeys) {
        if (body[key] !== undefined && body[key] !== '') {
            setSetting(key, String(body[key]));
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
            const memProviderMap = {
                'claude-cli': 'claude',
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
            const memProvider = memProviderMap[body.provider] || 'heuristic';
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
            }
            catch (tomlErr) {
                console.error('[Settings] Failed to update memory.toml:', tomlErr);
            }
        }
        catch (err) {
            console.error('[Settings] Failed to sync memory extraction provider:', err);
        }
    }
    // Hot-reload the LLM config
    try {
        await reinitAuth();
    }
    catch (err) {
        console.error('[Settings] reinitAuth error:', err);
    }
    res.json({ ok: true, provider: body.provider || getSetting('llm_provider') });
});
/**
 * POST /api/settings/test — test a provider connection
 */
settingsRouter.post('/test', async (req, res) => {
    const b = req.body;
    const { provider, api_key, model, base_url, openrouter_api_key } = b;
    try {
        switch (provider) {
            case 'claude-cli': {
                execSync('which claude', { stdio: 'pipe', timeout: 3000 });
                res.json({ success: true, model: 'Claude CLI', response: 'Claude CLI is available' });
                return;
            }
            case 'kimi-cli': {
                execSync(`which ${KIMI_BIN}`, { stdio: 'pipe', timeout: 3000 });
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
            // All OpenAI-compatible preset providers
            case 'google':
            case 'groq':
            case 'deepseek':
            case 'xai':
            case 'mistral':
            case 'kimi':
            case 'openrouter': {
                const presets = {
                    google: { url: 'https://generativelanguage.googleapis.com/v1beta/openai', keyName: 'google_api_key', defaultModel: 'gemini-2.5-flash' },
                    groq: { url: 'https://api.groq.com/openai/v1', keyName: 'groq_api_key', defaultModel: 'llama-3.3-70b-versatile' },
                    deepseek: { url: 'https://api.deepseek.com/v1', keyName: 'deepseek_api_key', defaultModel: 'deepseek-chat' },
                    xai: { url: 'https://api.x.ai/v1', keyName: 'xai_api_key', defaultModel: 'grok-3' },
                    mistral: { url: 'https://api.mistral.ai/v1', keyName: 'mistral_api_key', defaultModel: 'mistral-large-latest' },
                    kimi: { url: 'https://api.moonshot.ai/v1', keyName: 'kimi_api_key', defaultModel: 'kimi-k2.6' },
                    openrouter: { url: 'https://openrouter.ai/api/v1', keyName: 'openrouter_api_key', defaultModel: 'openai/gpt-4o' },
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
            case 'claude-cli': {
                // Check binary exists
                let cliBin = '';
                try {
                    cliBin = execSync('which claude', { stdio: 'pipe', timeout: 3000 }).toString().trim();
                }
                catch { }
                if (!cliBin) {
                    res.json({ ready: false, provider, status: 'unavailable', message: 'Claude CLI not found. Install it: curl -fsSL https://claude.ai/install.sh | bash' });
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
                    const result = execSync(`claude -p --model ${cliModel} --output-format text "Reply with only the word OK"`, { stdio: 'pipe', timeout: 30_000, cwd: getProjectRoot(), env: testEnv, encoding: 'utf-8' }).trim();
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
                    kimiBin = execSync(`which ${KIMI_BIN}`, { stdio: 'pipe', timeout: 3000 }).toString().trim();
                }
                catch { }
                if (!kimiBin) {
                    res.json({
                        ready: false,
                        provider,
                        status: 'unavailable',
                        message: `Kimi CLI not found. Install: curl -LsSf https://code.kimi.com/install.sh | bash`,
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
            // API-key providers — just check key exists
            case 'google':
            case 'groq':
            case 'deepseek':
            case 'xai':
            case 'mistral':
            case 'kimi':
            case 'openrouter': {
                const keyMap = {
                    google: 'google_api_key', groq: 'groq_api_key', deepseek: 'deepseek_api_key',
                    xai: 'xai_api_key', mistral: 'mistral_api_key', kimi: 'kimi_api_key',
                    openrouter: 'openrouter_api_key',
                };
                const nameMap = {
                    google: 'Google Gemini', groq: 'Groq', deepseek: 'DeepSeek',
                    xai: 'xAI (Grok)', mistral: 'Mistral', kimi: 'Kimi (Moonshot)',
                    openrouter: 'OpenRouter',
                };
                const key = settings[keyMap[provider]] || (provider === 'openrouter' ? process.env.OPENROUTER_API_KEY : undefined);
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
 * GET /api/settings/models/:provider — list available models
 */
settingsRouter.get('/models/:provider', async (req, res) => {
    const provider = req.params.provider;
    try {
        switch (provider) {
            case 'claude-cli':
                res.json({ models: ['opus', 'sonnet', 'haiku'] });
                return;
            case 'kimi-cli':
                res.json({
                    models: [
                        'kimi-k2.6',
                        'kimi-k2.5',
                        'kimi-k2-0905-preview',
                        'kimi-k2-0711-preview',
                        'kimi-k2-turbo-preview',
                        'kimi-k2-thinking-turbo',
                        'kimi-k2-thinking',
                        'moonshot-v1-128k',
                        'moonshot-v1-32k',
                        'moonshot-v1-8k',
                        'moonshot-v1-auto',
                        'moonshot-v1-8k-vision-preview',
                        'moonshot-v1-32k-vision-preview',
                        'moonshot-v1-128k-vision-preview',
                    ],
                });
                return;
            case 'anthropic':
                res.json({
                    models: [
                        'claude-opus-4-6', 'claude-sonnet-4-6',
                        'claude-haiku-4-5-20251001',
                        'claude-opus-4-20250514', 'claude-sonnet-4-20250514',
                        'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022',
                        'claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307',
                    ],
                });
                return;
            case 'openai': {
                const key = getSetting('openai_api_key');
                if (key && !looksLikeOpenRouterKey(key)) {
                    try {
                        const resp = await fetch('https://api.openai.com/v1/models', {
                            headers: { 'Authorization': 'Bearer ' + key },
                        });
                        const data = await resp.json();
                        const models = (data.data || [])
                            .map((m) => m.id)
                            .filter((id) => id.startsWith('gpt-') || id.startsWith('o'))
                            .sort();
                        if (models.length > 0) {
                            res.json({ models });
                            return;
                        }
                    }
                    catch { }
                }
                // Fallback hardcoded list
                res.json({ models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'] });
                return;
            }
            case 'google':
                res.json({ models: [
                        'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
                        'gemini-2.0-flash', 'gemini-2.0-flash-lite',
                        'gemini-1.5-pro', 'gemini-1.5-flash',
                    ] });
                return;
            case 'groq':
                res.json({ models: [
                        'llama-3.3-70b-versatile', 'llama-3.1-8b-instant',
                        'meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct',
                        'qwen/qwen-3-32b', 'qwen-qwq-32b',
                        'deepseek-r1-distill-llama-70b',
                        'mistral-saba-24b', 'gemma2-9b-it', 'llama-guard-3-8b',
                    ] });
                return;
            case 'deepseek':
                res.json({ models: ['deepseek-chat', 'deepseek-reasoner'] });
                return;
            case 'xai':
                res.json({ models: [
                        'grok-4', 'grok-3', 'grok-3-mini-beta',
                        'grok-2-1212', 'grok-2-vision-1212',
                    ] });
                return;
            case 'mistral':
                res.json({ models: [
                        'mistral-large-latest', 'mistral-small-latest', 'codestral-latest',
                        'magistral-medium-latest', 'magistral-small-latest',
                        'ministral-8b-latest', 'ministral-3b-latest',
                        'open-mistral-nemo', 'mistral-embed',
                    ] });
                return;
            case 'kimi':
                res.json({
                    models: [
                        'kimi-k2.6',
                        'kimi-k2.5',
                        'kimi-k2-0905-preview',
                        'kimi-k2-0711-preview',
                        'kimi-k2-turbo-preview',
                        'kimi-k2-thinking-turbo',
                        'kimi-k2-thinking',
                        'moonshot-v1-128k',
                        'moonshot-v1-32k',
                        'moonshot-v1-8k',
                        'moonshot-v1-auto',
                        'moonshot-v1-8k-vision-preview',
                        'moonshot-v1-32k-vision-preview',
                        'moonshot-v1-128k-vision-preview',
                    ],
                });
                return;
            case 'openrouter': {
                let models = [];
                const key = resolveOpenRouterApiKey();
                if (key) {
                    try {
                        const h = { Authorization: 'Bearer ' + key };
                        h['HTTP-Referer'] = process.env.OPENROUTER_HTTP_REFERER || process.env.GATEWAY_BASE_URL || 'http://localhost:8765';
                        h['X-Title'] = process.env.OPENROUTER_APP_TITLE || 'Vodou-Console';
                        // `output_modalities` defaults to text-only per OpenRouter docs; request all modalities so the dropdown matches their full catalog.
                        const resp = await fetch('https://openrouter.ai/api/v1/models?output_modalities=all', { headers: h });
                        const data = await resp.json();
                        models = (data.data || [])
                            .map((m) => m.id)
                            .filter(Boolean)
                            .sort();
                    }
                    catch { }
                }
                if (models.length === 0) {
                    models = loadBundledOpenRouterModels();
                }
                if (models.length === 0) {
                    models = [...OPENROUTER_MODEL_STUB];
                }
                res.json({ models });
                return;
            }
            case 'ollama': {
                const url = (getSetting('ollama_base_url') || 'http://localhost:11434').replace(/\/$/, '');
                try {
                    const resp = await fetch(url + '/api/tags');
                    const data = await resp.json();
                    const models = (data.models || []).map((m) => m.name);
                    res.json({ models });
                }
                catch (err) {
                    res.json({ models: [], error: 'Could not reach Ollama at ' + url });
                }
                return;
            }
            case 'custom':
                res.json({ models: [] });
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
    if (settings.custom_llm_base_url)
        updates['CUSTOM_LLM_BASE_URL'] = settings.custom_llm_base_url;
    if (settings.custom_llm_model)
        updates['CUSTOM_LLM_MODEL'] = settings.custom_llm_model;
    if (settings.custom_llm_api_key)
        updates['CUSTOM_LLM_API_KEY'] = settings.custom_llm_api_key;
    if (settings.max_tokens)
        updates['MAX_TOKENS'] = settings.max_tokens;
    // When switching to claude-cli, remove ANTHROPIC_API_KEY from .env
    // to prevent CLI from using API key auth instead of Max subscription OAuth
    const keysToRemove = new Set();
    if (settings.provider === 'claude-cli') {
        keysToRemove.add('ANTHROPIC_API_KEY');
    }
    // Update existing lines or append new ones
    const lines = envContent.split('\n');
    const seen = new Set();
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed || trimmed.startsWith('#'))
            continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0)
            continue;
        const key = trimmed.substring(0, eq);
        if (keysToRemove.has(key)) {
            lines[i] = '# ' + lines[i]; // Comment out instead of delete
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
    writeFileSync(envPath, lines.join('\n'));
}
