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
/**
 * Returns a memoized read-only connection to board.db with core/mem attached.
 * Idempotent — subsequent calls return the same handle.
 */
export declare function getReadDb(): DatabaseSync;
/** For tests / hot-reload. */
export declare function _closeReadDb(): void;
/** Returns the current paths (lazy — reads env at call time). */
export declare function paths(): {
    PROJECT_ROOT: string;
    BOARD_DB_PATH: string;
    CORE_DB_PATH: string;
    MEMORY_DB_PATH: string;
};
/** @deprecated Use paths() — module-load-time constants don't see test-set env. */
export declare const PATHS: {
    PROJECT_ROOT: string;
    BOARD_DB_PATH: string;
    CORE_DB_PATH: string;
    MEMORY_DB_PATH: string;
};
