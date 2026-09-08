// Vendored copy of MCP-servers/_shared/db.ts (house convention: copy, don't
// link — servers must remain standalone).
//
// Thin adapter around `node:sqlite` (built into Node 22.13+/24+). Replaces
// `better-sqlite3` with zero native bindings.
import { DatabaseSync } from 'node:sqlite';
// DI-7: the busy timeout DEFAULTS to 5000 ms rather than being opt-in. A bare
// `new DatabaseSync(path)` waits zero milliseconds for a lock, so the first
// concurrent write from the daemon, the worker or the gateway throws
// SQLITE_BUSY instead of waiting the moment it would have taken. Every caller
// that thought about it passed 5000 (Console, Board, ExecDesk); the ones that
// did not were not choosing zero, they were not choosing. Same number as
// `Database::new_with_timeout` on the Rust side. Pass `timeout: 0` to opt out.
const DEFAULT_BUSY_TIMEOUT_MS = 5000;
export function open(path, opts = {}) {
    const readOnly = opts.readOnly ?? opts.readonly ?? false;
    return new DatabaseSync(path, {
        readOnly,
        timeout: opts.timeout ?? DEFAULT_BUSY_TIMEOUT_MS,
    });
}
