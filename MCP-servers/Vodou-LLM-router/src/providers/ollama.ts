const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'smollm2:360m';
const OLLAMA_TIMEOUT_MS = 30_000;

let ollamaInFlight = false;

export async function completeOllama(
  prompt: string,
  system: string | undefined,
  modelOverride: string | undefined,
  baseUrlOverride: string | undefined,
  timeoutMs: number
): Promise<string> {
  if (ollamaInFlight) {
    throw new Error('skipping ollama: another request already in-flight');
  }
  ollamaInFlight = true;
  const timeout = Math.min(timeoutMs, OLLAMA_TIMEOUT_MS);
  try {
    const baseUrl = (baseUrlOverride || process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
    const model = modelOverride || process.env.OLLAMA_MODEL || DEFAULT_MODEL;
    const full = system ? `${system}\n\n${prompt}` : prompt;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: full, stream: false }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Ollama API error: ${text}`);
      }

      const json = (await res.json()) as { response?: string };
      return String(json.response ?? '');
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        throw new Error(`ollama timed out after ${timeout / 1000}s`);
      }
      throw e;
    }
  } finally {
    ollamaInFlight = false;
  }
}
