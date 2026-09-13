/**
 * Memory API — browse, read, edit, search memory markdown files
 */
import { sockConnectTarget } from '../cli-portability.js';
import { todayKey, localTime } from '../user-time.js';
import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import net from 'net';
import { DatabaseSync } from 'node:sqlite';
import { getProjectRoot, getMemoryDb } from '../db.js';
const router = Router();
const WORKSPACE_DIR = '.vodou/workspace';
const DAILY_DIR = '.vodou/workspace/memory';
/**
 * Validate that a relative path resolves safely under allowed directories.
 * Returns the absolute path or null if invalid.
 */
function validateMemoryPath(relPath) {
    if (!relPath || typeof relPath !== 'string')
        return null;
    if (!relPath.endsWith('.md'))
        return null;
    const root = getProjectRoot();
    const workspaceAbs = path.resolve(root, WORKSPACE_DIR);
    const resolved = path.resolve(root, relPath);
    // Must be a real subpath of .vodou/workspace/
    if (!resolved.startsWith(workspaceAbs + path.sep) && resolved !== workspaceAbs) {
        return null;
    }
    return resolved;
}
/**
 * Parse ## and ### headings from markdown content
 */
function parseHeadings(content) {
    const headings = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const m2 = lines[i].match(/^##\s+(.+)/);
        if (m2) {
            headings.push({ level: 2, text: m2[1].trim(), line: i + 1 });
            continue;
        }
        const m3 = lines[i].match(/^###\s+(.+)/);
        if (m3) {
            headings.push({ level: 3, text: m3[1].trim(), line: i + 1 });
        }
    }
    return headings;
}
// GET /api/memory/tree — build jsMind-compatible tree
router.get('/tree', async (req, res) => {
    try {
        const root = getProjectRoot();
        const workspacePath = path.join(root, WORKSPACE_DIR);
        const dailyPath = path.join(root, DAILY_DIR);
        const rootNode = {
            id: 'root',
            topic: 'Vodou Memory',
            children: [],
        };
        // --- Workspace files (branch right) ---
        const workspaceBranch = {
            id: 'workspace',
            topic: 'Workspace Files',
            direction: 'right',
            children: [],
        };
        try {
            const entries = await fs.readdir(workspacePath, { withFileTypes: true });
            const mdFiles = entries
                .filter(e => e.isFile() && e.name.endsWith('.md'))
                .sort((a, b) => a.name.localeCompare(b.name));
            for (const entry of mdFiles) {
                const relPath = path.join(WORKSPACE_DIR, entry.name);
                const absPath = path.join(workspacePath, entry.name);
                const fileNode = {
                    id: `ws_${entry.name}`,
                    topic: entry.name.replace(/\.md$/, ''),
                    file_path: relPath, file_type: 'workspace',
                    children: [],
                };
                try {
                    const content = await fs.readFile(absPath, 'utf-8');
                    const headings = parseHeadings(content);
                    let lastH2 = null;
                    for (const h of headings) {
                        const hNode = {
                            id: `ws_${entry.name}_h${h.line}`,
                            topic: h.text,
                            file_path: relPath, file_type: 'workspace', file_line: h.line,
                        };
                        if (h.level === 2) {
                            hNode.children = [];
                            lastH2 = hNode;
                            fileNode.children.push(hNode);
                        }
                        else if (h.level === 3 && lastH2) {
                            lastH2.children.push(hNode);
                        }
                        else {
                            fileNode.children.push(hNode);
                        }
                    }
                }
                catch {
                    // skip unreadable files
                }
                workspaceBranch.children.push(fileNode);
            }
        }
        catch {
            // workspace dir may not exist
        }
        rootNode.children.push(workspaceBranch);
        // --- Daily logs (branch left) ---
        const dailyBranch = {
            id: 'daily',
            topic: 'Daily Logs',
            direction: 'left',
            children: [],
        };
        try {
            const entries = await fs.readdir(dailyPath, { withFileTypes: true });
            const dailyFiles = entries
                .filter(e => e.isFile() && e.name.endsWith('.md'))
                .sort((a, b) => b.name.localeCompare(a.name)); // newest first
            for (const entry of dailyFiles) {
                const relPath = path.join(DAILY_DIR, entry.name);
                const absPath = path.join(dailyPath, entry.name);
                const fileNode = {
                    id: `dl_${entry.name}`,
                    topic: entry.name.replace(/\.md$/, ''),
                    file_path: relPath, file_type: 'daily',
                    children: [],
                };
                try {
                    const content = await fs.readFile(absPath, 'utf-8');
                    const headings = parseHeadings(content);
                    let lastH2 = null;
                    for (const h of headings) {
                        const hNode = {
                            id: `dl_${entry.name}_h${h.line}`,
                            topic: h.text,
                            file_path: relPath, file_type: 'daily', file_line: h.line,
                        };
                        if (h.level === 2) {
                            hNode.children = [];
                            lastH2 = hNode;
                            fileNode.children.push(hNode);
                        }
                        else if (h.level === 3 && lastH2) {
                            lastH2.children.push(hNode);
                        }
                        else {
                            fileNode.children.push(hNode);
                        }
                    }
                }
                catch {
                    // skip unreadable
                }
                dailyBranch.children.push(fileNode);
            }
        }
        catch {
            // daily dir may not exist
        }
        rootNode.children.push(dailyBranch);
        res.json(rootNode);
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// GET /api/memory/file?path=<rel> — read file content
router.get('/file', async (req, res) => {
    try {
        const relPath = req.query.path;
        const absPath = validateMemoryPath(relPath);
        if (!absPath) {
            res.status(403).json({ error: 'Invalid or disallowed path' });
            return;
        }
        // Verify resolved path is truly under workspace
        const realAbs = await fs.realpath(absPath);
        const workspaceReal = await fs.realpath(path.join(getProjectRoot(), WORKSPACE_DIR));
        if (!realAbs.startsWith(workspaceReal + path.sep) && realAbs !== workspaceReal) {
            res.status(403).json({ error: 'Path traversal blocked' });
            return;
        }
        const content = await fs.readFile(absPath, 'utf-8');
        res.type('text/plain').send(content);
    }
    catch (error) {
        if (error?.code === 'ENOENT') {
            res.status(404).json({ error: 'File not found' });
            return;
        }
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// PUT /api/memory/file?path=<rel> — save edited content (with .bak backup)
router.put('/file', async (req, res) => {
    try {
        const relPath = req.query.path;
        const absPath = validateMemoryPath(relPath);
        if (!absPath) {
            res.status(403).json({ error: 'Invalid or disallowed path' });
            return;
        }
        const realAbs = await fs.realpath(absPath);
        const workspaceReal = await fs.realpath(path.join(getProjectRoot(), WORKSPACE_DIR));
        if (!realAbs.startsWith(workspaceReal + path.sep) && realAbs !== workspaceReal) {
            res.status(403).json({ error: 'Path traversal blocked' });
            return;
        }
        const content = typeof req.body === 'string' ? req.body : (req.body?.content ?? '');
        const base = String(req.body?.base_hash ?? '').trim();
        const projectId = String(req.body?.project_id ?? '').trim();
        // ── §4.4 adopt, don't clobber ────────────────────────────────────────────
        //
        // This route used to write a `.bak` and overwrite whatever it was given.
        // For a GENERATED file that is a lie: the daemon re-renders MEMORY.md every
        // 60 s, so the edit was reverted a minute later and the only trace was a
        // `MEMORY.md.bak` sitting in the workspace — the corpse of an edit nobody
        // was told had been discarded. The chip row led straight into it.
        //
        // So for a generated file the edit is adopted as PINS via the daemon (which
        // owns memory.db — lane canon rule 4), and the reply carries a receipt.
        // Untouched lines produce no ops, so this never adopts what it merely showed.
        const baseName = path.basename(realAbs);
        if (baseName === 'MEMORY.md') {
            const resp = await callDaemon('memory_edit', {
                edited: content,
                base_hash: base,
                project_id: projectId || undefined,
                cwd: getProjectRoot(),
            });
            if (resp?.code === 'stale_base') {
                // Never apply a stale diff. Hand back what is current AND keep the
                // user's text — a 409 that loses the edit is just a slower clobber.
                res.status(409).json({
                    error: 'stale_base',
                    message: 'MEMORY.md was re-rendered while you were editing. Re-apply your change to the current content below.',
                    current: resp?.data?.markdown ?? '',
                    base_hash: resp?.data?.base_hash ?? '',
                    your_edit: content,
                    route: 'edit again, or use the Pinned tab for direct control',
                });
                return;
            }
            if (!resp?.ok) {
                res.status(502).json({ error: resp?.error || 'daemon refused the edit', route: 'vodou-core mem edit' });
                return;
            }
            res.json({
                ok: true,
                adopted: true,
                message: resp.data.receipt,
                receipt: resp.data.receipt,
                counts: { added: resp.data.added, removed: resp.data.removed, rejected: resp.data.rejected, moved: resp.data.moved },
                content: resp.data.markdown,
                base_hash: resp.data.base_hash,
            });
            return;
        }
        // Generated, but not diffable: refuse and NAME the real route. A refusal
        // that does not say what to do instead is the same lockout, politely.
        if (baseName === 'TOOLS.md') {
            res.status(409).json({
                error: 'generated',
                message: 'TOOLS.md is generated from the CLI command tree and verified paths. Edit templates/TOOLS.md for the build/restart section.',
                route: 'templates/TOOLS.md',
            });
            return;
        }
        // Hand-authored files keep today's behaviour (with the .bak) until P8
        // retires the last of them.
        try {
            const existing = await fs.readFile(absPath, 'utf-8');
            await fs.writeFile(absPath + '.bak', existing, 'utf-8');
        }
        catch {
            // no existing file to backup
        }
        await fs.writeFile(absPath, content, 'utf-8');
        res.json({ ok: true, message: 'Saved' });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// POST /api/memory/file/preview?path=… {content, base_hash, project_id}
// P2 (PLAN-MEMORY-PAGE-SAYS-WHAT-IT-IS) — what a raw-text save of a generated
// file WOULD do, before it does it: the ops, the receipt, and the typed lines
// the diff cannot see (prose outside a bullet, bullets under four characters).
// Same base-hash guard as the save: a stale preview is a 409 with the current
// content, never a preview of ops that would apply to something else.
router.post('/file/preview', async (req, res) => {
    try {
        const relPath = String(req.query.path ?? '');
        if (path.basename(relPath) !== 'MEMORY.md') {
            res.status(409).json({ error: 'not_diffable', message: 'Only MEMORY.md is edited as pins; TOOLS.md and HEARTBEAT.md have no text edit path.' });
            return;
        }
        const content = typeof req.body === 'string' ? req.body : (req.body?.content ?? '');
        const base = String(req.body?.base_hash ?? '').trim();
        const projectId = String(req.body?.project_id ?? '').trim();
        const resp = await callDaemon('memory_edit', {
            edited: content, base_hash: base, project_id: projectId || undefined, cwd: getProjectRoot(), preview: true,
        });
        if (resp?.code === 'stale_base') {
            res.status(409).json({
                error: 'stale_base',
                message: 'MEMORY.md was re-rendered while you were editing. Re-apply your change to the current content below.',
                current: resp?.data?.markdown ?? '', base_hash: resp?.data?.base_hash ?? '', your_edit: content,
            });
            return;
        }
        if (!resp?.ok) {
            res.status(502).json({ error: resp?.error || 'daemon could not preview' });
            return;
        }
        res.json({
            ok: true, receipt: resp.data.receipt, ops: resp.data.ops ?? [], ignored: resp.data.ignored ?? [],
            counts: { added: resp.data.added, removed: resp.data.removed, rejected: resp.data.rejected, moved: resp.data.moved },
            base_hash: resp.data.base_hash,
        });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// GET /api/memory/render — the LIVE rendering plus the token needed to edit it.
//
// §4.3/Q4: the file on disk is the GLOBAL snapshot; a session receives a
// per-project rendering. The viewer must display, and diff against, the SAME
// one — if it shows the file and hashes the render, every save is a 409. So the
// viewer asks for this, not for MEMORY.md, and `base_hash` comes back in the
// same response that produced the markdown (fetching it separately would race
// the 60 s tick between the two calls).
router.get('/render', async (req, res) => {
    try {
        const projectId = String(req.query.project_id ?? '').trim();
        const resp = await callDaemon('memory_render', {
            project_id: projectId || undefined,
            cwd: getProjectRoot(),
            host: 'console', // P5/Q3 — a named, first-party surface
        });
        if (!resp?.ok) {
            res.status(502).json({ error: resp?.error || 'daemon did not render' });
            return;
        }
        res.json({
            markdown: resp.data.markdown,
            base_hash: resp.data.base_hash,
            project_id: resp.data.project_id ?? null,
            project_name: resp.data.project_name ?? null,
            counts: { pinned: resp.data.pinned, fresh: resp.data.fresh, project: resp.data.project, global: resp.data.global },
            rendered_at: resp.data.rendered_at,
            chars: resp.data.chars,
            // P2 — per-line provenance ({chunk_id, section, text, pinned}) so the
            // viewer can offer the right action on each line instead of an Edit button.
            bullets: resp.data.bullets ?? [],
        });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// GET /api/memory/search?q=<term> — full-text search across memory files
router.get('/search', async (req, res) => {
    try {
        const query = (req.query.q || '').trim();
        if (!query) {
            res.json([]);
            return;
        }
        const root = getProjectRoot();
        const workspacePath = path.join(root, WORKSPACE_DIR);
        const queryLower = query.toLowerCase();
        const results = [];
        async function searchDir(dir, type, relBase) {
            try {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        await searchDir(path.join(dir, entry.name), entry.name === 'memory' ? 'daily' : type, path.join(relBase, entry.name));
                        continue;
                    }
                    if (!entry.isFile() || !entry.name.endsWith('.md'))
                        continue;
                    const filePath = path.join(dir, entry.name);
                    const relPath = path.join(relBase, entry.name);
                    try {
                        const content = await fs.readFile(filePath, 'utf-8');
                        const lines = content.split('\n');
                        let currentHeading = '';
                        for (let i = 0; i < lines.length; i++) {
                            const headingMatch = lines[i].match(/^#{1,3}\s+(.+)/);
                            if (headingMatch) {
                                currentHeading = headingMatch[1].trim();
                            }
                            if (lines[i].toLowerCase().includes(queryLower)) {
                                results.push({
                                    path: relPath,
                                    type,
                                    file: entry.name,
                                    line: i + 1,
                                    text: lines[i].trim().substring(0, 200),
                                    heading: currentHeading,
                                });
                            }
                        }
                    }
                    catch {
                        // skip unreadable
                    }
                }
            }
            catch {
                // dir doesn't exist
            }
        }
        await searchDir(workspacePath, 'workspace', WORKSPACE_DIR);
        // Cap results
        res.json(results.slice(0, 100));
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// GET /api/memory/timeline — daily logs with highlights for timeline view
router.get('/timeline', async (req, res) => {
    try {
        const root = getProjectRoot();
        const dailyPath = path.join(root, DAILY_DIR);
        const workspacePath = path.join(root, WORKSPACE_DIR);
        const days = [];
        // Daily logs — strict YYYY-MM-DD.md filter. Janitor reports moved to
        // .vodou/workspace/janitor/ in v0.5.86, so the previous janitor-*.md
        // contamination is gone for fresh installs. This regex remains as a
        // backstop against future stray files (.bak files, archived folder names,
        // etc.) — the frontend builds the date label by parsing the filename as
        // a Date, and anything off-format renders "Invalid Date, Invalid Date".
        const DAILY_FILENAME = /^\d{4}-\d{2}-\d{2}\.md$/;
        try {
            const entries = await fs.readdir(dailyPath, { withFileTypes: true });
            const dailyFiles = entries
                .filter(e => e.isFile() && DAILY_FILENAME.test(e.name))
                .sort((a, b) => b.name.localeCompare(a.name));
            for (const entry of dailyFiles) {
                const absPath = path.join(dailyPath, entry.name);
                const relPath = path.join(DAILY_DIR, entry.name);
                try {
                    const content = await fs.readFile(absPath, 'utf-8');
                    const lines = content.split('\n');
                    const stat = await fs.stat(absPath);
                    const headings = [];
                    const highlights = [];
                    for (const line of lines) {
                        const hMatch = line.match(/^##\s+(.+)/);
                        if (hMatch)
                            headings.push(hMatch[1].trim());
                        // Extract bullet highlights (first 8 meaningful bullets)
                        if (highlights.length < 8) {
                            const bMatch = line.match(/^[-*]\s+(.{10,})/);
                            if (bMatch) {
                                highlights.push(bMatch[1].trim().substring(0, 160));
                            }
                        }
                    }
                    days.push({
                        date: entry.name.replace(/\.md$/, ''),
                        path: relPath,
                        size: stat.size,
                        headings,
                        highlights,
                        lineCount: lines.length,
                    });
                }
                catch {
                    // skip
                }
            }
        }
        catch {
            // no daily dir
        }
        // Workspace file summaries (not timeline entries, but context)
        // P9 — the chip row must say which files a session actually reads and which
        // are generated, or a chip is an invitation to edit a file nothing reads.
        // Both facts come from the ARTIFACTS themselves, so there is no fourth copy
        // of FILES_ORDER in TypeScript: "injected" is whichever `### NAME.md`
        // headers the composed packet carries; "generated" is a renderer banner on
        // the file. A file that is neither is retired.
        let injectedNames = new Set();
        try {
            const cache = await fs.readFile(path.join(getProjectRoot(), WORKSPACE_DIR, '.context_cache'), 'utf-8');
            for (const m of cache.matchAll(/^### ([A-Za-z_][A-Za-z0-9_.-]*\.md)$/gm))
                injectedNames.add(m[1]);
        }
        catch { /* no cache yet — nothing is known to be injected */ }
        const workspaceFiles = [];
        try {
            const entries = await fs.readdir(workspacePath, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isFile() || !entry.name.endsWith('.md'))
                    continue;
                const absPath = path.join(workspacePath, entry.name);
                try {
                    const stat = await fs.stat(absPath);
                    // First few lines only: a renderer banner is always within the top two.
                    let head = '';
                    try {
                        head = (await fs.readFile(absPath, 'utf-8')).slice(0, 400);
                    }
                    catch { /* unreadable → not generated */ }
                    workspaceFiles.push({
                        name: entry.name,
                        path: path.join(WORKSPACE_DIR, entry.name),
                        size: stat.size,
                        modified: stat.mtime.toISOString(),
                        injected: injectedNames.has(entry.name),
                        generated: /^(?:[^\n]*\n){0,2}\s*<!-- rendered by /.test(head),
                        retired: !injectedNames.has(entry.name) && !/^(?:[^\n]*\n){0,2}\s*<!-- rendered by /.test(head),
                        // PLAN-MEMORY-PAGE-SAYS-WHAT-IT-IS P4 — the renderer's clock, so the chip
                        // can go amber/red on the same thresholds `vodou-core flows --flow 18`
                        // uses (2x the bound is a missed tick, 10x is a renderer that stopped).
                        freshness_secs: /^(?:[^\n]*\n){0,2}\s*<!-- rendered by /.test(head) ? 60 : undefined,
                    });
                }
                catch {
                    // skip
                }
            }
        }
        catch {
            // skip
        }
        res.json({ days, workspaceFiles });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// POST /api/memory — pin content to today's daily log
router.post('/', async (req, res) => {
    try {
        const { content, source } = req.body;
        if (!content || typeof content !== 'string') {
            res.status(400).json({ error: 'content is required' });
            return;
        }
        const root = getProjectRoot();
        const dailyPath = path.join(root, DAILY_DIR);
        // Ensure daily directory exists
        await fs.mkdir(dailyPath, { recursive: true });
        // Today's log file — the PERSON's day, matching every other daily-file
        // writer including the engine's (time canon, Bundle A).
        const today = todayKey();
        const filePath = path.join(dailyPath, `${today}.md`);
        // Build the pin entry
        // The heading must be on the SAME clock as the filename two lines above.
        // `toLocaleTimeString` with no `timeZone` renders in the process's zone, so
        // a pin at 11pm Detroit landed in that day's file headed 03:00.
        const time = localTime();
        const entry = `\n\n## Pinned (${time})\n\n${content.trim()}\n`;
        // Append to today's log (creates if doesn't exist)
        await fs.appendFile(filePath, entry, 'utf-8');
        console.error(`[Memory] Pinned ${content.length} chars to ${filePath}`);
        res.json({ ok: true, path: filePath, date: today });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// ---------------------------------------------------------------------------
// Phase B (PLAN-UNIFIED-SCOPED-CONVERSATIONS) — scope-aware DB views
// ---------------------------------------------------------------------------
// GET /api/memory/scopes — distinct scopes present in memory_chunks (with counts)
router.get('/scopes', async (_req, res) => {
    try {
        const db = getMemoryDb();
        if (!db) {
            res.json([]);
            return;
        }
        const rows = db.prepare("SELECT COALESCE(scope, 'web') AS scope, COUNT(*) AS count " +
            "FROM memory_chunks " +
            "WHERE archived = 0 OR archived IS NULL " +
            "GROUP BY COALESCE(scope, 'web') " +
            "ORDER BY count DESC").all();
        res.json(rows);
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// GET /api/memory/chunks?scope=<raw>&limit=<n> — recent memory chunks filtered by scope
// Used by Memory page filter and Skills page per-persona "what does this agent remember?" panel.
router.get('/chunks', async (req, res) => {
    try {
        const db = getMemoryDb();
        if (!db) {
            res.json([]);
            return;
        }
        const scope = (req.query.scope || '').trim();
        const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || '20', 10) || 20));
        let sql = "SELECT id, path, text, COALESCE(scope, 'web') AS scope, chunk_tag, created_at, COALESCE(pinned, 0) AS pinned " +
            "FROM memory_chunks " +
            "WHERE (archived = 0 OR archived IS NULL) " +
            "AND text NOT LIKE '[SUPERSEDED]%' " +
            "AND text NOT LIKE '- [SUPERSEDED]%' ";
        const params = [];
        if (scope && scope !== 'all') {
            sql += "AND COALESCE(scope, 'web') = ? ";
            params.push(scope);
        }
        sql += "ORDER BY created_at DESC LIMIT ?";
        params.push(limit);
        const rows = db.prepare(sql).all(...params);
        res.json(rows);
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// PLAN-MEMORY-VISIBILITY-UI Phase E (upgrade) — persistent pin toggle.
// Real pins set memory_chunks.pinned = 1; search.rs adds a +VODOU_MEMORY_PIN_BOOST
// (default 1.0) bonus so pinned chunks always surface on relevant queries.
// memory.db is opened read-only by getMemoryDb(); we use a short-lived RW handle.
function withWriteableMemoryDb(fn) {
    const memPath = path.join(getProjectRoot(), 'memory.db');
    const db = new DatabaseSync(memPath, { timeout: 5000 });
    try {
        return fn(db);
    }
    finally {
        try {
            db.close();
        }
        catch { /* noop */ }
    }
}
// chunk_id contains slashes (e.g. `memory/2026-04-28.md:169:abc123`) so we use a
// query param instead of a path param — Express only matches one path segment per :id.
// Path: POST /api/memory/pin?id=<chunk_id>   |   DELETE /api/memory/pin?id=<chunk_id>
router.post('/pin', async (req, res) => {
    try {
        const id = (req.query.id || '').trim();
        // §4.5.1 — create-from-text. Until now this route could ONLY flip
        // `pinned = 1` on a chunk that already existed, so the Console literally
        // could not do what `mem pin --text --section` does from the CLI. That was
        // the raw capability gap under every other hatch in this phase. Routed
        // through the daemon so pin creation stays in one implementation
        // (embedding, tag mapping, id-from-text) rather than a second one here.
        const text = String(req.body?.text ?? '').trim();
        if (!id && text) {
            const section = String(req.body?.section ?? 'Notes').trim() || 'Notes';
            const projectId = String(req.body?.project_id ?? '').trim();
            const resp = await callDaemon('memory_pin_text', { text, section, project_id: projectId || undefined });
            if (!resp?.ok) {
                res.status(502).json({ error: resp?.error || 'daemon refused the pin' });
                return;
            }
            res.status(201).json({ ok: true, id: resp.data?.id, section, text, created: true });
            return;
        }
        if (!id) {
            res.status(400).json({ error: 'missing ?id query param (or a {text, section} body to create one)' });
            return;
        }
        const result = withWriteableMemoryDb((db) => {
            const r = db.prepare("UPDATE memory_chunks SET pinned = 1 WHERE id = ?").run(id);
            return { changes: r.changes };
        });
        if (!result || result.changes === 0) {
            res.status(404).json({ error: 'chunk not found', id });
            return;
        }
        res.json({ ok: true, id, pinned: true });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
router.delete('/pin', (req, res) => {
    try {
        const id = (req.query.id || '').trim();
        if (!id) {
            res.status(400).json({ error: 'missing ?id query param' });
            return;
        }
        const result = withWriteableMemoryDb((db) => {
            const r = db.prepare("UPDATE memory_chunks SET pinned = 0 WHERE id = ?").run(id);
            return { changes: r.changes };
        });
        if (!result || result.changes === 0) {
            res.status(404).json({ error: 'chunk not found', id });
            return;
        }
        res.json({ ok: true, id, pinned: false });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// GET /api/memory/pinned — list all pinned chunks (for a future "Pinned" tab).
router.get('/pinned', (_req, res) => {
    try {
        const db = getMemoryDb();
        if (!db) {
            res.json([]);
            return;
        }
        const rows = db.prepare("SELECT id, path, text, COALESCE(scope, 'web') AS scope, chunk_tag, created_at, pinned " +
            "FROM memory_chunks WHERE pinned = 1 ORDER BY created_at DESC").all();
        res.json(rows);
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// PLAN-PEOPLE-PAGES P0 — the People list and one entity's page.
//
// Both are ONE Rust function each (`memory::entities::ranked` / `::page`),
// reached through the daemon socket. The gateway does not open memory.db for
// these on purpose: the daemon owns the query, the CLI (`mem entities page`)
// and the MCP tool (`vc_entities_lookup`) call the same function, and a
// second spelling of the join in TypeScript is exactly the drift the v1 plan
// was built on (it had the join wrong). Lane canon rule 4: ask the owner.
router.get('/entities', async (req, res) => {
    const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit ?? '100'), 10) || 100));
    const kinds = String(req.query.kinds ?? '')
        .split(',').map((k) => k.trim()).filter(Boolean);
    const r = await callDaemon('entities_ranked', { limit, kinds });
    if (!r || r.ok !== true) {
        res.status(503).json({ error: r?.error || 'daemon unavailable', entities: [] });
        return;
    }
    res.json(r.data);
});
router.get('/entities/:id', async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ error: 'entity id must be a positive integer' });
        return;
    }
    const r = await callDaemon('entity_page', { id });
    if (!r || r.ok !== true) {
        const notFound = typeof r?.error === 'string' && /no entity/i.test(r.error);
        res.status(notFound ? 404 : 503).json({ error: r?.error || 'daemon unavailable' });
        return;
    }
    res.json(r.data);
});
// PLAN-MEMORY-VISIBILITY-UI Phase B.1 — live ranked chunk search.
// Hits the daemon socket `cmd:'search'` so the Memory page UI can run the
// FULL ranking pipeline (vector + FTS + RRF + scope boost + reranker + tag bias)
// per keystroke, with score_breakdown attached to each result.
/// PLAN-CONTEXT-THAT-MAINTAINS-ITSELF §4.4 — one generic daemon round trip.
/// `callDaemonSearch` below is the same shape hard-coded to one verb; edit-to-pin
/// needs the full envelope back (including the `stale_base` code), so this
/// returns the raw response instead of digging a field out of it.
function callDaemon(cmd, payload, timeoutMs = 15000) {
    const sockPath = path.join(getProjectRoot(), '.vodou', 'daemon.sock');
    const request = JSON.stringify({ cmd, payload }) + '\n';
    return new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) {
            settled = true;
            resolve(v);
        } };
        const c = net.createConnection({ path: sockConnectTarget(sockPath) }, () => {
            // `end(payload)` rather than write-then-end: an edit carries the whole
            // rendered MEMORY.md (8 KB+), `write` can return false under backpressure,
            // and the separate `end()` then raced it into EPIPE. Measured, not
            // theorised — the first live edit failed exactly this way.
            c.end(request);
        });
        c.setTimeout(timeoutMs);
        let data = '';
        c.on('data', (b) => { data += b.toString(); });
        const finish = () => {
            try {
                done(JSON.parse(data.trim()));
            }
            catch {
                done({ ok: false, error: 'daemon returned unparseable JSON' });
            }
        };
        c.on('end', finish);
        c.on('close', finish);
        // A degraded daemon must not read as "your edit was saved".
        c.on('error', (e) => done({ ok: false, error: `daemon unreachable: ${e.message}` }));
        c.on('timeout', () => { try {
            c.destroy();
        }
        catch { /* noop */ } done({ ok: false, error: 'daemon timed out' }); });
    });
}
function callDaemonSearch(query, scope, top_k, fast = true) {
    const sockPath = path.join(getProjectRoot(), '.vodou', 'daemon.sock');
    const payload = { query, top_k, fast };
    if (scope)
        payload.scope = scope;
    const request = JSON.stringify({ cmd: 'search', payload }) + '\n';
    return new Promise((resolve) => {
        const c = net.createConnection({ path: sockConnectTarget(sockPath) }, () => {
            c.write(request);
            c.end();
        });
        c.setTimeout(5000);
        let data = '';
        c.on('data', (b) => { data += b.toString(); });
        c.on('end', () => {
            try {
                const resp = JSON.parse(data.trim());
                resolve(resp?.data?.results ?? []);
            }
            catch {
                resolve([]);
            }
        });
        c.on('error', () => resolve([]));
        c.on('timeout', () => { try {
            c.destroy();
        }
        catch { /* noop */ } resolve([]); });
    });
}
router.get('/search-chunks', async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (!q) {
            res.json({ results: [] });
            return;
        }
        const scope = (req.query.scope || '').trim() || null;
        const top_k = Math.max(1, Math.min(50, parseInt(req.query.top_k || '10', 10) || 10));
        const tagFilter = (req.query.tag || '').trim().toUpperCase() || null;
        const since = (req.query.since || '').trim() || null; // ISO date
        let results = await callDaemonSearch(q, scope, top_k);
        // Cheap in-process post-filter for tag and date — small result set (≤50).
        if (tagFilter) {
            const wanted = tagFilter.split(',').map(t => t.trim()).filter(Boolean);
            results = results.filter(r => r.chunk_tag && wanted.includes(String(r.chunk_tag).toUpperCase()));
        }
        if (since) {
            results = results.filter(r => (r.created_at || '') >= since);
        }
        res.json({ query: q, scope, results });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// PLAN-RESEARCH-MEMORY-TAG §99.1 — tag-distribution telemetry.
// GET /api/memory/tag-distribution?days=7 — counts per chunk_tag over a window.
// Used by the Memory page UI to surface drift (e.g. [RESEARCH] catch-all overuse).
router.get('/tag-distribution', async (req, res) => {
    try {
        const db = getMemoryDb();
        if (!db) {
            res.json({ days: 0, total: 0, tags: [] });
            return;
        }
        const days = Math.max(1, Math.min(365, parseInt(req.query.days || '7', 10) || 7));
        const rows = db.prepare("SELECT COALESCE(chunk_tag, 'UNTAGGED') AS tag, COUNT(*) AS count " +
            "FROM memory_chunks " +
            "WHERE (archived = 0 OR archived IS NULL) " +
            "AND text NOT LIKE '[SUPERSEDED]%' " +
            "AND text NOT LIKE '- [SUPERSEDED]%' " +
            "AND created_at >= datetime('now', ?) " +
            "GROUP BY COALESCE(chunk_tag, 'UNTAGGED') " +
            "ORDER BY count DESC").all(`-${days} days`);
        const total = rows.reduce((s, r) => s + r.count, 0);
        const tags = rows.map(r => ({
            tag: r.tag,
            count: r.count,
            pct: total > 0 ? Math.round((r.count / total) * 1000) / 10 : 0,
        }));
        res.json({ days, total, tags });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
export { router as memoryRouter };
