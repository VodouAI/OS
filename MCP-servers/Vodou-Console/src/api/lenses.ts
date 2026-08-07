/**
 * /api/lenses/* — backend for the Cards framework.
 *
 * Endpoints:
 *   POST /api/lenses/fetch       — resolve a card render model
 *   POST /api/lenses/action      — invoke a card action (consent-gated)
 *   GET  /api/lenses/manifests   — list installed card manifests
 *   GET  /api/lenses/status      — bridge + cache status
 *
 * All endpoints return structured { ok, data?, error? } JSON. They never
 * throw to the client — failed fetches return text-fallback-ready errors
 * so chat.js can degrade gracefully to the LLM's text answer.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getRegistry, ensureRegistryLoaded, reloadRegistry } from '../lenses/registry.js';
import { cacheKey, readCache, writeCache, coalesce, cacheStats } from '../lenses/_lib/cache.js';
import { buildFetchCtx } from '../lenses/_lib/fetch_ctx.js';
import { bridgeStatus } from '../vbb/bridge.js';
import { getPolicyState } from '../lenses/_lib/policy.js';
import * as metadata from '../lenses/metadata.js';
import { installLensFromGit, uninstallLens } from '../lenses/install.js';
import { fetchDirectoryIndex, searchDirectory, findDirectoryEntriesForUrl } from '../lenses/directory.js';
import { urlMatch } from '../lenses/_lib/urlmatch.js';
import { scaffoldLensStub } from '../lenses/scaffold.js';

export const lensesRouter = Router();

// Vodou Bridge on the Chrome Web Store (live since 2026-08-04). The item id is
// permanent across updates, so this URL never changes.
const CWS_LISTING_URL =
  'https://chromewebstore.google.com/detail/vodou-bridge/ehlanbbiaeelnimkakfffehoahimkjjf';

// All endpoints await registry load — first request after boot may pay a small cost.
lensesRouter.use(async (_req, _res, next) => {
  try { await ensureRegistryLoaded(); } catch { /* surface in endpoints */ }
  next();
});

