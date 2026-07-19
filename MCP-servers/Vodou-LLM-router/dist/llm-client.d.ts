/**
 * LLM Client for Vodou-LLM-Router
 * Reads the user's configured llm_provider from gateway_settings (DB-first),
 * matching the same pattern as Vodou-Console/anthropic.ts.
 */
type AuthMode = 'api-key' | 'claude-cli' | 'byok' | 'none';
export declare function isLLMConfigured(): boolean;
export declare function getAuthMode(): AuthMode;
export interface LLMMessage {
    role: 'user' | 'assistant';
    content: string;
}
/**
 * Send messages to the LLM and get a response (API or CLI).
 */
export declare function sendMessage(systemPrompt: string, messages: LLMMessage[]): Promise<string>;
export declare function prompt(systemPrompt: string, userPrompt: string): Promise<string>;
export declare function chat(systemPrompt: string, conversationHistory: LLMMessage[], newMessage: string): Promise<string>;
export {};
//# sourceMappingURL=llm-client.d.ts.map