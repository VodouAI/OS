/**
 * Card render-model cache.
 *
 * Keyed by sha256(type + ":" + source_url + ":" + json(payload)).
 * TTL is per-card (declared on the manifest). Cleanup runs hourly.
 * In-memory inflight coalescing prevents stampedes when N tabs
 * render the same card simultaneously.
 */

import { createHash } from 'node:crypto';
import { getGatewayDb } from '../../db.js';

export interface CacheEntry {
  type: string;
  render_model: any;
  fetched_at: number;
  ttl_seconds: number;
}

const inflight = new Map<string, Promise<any>>();

export function cacheKey(type: string, sourceUrl: string, payload: any): string {
  const stable = JSON.stringify(payload || {}, Object.keys(payload || {}).sort());
  return createHash('sha256').update(`${type}:${sourceUrl}:${stable}`).digest('hex');
}

export function readCache(key: string): CacheEntry | null {
  const db = getGatewayDb();
  const row = db.prepare(
    `SELECT type, render_model, fetched_at, ttl_seconds FROM lens_cache WHERE key = ?`
  ).get(key) as any;
  if (!row) return null;
  // TTL check
  const now = Date.now();
  if (row.fetched_at + row.ttl_seconds * 1000 < now) {
    try {
      db.prepare(`DELETE FROM lens_cache WHERE key = ?`).run(key);
    } catch { /* ignore */ }
    return null;
  }
  return {
    type: row.type,
    render_model: JSON.parse(row.render_model),
    fetched_at: row.fetched_at,
    ttl_seconds: row.ttl_seconds,
  };
}

// Maximum total bytes in lens_cache before we LRU-evict by fetched_at ASC.
// 25 MB is comfortable for a single user without growing unbounded.
const MAX_CACHE_BYTES = 25 * 1024 * 1024;

export function writeCache(
  key: string,
  type: string,
  sourceUrl: string,
  renderModel: any,
  ttlSeconds: number,
): void {
  const db = getGatewayDb();
  const json = JSON.stringify(renderModel);
  const bytes = Buffer.byteLength(json, 'utf8');
  db.prepare(`
    INSERT OR REPLACE INTO lens_cache (key, type, source_url, render_model, fetched_at, ttl_seconds, bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(key, type, sourceUrl, json, Date.now(), ttlSeconds, bytes);
  enforceCacheSizeCap();
}

/**
 * If total bytes > MAX_CACHE_BYTES, evict oldest entries (by fetched_at)
 * until we're under the cap. Runs on every write — cheap because the index
 * makes the SUM + ORDER BY fast.
 */
function enforceCacheSizeCap(): void {
  const db = getGatewayDb();
  const row = db.prepare(`SELECT COALESCE(SUM(bytes), 0) AS total FROM lens_cache`).get() as { total: number };
  if (!row || row.total <= MAX_CACHE_BYTES) return;
  let overBy = row.total - MAX_CACHE_BYTES;
  const oldest = db.prepare(`SELECT key, bytes FROM lens_cache ORDER BY fetched_at ASC LIMIT 100`).all() as Array<{ key: string; bytes: number }>;
  const delStmt = db.prepare(`DELETE FROM lens_cache WHERE key = ?`);
  let evicted = 0;
  for (const r of oldest) {
    if (overBy <= 0) break;
    delStmt.run(r.key);
    overBy -= r.bytes || 0;
    evicted++;
  }
  if (evicted > 0) console.log(`[lenses] cache size-cap evicted ${evicted} entries`);
}

/** Diagnostic — total size + entry count. */
export function cacheStats() {
  const db = getGatewayDb();
  const row = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM lens_cache`,
  ).get() as { n: number; bytes: number };
  return { entries: row.n, bytes: row.bytes, max_bytes: MAX_CACHE_BYTES };
}

/**
 * Inflight coalescing — if multiple concurrent requests hit the same
 * (type, sourceUrl, payload) tuple, only one fetch runs; others await it.
 */
export async function coalesce<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const promise = run().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/** Hourly cleanup — call from gateway boot scheduler. */
export function pruneExpired(): number {
  const db = getGatewayDb();
  const now = Date.now();
  const res = db.prepare(
    `DELETE FROM lens_cache WHERE fetched_at + ttl_seconds * 1000 < ?`
  ).run(now);
  return Number(res.changes || 0);
}

/** Clear all entries for a card type (used by management on uninstall). */
export function clearCardType(type: string): number {
  const db = getGatewayDb();
  const res = db.prepare(`DELETE FROM lens_cache WHERE type = ?`).run(type);
  return Number(res.changes || 0);
}
