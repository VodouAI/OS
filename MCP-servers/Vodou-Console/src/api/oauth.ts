/**
 * OAuth / Apps API — thin layer over vodou-core.db
 *
 * Architecture (Option B):
 *   - vodou-core owns OAuth end-to-end (oauth_configs, server_credentials, mcp_servers)
 *   - Gateway provides: preset catalog, UI, API-key flow, status reads, revoke cleanup
 *   - DCR-based OAuth will shell out to `vodou-core oauth-begin`/`oauth-complete`
 *     (Rust CLI commands — Phase 1 Rust work; endpoints below return 501 until those land)
 *
 * Endpoints:
 *   GET  /api/oauth/presets       — list the curated preset catalog
 *   GET  /api/oauth/status        — which presets are connected + MCP health
 *   POST /api/oauth/start         — begin OAuth for a DCR-capable preset (shells out to Rust)
 *   GET  /api/oauth/callback      — provider redirects here; completes OAuth (shells out to Rust)
 *   POST /api/oauth/credentials   — submit API key for API-key-only providers
 *   POST /api/oauth/revoke        — disconnect integration (delete creds, deactivate server)
 */

import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { PRESETS, OAuthPreset, presetAuthPath, resolveApiKey } from './oauth-presets.js';
import { getDb, getProjectRoot } from '../db.js';

// ─── helpers ────────────────────────────────────────────────────────────────

function redirectUri(): string {
  const base = (process.env.GATEWAY_BASE_URL || `http://localhost:${process.env.WEB_PORT || '8765'}`)
    .replace(/\/$/, '');
  return `${base}/api/oauth/callback`;
}

/**
 * Set `active` on the mcp_servers row matching `serverName` AND any duplicate
 * rows sharing the same `connection_config.url`. This handles the case where
 * the same logical MCP server got registered twice (e.g. once as a preset
 * `notion`, again as a custom URL `notion-custom`) — without this, disconnect
 * silently leaves the duplicate row at its old state and the user has to hunt
 * it down to manually toggle. Logs the affected row count so silent no-ops
 * are visible. Returns the number of rows updated.
 */
function setServerActiveByNameAndUrl(serverName: string, active: 0 | 1, callsite: string): number {
  const db = getDb();
  const row = db
    .prepare('SELECT id, connection_config FROM mcp_servers WHERE name = ?')
    .get(serverName) as { id: number; connection_config: string | null } | undefined;

  let url: string | null = null;
  if (row?.connection_config) {
    try {
      const cfg = JSON.parse(row.connection_config);
      if (typeof cfg?.url === 'string' && cfg.url.trim()) url = cfg.url.trim();
    } catch { /* not JSON or no url — fall back to name-only */ }
  }

  let total = 0;
  if (url) {
    // Update every row pointing at this URL, including the named one.
    const r = db
      .prepare(
        `UPDATE mcp_servers
           SET active = ?
         WHERE name = ?
            OR json_extract(connection_config, '$.url') = ?`,
      )
      .run(active, serverName, url);
    total = Number(r.changes);
  } else {
    const r = db.prepare('UPDATE mcp_servers SET active = ? WHERE name = ?').run(active, serverName);
    total = Number(r.changes);
  }

  if (total === 0) {
    console.warn(
      `[oauth/${callsite}] active=${active} update matched 0 rows (serverName=${serverName}, url=${url ?? '(none)'}) — row may be missing or renamed`,
    );
  } else if (total > 1) {
    console.error(
      `[oauth/${callsite}] active=${active} updated ${total} rows for ${serverName} (siblings share url=${url})`,
    );
  }
  return total;
}

function brainTrust4Path(): string {
  return path.join(getProjectRoot(), 'vodou-core');
}

// ─── live tool-discovery cache ─────────────────────────────────────────────
// /api/oauth/test shells out to `vodou-core tools <server>` to get a live
// tool count. Some integrations (Canva, Notion cold-start) take 60-80s. The
// audit reported users staring at frozen autocomplete; the real fix is to
// cache the live result for a short window so rapid refreshes / status pings
// don't re-pay the spawn cost.
type ToolTestCacheEntry = { result: any; ts: number };
const _toolTestCache = new Map<string, ToolTestCacheEntry>();
const TOOL_TEST_CACHE_TTL_MS = parseInt(process.env.TOOL_TEST_CACHE_TTL_MS || '60000', 10);
const TOOL_TEST_TIMEOUT_MS = parseInt(process.env.TOOL_TEST_TIMEOUT_MS || '30000', 10);
function getCachedToolTest(serverName: string): any | null {
  const hit = _toolTestCache.get(serverName);
  if (!hit) return null;
  if (Date.now() - hit.ts > TOOL_TEST_CACHE_TTL_MS) {
    _toolTestCache.delete(serverName);
    return null;
  }
  return hit.result;
}
function setCachedToolTest(serverName: string, result: any): void {
  _toolTestCache.set(serverName, { result, ts: Date.now() });
}
// Exposed for callers that want to bust the cache (e.g. revoke + reconnect).
export function invalidateToolTestCache(serverName?: string): void {
  if (serverName) _toolTestCache.delete(serverName);
  else _toolTestCache.clear();
}