// -------------------- POST /api/lenses/fetch --------------------
lensesRouter.post('/fetch', async (req: Request, res: Response) => {
  const { type, source_url = '', payload = {} } = (req.body || {}) as {
    type?: string;
    source_url?: string;
    payload?: any;
  };

  if (!type || typeof type !== 'string') {
    return res.status(400).json({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'missing "type"' },
    });
  }

  const reg = getRegistry();
  const card = reg.get(type);
  if (!card) {
    return res.status(404).json({
      ok: false,
      error: { code: 'UNKNOWN_TYPE', message: `no card registered for type "${type}"` },
    });
  }

  // Synthesize URL if card supports it and the caller didn't provide one
  let effectiveUrl = source_url;
  if (!effectiveUrl && card.synthesizeUrl) {
    try { effectiveUrl = card.synthesizeUrl(payload); } catch { /* ignore */ }
  }

  if (!card.validate(payload, effectiveUrl)) {
    return res.status(400).json({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: `card "${type}" rejected payload` },
    });
  }

  // BRIDGE_REQUIRED — if the card declares needs_session: true and the
  // bridge isn't connected, surface a structured error so the chat UI
  // can show "Install Vodou Bridge" instead of a generic failure.
  if (card.manifest.requires?.needs_session) {
    const bs = bridgeStatus();
    if (!bs.connected) {
      // Differentiate the two real failure modes so the user knows
      // exactly what to do, not a generic "installed and running" line:
      //   - Browser info present → extension was connected before; the
      //     MV3 service worker likely suspended. Just clicking the
      //     Vodou icon in the toolbar wakes it and reconnects in ~2s.
      //   - No browser info → extension truly not installed / never
      //     connected since gateway boot.
      const everConnected = !!bs.browser_info;
      const msg = everConnected
        ? `Vodou Bridge isn't currently connected. Click the Vodou icon in your Chrome toolbar to wake the extension — it reconnects in a couple of seconds.`
        : `Vodou Bridge isn't installed (or this gateway hasn't seen it yet). Install it from the Chrome Web Store: ${CWS_LISTING_URL}`;
      return res.status(503).json({
        ok: false,
        error: {
          code: 'BRIDGE_REQUIRED',
          message: msg,
          detail: {
            install_url: CWS_LISTING_URL,
            card_type: type,
            ever_connected: everConnected,
            last_browser: bs.browser_info?.ua || null,
          },
        },
      });
    }
  }

  // Cache lookup
  const key = cacheKey(type, effectiveUrl, payload);
  const cached = readCache(key);
  if (cached && card.manifest.ttl_seconds > 0) {
    return res.json({
      ok: true,
      data: {
        type,
        source_url: effectiveUrl,
        manifest: publicManifest(card.manifest),
        render_model: cached.render_model,
        cache: { hit: true, age_ms: Date.now() - cached.fetched_at },
      },
    });
  }

  // Coalesced fetch
  try {
    const renderModel = await coalesce(key, async () => {
      const ctx = buildFetchCtx();
      const t0 = Date.now();
      const model = await card.fetch(payload, effectiveUrl, ctx);
      const elapsed = Date.now() - t0;
      console.log(`[lenses] fetch ${type} ${elapsed}ms`);
      if (card.manifest.ttl_seconds > 0) {
        writeCache(key, type, effectiveUrl, model, card.manifest.ttl_seconds);
      }
      return model;
    });

    // Extraction health check
    let health: { ok: boolean; missing?: string[] } = { ok: true };
    if (card.extractionHealth) {
      try { health = card.extractionHealth(renderModel); } catch { /* ignore */ }
    }

    return res.json({
      ok: true,
      data: {
        type,
        source_url: effectiveUrl,
        manifest: publicManifest(card.manifest),
        render_model: renderModel,
        cache: { hit: false },
        health,
      },
    });
  } catch (err: any) {
    const code = err?.code || 'FETCH_FAILED';
    // Enrich BRIDGE_REQUIRED with install detail so the frontend can render
    // a real install card. Some lenses don't declare needs_session up-front
    // (the precheck at the top of this handler doesn't fire for them) but
    // still call ctx.extension.* at fetch time, which throws BRIDGE_REQUIRED
    // from bridge.ts:134. Without this enrichment, the frontend would only
    // see a generic error message.
    const httpStatus = code === 'BRIDGE_REQUIRED' ? 503 : 500;
    const errorBody: any = { code, message: err?.message || 'card fetch failed' };
    if (code === 'BRIDGE_REQUIRED') {
      const bs = bridgeStatus();
      const everConnected = !!bs.browser_info;
      errorBody.message = everConnected
        ? `Vodou Bridge isn't currently connected. Click the Vodou icon in your Chrome toolbar to wake the extension — it reconnects in a couple of seconds.`
        : `Vodou Bridge isn't installed (or this gateway hasn't seen it yet). Install it from the Chrome Web Store: ${CWS_LISTING_URL}`;
      errorBody.detail = {
        install_url: CWS_LISTING_URL,
        card_type: type,
        ever_connected: everConnected,
        last_browser: bs.browser_info?.ua || null,
      };
    }
    return res.status(httpStatus).json({ ok: false, error: errorBody });
  }
});

// -------------------- POST /api/lenses/action --------------------
// In-memory consent map for MVP. PLAN-LENSES-MANAGEMENT (0.5.89) replaces
// this with the card_consents table.
const consents = new Map<string, true>();
function consentKey(cardType: string, actionId: string, domain: string) {
  return `${cardType}:${actionId}:${domain}`;
}

