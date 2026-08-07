/**
 * Attached clients API — PLAN-MCP-EGRESS-MEMORY T2 (Console surface).
 *
 * The other direction from Settings → Servers. That page manages which MCP servers
 * Vodou connects TO; this one shows which clients have attached to Vodou and what each
 * of them may reach.
 *
 * Every operation shells `vodou-core mcp … --json`, the same pattern memory-vaults.ts
 * uses: the registry lives in vodou-core.db and the Rust CLI owns all of its semantics.
 * Nothing here re-implements profile or vault rules — a second implementation is a
 * second answer, and for a disclosure boundary the two answers eventually disagree.
 *
 *   GET  /api/mcp/clients              — registered HTTP clients + config-attached targets
 *   POST /api/mcp/clients/:id/revoke   — kill one client's token
 *   GET  /api/mcp/clients/audit        — what attached clients actually did (recent calls
 *                                        + per-client counts). Argument text is never in
 *                                        this data: the engine stores a salted digest.
 */

import { Router, Request, Response } from 'express';
import { runCore } from './memory-capture.js';

export const mcpClientsRouter = Router();

/** Client ids reach the CLI as positional argv. No leading dash (clap would read it as
 *  a flag), conservative charset, bounded length — same guard class as vault names. */
function isValidClientId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id);
}

interface ClientRow {
  client_id: string;
  label: string;
  profile: string;
  vault: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  revoked: boolean;
  /** Stored ceiling: null = default, 0 = explicitly unlimited. */
  rate_limit_per_min: number | null;
  /** Resolved by the engine (`mcp_rate::effective`): null = unlimited. The Console
   *  must not re-derive the default/opt-out distinction — one implementation. */
  effective_rate_limit_per_min: number | null;
}

interface AuditRow {
  id: number;
  client_id: string;
  label: string | null;
  transport: string;
  profile: string;
  vault: string;
  tool: string;
  outcome: string; // ok | denied | error | limited
  args_digest: string | null;
  arg_bytes: number;
  duration_ms: number | null;
  at: string; // naive UTC — rendered local in the view
}

interface AuditSummaryRow {
  client_id: string;
  outcome: string;
  count: number;
}

interface TargetRow {
  id: string;
  label: string;
  path: string;
  config_exists: boolean;
  attached: boolean;
  transport: string | null;
}

async function coreJson<T>(args: string[], key: string): Promise<T[]> {
  const r = await runCore(args, { timeout: 20_000 });
  if (r.status !== 0) {
    throw new Error(r.stderr.trim().split('\n')[0] || `vodou-core ${args.join(' ')} failed`);
  }
  const parsed = JSON.parse(r.stdout) as Record<string, T[]>;
  return parsed[key] ?? [];
}

mcpClientsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    // Two lists, deliberately. A registry row is an HTTP client holding its own token;
    // a target is a config file with a Vodou entry in it. stdio clients only ever appear
    // as the latter — they get their own process and carry no token — so showing only
    // the registry would report "nothing attached" while Cursor is happily connected.
    const [clients, targets] = await Promise.all([
      coreJson<ClientRow>(['mcp', 'clients', '--json'], 'clients'),
      coreJson<TargetRow>(['mcp', 'list', '--json'], 'targets'),
    ]);
    const registered = new Set(clients.filter((c) => !c.revoked).map((c) => c.client_id));
    res.json({
      ok: true,
      clients,
      // A config-attached client with no live registry row: stdio, or an HTTP entry
      // written before per-client tokens existed (it authenticates as the owner).
      targets: targets.map((t) => ({ ...t, registered: registered.has(t.id) })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// NOTE: registered before '/:id/revoke' matters not at all (different methods), but it
// MUST stay a literal path — an '/:id'-style GET added later would shadow it.
mcpClientsRouter.get('/audit', async (req: Request, res: Response) => {
  try {
    const args = ['mcp', 'audit', '--json'];
    // Query params reach the CLI as argv — same validation class as revoke's id.
    const client = req.query.client;
    if (client !== undefined) {
      if (!isValidClientId(client)) {
        return res.status(400).json({ ok: false, error: 'invalid client id' });
      }
      args.push('--client', client);
    }
    if (req.query.denied === '1' || req.query.denied === 'true') {
      args.push('--denied');
    }
    const limit = Number(req.query.limit ?? 50);
    if (Number.isFinite(limit) && limit >= 1 && limit <= 500) {
      args.push('--limit', String(Math.floor(limit)));
    }
    // Calls and per-client counts in one response: the panel shows both, and two
    // round-trips through the CLI for one render is a spawn we don't need.
    const [calls, summary] = await Promise.all([
      coreJson<AuditRow>(args, 'calls'),
      coreJson<AuditSummaryRow>(['mcp', 'audit', '--summary', '--json'], 'summary'),
    ]);
    res.json({ ok: true, calls, summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

mcpClientsRouter.post('/:id/revoke', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!isValidClientId(id)) {
    return res.status(400).json({ ok: false, error: 'invalid client id' });
  }
  try {
    const r = await runCore(['mcp', 'revoke', id, '--json'], { timeout: 20_000 });
    if (r.status !== 0) {
      throw new Error(r.stderr.trim().split('\n')[0] || 'revoke failed');
    }
    const out = JSON.parse(r.stdout) as { ok: boolean };
    // `ok: false` means "no ACTIVE client by that id" — already revoked, or never
    // existed. Not a server error, and the UI says so rather than showing a red toast.
    res.json({ ok: true, revoked: out.ok, client_id: id });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});
