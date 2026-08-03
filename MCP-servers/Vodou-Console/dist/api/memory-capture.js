/**
 * Capture Control API — PLAN-MEMORY-EVERYWHERE-FRONTEND P0 (PLANS/0.6.16).
 *
 * The surface-agnostic backend for the "Sources" UI: every capture lane
 * (This Mac / browser / BYOK apps / manual / file imports) as a togglable,
 * observable source. Four responsibilities:
 *
 *   GET  /api/capture/status    — one aggregate: per-lane enabled/connected/
 *                                 last-capture/counts. UIs poll this.
 *   GET/PUT /api/capture/settings — lane toggles. IDE-lane keys live in
 *                                 vodou-core.db `metadata` (the daemon re-reads
 *                                 them every tick); gateway-side lanes (BYOK,
 *                                 browser-armed) live in gateway_settings.
 *                                 Precedence is ALWAYS env > DB — existing .env
 *                                 installs behave bit-identically, and the UI
 *                                 shows `overridden_by_env` instead of lying.
 *   GET  /api/capture/recent    — what Vodou just remembered (capture-scoped
 *                                 chunks). This — not the import_jobs flagged
 *                                 queue — is the honest review surface for the
 *                                 live lanes, which never create jobs rows.
 *   POST /api/capture/forget    — surgical per-chunk delete ("forget this"),
 *                                 shells `mem reject --chunk-id` (guarded to
 *                                 import:%/capture:% in Rust).
 *   POST /api/capture/upload    — file-import without a terminal: stream the
 *                                 raw body to .vodou/uploads/ and shell
 *                                 `mem import <source> <file>`. Raw
 *                                 octet-stream (NOT multipart, NOT JSON) so the
 *                                 10MB express.json limit never applies and a
 *                                 500MB export never buffers in memory.
 *
 * No new ingest, no new store: reads memory.db/gateway.db/vodou-core.db,
 * writes settings rows, and shells the same Rust CLI as memory-import.ts.
 */
