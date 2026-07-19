/**
 * Vodou Router - Intelligent routing using LLM
 * Determines the best skill/MCP/script to handle any query
 */
export interface RouteDecision {
    type: 'skill' | 'mcp' | 'script' | 'chat';
    target?: string;
    tools?: string[];
    reasoning: string;
    confidence: number;
    originalQuery: string;
}
/**
 * Route a query using LLM intelligence
 */
export declare function routeQuery(query: string, context?: string): Promise<RouteDecision>;
/**
 * Get routing explanation for a query (for debugging)
 */
export declare function explainRoute(query: string): Promise<string>;
//# sourceMappingURL=router.d.ts.map