/**
 * OpenAI-compatible endpoint (e.g. LM Studio, local proxy, other APIs).
 */
export declare function completeCustom(prompt: string, system: string | undefined, model: string, baseUrl: string, apiKeyEnv: string | undefined, maxTokens: number, timeoutMs: number, 
/** Direct API key value — takes priority over apiKeyEnv. Used by the built-in
 *  provider cases (groq, google, etc.) which read the key from gateway_settings. */
directApiKey?: string): Promise<string>;
//# sourceMappingURL=custom.d.ts.map