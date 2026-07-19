import { getDefaultProvider, getTimeoutSecs, getMaxTokens, truncatePrompt } from '../complete-config.js';
import { getGatewaySetting } from '../workspace-context.js';
import { completeClaudeCli } from './claude-cli.js';
import { completeAnthropic } from './anthropic.js';
import { completeOllama } from './ollama.js';
import { completeScript } from './script.js';
import { completeOpenAI } from './openai.js';
import { completeCustom } from './custom.js';
export async function complete(options) {
    const prompt = truncatePrompt(options.prompt);
    const system = options.system;
    const timeoutMs = (options.timeout_secs ?? getTimeoutSecs(options.timeout_secs)) * 1000;
    const maxTokens = options.max_tokens ?? getMaxTokens(options.max_tokens);
    // Resolve provider: explicit arg > DB setting > env default > 'claude'
    let provider = (options.provider || getGatewaySetting('llm_provider') || getDefaultProvider()).toLowerCase();
    // Normalize: gateway stores 'claude-cli', complete() uses 'claude' for CLI mode
    if (provider === 'claude-cli')
        provider = 'claude';
    switch (provider) {
        case 'claude':
            return completeClaudeCli(prompt, system, options.model, timeoutMs);
        case 'anthropic':
            return completeAnthropic(prompt, system, options.model, maxTokens, timeoutMs);
        case 'ollama':
            return completeOllama(prompt, system, options.model, options.ollama_base_url, timeoutMs);
        case 'script': {
            const cmd = options.script_command || process.env.VODOU_EXTRACTION_SCRIPT_COMMAND;
            if (!cmd)
                throw new Error('script provider requires script_command or VODOU_EXTRACTION_SCRIPT_COMMAND');
            return completeScript(prompt, system, cmd, timeoutMs);
        }
        case 'openai':
            return completeOpenAI(prompt, system, options.model, maxTokens, timeoutMs);
        // OpenAI-compatible providers — all share the same HTTP shape, just different
        // endpoints and key env vars. Reads key + model from gateway_settings first,
        // falls back to env vars so existing installs keep working.
        case 'groq': {
            const key = getGatewaySetting('groq_api_key') || process.env.GROQ_API_KEY || '';
            const model = options.model || getGatewaySetting('groq_model') || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
            return completeCustom(prompt, system, model, 'https://api.groq.com/openai/v1', undefined, maxTokens, timeoutMs, key);
        }
        case 'google': {
            const key = getGatewaySetting('google_api_key') || process.env.GEMINI_API_KEY || '';
            const model = options.model || getGatewaySetting('google_model') || process.env.GOOGLE_MODEL || 'gemini-2.5-flash';
            return completeCustom(prompt, system, model, 'https://generativelanguage.googleapis.com/v1beta/openai', undefined, maxTokens, timeoutMs, key);
        }
        case 'fireworks': {
            const key = getGatewaySetting('fireworks_api_key') || process.env.FIREWORKS_API_KEY || '';
            const model = options.model || getGatewaySetting('fireworks_model') || process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/kimi-k2p6';
            return completeCustom(prompt, system, model, 'https://api.fireworks.ai/inference/v1', undefined, maxTokens, timeoutMs, key);
        }
        case 'together': {
            const key = getGatewaySetting('together_api_key') || process.env.TOGETHER_API_KEY || '';
            const model = options.model || getGatewaySetting('together_model') || process.env.TOGETHER_MODEL || 'moonshotai/Kimi-K2.6';
            return completeCustom(prompt, system, model, 'https://api.together.ai/v1', undefined, maxTokens, timeoutMs, key);
        }
        case 'deepseek': {
            const key = getGatewaySetting('deepseek_api_key') || process.env.DEEPSEEK_API_KEY || '';
            const model = options.model || getGatewaySetting('deepseek_model') || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
            return completeCustom(prompt, system, model, 'https://api.deepseek.com/v1', undefined, maxTokens, timeoutMs, key);
        }
        case 'xai': {
            const key = getGatewaySetting('xai_api_key') || process.env.XAI_API_KEY || '';
            const model = options.model || getGatewaySetting('xai_model') || process.env.XAI_MODEL || 'grok-3';
            return completeCustom(prompt, system, model, 'https://api.x.ai/v1', undefined, maxTokens, timeoutMs, key);
        }
        case 'mistral': {
            const key = getGatewaySetting('mistral_api_key') || process.env.MISTRAL_API_KEY || '';
            const model = options.model || getGatewaySetting('mistral_model') || process.env.MISTRAL_MODEL || 'mistral-large-latest';
            return completeCustom(prompt, system, model, 'https://api.mistral.ai/v1', undefined, maxTokens, timeoutMs, key);
        }
        case 'openrouter': {
            const key = getGatewaySetting('openrouter_api_key') || process.env.OPENROUTER_API_KEY || '';
            const model = options.model || getGatewaySetting('openrouter_model') || process.env.OPENROUTER_MODEL || 'openai/gpt-4o';
            return completeCustom(prompt, system, model, 'https://openrouter.ai/api/v1', undefined, maxTokens, timeoutMs, key);
        }
        case 'kimi':
        case 'kimi-cli': {
            const key = getGatewaySetting('kimi_api_key') || process.env.KIMI_API_KEY || '';
            const model = options.model || getGatewaySetting('kimi_model') || process.env.KIMI_MODEL || 'kimi-k2.6';
            return completeCustom(prompt, system, model, 'https://api.moonshot.ai/v1', undefined, maxTokens, timeoutMs, key);
        }
        case 'custom': {
            const baseUrl = options.base_url || process.env.VODOU_CUSTOM_LLM_BASE_URL;
            const model = options.model || process.env.VODOU_CUSTOM_LLM_MODEL || 'local';
            if (!baseUrl)
                throw new Error('custom provider requires base_url or VODOU_CUSTOM_LLM_BASE_URL');
            return completeCustom(prompt, system, model, baseUrl, options.api_key_env, maxTokens, timeoutMs);
        }
        default:
            throw new Error(`Unknown provider: ${provider}`);
    }
}
//# sourceMappingURL=index.js.map