lensesRouter.post('/action', async (req: Request, res: Response) => {
  const { type, action_id, source_url, payload = {}, render_model = {}, consent_granted = false, conversation_id = '' } = (req.body || {});

  if (!type || !action_id || !source_url) {
    return res.status(400).json({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'type, action_id, source_url required' },
    });
  }

  const card = getRegistry().get(type);
  if (!card || !card.actions || !card.actions[action_id]) {
    return res.status(404).json({
      ok: false,
      error: { code: 'UNKNOWN_TYPE', message: `card "${type}" has no action "${action_id}"` },
    });
  }
  const action = card.actions[action_id];

  // Consent check
  let domain = '';
  try { domain = new URL(source_url).hostname; } catch { /* ignore */ }
  const ck = consentKey(type, action_id, domain);
  if (action.requiresConsent && !consents.has(ck)) {
    if (!consent_granted) {
      return res.status(403).json({
        ok: false,
        error: {
          code: 'CONSENT_REQUIRED',
          message: `Action "${action.label}" requires consent for ${domain}`,
          detail: { domain, action_id, label: action.label },
        },
      });
    }
    consents.set(ck, true);
  }

  // BRIDGE_REQUIRED check — actions almost always need the Bridge.
  // Surface a structured error if the card needs a session and bridge isn't connected.
  if (card.manifest.requires?.needs_session || card.manifest.requires?.paths?.includes('bridge')) {
    const bs = bridgeStatus();
    if (!bs.connected) {
      return res.status(503).json({
        ok: false,
        error: {
          code: 'BRIDGE_REQUIRED',
          message: `Action "${action.label}" needs the Vodou Bridge extension and Chrome running.`,
          detail: { install_url: CWS_LISTING_URL, card_type: type, action_id },
        },
      });
    }
  }

  // Build action ctx
  const fetchCtx = buildFetchCtx();
  const ctx = {
    ...fetchCtx,
    conversationId: conversation_id,
    sourceUrl: source_url,
  } as any;

  try {
    const result = await action.run(render_model, ctx);
    return res.json({ ok: result.ok, data: { message: result.message || '' } });
  } catch (err: any) {
    return res.status(500).json({
      ok: false,
      error: { code: 'INTERNAL', message: err?.message || 'action failed' },
    });
  }
});

// -------------------- GET /api/lenses/manifests --------------------
lensesRouter.get('/manifests', (_req: Request, res: Response) => {
  const reg = getRegistry();
  res.json({
    ok: true,
    data: reg.listManifests().filter(m => m.category !== 'debug').map(publicManifest),
  });
});

// -------------------- GET /api/lenses/preview --------------------
// Given a URL, list which installed cards claim it. Used by:
//   - the LLM (when an LLM-generated URL appears, hint which card to emit)
//   - the chat composer ("paste a URL → render a card?")
//   - the future router-LLM (URL context → card candidates)
lensesRouter.get('/preview', (req: Request, res: Response) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  if (!url) {
    return res.status(400).json({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'url query param required' },
    });
  }
  const matches = getRegistry().findCardsForUrl(url).filter(m => m.category !== 'debug');
  res.json({ ok: true, data: matches.map(publicManifest) });
});

// -------------------- GET /api/lenses/health --------------------
// Run a sampled extractionHealth across cards that can self-test.
// Returns per-card { type, ok, missing }. Useful for the management UI
// "selectors stale" surface in 0.5.89.
lensesRouter.get('/health', async (_req: Request, res: Response) => {
  // Health is per-card and may need a live URL — for MVP we just report
  // which cards declare extractionHealth + have non-empty url_patterns.
  // Active probing is deferred to a background job (PLAN-LENSES-MANAGEMENT).
  const reg = getRegistry();
  const results = reg.listManifests()
    .filter(m => m.category !== 'debug')
    .map(m => {
      const card = reg.get(m.type);
      return {
        type: m.type,
        version: m.version,
        probeable: !!card?.extractionHealth,
        url_patterns: m.url_patterns,
      };
    });
  res.json({ ok: true, data: results });
});

// -------------------- GET /api/lenses/status --------------------
lensesRouter.get('/status', (_req: Request, res: Response) => {
  const reg = getRegistry();
  res.json({
    ok: true,
    data: {
      registered: reg.listManifests().length,
      load_errors: reg.getLoadErrors(),
      bridge: bridgeStatus(),
      cache: cacheStats(),
      policy: getPolicyState(),
    },
  });
});