import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { getMemoryDb, getGatewayDb, getSetting, setSetting, getProjectRoot } from '../db.js';
import { bridgeStatus, pushCaptureArmed, disconnectBridge } from '../vbb/bridge.js';
export const memoryCaptureRouter = Router();
// ── vodou-core.db metadata access (IDE-lane settings + daemon heartbeat) ─────
// Short-lived handles: the Rust daemon owns this DB; we do single-row
// reads/upserts under WAL (established cross-process pattern here).
function coreDbPath() {
    return path.join(getProjectRoot(), 'vodou-core.db');
}
function readCoreMeta(keys) {
    const out = {};
    const p = coreDbPath();
    if (!fs.existsSync(p))
        return out;
    let db;
    try {
        db = new DatabaseSync(p, { readOnly: true, timeout: 2000 });
        const stmt = db.prepare('SELECT value FROM metadata WHERE key = ?');
        for (const k of keys) {
            const row = stmt.get(k);
            if (row?.value !== undefined)
                out[k] = String(row.value);
        }
    }
    catch { /* metadata table absent on fresh installs — treat as unset */ }
    finally {
        try {
            db?.close();
        }
        catch { /* ignore */ }
    }
    return out;
}
function writeCoreMeta(key, value) {
    let db;
    try {
        db = new DatabaseSync(coreDbPath(), { timeout: 2000 });
        db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(key, value);
    }
    finally {
        try {
            db?.close();
        }
        catch { /* ignore */ }
    }
}
// ── Lane setting resolution (mirror of the daemon's env > DB > default) ──────
const TRUTHY = new Set(['1', 'true', 'TRUE', 'yes', 'YES', 'on']);
/** env (if set, non-empty) > store row > null. */
function resolveSetting(envKey, stored) {
    const env = process.env[envKey];
    if (env !== undefined && env.trim() !== '')
        return { value: env, overridden_by_env: true };
    return { value: stored ?? null, overridden_by_env: false };
}
function asBool(s, dflt) {
    if (s.value === null)
        return dflt;
    return TRUTHY.has(s.value.trim());
}
/** The settings a UI may read/write, with their storage location. */
const SETTING_SPEC = {
    'capture.ide.enabled': { store: 'core', envKey: 'VODOU_CAPTURE_IDE_ENABLED' },
    'capture.ide.sources': { store: 'core', envKey: 'VODOU_CAPTURE_IDE_SOURCES' },
    'capture.ide.since_hours': { store: 'core', envKey: 'VODOU_CAPTURE_IDE_SINCE_HOURS' },
    'capture.ide.interval_secs': { store: 'core', envKey: 'VODOU_CAPTURE_IDE_INTERVAL_SECS' },
    'capture.byok.enabled': { store: 'gateway', envKey: 'VODOU_BYOK_SCOPED_IDS' },
    'capture.web.armed': { store: 'gateway', envKey: 'VODOU_CAPTURE_WEB_ARMED' },
};
function readStored(key) {
    const spec = SETTING_SPEC[key];
    if (!spec)
        return null;
    if (spec.store === 'gateway')
        return getSetting(key);
    return readCoreMeta([key])[key] ?? null;
}
function resolveByKey(key) {
    return resolveSetting(SETTING_SPEC[key].envKey, readStored(key));
}
// ── GET /api/capture/status ───────────────────────────────────────────────────
memoryCaptureRouter.get('/status', (_req, res) => {
    try {
        // Chunk counts + freshness per lane bucket from memory.db (read-only).
        const buckets = {};
        const mem = getMemoryDb();
        if (mem) {
            try {
                const rows = mem.prepare(`SELECT scope, COUNT(*) AS n, MAX(created_at) AS latest
             FROM memory_chunks
            WHERE archived = 0 AND (scope LIKE 'capture:%' OR scope LIKE 'import:%')
            GROUP BY scope`).all();
                for (const r of rows) {
                    const parts = r.scope.split(':');
                    const bucket = parts[0] === 'import' ? 'import' : (parts[1] || 'other');
                    const b = (buckets[bucket] ??= { chunks: 0, last_capture_at: null });
                    b.chunks += r.n;
                    if (r.latest && (!b.last_capture_at || r.latest > b.last_capture_at))
                        b.last_capture_at = r.latest;
                }
            }
            catch { /* fresh memory.db without chunks table */ }
        }
        // BYOK apps seen (distinct app tokens from byok:<app>:<uuid> conversation ids).
        let byokApps = [];
        try {
            const rows = getGatewayDb().prepare(`SELECT DISTINCT substr(id, 6, instr(substr(id, 6), ':') - 1) AS app
           FROM gateway_conversations WHERE id LIKE 'byok:%' LIMIT 50`).all();
            byokApps = rows.map((r) => r.app || '').filter(Boolean);
        }
        catch { /* older schema — apps list is a nicety */ }
        // Daemon heartbeat for the IDE lane (written every cycle by the capture task).
        const hb = readCoreMeta([
            'capture.ide.effective', 'capture.ide.last_run', 'capture.ide.last_new_turns', 'capture.ide.last_error',
        ]);
        const lastRun = Number(hb['capture.ide.last_run'] || 0);
        const ideEnabled = resolveByKey('capture.ide.enabled');
        const ideSources = resolveByKey('capture.ide.sources');
        const byokEnabled = resolveByKey('capture.byok.enabled');
        const webArmed = resolveByKey('capture.web.armed');
        const bridge = bridgeStatus();
        res.json({
            ok: true,
            lanes: {
                ide: {
                    enabled: asBool(ideEnabled, false),
                    overridden_by_env: ideEnabled.overridden_by_env,
                    // Name the variable when it is the thing in charge. A UI that greys a
                    // control out without saying WHY reads as broken; with the key it becomes
                    // an instruction. Only sent when it is actually overriding.
                    env_key: ideEnabled.overridden_by_env ? SETTING_SPEC['capture.ide.enabled'].envKey : null,
                    sources: ideSources.value || 'cursor',
                    // The SOURCES list has its own env var, separate from the enabled flag. The
                    // settings card was gating its dropdown on the enabled lock, so setting only
                    // VODOU_CAPTURE_IDE_SOURCES left an editable control whose writes were
                    // silently ignored, and setting only ..._ENABLED disabled a dropdown that was
                    // still changeable. Both are set in the dev .env, which is why it looked fine.
                    sources_overridden_by_env: ideSources.overridden_by_env,
                    sources_env_key: ideSources.overridden_by_env ? SETTING_SPEC['capture.ide.sources'].envKey : null,
                    // "connected" = the daemon task has actually run recently (< 2 intervals).
                    connected: lastRun > 0 && Date.now() / 1000 - lastRun < 2 * 900 + 120,
                    last_run_at: lastRun > 0 ? new Date(lastRun * 1000).toISOString() : null,
                    last_new_turns: Number(hb['capture.ide.last_new_turns'] || 0),
                    last_error: hb['capture.ide.last_error'] || null,
                    chunks: buckets.ide?.chunks ?? 0,
                    last_capture_at: buckets.ide?.last_capture_at ?? null,
                },
                byok: {
                    // Matches openai-compat.ts: scoped ids ON unless explicitly '0'.
                    enabled: byokEnabled.value === null ? true : byokEnabled.value !== '0',
                    overridden_by_env: byokEnabled.overridden_by_env,
                    env_key: byokEnabled.overridden_by_env ? SETTING_SPEC['capture.byok.enabled'].envKey : null,
                    connected: byokApps.length > 0,
                    apps: byokApps,
                    chunks: buckets.byok?.chunks ?? 0,
                    last_capture_at: buckets.byok?.last_capture_at ?? null,
                },
                web: {
                    enabled: asBool(webArmed, false),
                    overridden_by_env: webArmed.overridden_by_env,
                    env_key: webArmed.overridden_by_env ? SETTING_SPEC['capture.web.armed'].envKey : null,
                    connected: !!bridge.connected,
                    extension_version: bridge.version ?? null,
                    chunks: buckets.web?.chunks ?? 0,
                    last_capture_at: buckets.web?.last_capture_at ?? null,
                },
                manual: {
                    enabled: true, // always available once the extension is installed
                    connected: !!bridge.connected,
                    chunks: buckets.manual?.chunks ?? 0,
                    last_capture_at: buckets.manual?.last_capture_at ?? null,
                },
                import: {
                    enabled: true,
                    connected: true,
                    chunks: buckets.import?.chunks ?? 0,
                    last_capture_at: buckets.import?.last_capture_at ?? null,
                },
            },
        });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// ── GET /api/capture/settings ─────────────────────────────────────────────────
memoryCaptureRouter.get('/settings', (_req, res) => {
    try {
        const out = {};
        for (const key of Object.keys(SETTING_SPEC))
            out[key] = resolveByKey(key);
        res.json({ ok: true, settings: out });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// ── PUT /api/capture/settings ─────────────────────────────────────────────────
// Body: { "capture.ide.enabled": "1", ... } — allowlisted keys only. Env-
// overridden keys are still written (they take effect when the override is
// removed) but the response flags them so the UI can explain.
memoryCaptureRouter.put('/settings', (req, res) => {
    try {
        const body = (req.body ?? {});
        const applied = {};
        for (const [key, raw] of Object.entries(body)) {
            const spec = SETTING_SPEC[key];
            if (!spec) {
                res.status(400).json({ error: `unknown setting: ${key}` });
                return;
            }
            const value = String(raw).slice(0, 200);
            if (spec.store === 'gateway')
                setSetting(key, value);
            else
                writeCoreMeta(key, value);
            if (key === 'capture.web.armed') {
                // Keep the extension's local checkbox in sync (best-effort — the
                // extension also pulls this on bridge_ready).
                pushCaptureArmed(TRUTHY.has(value.trim())).catch(() => { });
            }
            applied[key] = resolveByKey(key);
        }
        res.json({ ok: true, settings: applied });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// ── GET /api/capture/recent ───────────────────────────────────────────────────
// ?limit=50&include=imports — newest capture-scoped chunks (plus imports when asked).
memoryCaptureRouter.get('/recent', (req, res) => {
    try {
        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
        const includeImports = String(req.query.include || '') === 'imports';
        const mem = getMemoryDb();
        if (!mem) {
            res.json({ ok: true, recent: [] });
            return;
        }
        const scopeFilter = includeImports
            ? `(scope LIKE 'capture:%' OR scope LIKE 'import:%')`
            : `scope LIKE 'capture:%'`;
        const rows = mem.prepare(`SELECT id, scope, path, chunk_tag, created_at, substr(text, 1, 300) AS snippet
         FROM memory_chunks
        WHERE archived = 0 AND ${scopeFilter}
        ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(limit);
        res.json({ ok: true, recent: rows });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// ── GET /api/capture/conversations ────────────────────────────────────────────
// The raw captured/imported conversations (ChatGPT/Claude web + IDE + file
// imports) — the source transcripts behind the distilled memories. These were
// removed from the chat dock (they're memory sources, not chats); this is where
// you browse them. ?limit=50&include=imports.
memoryCaptureRouter.get('/conversations', (req, res) => {
    try {
        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
        const includeImports = String(req.query.include || '') === 'imports';
        const srcFilter = includeImports
            ? `(source LIKE 'capture:%' OR source LIKE 'import:%')`
            : `source LIKE 'capture:%'`;
        const rows = getGatewayDb().prepare(`SELECT id, title, source, created_at, updated_at,
              (SELECT COUNT(*) FROM gateway_messages m WHERE m.conversation_id = c.id) AS message_count
         FROM gateway_conversations c
        WHERE deleted_at IS NULL AND ${srcFilter}
        ORDER BY updated_at DESC LIMIT ?`).all(limit);
        res.json({ ok: true, conversations: rows });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// ── GET /api/capture/conversation/:id/transcript ──────────────────────────────
// The original message-by-message transcript of ONE captured conversation.
// Guarded: only capture:%/import:% conversations are readable here, so this
// "capture" surface can never be used to read a private Vodou chat.
memoryCaptureRouter.get('/conversation/:id/transcript', (req, res) => {
    try {
        const id = String(req.params.id || '');
        const db = getGatewayDb();
        const conv = db.prepare(`SELECT id, title, source, created_at FROM gateway_conversations WHERE id = ? AND deleted_at IS NULL`).get(id);
        if (!conv) {
            res.status(404).json({ error: 'not found' });
            return;
        }
        if (!/^(capture:|import:)/.test(conv.source || '')) {
            res.status(403).json({ error: 'not a captured conversation' });
            return;
        }
        const messages = db.prepare(`SELECT role, content, created_at FROM gateway_messages
        WHERE conversation_id = ? ORDER BY id ASC`).all(id);
        res.json({ ok: true, conversation: conv, messages });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// ── POST /api/capture/remember ────────────────────────────────────────────────
// PLAN-MEMORY-FOLLOWS-YOU Lane B — the vodou-memory MCP server's `remember`
// tool. Body: { text, source? }. Flows through the SAME manual-capture lane as
// the right-click floor (capture:manual:<source>, capture trust tier,
// extractor-distilled) — never a direct memory write.
memoryCaptureRouter.post('/remember', async (req, res) => {
    try {
        const body = (req.body ?? {});
        const text = String(body.text || '').trim();
        if (text.length < 2) {
            res.status(400).json({ error: 'text required' });
            return;
        }
        const source = String(body.source || 'mcp').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'mcp';
        const { persistCaptureTurn } = await import('../vbb/bridge.js');
        await persistCaptureTurn({
            lane: 'manual',
            provider: source,
            conversationId: 'remember-' + Date.now().toString(36),
            turns: [{ role: 'user', content: text.slice(0, 100000) }],
        });
        res.json({ ok: true, lane: `capture:manual:${source}` });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// ── POST /api/capture/forget ──────────────────────────────────────────────────
// { chunk_id } → `mem reject --chunk-id` (Rust guards to import:%/capture:%).
memoryCaptureRouter.post('/forget', async (req, res) => {
    const chunkId = String((req.body ?? {}).chunk_id || '').trim();
    // Real ids are `path:line:hash` (e.g. memory/2026-07-12.md:1725:fdb92068).
    // Must not start with `-` (would parse as a clap flag — argv injection).
    if (!/^[A-Za-z0-9][A-Za-z0-9/:_.-]*$/.test(chunkId) || chunkId.length > 300) {
        res.status(400).json({ error: 'invalid chunk_id' });
        return;
    }
    const r = await runCore(['mem', 'reject', '--chunk-id', chunkId, '--json'], { timeout: 30_000 });
    if (r.status !== 0) {
        // On refusal the CLI emits {"ok":false,"error":...} on stdout — surface
        // that message directly rather than nesting JSON-in-JSON.
        let msg = (r.stderr || r.stdout || 'reject failed').trim();
        try {
            msg = JSON.parse(r.stdout).error || msg;
        }
        catch { /* keep raw */ }
        res.status(422).json({ error: msg.slice(0, 400) });
        return;
    }
    try {
        res.json({ ok: true, ...JSON.parse(r.stdout) });
    }
    catch {
        res.json({ ok: true, output: (r.stdout || '').trim() });
    }
});
// ── POST /api/capture/upload ──────────────────────────────────────────────────
// ?source=claude|chatgpt|obsidian|openclaw|hermes|letta|pack&filename=x.zip
// Raw request body streamed straight to disk (application/octet-stream — the
// express.json 10MB limit does not apply), then `mem import <source> <file>`.
const UPLOAD_SOURCES = new Set(['chatgpt', 'claude', 'obsidian', 'openclaw', 'hermes', 'letta', 'pack']);
const UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB hard stop
memoryCaptureRouter.post('/upload', (req, res) => {
    const source = String(req.query.source || '').trim();
    if (!UPLOAD_SOURCES.has(source)) {
        res.status(400).json({ error: `source must be one of: ${[...UPLOAD_SOURCES].join(', ')}` });
        return;
    }
    const rawName = String(req.query.filename || 'upload.bin');
    const safeName = path.basename(rawName).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'upload.bin';
    const dir = path.join(getProjectRoot(), '.vodou', 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${Date.now()}-${safeName}`);
    let bytes = 0;
    let failed = false;
    const out = fs.createWriteStream(dest);
    req.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > UPLOAD_MAX_BYTES && !failed) {
            failed = true;
            out.destroy();
            fs.rm(dest, { force: true }, () => { });
            res.status(413).json({ error: 'upload exceeds 2GB limit' });
            req.destroy();
        }
    });
    req.on('error', () => {
        if (failed)
            return;
        failed = true;
        out.destroy();
        fs.rm(dest, { force: true }, () => { });
    });
    req.pipe(out);
    out.on('finish', async () => {
        if (failed)
            return;
        // Extraction runs on the daemon's background drain — this call just parses
        // + lands the archive, so 10 min covers even very large exports.
        const r = await runCore(['mem', 'import', source, dest, '--extract', 'background'], { timeout: 600_000 });
        // The upload itself is disposable once ingested (gateway.db / memory/ hold
        // the durable copy, import_jobs.origin_path records where it came from).
        if (r.status !== 0) {
            res.status(422).json({ error: (r.stderr || r.stdout || 'import failed').slice(0, 600), file: dest });
            return;
        }
        res.json({ ok: true, source, file: dest, output: (r.stdout || '').trim().slice(0, 2000) });
    });
    out.on('error', (e) => {
        if (failed)
            return;
        failed = true;
        res.status(500).json({ error: e.message });
    });
});
// ── Extension pairing (PLAN-MEMORY-EVERYWHERE-FRONTEND P4) ───────────────────
// The Sources card shows a 6-digit pair code; the extension popup accepts it
// and echoes it in bridge_ready. Enforcement (`bridge_require_token`) is a
// separate switch so existing sideloads keep working until the user opts in
// (env VODOU_VBB_REQUIRE_TOKEN overrides, checked in vbb/bridge.ts).
function ensureBridgeToken() {
    let token = getSetting('bridge_token');
    if (!token) {
        token = String(crypto.randomInt(100000, 1000000));
        setSetting('bridge_token', token);
    }
    return token;
}
// GET /api/capture/pair — the code + enforcement + live connection state.
memoryCaptureRouter.get('/pair', (_req, res) => {
    try {
        const env = process.env.VODOU_VBB_REQUIRE_TOKEN;
        const required = env !== undefined && env.trim() !== ''
            ? env.trim() === '1'
            : getSetting('bridge_require_token') === '1';
        res.json({
            ok: true,
            code: ensureBridgeToken(),
            required,
            required_by_env: env !== undefined && env.trim() !== '',
            connected: !!bridgeStatus().connected,
        });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// POST /api/capture/pair/rotate — mint a new code (existing pairings break on
// their next reconnect and must re-pair).
memoryCaptureRouter.post('/pair/rotate', (_req, res) => {
    try {
        const token = String(crypto.randomInt(100000, 1000000));
        setSetting('bridge_token', token);
        // Rotation invalidates existing pairings — when enforcement is live, apply
        // that NOW instead of at the next incidental reconnect (Chad, 2026-07-30:
        // a rotated code that stays connected looks like rotation did nothing).
        // The kicked extension re-dials, offers its stale code, gets 4403, and its
        // panel shows the pair prompt. With enforcement off there is nothing to
        // enforce, so don't blip the connection for no visible effect.
        const env = process.env.VODOU_VBB_REQUIRE_TOKEN;
        const required = env !== undefined && env.trim() !== ''
            ? env.trim() === '1'
            : getSetting('bridge_require_token') === '1';
        if (required) {
            try {
                disconnectBridge('pair code rotated');
            }
            catch { /* ignore */ }
        }
        res.json({ ok: true, code: token, kicked: required });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// POST /api/capture/pair/require — { required: boolean } toggles enforcement.
memoryCaptureRouter.post('/pair/require', (req, res) => {
    try {
        const required = !!(req.body ?? {}).required;
        if (required)
            ensureBridgeToken(); // never enforce with no code to pair against
        setSetting('bridge_require_token', required ? '1' : '0');
        // Force reconnect so the new policy applies immediately (existing sockets
        // were verified under the old rules).
        try {
            disconnectBridge(required ? 'pairing now required' : 'pairing optional');
        }
        catch { /* ignore */ }
        res.json({ ok: true, required });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// ── shared Rust CLI runner (same pattern as memory-import.ts) ────────────────
function resolveCoreBin() {
    if (process.env.VODOU_CORE_BIN)
        return process.env.VODOU_CORE_BIN;
    const root = getProjectRoot();
    const release = path.join(root, 'vodou-core');
    if (fs.existsSync(release))
        return release;
    const dev = path.join(root, 'target', 'release', 'vodou-core');
    if (fs.existsSync(dev))
        return dev;
    return release;
}
export function runCore(args, opts = {}) {
    return new Promise((resolve) => {
        execFile(resolveCoreBin(), args, { cwd: getProjectRoot(), timeout: opts.timeout ?? 60_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf-8' }, (err, stdout, stderr) => {
            const status = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
            resolve({ status, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        });
    });
}
export function captureLanesForPresence() {
    const hb = readCoreMeta(['capture.ide.last_run']);
    const lastRun = Number(hb['capture.ide.last_run'] || 0);
    const ideEnabled = asBool(resolveByKey('capture.ide.enabled'), false);
    const sourcesRaw = resolveByKey('capture.ide.sources').value || 'cursor';
    const intervalSecs = Number(resolveByKey('capture.ide.interval_secs').value || 900) || 900;
    const nowSecs = Date.now() / 1000;
    return {
        ide: {
            enabled: ideEnabled,
            sources: sourcesRaw.split(',').map((s) => s.trim()).filter(Boolean),
            connected: lastRun > 0 && nowSecs - lastRun < 2 * intervalSecs + 120,
            lastRunAt: lastRun > 0 ? new Date(lastRun * 1000).toISOString() : null,
            lagSeconds: lastRun > 0 ? Math.max(0, Math.round(nowSecs - lastRun)) : null,
        },
        web: { armed: asBool(resolveByKey('capture.web.armed'), false) },
    };
}
