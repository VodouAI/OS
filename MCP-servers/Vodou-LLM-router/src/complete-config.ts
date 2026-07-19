/**
 * Config for the complete tool: provider, timeouts, model defaults.
 * Env: VODOU_MEMORY_EXTRACTION_PROVIDER, CLAUDE_BIN, CLI_MODEL, ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.
 */

const DEFAULT_PROVIDER = 'claude';
const DEFAULT_TIMEOUT_SECS = 60;
const DEFAULT_MAX_TOKENS = 1024;
const MAX_PROMPT_CHARS = 50_000;

export function getDefaultProvider(): string {
  const p = process.env.VODOU_MEMORY_EXTRACTION_PROVIDER?.trim().toLowerCase();
  return p && ['claude', 'anthropic', 'ollama', 'script', 'openai', 'custom'].includes(p)
    ? p
    : DEFAULT_PROVIDER;
}

export function getTimeoutSecs(override?: number): number {
  if (override != null && override > 0) return override;
  const n = parseInt(process.env.VODOU_LLM_TIMEOUT_SECS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_SECS;
}

export function getMaxTokens(override?: number): number {
  if (override != null && override > 0) return override;
  const n = parseInt(process.env.MAX_TOKENS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TOKENS;
}

export function truncatePrompt(prompt: string): string {
  if (prompt.length <= MAX_PROMPT_CHARS) return prompt;
  let end = MAX_PROMPT_CHARS;
  while (end > 0 && (prompt[end] && (prompt.charCodeAt(end) & 0xc0) === 0x80)) end--;
  return prompt.slice(0, end) + '...[truncated]';
}

export const completeConfig = {
  DEFAULT_PROVIDER,
  DEFAULT_TIMEOUT_SECS,
  DEFAULT_MAX_TOKENS,
  MAX_PROMPT_CHARS,
};
