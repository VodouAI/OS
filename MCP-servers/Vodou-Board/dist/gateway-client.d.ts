/**
 * HTTP write-path client. All board_* write tools route through here.
 * Falls back to direct SQLite orphan-event writes when the gateway is
 * unreachable; the dispatcher reconciles on next start.
 *
 * The bearer token (VODOU_BOARD_WRITE_TOKEN) is minted per-worker-spawn by
 * src/board/jwt.rs and injected via env. The gateway verifies HS256 with the
 * shared key in vodou-core.db::board_config.write_token_key_b64.
 */
export declare class GatewayError extends Error {
    status: number;
    body: string;
    route: string;
    constructor(status: number, body: string, route: string);
}
export interface GatewayOpts {
    method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    body?: unknown;
    timeoutMs?: number;
}
export interface GatewayResult<T> {
    ok: true;
    data: T;
    orphan: false;
}
export interface OrphanResult {
    ok: true;
    data: null;
    orphan: true;
    reason: string;
}
export type GatewayCallResult<T> = GatewayResult<T> | OrphanResult;
/**
 * Call POST /api/board<routePath>. Returns the JSON body on 2xx.
 * Falls back to orphan-event SQLite write on network failure / 5xx (idempotent).
 */
export declare function gatewayCall<T = unknown>(routePath: string, opts?: GatewayOpts): Promise<GatewayCallResult<T>>;
