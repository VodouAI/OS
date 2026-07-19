/**
 * Audit log — JSON lines file tracking every action.
 * Writes to /tmp/vodou-mac-control/audit.jsonl.
 * Rotates at 10MB.
 */
import { appendFileSync, mkdirSync, statSync, renameSync } from 'fs';
const LOG_DIR = '/tmp/vodou-mac-control';
const LOG_PATH = `${LOG_DIR}/audit.jsonl`;
const MAX_SIZE = 10 * 1024 * 1024; // 10MB
try {
    mkdirSync(LOG_DIR, { recursive: true });
}
catch { }
export function logAction(entry) {
    const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        ...entry,
    }) + '\n';
    try {
        // Rotate if too large
        try {
            const stats = statSync(LOG_PATH);
            if (stats.size > MAX_SIZE) {
                renameSync(LOG_PATH, `${LOG_PATH}.1`);
            }
        }
        catch { }
        appendFileSync(LOG_PATH, line);
    }
    catch {
        // Don't let audit logging failures break tool execution
    }
}
//# sourceMappingURL=audit-log.js.map