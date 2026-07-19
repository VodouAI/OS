/**
 * Config for the complete tool: provider, timeouts, model defaults.
 * Env: VODOU_MEMORY_EXTRACTION_PROVIDER, CLAUDE_BIN, CLI_MODEL, ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.
 */
export declare function getDefaultProvider(): string;
export declare function getTimeoutSecs(override?: number): number;
export declare function getMaxTokens(override?: number): number;
export declare function truncatePrompt(prompt: string): string;
export declare const completeConfig: {
    DEFAULT_PROVIDER: string;
    DEFAULT_TIMEOUT_SECS: number;
    DEFAULT_MAX_TOKENS: number;
    MAX_PROMPT_CHARS: number;
};
//# sourceMappingURL=complete-config.d.ts.map