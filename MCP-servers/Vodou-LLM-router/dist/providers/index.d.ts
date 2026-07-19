export interface CompleteOptions {
    prompt: string;
    system?: string;
    provider?: string;
    model?: string;
    timeout_secs?: number;
    max_tokens?: number;
    /** script only */
    script_command?: string;
    /** custom only */
    base_url?: string;
    api_key_env?: string;
    /** ollama only */
    ollama_base_url?: string;
}
export declare function complete(options: CompleteOptions): Promise<string>;
//# sourceMappingURL=index.d.ts.map