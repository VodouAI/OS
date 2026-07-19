/**
 * HTTP write-path client. All board_* write tools route through here.
 * Falls back to direct SQLite orphan-event writes when the gateway is
 * unreachable; the dispatcher reconciles on next start.
 *
 * The bearer token (VODOU_BOARD_WRITE_TOKEN) is minted per-worker-spawn by
 * src/board/jwt.rs and injected via env. The gateway verifies HS256 with the
 * shared key in vodou-core.db::board_config.write_token_key_b64.
 */

import { DatabaseSync } from 'node:sqlite';
import { PATHS } from './db.js';
import { currentWriteToken } from './gating.js';

const GATEWAY_URL = process.env.VODOU_GATEWAY_URL ?? 'http://127.0.0.1:8765';

export class GatewayError extends Error {
  constructor(public status: number, public body: string, public route: string) {
    super(`gateway ${status} on ${route}: ${body.slice(0, 200)}`);
  }
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
export async function gatewayCall<T = unknown>(
  routePath: string,
  opts: GatewayOpts = {},
): Promise<GatewayCallResult<T>> {
  const url = `${GATEWAY_URL}/api/board${routePath}`;
  const token = currentWriteToken();
  const timeout = opts.timeoutMs ?? 10_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      method: opts.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status >= 500) {
        // Gateway is up but error'd — try orphan fallback (idempotent)
        return orphanWrite<T>(routePath, opts, `gateway ${res.status}`);
      }
      // 4xx is a programmer/contract error — surface, don't orphan
      throw new GatewayError(res.status, text, routePath);
    }
    const data = (await res.json()) as T;
    return { ok: true, data, orphan: false };
  } catch (e) {
    if (e instanceof GatewayError) throw e;
    const reason = e instanceof Error ? e.message : String(e);
    return orphanWrite<T>(routePath, opts, reason);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Orphan-event fallback. Writes a `_orphan` row into task_events so the
 * dispatcher's next tick can reconcile (re-issue the write through normal
 * channels with full event-emission + notifier fan-out).
 *
 * Opens its own write connection so we don't touch the read-only one from db.ts.
 */
let _fallbackDb: DatabaseSync | null = null;

function orphanWrite<T>(
  routePath: string,
  opts: GatewayOpts,
  reason: string,
): OrphanResult {
  if (!_fallbackDb) {
    _fallbackDb = new DatabaseSync(PATHS.BOARD_DB_PATH, {
      readOnly: false,
      timeout: 5000,
    });
    _fallbackDb.exec('PRAGMA journal_mode = WAL');
    _fallbackDb.exec('PRAGMA trusted_schema = ON');
  }
  const taskId = extractTaskId(routePath);
  _fallbackDb.prepare(
    `INSERT INTO task_events (task_id, kind, payload_json, actor)
     VALUES (?, '_orphan', ?, ?)`
  ).run(
    taskId,
    JSON.stringify({ route: routePath, method: opts.method, body: opts.body, reason }),
    `mcp:offline:${process.pid}`,
  );
  return { ok: true, data: null, orphan: true, reason };
}

function extractTaskId(routePath: string): string {
  const m = routePath.match(/\/tasks\/([^\/]+)/);
  return m?.[1] ?? 'unknown';
}
