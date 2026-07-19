/**
 * Vodou Capabilities Loader
 * Loads and caches information about all available skills, MCP servers, and scripts
 */
export interface Skill {
    name: string;
    description: string;
    triggers: string[];
    category: string;
    path: string;
}
export interface MCPServer {
    name: string;
    description: string;
    tools: MCPTool[];
}
export interface MCPTool {
    name: string;
    description: string;
    server: string;
}
export interface Script {
    name: string;
    description: string;
    command: string;
}
export interface OICapabilities {
    skills: Skill[];
    mcpServers: MCPServer[];
    scripts: Script[];
    lastUpdated: Date;
}
/**
 * Load all Vodou capabilities (skills, MCP servers, scripts). Intents come from workspace-context (direct DB).
 */
export declare function loadCapabilities(forceRefresh?: boolean): OICapabilities;
/**
 * Get a formatted summary of capabilities for LLM context
 */
export declare function getCapabilitiesSummary(): string;
/**
 * Get capabilities as structured data for routing
 */
export declare function getCapabilitiesForRouting(): {
    skillNames: string[];
    skillTriggers: Map<string, string>;
    mcpServerNames: string[];
    scriptNames: string[];
};
//# sourceMappingURL=capabilities.d.ts.map