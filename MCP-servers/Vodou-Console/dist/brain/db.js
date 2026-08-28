// Vendored copy of MCP-servers/_shared/db.ts (house convention: copy, don't
// link — servers must remain standalone).
//
// Thin adapter around `node:sqlite` (built into Node 22.13+/24+). Replaces
// `better-sqlite3` with zero native bindings.
import { DatabaseSync } from 'node:sqlite';
export function open(path, opts = {}) {
    const readOnly = opts.readOnly ?? opts.readonly ?? false;
    return new DatabaseSync(path, {
        readOnly,
        ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    });
}
