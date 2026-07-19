/**
 * Read-only connection to board.db with vodou-core.db + memory.db ATTACHed.
 *
 * Writes do NOT happen here — they go through src/gateway-client.ts which
 * POSTs to the gateway's REST API. The gateway is the single source of truth
 * for state transitions, event emission, and notifier fan-out.
 *
 * Mirrors MCP-servers/Vodou-Enhanced-Thinking/src/db.ts pattern.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { existsSync } from 'node:fs';
function resolveProjectRoot() {
    // 1. Explicit env override (set by the dispatcher on worker spawn)
    const envRoot = process.env.VODOU_PROJECT_PATH;
    if (envRoot && (existsSync(path.join(envRoot, 'vodou-core.db'))
        || existsSync(path.join(envRoot, 'board.db')))) {
        return envRoot;
    }
    // 2. Walk up from cwd looking for vodou-core.db
    let dir = process.cwd();
    while (dir !== path.dirname(dir)) {
        if (existsSync(path.join(dir, 'vodou-core.db')))
            return dir;
        dir = path.dirname(dir);
    }
    // 3. Fall back to cwd
    return process.cwd();
}
/** Lazy path resolution — reads env at call-time, not module-load-time. */
function resolvePaths() {
    const projectRoot = resolveProjectRoot();
    return {
        PROJECT_ROOT: projectRoot,
        BOARD_DB_PATH: process.env.VODOU_BOARD_DB ?? path.join(projectRoot, 'board.db'),
        CORE_DB_PATH: path.join(projectRoot, 'vodou-core.db'),
        MEMORY_DB_PATH: path.join(projectRoot, 'memory.db'),
    };
}
let _readDb = null;
/**
 * Returns a memoized read-only connection to board.db with core/mem attached.
 * Idempotent — subsequent calls return the same handle.
 */
export function getReadDb() {
    if (_readDb)
        return _readDb;
    const paths = resolvePaths();
    if (!existsSync(paths.BOARD_DB_PATH)) {
        throw new Error(`board.db not found at ${paths.BOARD_DB_PATH}. ` +
            `Run \`./do board migrate --init\` first.`);
    }
    const db = new DatabaseSync(paths.BOARD_DB_PATH, {
        readOnly: true,
        timeout: 5000,
    });
    db.exec('PRAGMA trusted_schema = ON');
    if (existsSync(paths.CORE_DB_PATH)) {
        db.exec(`ATTACH DATABASE '${escapeSqlPath(paths.CORE_DB_PATH)}' AS core`);
    }
    else {
        console.error(`[Vodou-Board] WARN: vodou-core.db missing at ${paths.CORE_DB_PATH}; ` +
            `principal/tenant joins will fail.`);
    }
    if (existsSync(paths.MEMORY_DB_PATH)) {
        db.exec(`ATTACH DATABASE '${escapeSqlPath(paths.MEMORY_DB_PATH)}' AS mem`);
    }
    _readDb = db;
    return db;
}
/** SQL-safe path escape (single quotes doubled). */
function escapeSqlPath(p) {
    return p.replace(/'/g, "''");
}
/** For tests / hot-reload. */
export function _closeReadDb() {
    if (_readDb) {
        _readDb.close();
        _readDb = null;
    }
}
/** Returns the current paths (lazy — reads env at call time). */
export function paths() {
    return resolvePaths();
}
/** @deprecated Use paths() — module-load-time constants don't see test-set env. */
export const PATHS = new Proxy({}, {
    get(_t, k) { return resolvePaths()[k]; },
});
