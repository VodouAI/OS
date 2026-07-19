/**
 * OpenAI-compatible endpoint (e.g. LM Studio, local proxy, other APIs).
 */

export async function completeCustom(
  prompt: string,
  system: string | undefined,
  model: string,
  baseUrl: string,
  apiKeyEnv: string | undefined,
  maxTokens: number,
  timeoutMs: number,
  /** Direct API key value — takes priority over apiKeyEnv. Used by the built-in
   *  provider cases (groq, google, etc.) which read the key from gateway_settings. */
  directApiKey?: string
): Promise<string> {
  const url = baseUrl.replace(/\/$/, '') + '/v1/chat/completions';
  const apiKey = directApiKey || (apiKeyEnv ? process.env[apiKeyEnv] : undefined);

  const messages: Array<{ role: string; content: string }> = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Custom API error: ${text}`);
    }

    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new Error(`custom endpoint timed out after ${timeoutMs / 1000}s`);
    }
    throw e;
  }
}
