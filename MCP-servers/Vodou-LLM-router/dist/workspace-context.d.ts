/**
 * Vodou Context Loader — direct DB access so the LLM has full Vodou state before answering.
 * Everything: intents, memory search, MCP servers & tools, scheduler, skills registry, scripts.
 */
/**
 * Read a setting from gateway_settings (same store the web UI writes to).
 */
export declare function getGatewaySetting(key: string): string | null;
export interface IntentRow {
    keyword: string;
    server_name: string;
    tool_name: string;
    priority: number;
}
export declare function getIntentMappings(): IntentRow[];
export interface ServerToolRow {
    server_name: string;
    tool_name: string;
    description: string | null;
}
/** All MCP servers and their tools from the brain DB. */
export declare function getMcpServersAndTools(): ServerToolRow[];
export interface ScheduledTaskRow {
    id: number;
    name: string;
    schedule: string;
    schedule_type: string;
    payload: string;
    enabled: number;
    one_shot: number;
    next_run_at: string | null;
    last_run_at: string | null;
}
/** Scheduled tasks (scheduler). */
export declare function getScheduledTasks(): ScheduledTaskRow[];
export interface SkillRegistryRow {
    name: string;
    description: string | null;
}
/** Skills from brain's skills_registry (DB). */
export declare function getSkillsRegistry(): SkillRegistryRow[];
export interface ScriptRegistryRow {
    server_name: string;
    script_name: string;
    command: string;
    description: string | null;
}
/** Registered scripts (Vodou-script-executor). */
export declare function getScriptRegistry(): ScriptRegistryRow[];
export interface MemoryHit {
    path: string;
    text: string;
    score: number;
}
export declare function searchMemoryFts(query: string, topK?: number): MemoryHit[];
export interface BrainContext {
    intents: IntentRow[];
    memoryHits: MemoryHit[];
    capabilitiesSummary: string;
    promptSection: string;
}
export interface RelevantMatches {
    skills: {
        name: string;
        description: string | null;
    }[];
    mcpServers: {
        server_name: string;
        tools: string[];
    }[];
    scripts: {
        server_name: string;
        script_name: string;
        command: string;
    }[];
}
/** Query-scoped skills, MCP servers+tools, and scripts (for route output). */
export declare function getRelevantMatchesForQuery(query: string): RelevantMatches;
/** Assemble Vodou context relevant to the query only: filtered intents, memory, MCP+tools, scheduler, skills, scripts. */
export declare function getBrainContextForQuery(query: string): BrainContext;
//# sourceMappingURL=workspace-context.d.ts.map