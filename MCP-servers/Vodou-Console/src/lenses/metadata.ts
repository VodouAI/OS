/**
 * LensMetadataStore — thin SQL wrapper around `installed_lenses` + `lens_consents`.
 *
 * PLAN-LENSES-MANAGEMENT §6 — this is the metadata sidecar that augments the
 * filesystem-scanned registry. Built-in lenses bypass this store entirely
 * (their source-of-truth is the filesystem). User-installed lenses under
 * `~/.vodou/lenses/<id>/` each get a row here with usage, enable state,
 * source URL, frozen manifest, and health.
 *
 * The store is intentionally narrow: it doesn't know about LensModule, fetch,
 * or render — only the metadata fields. The registry consults it during load
 * to skip disabled lenses and run drift checks.
 */

import { getGatewayDb, type DB } from '../db.js';

export type LensSource = 'directory' | 'git' | 'local';
export type HealthStatus = 'healthy' | 'selectors_stale' | 'fetch_failing' | 'load_failed';

export interface InstalledLensRow {
  id: string;
  version: string;
  source: LensSource;
  source_url: string | null;
  manifest_json: string;
  installed_at: number;
  enabled: number;            // 0|1
  module_path: string;
  uses_count: number;
  last_used_at: number | null;
  health_status: HealthStatus | null;
  health_last_check: number | null;
}

export interface LensConsentRow {
  id: number;
  lens_id: string;
  action_id: string;
  domain: string;
  granted_at: number;
  used_count: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

function db(): DB {
  return getGatewayDb();
}

// -------------------- installed_lenses --------------------

export function list(): InstalledLensRow[] {
  return db().prepare(`SELECT * FROM installed_lenses ORDER BY id`).all() as unknown as InstalledLensRow[];
}

export function get(id: string): InstalledLensRow | null {
  const row = db().prepare(`SELECT * FROM installed_lenses WHERE id = ?`).get(id) as unknown as InstalledLensRow | undefined;
  return row || null;
}

export function upsertOnInstall(row: Omit<InstalledLensRow, 'uses_count' | 'last_used_at' | 'health_status' | 'health_last_check'>): void {
  db().prepare(`
    INSERT INTO installed_lenses
      (id, version, source, source_url, manifest_json, installed_at, enabled, module_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      version = excluded.version,
      source = excluded.source,
      source_url = excluded.source_url,
      manifest_json = excluded.manifest_json,
      installed_at = excluded.installed_at,
      enabled = excluded.enabled,
      module_path = excluded.module_path
  `).run(
    row.id,
    row.version,
    row.source,
    row.source_url,
    row.manifest_json,
    row.installed_at,
    row.enabled,
    row.module_path,
  );
}

export function setEnabled(id: string, enabled: boolean): void {
  db().prepare(`UPDATE installed_lenses SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
}

export function markUsed(id: string): void {
  db().prepare(`
    UPDATE installed_lenses
       SET uses_count = uses_count + 1,
           last_used_at = ?
     WHERE id = ?
  `).run(Date.now(), id);
}

export function setHealth(id: string, status: HealthStatus): void {
  db().prepare(`
    UPDATE installed_lenses
       SET health_status = ?,
           health_last_check = ?
     WHERE id = ?
  `).run(status, Date.now(), id);
}

export function remove(id: string): void {
  db().prepare(`DELETE FROM installed_lenses WHERE id = ?`).run(id);
}

// -------------------- lens_consents --------------------

export function listConsents(includeRevoked = false): LensConsentRow[] {
  const sql = includeRevoked
    ? `SELECT * FROM lens_consents ORDER BY granted_at DESC`
    : `SELECT * FROM lens_consents WHERE revoked_at IS NULL ORDER BY granted_at DESC`;
  return db().prepare(sql).all() as unknown as LensConsentRow[];
}

export function grantConsent(lens_id: string, action_id: string, domain: string): void {
  db().prepare(`
    INSERT INTO lens_consents (lens_id, action_id, domain, granted_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(lens_id, action_id, domain) DO UPDATE SET
      granted_at = excluded.granted_at,
      revoked_at = NULL
  `).run(lens_id, action_id, domain, Date.now());
}

export function isConsentActive(lens_id: string, action_id: string, domain: string): boolean {
  const row = db().prepare(`
    SELECT 1 FROM lens_consents
     WHERE lens_id = ? AND action_id = ? AND domain = ? AND revoked_at IS NULL
  `).get(lens_id, action_id, domain);
  return !!row;
}

export function markConsentUsed(lens_id: string, action_id: string, domain: string): void {
  db().prepare(`
    UPDATE lens_consents
       SET used_count = used_count + 1,
           last_used_at = ?
     WHERE lens_id = ? AND action_id = ? AND domain = ? AND revoked_at IS NULL
  `).run(Date.now(), lens_id, action_id, domain);
}

export function revokeConsent(lens_id: string, action_id?: string, domain?: string): number {
  let sql = `UPDATE lens_consents SET revoked_at = ? WHERE lens_id = ? AND revoked_at IS NULL`;
  const args: any[] = [Date.now(), lens_id];
  if (action_id !== undefined) { sql += ` AND action_id = ?`; args.push(action_id); }
  if (domain !== undefined) { sql += ` AND domain = ?`; args.push(domain); }
  const r = db().prepare(sql).run(...args);
  return r.changes as number;
}

// -------------------- drift check --------------------

/**
 * Compare a runtime manifest object against the frozen install-time manifest
 * for the same lens. Returns null if they match, or an array of human-readable
 * diff lines if they don't. The registry uses this to refuse to load lenses
 * whose code lies about their declared contract.
 */
export function detectManifestDrift(
  runtime: Record<string, any>,
  frozen: Record<string, any>,
): string[] | null {
  const diffs: string[] = [];
  const fields: Array<keyof typeof runtime> = ['type', 'version', 'url_patterns', 'requires', 'extracts'];
  for (const f of fields) {
    const a = JSON.stringify(runtime[f] ?? null);
    const b = JSON.stringify(frozen[f] ?? null);
    if (a !== b) diffs.push(`${String(f)}: runtime=${a} frozen=${b}`);
  }
  return diffs.length ? diffs : null;
}