/** Shell out to vodou-core binary, capture JSON on stdout. Rejects on non-zero exit. */
function runVodouCore(args: string[], stdinPayload?: string, timeoutMs = 60000): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(brainTrust4Path(), args, {
      cwd: getProjectRoot(),
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`vodou-core timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`vodou-core exited ${code}: ${stderr || stdout}`));
      }
      try {
        // Last non-empty line should be the JSON payload
        const lines = stdout.trim().split('\n').filter(Boolean);
        const jsonLine = lines[lines.length - 1];
        resolve(JSON.parse(jsonLine));
      } catch (e) {
        reject(new Error(`vodou-core did not return JSON: ${stdout.slice(-500)}`));
      }
    });

    if (stdinPayload !== undefined) {
      child.stdin.write(stdinPayload);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

/** Resolve or create the mcp_servers row for a preset. Returns server_id. */
function upsertMcpServer(preset: OAuthPreset): number {
  const db = getDb();
  const config = JSON.stringify({
    url: preset.mcpUrl,
    transport: preset.mcpTransport,
  });

  db.prepare(`
    INSERT INTO mcp_servers (name, command, args, connection_type, connection_config, description, install_method, active)
    VALUES (?, ?, '[]', 'http', ?, ?, 'remote', 0)
    ON CONFLICT(name) DO UPDATE SET
      connection_config = excluded.connection_config
  `).run(preset.id, preset.mcpUrl, config, preset.description);

  const row = db.prepare('SELECT id FROM mcp_servers WHERE name = ?').get(preset.id) as { id: number };
  return row.id;
}

/** Write an API-key credential to vodou-core.db. */
function saveApiKeyCredential(serverId: number, preset: OAuthPreset, apiKey: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO server_credentials (server_id, credential_type, credential_value, header_name, header_format, source)
    VALUES (?, 'bearer_token', ?, ?, ?, 'database')
    ON CONFLICT(server_id, credential_type) DO UPDATE SET
      credential_value = excluded.credential_value,
      header_name = excluded.header_name,
      header_format = excluded.header_format,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    serverId,
    apiKey,
    preset.apiKeyHeader || 'Authorization',
    preset.apiKeyFormat || 'Bearer {key}'
  );
}

/** Query current connection status for a preset. Returns null if not connected. */
interface ConnectionStatus {
  connected: boolean;
  credentialType: string | null;
  expired: boolean;
  scope: string | null;
  updatedAt: string | null;
  mcpHealth: string;
  /** When false, MCP row exists but is disabled until user toggles Active on the Apps card. */
  mcpEnabled: boolean;
  /** Count of intent_mappings rows for this server. */
  intentCount: number;
  /** Why the stored refresh token can't renew (null when it looks usable). */
  refreshError: string | null;
}

/** Number of consecutive refresh failures after which we stop calling a token "recoverable". */
const REFRESH_FAILURE_LIMIT = 3;

/**
 * Decide whether a stored refresh token can actually renew an access token.
 *
 * A row existing in `server_credentials` does NOT mean the token is usable — this is the
 * same trap the Rust side already fixed (QA-B13, `oauth_handler.rs`: use `usable_value()`,
 * not `.clone()`; an `enc:v1:` credential encrypted under a rotated VODOU_TOKEN key
 * decrypts to `Some("")`). The refresh sweep records its verdict on the ACCESS token row
 * (`refresh_failures` / `refresh_last_error`), so that is where we look.
 *
 * The `client_id` clause covers the silent-skip path (`oauth_handler.rs`: missing client_id
 * -> `skipped += 1; continue;` with no reason written). Those rows look pristine —
 * 0 failures, NULL error — while being permanently unrefreshable.
 */
function getRefreshState(
  db: ReturnType<typeof getDb>,
  serverId: number
): { usable: boolean; error: string | null } {
  const hasRow = !!db.prepare(
    "SELECT 1 FROM server_credentials WHERE server_id = ? AND credential_type = 'oauth_refresh_token' LIMIT 1"
  ).get(serverId);
  if (!hasRow) return { usable: false, error: null };

  const health = db.prepare(
    "SELECT refresh_failures, refresh_last_error FROM server_credentials WHERE server_id = ? AND credential_type = 'oauth_access_token' LIMIT 1"
  ).get(serverId) as { refresh_failures: number | null; refresh_last_error: string | null } | undefined;

  const lastError = health?.refresh_last_error || null;
  if (lastError) return { usable: false, error: lastError };

  const failures = Number(health?.refresh_failures ?? 0);
  if (failures >= REFRESH_FAILURE_LIMIT) {
    return { usable: false, error: `refresh failed ${failures} times \u2014 reconnect required` };
  }

  const cfg = db.prepare('SELECT client_id FROM oauth_configs WHERE server_id = ?')
    .get(serverId) as { client_id: string | null } | undefined;
  if (cfg && !(cfg.client_id || '').trim()) {
    return { usable: false, error: 'OAuth client_id missing; reconnect required' };
  }

  return { usable: true, error: null };
}

function getStatusForPreset(preset: OAuthPreset): ConnectionStatus & { toolCount: number } {
  const db = getDb();
  const server = db.prepare(
    'SELECT id, health_status, COALESCE(active, 1) AS active_n FROM mcp_servers WHERE name = ?'
  ).get(preset.id) as { id: number; health_status: string | null; active_n: number } | undefined;

  const intentCount = (db.prepare('SELECT COUNT(*) as c FROM intent_mappings WHERE server_name = ?').get(preset.id) as { c: number }).c;

  if (preset.localStdio) {
    if (!server) {
      return {
        connected: false,
        credentialType: null,
        expired: false,
        scope: null,
        updatedAt: null,
        mcpHealth: 'unknown',
        toolCount: 0,
        mcpEnabled: false,
        intentCount,
        refreshError: null,
      };
    }
    const toolCount = (db.prepare('SELECT COUNT(*) as c FROM tools WHERE server_id = ?').get(server.id) as { c: number }).c;
    // For localStdio providers we don't store credentials in server_credentials
    // (tokens live in the provider's own cache file). So `connected` here
    // mirrors the `active` column — that's what /revoke flips, and without
    // this check the UI would show "Connected" forever after disconnect (no
    // way to clear the connected state since the server row stays).
    const isActive = server.active_n !== 0;
    return {
      connected: isActive,
      credentialType: 'local_stdio',
      expired: false,
      scope: null,
      updatedAt: null,
      mcpHealth: server.health_status || 'unknown',
      toolCount,
      mcpEnabled: isActive,
      intentCount,
      refreshError: null,
    };
  }

  if (!server) {
    return {
      connected: false,
      credentialType: null,
      expired: false,
      scope: null,
      updatedAt: null,
      mcpHealth: 'unknown',
      toolCount: 0,
      mcpEnabled: false,
      intentCount,
      refreshError: null,
    };
  }

  const mcpEnabled = server.active_n !== 0;

  const cred = db.prepare(`
    SELECT credential_type, expires_at, updated_at
    FROM server_credentials
    WHERE server_id = ? AND credential_type IN ('oauth_access_token', 'bearer_token', 'api_key')
    ORDER BY CASE credential_type
      WHEN 'oauth_access_token' THEN 0
      WHEN 'bearer_token' THEN 1
      ELSE 2 END
    LIMIT 1
  `).get(server.id) as { credential_type: string; expires_at: string | null; updated_at: string } | undefined;

  const toolCount = (db.prepare('SELECT COUNT(*) as c FROM tools WHERE server_id = ?').get(server.id) as { c: number }).c;

  if (!cred) {
    return {
      connected: false,
      credentialType: null,
      expired: false,
      scope: null,
      updatedAt: null,
      mcpHealth: server.health_status || 'unknown',
      toolCount,
      mcpEnabled,
      intentCount,
      refreshError: null,
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const accessExpired = cred.expires_at ? Number(cred.expires_at) < now : false;

  // If an access token is past its TTL but a USABLE refresh_token exists, the Rust
  // refresh-on-401 wiring self-heals on the next tool call — don't alarm the user.
  // getRefreshState() is what makes "usable" mean usable rather than "a row exists":
  // an unreadable enc:v1: blob or a missing client_id never self-heals, and reporting
  // `expired: false` for those hides a dead integration indefinitely.
  const refreshState = getRefreshState(db, server.id);
  const expired = accessExpired && !refreshState.usable;

  let scope: string | null = null;
  const oauthConfig = db.prepare(
    'SELECT scope FROM oauth_configs WHERE server_id = ?'
  ).get(server.id) as { scope: string | null } | undefined;
  if (oauthConfig) scope = oauthConfig.scope;

  return {
    connected: true,
    credentialType: cred.credential_type,
    expired,
    scope,
    updatedAt: cred.updated_at,
    mcpHealth: server.health_status || 'unknown',
    toolCount,
    mcpEnabled,
    intentCount,
    refreshError: refreshState.error,
  };
}

/** Look up saved OAuth client_id for a server (returns null if no oauth_configs row,
 *  or if the underlying dynamic_oauth_clients registration has expired).
 *  Used by UI to prefill the manual-OAuth form on reconnect. We never expose client_secret;
 *  the gateway just uses the saved value server-side when start is called without explicit creds.
 *
 *  Expiry check: providers like Buildkite issue DCR clients with a short `expires_at`.
 *  Reusing an expired client_id makes the provider return `invalid_client` on authorize,
 *  even though our oauth_configs row looks fresh. When expired, return null so /start
 *  re-runs DCR and gets a new client.
 */
function getSavedClientId(serverName: string): string | null {
  try {
    const db = getDb();
    const row = db.prepare(
      `SELECT oc.client_id, oc.server_id FROM oauth_configs oc
       JOIN mcp_servers ms ON oc.server_id = ms.id
       WHERE ms.name = ?`
    ).get(serverName) as { client_id: string | null; server_id: number } | undefined;
    if (!row?.client_id) return null;
    // If this client was issued via DCR, honor the expires_at and drop the
    // saved id when stale so /start triggers a fresh registration.
    try {
      const dyn = db.prepare(
        `SELECT expires_at FROM dynamic_oauth_clients WHERE server_id = ? AND client_id = ?`
      ).get(row.server_id, row.client_id) as { expires_at: string | null } | undefined;
      if (dyn?.expires_at) {
        const expSec = Number(dyn.expires_at);
        if (Number.isFinite(expSec) && expSec > 0 && expSec * 1000 < Date.now()) {
          console.error(`[oauth] saved DCR client for ${serverName} expired (exp=${expSec}); forcing re-registration`);
          return null;
        }
      }
    } catch { /* dynamic_oauth_clients table or row missing — treat as non-DCR, reuse saved id */ }
    return row.client_id;
  } catch { return null; }
}

function getSavedClientSecret(serverName: string): string | null {
  try {
    const db = getDb();
    const row = db.prepare(
      `SELECT oc.client_secret, oc.server_id, oc.client_id FROM oauth_configs oc
       JOIN mcp_servers ms ON oc.server_id = ms.id
       WHERE ms.name = ?`
    ).get(serverName) as { client_secret: string | null; server_id: number; client_id: string | null } | undefined;
    if (!row?.client_secret) return null;
    // Mirror getSavedClientId expiry check — never return a secret for an
    // expired DCR client. /start will re-register and overwrite both.
    try {
      if (row.client_id) {
        const dyn = db.prepare(
          `SELECT expires_at FROM dynamic_oauth_clients WHERE server_id = ? AND client_id = ?`
        ).get(row.server_id, row.client_id) as { expires_at: string | null } | undefined;
        if (dyn?.expires_at) {
          const expSec = Number(dyn.expires_at);
          if (Number.isFinite(expSec) && expSec > 0 && expSec * 1000 < Date.now()) return null;
        }
      }
    } catch { /* table missing — proceed */ }
    return row.client_secret;
  } catch { return null; }
}

// ─── router ──────────────────────────────────────────────────────────────────

export const oauthRouter = Router();

/** GET /api/oauth/presets — list all curated providers */
oauthRouter.get('/presets', (_req: Request, res: Response) => {
    const presets = Object.values(PRESETS).map(p => ({
    id: p.id,
    name: p.name,
    icon: p.icon,
    logo: p.logo || null,
    logoColor: !!p.logoColor,
    description: p.description,
    category: p.category,
    authPath: presetAuthPath(p),
    dcrOptionalApiKey: !!p.dcrOptionalApiKey,
    apiKeyEnv: p.apiKeyEnv || null,
    apiKeyHint: p.apiKeyEnv ? `Paste your ${p.name} token` : null,
    setupDocsUrl: p.setupDocsUrl || null,
    mcpUrl: p.mcpUrl,
    localStdio: !!p.localStdio,
    stdioCommand: p.stdioCommand || null,
    stdioArgs: p.stdioArgs || null,
    blocked: !!p.blocked,
    blockedReason: p.blockedReason || null,
  }));
  res.json({ presets });
});

/** GET /api/oauth/status — connection status + MCP health per preset + custom integrations */
oauthRouter.get('/status', (_req: Request, res: Response) => {
  try {
    const presetIds = new Set(Object.keys(PRESETS));

    // Preset providers
    const providers = Object.values(PRESETS).map(p => {
      const status = getStatusForPreset(p);
      const envKeyPresent = !!resolveApiKey(p);
      const savedClientId = getSavedClientId(p.id);
      const savedClientSecret = getSavedClientSecret(p.id);
      return {
        id: p.id,
        name: p.name,
        icon: p.icon,
        logo: p.logo || null,
        logoColor: !!p.logoColor,
        category: p.category,
        description: p.description,
        authPath: presetAuthPath(p),
        dcrOptionalApiKey: !!p.dcrOptionalApiKey,
        apiKeyEnv: p.apiKeyEnv || null,
        setupDocsUrl: p.setupDocsUrl || null,
        setupSteps: p.setupSteps || null,
        blocked: !!p.blocked,
        blockedReason: p.blockedReason || null,
        custom: false,
        mcpUrl: p.mcpUrl,
        localStdio: !!p.localStdio,
        stdioCommand: p.stdioCommand || null,
        stdioArgs: p.stdioArgs || null,
        switchAccount: p.switchAccount || null,
        userSuppliedUrl: !!p.userSuppliedUrl,
        userSuppliedUrlPlaceholder: p.userSuppliedUrlPlaceholder || null,
        savedClientId,
        savedClientSecret,
        ...status,
        envKeyPresent,
      };
    });

    // Custom integrations: active HTTP servers that aren't in the preset catalog
    const db = getDb();
    const customServers = db.prepare(`
      SELECT id, name, command, connection_config, description, health_status, COALESCE(active, 1) AS active_n
      FROM mcp_servers
      WHERE connection_type = 'http' AND name NOT IN (${[...presetIds].map(() => '?').join(',')})
    `).all(...presetIds) as Array<{
      id: number; name: string; command: string;
      connection_config: string | null; description: string | null; health_status: string | null;
      active_n: number;
    }>;

    for (const srv of customServers) {
      const cred = db.prepare(`
        SELECT credential_type, expires_at, updated_at
        FROM server_credentials
        WHERE server_id = ? AND credential_type IN ('oauth_access_token', 'bearer_token', 'api_key')
        ORDER BY CASE credential_type WHEN 'oauth_access_token' THEN 0 WHEN 'bearer_token' THEN 1 ELSE 2 END
        LIMIT 1
      `).get(srv.id) as { credential_type: string; expires_at: string | null; updated_at: string } | undefined;

      const now = Math.floor(Date.now() / 1000);
      let mcpUrl = srv.command || '';
      try { const cc = JSON.parse(srv.connection_config || '{}'); if (cc.url) mcpUrl = cc.url; } catch {}

      const oauthConfig = db.prepare(
        'SELECT scope FROM oauth_configs WHERE server_id = ?'
      ).get(srv.id) as { scope: string | null } | undefined;
      const toolCount = (db.prepare('SELECT COUNT(*) as c FROM tools WHERE server_id = ?').get(srv.id) as { c: number }).c;
      const intentCount = (db.prepare('SELECT COUNT(*) as c FROM intent_mappings WHERE server_name = ?').get(srv.name) as { c: number }).c;

      // Same rule as the preset path, via the same helper so the two can't drift again.
      const customAccessExpired = cred?.expires_at ? Number(cred.expires_at) < now : false;
      const customRefreshState = getRefreshState(db, srv.id);

      providers.push({
        id: srv.name,
        name: srv.name,
        icon: '🔗',
        logo: null,
        logoColor: false,
        category: 'Custom',
        description: srv.description || mcpUrl,
        authPath: cred?.credential_type === 'oauth_access_token' ? 'dcr' : 'apiKey',
        dcrOptionalApiKey: false,
        apiKeyEnv: null,
        setupDocsUrl: null,
        setupSteps: null,
        blocked: false,
        blockedReason: null,
        savedClientId: getSavedClientId(srv.name),
        savedClientSecret: getSavedClientSecret(srv.name),
        custom: true,
        mcpUrl,
        localStdio: false,
        stdioCommand: null,
        stdioArgs: null,
        switchAccount: null,
        userSuppliedUrl: false,
        userSuppliedUrlPlaceholder: null,
        connected: !!cred,
        credentialType: cred?.credential_type || null,
        expired: customAccessExpired && !customRefreshState.usable,
        refreshError: customRefreshState.error,
        scope: oauthConfig?.scope || null,
        updatedAt: cred?.updated_at || null,
        mcpHealth: srv.health_status || 'unknown',
        envKeyPresent: false,
        toolCount,
        mcpEnabled: srv.active_n !== 0,
        intentCount,
      });
    }

    // Stdio servers registered in mcp_servers but not in PRESETS catalog → Custom category
    const presetIdList = [...presetIds];
    const stdioPlaceholders = presetIdList.map(() => '?').join(',');
    const stdioServers = db.prepare(`
      SELECT id, name, command, description, health_status, COALESCE(active, 1) AS active_n
      FROM mcp_servers
      WHERE connection_type = 'stdio' AND name NOT IN (${stdioPlaceholders})
    `).all(...presetIdList) as Array<{
      id: number; name: string; command: string;
      description: string | null; health_status: string | null; active_n: number;
    }>;

    for (const srv of stdioServers) {
      const toolCount = (db.prepare('SELECT COUNT(*) as c FROM tools WHERE server_id = ?').get(srv.id) as { c: number }).c;
      const intentCount = (db.prepare('SELECT COUNT(*) as c FROM intent_mappings WHERE server_name = ?').get(srv.name) as { c: number }).c;
      providers.push({
        id: srv.name,
        name: srv.name,
        icon: '⚙️',
        logo: null,
        logoColor: false,
        category: 'Custom',
        description: srv.description || srv.command || '',
        authPath: 'localStdio',
        dcrOptionalApiKey: false,
        apiKeyEnv: null,
        setupDocsUrl: null,
        setupSteps: null,
        blocked: false,
        blockedReason: null,
        savedClientId: null,
        savedClientSecret: null,
        custom: true,
        mcpUrl: '',
        localStdio: true,
        stdioCommand: srv.command || null,
        stdioArgs: null,
        switchAccount: null,
        userSuppliedUrl: false,
        userSuppliedUrlPlaceholder: null,
        connected: true,
        credentialType: 'local_stdio',
        expired: false,
        refreshError: null,
        scope: null,
        updatedAt: null,
        mcpHealth: srv.health_status || 'unknown',
        envKeyPresent: false,
        toolCount,
        mcpEnabled: srv.active_n !== 0,
        intentCount,
      });
    }

    res.json({ providers });
  } catch (err) {
    console.error('[oauth/status] error:', err);
    res.status(500).json({ error: 'Failed to load integration status' });
  }
});

/** POST /api/oauth/credentials — API-key providers (no OAuth flow)
 *  Accepts either:
 *    { provider: "airtable", apiKey: "pat..." }                   — preset
 *    { url: "https://mcp.example.com/mcp", name: "x", apiKey: "..." }  — custom
 */
oauthRouter.post('/credentials', (req: Request, res: Response) => {
  const { provider, url, name, apiKey } =
    (req.body || {}) as { provider?: string; url?: string; name?: string; apiKey?: string };
  if (!apiKey || !apiKey.trim()) return res.status(400).json({ error: 'apiKey is required' });

  if (provider) {
    // Preset path
    const preset = PRESETS[provider];
    if (!preset) return res.status(400).json({ error: `Unknown provider: ${provider}` });
    if (preset.localStdio) {
      return res.status(400).json({
        error:
          'This app runs as a local stdio MCP — use Apps → Add server on its card (or run vodou-core connect from a terminal).',
      });
    }
    if (!preset.apiKeyOnly && !preset.dcrOptionalApiKey) {
      return res.status(400).json({
        error: `${preset.name} does not accept pasted API keys here — use Connect (OAuth) or an API-key preset.`,
      });
    }
    try {
      const serverId = upsertMcpServer(preset);
      if (preset.dcrOptionalApiKey) {
        const db = getDb();
        db.prepare(
          `DELETE FROM server_credentials WHERE server_id = ? AND credential_type IN ('oauth_access_token', 'oauth_refresh_token')`
        ).run(serverId);
      }
      saveApiKeyCredential(serverId, preset, apiKey.trim());
      // Auto-enable on connect — user just connected, they want it active.
      getDb().prepare('UPDATE mcp_servers SET active = 1 WHERE id = ?').run(serverId);
      console.error(`[oauth] api-key saved for ${provider} (server_id=${serverId}, auto-enabled)`);
      res.json({ success: true, serverName: preset.id, mcpUrl: preset.mcpUrl });
    } catch (err) {
      console.error(`[oauth/credentials] error for ${provider}:`, err);
      res.status(500).json({ error: (err as Error).message || 'Failed to save credentials' });
    }
  } else if (url) {
    // Custom URL path
    try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
    const serverName = name || new URL(url).hostname.replace(/^mcp\./, '').split('.')[0];
    const transport = url.endsWith('/sse') ? 'sse' : 'http';
    try {
      const db = getDb();
      const config = JSON.stringify({ url, transport });
      db.prepare(`
        INSERT INTO mcp_servers (name, command, args, connection_type, connection_config, description, install_method, active)
        VALUES (?, ?, '[]', 'http', ?, ?, 'remote', 0)
        ON CONFLICT(name) DO UPDATE SET connection_config = excluded.connection_config
      `).run(serverName, url, config, `Custom MCP server: ${serverName}`);
      const row = db.prepare('SELECT id FROM mcp_servers WHERE name = ?').get(serverName) as { id: number };
      db.prepare(`
        INSERT INTO server_credentials (server_id, credential_type, credential_value, header_name, header_format, source)
        VALUES (?, 'bearer_token', ?, 'Authorization', 'Bearer {key}', 'database')
        ON CONFLICT(server_id, credential_type) DO UPDATE SET
          credential_value = excluded.credential_value, updated_at = CURRENT_TIMESTAMP
      `).run(row.id, apiKey.trim());
      // Auto-enable on connect — same rationale as preset path.
      db.prepare('UPDATE mcp_servers SET active = 1 WHERE id = ?').run(row.id);
      console.error(`[oauth] custom api-key saved for ${serverName} (server_id=${row.id}, auto-enabled)`);
      res.json({ success: true, serverName, mcpUrl: url });
    } catch (err) {
      console.error(`[oauth/credentials] custom error:`, err);
      res.status(500).json({ error: (err as Error).message || 'Failed to save credentials' });
    }
  } else {
    return res.status(400).json({ error: 'provider or url is required' });
  }
});

/** POST /api/oauth/test — run a live tool discovery against a connected integration
 *  Body: { provider: "cloudflare" | "notion-custom" | ... }
 *  Shells out to `vodou-core tools <name>` and reports back.
 */
oauthRouter.post('/test', async (req: Request, res: Response) => {
  const { provider } = (req.body || {}) as { provider?: string };
  if (!provider) return res.status(400).json({ error: 'provider is required' });

  // Resolve the server name (preset id or custom name)
  const preset = PRESETS[provider];
  const serverName = preset ? preset.id : provider;

  const db = getDb();
  const row = db.prepare('SELECT id, COALESCE(active, 1) AS a FROM mcp_servers WHERE name = ?')
    .get(serverName) as { id: number; a: number } | undefined;
  if (!row) return res.status(404).json({ error: `Not registered: ${serverName}` });
  if (row.a === 0) {
    return res.status(400).json({
      error: `Enable "${serverName}" under Capabilities → MCP Servers (Tools) before testing.`,
    });
  }

  // Serve from cache if a recent live discovery is still warm.
  // Skip cache when ?fresh=1 — UI uses this for explicit "rediscover" buttons.
  const wantsFresh = req.query.fresh === '1' || req.body?.fresh === true;
  if (!wantsFresh) {
    const cached = getCachedToolTest(serverName);
    if (cached) {
      res.json({ ...cached, cached: true });
      return;
    }
  }

  try {
    const child = spawn(brainTrust4Path(), ['tools', serverName], {
      cwd: getProjectRoot(),
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    // Default 30s timeout; override via TOOL_TEST_TIMEOUT_MS for known-slow
    // integrations (Canva cold-start was the original 120s justification).
    // Most providers respond in <5s. Pair with the cache above so the worst
    // case is paid at most once per minute.
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, TOOL_TEST_TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      // vodou-core tools emits three shapes per server:
      //   A) Legacy slash form — `  /<server> <tool> - <desc>`
      //   B) HTTP/SSE — `  <ToolName>: <desc>`
      //   C) Current catalog (gmail etc.) — `  🔧 <tool> - <desc>`
      //      (emoji may be stripped in some terminals; also accept bare `  tool - `)
      const toolLines = stdout.split('\n').filter(l =>
        /^\s{2}\/[\w-]+\s+[\w_-]+\s+-\s/.test(l) ||
        /^\s{2}[A-Za-z][\w_-]*:\s/.test(l) ||
        /^\s{2}(?:🔧\s+)?[\w_-]+\s+-\s/.test(l)
      );
      const toolCount = toolLines.length;
      const ok = code === 0 && toolCount > 0;

      // Update tool count in the db
      if (ok) {
        // No writes needed — vodou-core tools command already persists them
      }

      const payload = {
        success: ok,
        toolCount,
        sample: toolLines.slice(0, 5).map(l => {
          const slashMatch = l.match(/^\s{2}\/[\w-]+\s+([\w_-]+)\s+-/);
          if (slashMatch) return slashMatch[1];
          const emojiMatch = l.match(/^\s{2}(?:🔧\s+)?([\w_-]+)\s+-/);
          if (emojiMatch) return emojiMatch[1];
          const colonMatch = l.match(/^\s{2}([A-Za-z][\w_-]*):/);
          if (colonMatch) return colonMatch[1];
          return l.trim();
        }),
        error: ok ? null : (stderr.trim() || stdout.slice(-400) || `exited with code ${code}`),
      };
      // Only cache successful results — a transient failure shouldn't poison
      // the cache for a minute.
      if (ok) setCachedToolTest(serverName, payload);
      res.json(payload);
    });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      res.status(502).json({ success: false, error: err.message });
    });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** POST /api/oauth/start — kick off OAuth (DCR path via vodou-core)
 *  Accepts either:
 *    { provider: "cloudflare" }           — use preset catalog
 *    { url: "https://mcp.example.com/mcp", name: "my-service" }  — custom MCP URL
 */
oauthRouter.post('/start', async (req: Request, res: Response) => {
  const { provider, url, name, clientId: bodyClientId, clientSecret: bodyClientSecret } =
    (req.body || {}) as { provider?: string; url?: string; name?: string; clientId?: string; clientSecret?: string };

  let serverName: string;
  let mcpUrl: string;
  let manualClientId: string | undefined;
  let manualClientSecret: string | undefined;

  if (provider) {
    // Preset path
    const preset = PRESETS[provider];
    if (!preset) return res.status(400).json({ error: `Unknown provider: ${provider}` });
    if (preset.blocked) {
      return res.status(400).json({
        error:
          preset.blockedReason ||
          'This provider cannot be connected from the gateway until the vendor allowlists it.',
        setupDocsUrl: preset.setupDocsUrl || null,
      });
    }
    if (preset.localStdio) {
      return res.status(400).json({
        error:
          'Local stdio MCP — no OAuth. On Apps, open this provider’s card and click Add server.',
        setupDocsUrl: preset.setupDocsUrl || null,
      });
    }
    serverName = preset.id;
    mcpUrl = preset.mcpUrl;
    // For non-DCR presets, try env vars first (user may have set them in .env)
    if (!preset.dcrSupported && preset.clientIdEnv) {
      manualClientId = process.env[preset.clientIdEnv];
      manualClientSecret = preset.clientSecretEnv ? process.env[preset.clientSecretEnv] : undefined;
    }
  } else if (url) {
    // Custom URL path
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }
    mcpUrl = url;
    serverName = name || parsed.hostname.replace(/^mcp\./, '').split('.')[0];
  } else {
    return res.status(400).json({ error: 'provider or url is required' });
  }

  // Body-level client creds override env vars (user pasted them in the UI)
  if (bodyClientId) manualClientId = bodyClientId;
  if (bodyClientSecret) manualClientSecret = bodyClientSecret;

  // Fill any missing field from saved oauth_configs. Lets users reconnect with
  // partial input — e.g., client_id prefilled in UI, secret left blank → reuse saved secret.
  if (!manualClientId) {
    const savedId = getSavedClientId(serverName);
    if (savedId) {
      manualClientId = savedId;
      console.error(`[oauth/start] using saved client_id for ${serverName}`);
    }
  }
  if (manualClientId && !manualClientSecret) {
    const savedSecret = getSavedClientSecret(serverName);
    if (savedSecret) {
      manualClientSecret = savedSecret;
      console.error(`[oauth/start] using saved client_secret for ${serverName}`);
    }
  }

  // If provider needs manual OAuth and we still have no creds, reject clearly
  if (provider) {
    const preset = PRESETS[provider];
    if (preset && !preset.dcrSupported && !manualClientId) {
      return res.status(400).json({
        error: `${preset.name} requires OAuth credentials. Paste Client ID and Client Secret in the UI, or set ${preset.clientIdEnv || 'the relevant env vars'} in .env.`,
        setupDocsUrl: preset.setupDocsUrl || null,
      });
    }
  }

  try {
    const args = ['oauth-begin', serverName, mcpUrl, '--redirect-uri', redirectUri()];
    if (manualClientId) args.push('--client-id', manualClientId);
    if (manualClientSecret) args.push('--client-secret', manualClientSecret);

    const result = await runVodouCore(args, undefined, 30000);

    if (!result.authorize_url) {
      return res.status(502).json({ error: 'vodou-core did not return an authorize_url' });
    }
    res.json({ authorize_url: result.authorize_url, state: result.state, server_name: result.server_name });
  } catch (err) {
    const rawMsg = (err as Error).message || String(err);
    const code = (err as NodeJS.ErrnoException).code;
    console.error('[oauth/start] error:', err);
    // Translate the most common spawn/integrity failures into actionable
    // guidance — the raw error string is unreadable for non-engineers.
    let friendly = rawMsg;
    let hint: string | null = null;
    if (code === 'ENOENT' || /ENOENT|no such file/i.test(rawMsg)) {
      friendly = 'vodou-core binary not found.';
      hint = 'Run ./install-prebuilt.sh from the project root, then retry.';
    } else if (/killed|SIGKILL|signal 9/i.test(rawMsg)) {
      friendly = 'vodou-core was killed before completing OAuth begin.';
      hint = 'macOS may have SIGKILL\'d an unsigned binary. Run: codesign --force --deep --sign - vodou-core (then retry).';
    } else if (/EACCES|permission denied/i.test(rawMsg)) {
      friendly = 'vodou-core is not executable.';
      hint = 'Run: chmod +x vodou-core';
    } else if (/timed out/i.test(rawMsg)) {
      friendly = 'OAuth begin timed out talking to the provider.';
      hint = 'The MCP endpoint may be unreachable or slow. Check connectivity to ' + mcpUrl + ' and retry.';
    }
    res.status(502).json({
      error: friendly,
      hint,
      raw: rawMsg !== friendly ? rawMsg : undefined,
    });
  }
});

/** GET /api/oauth/callback — provider redirects here after user authorizes */
oauthRouter.get('/callback', async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string>;

  if (error) {
    return res.status(400).send(htmlPage(false, 'Authorization denied', `Provider returned: ${error}`));
  }
  if (!code || !state) {
    return res.status(400).send(htmlPage(false, 'Bad request', 'Missing code or state parameter.'));
  }

  // Basic state format validation before shelling out — prevent argv injection via length/charset
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(state)) {
    return res.status(400).send(htmlPage(false, 'Invalid state', 'State parameter failed validation.'));
  }

  try {
    const payload = JSON.stringify({ code, state });
    const result = await runVodouCore(['oauth-complete'], payload, 30000);

    if (!result.success) {
      return res.status(502).send(htmlPage(false, 'OAuth failed', result.error || 'Token exchange failed.'));
    }

    const serverName = result.server_name || 'integration';
    // Auto-enable on successful OAuth — fan out to any duplicate rows sharing
    // the same connection URL so a `notion` + `notion-custom` situation doesn't
    // leave one half stuck at active=0.
    if (result.server_name) {
      try {
        setServerActiveByNameAndUrl(result.server_name, 1, 'callback');
      } catch (e) {
        console.warn(`[oauth/callback] auto-enable failed for ${result.server_name}:`, e);
      }
    }
    res.send(htmlPage(true, `${serverName} connected!`, 'You can close this tab.', serverName));
  } catch (err) {
    const msg = (err as Error).message;
    console.error('[oauth/callback] error:', err);
    res.status(500).send(htmlPage(false, 'Server error', msg));
  }
});

/** POST /api/oauth/revoke — disconnect integration (preset or custom) */
oauthRouter.post('/revoke', async (req: Request, res: Response) => {
  const { provider } = (req.body || {}) as { provider?: string };
  if (!provider) return res.status(400).json({ error: 'provider is required' });

  const preset = PRESETS[provider]; // may be undefined for custom integrations

  try {
    const db = getDb();
    const serverName = preset ? preset.id : provider;
    const server = db.prepare('SELECT id FROM mcp_servers WHERE name = ?').get(serverName) as { id: number } | undefined;

    if (server) {
      // Best-effort provider-side revoke for OAuth tokens
      if (preset?.revokeUrl) {
        const token = db.prepare(
          'SELECT credential_value FROM server_credentials WHERE server_id = ? AND credential_type = ?'
        ).get(server.id, 'oauth_access_token') as { credential_value: string } | undefined;
        if (token?.credential_value) {
          try {
            await fetch(`${preset.revokeUrl}?token=${encodeURIComponent(token.credential_value)}`, { method: 'POST' });
          } catch (e) {
            console.warn(`[oauth/revoke] provider-side revoke failed (non-fatal):`, e);
          }
        }
      }

      db.prepare('DELETE FROM server_credentials WHERE server_id = ?').run(server.id);
      // Intentionally KEEP oauth_configs (client_id/secret + endpoints).
      // Disconnect just revokes the user's session — the OAuth app config is reusable
      // so the next reconnect prefills the form instead of forcing the user to hunt
      // their credentials down again. To fully forget app config, use a "Forget app"
      // action (not yet exposed in UI).
      setServerActiveByNameAndUrl(serverName, 0, 'revoke');
    }

    console.error(`[oauth] revoked ${serverName} (oauth_configs preserved for next reconnect)`);
    res.json({ success: true });
  } catch (err) {
    console.error('[oauth/revoke] error:', err);
    res.status(500).json({ error: (err as Error).message || 'Failed to revoke' });
  }
});

/** POST /api/oauth/switch-account — sign out + prep for re-auth as a different user.
 *
 *  - localStdio with `switchAccount.tokensPath`: rm tokens, deactivate server row, return
 *    `mode: 'localStdio'` + the reauth command for the user to run.
 *  - cloud OAuth (DCR/manual): same effect as /revoke, return `mode: 'cloud'` so the UI
 *    can prompt the user to click Connect again and pick a different account.
 */
oauthRouter.post('/switch-account', async (req: Request, res: Response) => {
  const { provider } = (req.body || {}) as { provider?: string };
  if (!provider) return res.status(400).json({ error: 'provider is required' });

  const preset = PRESETS[provider];
  const serverName = preset ? preset.id : provider;

  try {
    const db = getDb();
    const server = db.prepare('SELECT id FROM mcp_servers WHERE name = ?').get(serverName) as
      | { id: number } | undefined;

    // localStdio path: wipe tokens file
    if (preset?.localStdio && preset.switchAccount) {
      const tokensFull = path.join(getProjectRoot(), preset.switchAccount.tokensPath);
      let tokensRemoved = false;
      try {
        if (fs.existsSync(tokensFull)) {
          fs.unlinkSync(tokensFull);
          tokensRemoved = true;
        }
      } catch (e) {
        console.warn(`[switch-account] tokens unlink failed for ${serverName}:`, e);
      }
      if (server) {
        setServerActiveByNameAndUrl(serverName, 0, 'switch-account/localStdio');
      }
      console.error(`[switch-account] ${serverName} (localStdio): tokensRemoved=${tokensRemoved}`);
      return res.json({
        success: true,
        mode: 'localStdio',
        tokensRemoved,
        reauthCommand: preset.switchAccount.reauthCommand,
      });
    }

    // Cloud OAuth path: same as /revoke — drop credentials + deactivate.
    if (server) {
      if (preset?.revokeUrl) {
        const token = db.prepare(
          'SELECT credential_value FROM server_credentials WHERE server_id = ? AND credential_type = ?'
        ).get(server.id, 'oauth_access_token') as { credential_value: string } | undefined;
        if (token?.credential_value) {
          try {
            await fetch(`${preset.revokeUrl}?token=${encodeURIComponent(token.credential_value)}`, { method: 'POST' });
          } catch (e) {
            console.warn(`[switch-account] provider-side revoke failed (non-fatal):`, e);
          }
        }
      }
      db.prepare('DELETE FROM server_credentials WHERE server_id = ?').run(server.id);
      setServerActiveByNameAndUrl(serverName, 0, 'switch-account/cloud');
    }

    console.error(`[switch-account] ${serverName} (cloud): credentials cleared`);
    return res.json({ success: true, mode: 'cloud' });
  } catch (err) {
    console.error('[switch-account] error:', err);
    return res.status(500).json({ error: (err as Error).message || 'Failed to switch account' });
  }
});

// ─── HTML helpers ─────────────────────────────────────────────────────────────

function htmlPage(ok: boolean, title: string, body: string, provider?: string): string {
  const color = ok ? '#22c55e' : '#ef4444';
  const postMsg = ok && provider
    ? `<script>try { window.opener?.postMessage({ type: 'oauth_done', provider: ${JSON.stringify(provider)} }, window.location.origin); } catch(e) {}</script>`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f0f0f;color:#e5e7eb;}
.card{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:2rem 2.5rem;text-align:center;max-width:420px;}
h2{color:${color};margin-top:0;} p{color:#9ca3af;margin-bottom:0;}</style>
</head><body><div class="card"><h2>${title}</h2><p>${body}</p></div>${postMsg}</body></html>`;
}