// -------------------- GET /api/lenses/installed --------------------
// PLAN-LENSES-MANAGEMENT Phase 1 — combined view: every loaded lens with its
// metadata sidecar (or built-in defaults). Drives the sidebar list.
lensesRouter.get('/installed', async (_req: Request, res: Response) => {
  try {
    const registry = await ensureRegistryLoaded();
    const rows = metadata.list();
    const byId = new Map(rows.map(r => [r.id, r]));
    const data = registry.listManifests().map((m: any) => {
      const row = byId.get(m.type);
      return {
        manifest: publicManifest(m),
        source: row?.source ?? 'builtin',
        source_url: row?.source_url ?? null,
        installed_at: row?.installed_at ?? null,
        enabled: row ? !!row.enabled : true,
        uses_count: row?.uses_count ?? 0,
        last_used_at: row?.last_used_at ?? null,
        health_status: row?.health_status ?? 'healthy',
        health_last_check: row?.health_last_check ?? null,
      };
    });
    res.json({ ok: true, data });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err?.message || 'list failed' } });
  }
});

// -------------------- GET /api/lenses/installed/:id --------------------
lensesRouter.get('/installed/:id', async (req: Request, res: Response) => {
  try {
    const registry = await ensureRegistryLoaded();
    const id = req.params.id;
    const lens = registry.get(id);
    if (!lens) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `lens '${id}' not registered` } });
    }
    const row = metadata.get(id);
    res.json({
      ok: true,
      data: {
        manifest: publicManifest(lens.manifest),
        source: row?.source ?? 'builtin',
        source_url: row?.source_url ?? null,
        installed_at: row?.installed_at ?? null,
        enabled: row ? !!row.enabled : true,
        uses_count: row?.uses_count ?? 0,
        last_used_at: row?.last_used_at ?? null,
        health_status: row?.health_status ?? 'healthy',
        health_last_check: row?.health_last_check ?? null,
      },
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err?.message || 'inspect failed' } });
  }
});

// -------------------- GET /api/lenses/installed/:id/stats --------------------
lensesRouter.get('/installed/:id/stats', async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const row = metadata.get(id);
    res.json({
      ok: true,
      data: {
        id,
        uses_count: row?.uses_count ?? 0,
        last_used_at: row?.last_used_at ?? null,
        health_status: row?.health_status ?? 'healthy',
        health_last_check: row?.health_last_check ?? null,
      },
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err?.message || 'stats failed' } });
  }
});

// -------------------- POST /api/lenses/installed/:id/enable|disable --------------------
async function setLensEnabled(req: Request, res: Response, enabled: boolean) {
  const id = req.params.id;
  if (!id) return res.status(400).json({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'missing :id' } });
  try {
    const row = metadata.get(id);
    if (!row) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `lens '${id}' is not user-installed (built-ins can't be disabled)` } });
    }
    metadata.setEnabled(id, enabled);
    await reloadRegistry();
    res.json({ ok: true, data: { id, enabled } });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err?.message || 'toggle failed' } });
  }
}
lensesRouter.post('/installed/:id/enable',  (req: Request, res: Response) => setLensEnabled(req, res, true));
lensesRouter.post('/installed/:id/disable', (req: Request, res: Response) => setLensEnabled(req, res, false));

// -------------------- POST /api/lenses/install --------------------
// PLAN-LENSES-MANAGEMENT §7.1–7.2 — install from either:
//   { directory_id }            → look up entry, install from its git_url/ref
//   { git_url, version? }       → arbitrary-URL install (no hash verify)
lensesRouter.post('/install', async (req: Request, res: Response) => {
  const body = (req.body as any) || {};
  let git_url = String(body.git_url || '').trim();
  let version = body.version ? String(body.version).trim() : undefined;
  const directory_id = String(body.directory_id || '').trim();

  if (directory_id) {
    try {
      const idx = await fetchDirectoryIndex();
      const entry = idx.lenses.find(e => e.id === directory_id);
      if (!entry) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `directory entry '${directory_id}' not found` } });
      }
      git_url = entry.git_url;
      if (!version && entry.git_ref) version = entry.git_ref;
    } catch (err: any) {
      return res.status(502).json({ ok: false, error: { code: 'DIRECTORY_FETCH_FAILED', message: err?.message || 'directory lookup failed' } });
    }
  }

  if (!git_url) {
    return res.status(400).json({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'directory_id or git_url required' } });
  }
  if (!/^https?:\/\/|^git@|^file:\/\//.test(git_url)) {
    return res.status(400).json({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'git_url must be http(s), git@, or file://' } });
  }
  try {
    const result = await installLensFromGit(git_url, version);
    res.json({ ok: true, data: result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: { code: 'INSTALL_FAILED', message: err?.message || 'install failed' } });
  }
});

