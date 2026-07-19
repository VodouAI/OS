/**
 * LLM Client for Vodou-LLM-Router
 * Reads the user's configured llm_provider from gateway_settings (DB-first),
 * matching the same pattern as Vodou-Console/anthropic.ts.
 */

import Anthropic from '@anthropic-ai/sdk';
import { spawn, execSync } from 'child_process';
import { getGatewaySetting } from './workspace-context.js';
import { complete } from './providers/index.js';

let MODEL = process.env.LLM_MODEL || 'claude-sonnet-4-20250514';
let CLI_MODEL = process.env.CLI_MODEL || 'sonnet';
let MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '1024', 10);
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

type AuthMode = 'api-key' | 'claude-cli' | 'byok' | 'none';

let authMode: AuthMode = 'none';
let configuredProvider = 'none';  // actual provider name for byok routing
let initialized = false;

/**
 * Load provider config from gateway_settings DB (same source the web UI writes to).
 * Mirrors Vodou-Console/anthropic.ts detectProvider + loadProviderConfig.
 */
function initFromDb(): void {
  if (initialized) return;
  initialized = true;

  try {
    // 1. Read user's chosen provider from DB
    const dbProvider = getGatewaySetting('llm_provider');

    if (dbProvider === 'claude-cli') {
      authMode = 'claude-cli';
      configuredProvider = 'claude-cli';
      // Claude CLI must NOT see ANTHROPIC_API_KEY — it causes API-key auth
      // instead of Max subscription OAuth → "credit balance too low" error.
      delete process.env.ANTHROPIC_API_KEY;
    } else if (dbProvider === 'anthropic') {
      authMode = 'api-key';
      configuredProvider = 'anthropic';
      const dbKey = getGatewaySetting('anthropic_api_key');
      if (dbKey) process.env.ANTHROPIC_API_KEY = dbKey;
    } else if (dbProvider && dbProvider !== 'none') {
      // Non-Anthropic BYOK provider (openai, groq, ollama, fireworks, etc.)
      // Route through the complete() multi-provider path; no claude dep.
      authMode = 'byok';
      configuredProvider = dbProvider;
    }

    // Load model overrides from DB
    CLI_MODEL = getGatewaySetting('cli_model') || process.env.CLI_MODEL || 'sonnet';
    MODEL = getGatewaySetting('claude_model') || process.env.LLM_MODEL || 'claude-sonnet-4-20250514';
    const dbMaxTokens = getGatewaySetting('max_tokens');
    if (dbMaxTokens) MAX_TOKENS = parseInt(dbMaxTokens, 10) || MAX_TOKENS;
  } catch {
    // DB not available — fall through to auto-detect
  }

  // If DB didn't set a mode, auto-detect
  if (authMode === 'none') {
    authMode = autoDetect();
  }

  console.error(`[Vodou-LLM-Router] LLM auth: ${authMode} provider=${configuredProvider} (cli_model=${CLI_MODEL})`);
}

/** Fallback auto-detection when no DB setting exists. */
function autoDetect(): AuthMode {
  // Prefer CLI over API key
  try {
    execSync('which claude', { stdio: 'pipe', timeout: 3000 });
    return 'claude-cli';
  } catch {
    // no-op
  }
  if (process.env.ANTHROPIC_API_KEY) return 'api-key';
  return 'none';
}

export function isLLMConfigured(): boolean {
  initFromDb();
  return authMode === 'api-key' || authMode === 'claude-cli' || authMode === 'byok';
}

export function getAuthMode(): AuthMode {
  initFromDb();
  return authMode;
}

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY required for SDK mode');
    anthropicClient = new Anthropic({ apiKey: key });
  }
  return anthropicClient;
}

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

function formatMessagesForCLI(messages: LLMMessage[]): string {
  return messages
    .map((m) => (m.role === 'user' ? `User: ${m.content}` : `Assistant: ${m.content}`))
    .join('\n\n');
}

/**
 * Single completion via Claude CLI (no tools). Parses stream-json for final text.
 */
function sendMessageViaCLI(systemPrompt: string, messages: LLMMessage[]): Promise<string> {
  const fullPrompt = formatMessagesForCLI(messages);
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--verbose',
      '--output-format', 'stream-json',
      '--no-session-persistence',
      '--model', CLI_MODEL,
      '--system-prompt', systemPrompt,
      fullPrompt,
    ];
    const env = { ...process.env };
    delete env.CLAUDECODE;
    // Ensure CLI doesn't pick up a stale API key
    delete env.ANTHROPIC_API_KEY;

    const proc = spawn(CLAUDE_BIN, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let fullText = '';
    let buffer = '';
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) fullText = block.text;
            }
          }
          if (event.type === 'result' && typeof event.result === 'string') {
            fullText = event.result;
          }
        } catch {
          /* ignore parse errors */
        }
      }
    });

    proc.on('close', (code) => {
      if (code === 0) resolve(fullText.trim() || '');
      else reject(new Error(`Claude CLI exited with code ${code}${stderr ? ': ' + stderr.slice(-500) : ''}`));
    });
    proc.on('error', reject);
  });
}

/**
 * Send messages to the LLM and get a response (API or CLI).
 */
export async function sendMessage(
  systemPrompt: string,
  messages: LLMMessage[]
): Promise<string> {
  initFromDb();

  if (authMode === 'claude-cli') {
    return sendMessageViaCLI(systemPrompt, messages);
  }

  // Non-Anthropic BYOK: flatten history + route through complete() which already
  // handles all 15 providers. Routing/planning queries are short so flattening is fine.
  if (authMode === 'byok') {
    const history = messages.slice(0, -1)
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
    const lastMsg = messages[messages.length - 1]?.content ?? '';
    const prompt = history ? `${history}\n\nUser: ${lastMsg}` : lastMsg;
    return complete({ prompt, system: systemPrompt, provider: configuredProvider });
  }

  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });
  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock && textBlock.type === 'text' ? textBlock.text : '';
}

export async function prompt(systemPrompt: string, userPrompt: string): Promise<string> {
  return sendMessage(systemPrompt, [{ role: 'user', content: userPrompt }]);
}

export async function chat(
  systemPrompt: string,
  conversationHistory: LLMMessage[],
  newMessage: string
): Promise<string> {
  const messages = [...conversationHistory, { role: 'user' as const, content: newMessage }];
  return sendMessage(systemPrompt, messages);
}
