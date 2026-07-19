/**
 * Audit log — JSON lines file tracking every action.
 * Writes to /tmp/vodou-mac-control/audit.jsonl.
 * Rotates at 10MB.
 */
export declare function logAction(entry: {
    tool: string;
    app?: string;
    args?: Record<string, unknown>;
    ok: boolean;
    duration_ms: number;
    error?: string;
}): void;
//# sourceMappingURL=audit-log.d.ts.map