// -------------------- DELETE /api/lenses/installed/:id --------------------
// Full uninstall: cache purge, consent revocation, DB row delete, fs removal,
// registry reload. Built-ins refused (they're source-tree only).
lensesRouter.delete('/installed/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'missing :id' } });
  try {
    const row = metadata.get(id);
    if (!row) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `lens '${id}' is not user-installed` } });
    }
    const result = await uninstallLens(id, row.module_path);
    res.json({ ok: true, data: result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: { code: 'UNINSTALL_FAILED', message: err?.message || 'uninstall failed' } });
  }
});

// -------------------- GET /api/lenses/directory --------------------
// PLAN-LENSES-MANAGEMENT §9 + Phase 4 — browse the curated community index.
// `?q=<query>` filters by id/motive/category/author; `?url=<full-url>` finds
// directory entries whose url_patterns match.
lensesRouter.get('/directory', async (req: Request, res: Response) => {
  try {
    const url = (req.query.url as string | undefined)?.trim();
    const q = (req.query.q as string | undefined) || '';
    let entries;
    if (url) {
      entries = await findDirectoryEntriesForUrl(url, urlMatch);
    } else {
      entries = await searchDirectory(q);
    }
    res.json({ ok: true, data: { entries } });
  } catch (err: any) {
    res.status(502).json({ ok: false, error: { code: 'DIRECTORY_FETCH_FAILED', message: err?.message || 'directory fetch failed' } });
  }
});

// -------------------- POST /api/lenses/directory/refresh --------------------
// Force-bust the in-memory directory cache (otherwise: 1h TTL).
lensesRouter.post('/directory/refresh', async (_req: Request, res: Response) => {
  try {
    const idx = await fetchDirectoryIndex(true);
    res.json({ ok: true, data: { count: idx.lenses.length, generated_at: idx.generated_at } });
  } catch (err: any) {
    res.status(502).json({ ok: false, error: { code: 'DIRECTORY_FETCH_FAILED', message: err?.message || 'directory fetch failed' } });
  }
});

// -------------------- GET /api/lenses/consents --------------------
// PLAN-LENSES-MANAGEMENT §3.5 Phase 5 — every active consent the user has
// granted to a lens action. `?include_revoked=1` returns the full history.
lensesRouter.get('/consents', (req: Request, res: Response) => {
  try {
    const includeRevoked = (req.query.include_revoked as string | undefined) === '1';
    const rows = metadata.listConsents(includeRevoked);
    res.json({ ok: true, data: { consents: rows } });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err?.message || 'list failed' } });
  }
});

// -------------------- POST /api/lenses/consents/grant --------------------
// Called by the lens action layer when the user clicks Allow on the consent
// dialog. Idempotent: re-granting an already-active consent is a no-op.
lensesRouter.post('/consents/grant', (req: Request, res: Response) => {
  const body = (req.body as any) || {};
  const lens_id = String(body.lens_id || '').trim();
  const action_id = String(body.action_id || '').trim();
  const domain = String(body.domain || '').trim();
  if (!lens_id || !action_id || !domain) {
    return res.status(400).json({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'lens_id, action_id, domain required' } });
  }
  try {
    metadata.grantConsent(lens_id, action_id, domain);
    res.json({ ok: true, data: { lens_id, action_id, domain } });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err?.message || 'grant failed' } });
  }
});

// -------------------- DELETE /api/lenses/consents/:lens_id/:action_id --------------------
// Revoke a specific consent. Next attempted use re-prompts.
lensesRouter.delete('/consents/:lens_id/:action_id', (req: Request, res: Response) => {
  const lens_id = req.params.lens_id;
  const action_id = req.params.action_id;
  const domain = req.query.domain as string | undefined;
  try {
    const changed = metadata.revokeConsent(lens_id, action_id, domain);
    res.json({ ok: true, data: { lens_id, action_id, domain: domain || null, revoked: changed } });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err?.message || 'revoke failed' } });
  }
});

// -------------------- POST /api/lenses/installed/:id/health-check --------------------
// PLAN-LENSES-MANAGEMENT §8 — run a fetch against a sample URL from the lens's
// url_patterns, validate every declared `extracts` field is non-empty, set
// health_status accordingly. Daily scheduler in Phase 5 ticks all lenses;
// this endpoint runs one on demand.
lensesRouter.post('/installed/:id/health-check', async (req: Request, res: Response) => {
  const id = req.params.id;
  try {
    const registry = await ensureRegistryLoaded();
    const lens = registry.get(id);
    if (!lens) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `lens '${id}' not registered` } });
    }
    const sampleUrl = (req.body as any)?.sample_url
      || (lens.manifest.url_patterns?.[0] || '').replace(/\*\*/g, 'sample').replace(/\*/g, 'sample');
    if (!sampleUrl || !/^https?:\/\//.test(sampleUrl)) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'no sample_url and no usable url_pattern' } });
    }
    let status: 'healthy' | 'selectors_stale' | 'fetch_failing';
    let detail: any = {};
    try {
      const ctx = buildFetchCtx();
      const fetched: any = await lens.fetch({}, sampleUrl, ctx);
      const expected: string[] = lens.manifest.extracts || [];
      const empty = expected.filter(k => fetched?.[k] === undefined || fetched?.[k] === null || fetched?.[k] === '' || (Array.isArray(fetched?.[k]) && fetched[k].length === 0));
      status = empty.length === 0 ? 'healthy' : 'selectors_stale';
      detail = { tested_url: sampleUrl, empty_fields: empty, total_declared: expected.length };
    } catch (e: any) {
      status = 'fetch_failing';
      detail = { tested_url: sampleUrl, error: e?.message || String(e) };
    }
    // Only persist for community lenses (built-ins have no DB row).
    if (metadata.get(id)) {
      try { metadata.setHealth(id, status); } catch {}
    }
    res.json({ ok: true, data: { id, status, detail } });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err?.message || 'health check failed' } });
  }
});

// -------------------- POST /api/lenses/scaffold --------------------
// PLAN-LENSES-MANAGEMENT §4 + Phase 5 — write a stub lens module to
// ~/.vodou/lenses/<id>/ from a URL hint. Phase 5 ships CLI-only stub
// generation; the visual click-to-label UX slips to 0.5.90.
lensesRouter.post('/scaffold', async (req: Request, res: Response) => {
  const body = (req.body as any) || {};
  const url = String(body.url || '').trim();
  const id = String(body.id || '').trim();
  if (!id || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    return res.status(400).json({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'id must be alphanumeric + dot/dash/underscore' } });
  }
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'url must be http(s)' } });
  }
  try {
    const result = await scaffoldLensStub(id, url);
    res.json({ ok: true, data: result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: { code: 'SCAFFOLD_FAILED', message: err?.message || 'scaffold failed' } });
  }
});

// -------------------- POST /api/lenses/reload --------------------
// Re-scan card directories (built-in + user). No gateway restart needed.
// Use this after dropping a new card folder into ~/.vodou/cards/<id>/.
lensesRouter.post('/reload', async (_req: Request, res: Response) => {
  try {
    const r = await reloadRegistry();
    res.json({ ok: true, data: r });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err?.message || 'reload failed' } });
  }
});

function publicManifest(m: any) {
  // What we expose to clients + the router-LLM. No internal handler refs.
  return {
    type: m.type,
    version: m.version,
    motive: m.motive,
    url_patterns: m.url_patterns,
    ttl_seconds: m.ttl_seconds,
    requires: m.requires,
    icon: m.icon,
    category: m.category,
    author: m.author,
    license: m.license,
    extracts: m.extracts,
  };
}
