/**
 * Skills API — list, detail, toggle active, get/put content
 */
import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { getDb, getProjectRoot } from '../db.js';
const router = Router();
let serverNamesCache = null;
/** Auto-detect required_tools by scanning skill file content for known server names.
 *  Guarded against false-positives from English prose:
 *   - Only match server names that are "distinctive": contain a hyphen, uppercase,
 *     or digit — this excludes common English words like "exa" (matches "Example"),
 *     "linear" ("linear path"), "slack" ("take up the slack"), etc.
 *   - Match on word boundaries, not raw substring.
 *   - Only scan the Tools / Required section / fenced code blocks of the skill
 *     (explicit author intent), not prose.
 *  Author can always override by declaring `required_tools:` in frontmatter.
 */
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function isDistinctiveServerName(name) {
    // Ambiguous short/lowercase names that collide with English prose are skipped.
    // They must be declared explicitly in skill frontmatter instead.
    return /[-_0-9]/.test(name) || /[A-Z]/.test(name);
}
function extractRequiredSections(content) {
    // Prefer content under "## Tools", "## Required Tools", "## Servers"
    // headings, plus any fenced code blocks. Falls back to full content if none.
    const sections = [];
    const headingMatch = content.match(/^#{1,6}\s+(?:Required\s+)?(?:Tools|Servers|MCP)[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s|\n*$)/gim);
    if (headingMatch)
        sections.push(...headingMatch);
    const codeFences = content.match(/```[\s\S]*?```/g);
    if (codeFences)
        sections.push(...codeFences);
    return sections.length > 0 ? sections.join('\n\n') : '';
}
async function backfillRequiredTools(db) {
    try {
        if (!serverNamesCache) {
            const servers = db.prepare('SELECT name FROM mcp_servers WHERE active = 1').all();
            serverNamesCache = servers.map(s => s.name);
        }
        if (serverNamesCache.length === 0)
            return;
        // Pre-filter out ambiguous names once per refresh.
        const candidates = serverNamesCache.filter(isDistinctiveServerName);
        if (candidates.length === 0)
            return;
        const skills = db.prepare("SELECT id, name, file_path FROM skills_registry WHERE required_tools = '[]' OR required_tools IS NULL").all();
        if (skills.length === 0)
            return;
        const update = db.prepare('UPDATE skills_registry SET required_tools = ? WHERE id = ?');
        for (const skill of skills) {
            try {
                const fullPath = resolveSkillPath(skill.file_path);
                let content;
                try {
                    content = await fs.readFile(fullPath, 'utf-8');
                }
                catch {
                    const fallback = resolveSkillPathFallback(skill.file_path);
                    if (fallback) {
                        try {
                            content = await fs.readFile(fallback, 'utf-8');
                        }
                        catch {
                            continue;
                        }
                    }
                    else
                        continue;
                }
                // Prefer explicit Tools/Required sections or fenced code; fall back to
                // full content only if the skill has no structured tools section.
                const haystack = extractRequiredSections(content) || content;
                const matched = candidates.filter(name => {
                    const re = new RegExp(`\\b${escapeRegExp(name)}\\b`);
                    return re.test(haystack);
                });
                if (matched.length > 0) {
                    update.run(JSON.stringify(matched), skill.id);
                }
            }
            catch {
                // Skip individual skill errors
            }
        }
    }
    catch {
        // Non-critical — don't break the API
    }
}
let backfillDone = false;
let startupSyncDone = false;
/** Parse YAML frontmatter from SKILL.md content */
function parseSkillFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match)
        return {};
    const yaml = match[1];
    const get = (key) => {
        const m = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
        return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
    };
    return { name: get('name'), description: get('description'), version: get('version'), kind: get('kind') };
}
/**
 * Derive a `source` label for the UI from the relative directory_path.
 * Maps the top-level dir under skills/ to one of:
 *   built-in | catalog | imported | forked | mine
 */
function deriveSkillSource(dirPath) {
    if (!dirPath)
        return 'built-in';
    const top = dirPath.split(/[\\/]/)[0] || '';
    if (top === 'catalog')
        return 'catalog';
    if (top === 'imported' || top === 'installed')
        return 'imported';
    if (top === 'forks')
        return 'forked';
    if (top === 'my-skills')
        return 'mine';
    return 'built-in';
}
/**
 * Guarded one-shot migration: add `kind` column to skills_registry if missing.
 * Safe to call repeatedly. Owned by vodou-core.db (Rust-side CREATE), but
 * gateway can ALTER without rebuilding the binary.
 */
function ensureKindColumn(db) {
    try {
        db.prepare('SELECT kind FROM skills_registry LIMIT 0').get();
    }
    catch {
        try {
            db.exec('ALTER TABLE skills_registry ADD COLUMN kind TEXT');
            console.error('[Skills] migration: added skills_registry.kind column');
        }
        catch (e) {
            console.error('[Skills] migration: failed to add kind column:', e);
        }
    }
}
/** Recursively find all SKILL.md files under a directory */
async function findSkillFiles(dir) {
    const results = [];
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...await findSkillFiles(fullPath));
            }
            else if (entry.name === 'SKILL.md') {
                results.push(fullPath);
            }
        }
    }
    catch { /* ignore permission errors */ }
    return results;
}
/**
 * Scan the skills/ directory and auto-register any SKILL.md files not yet in skills_registry.
 * Safe to call multiple times — skips skills that already have a DB record.
 * Exported so index.ts can call it at startup.
 */
export async function syncSkillsFromFilesystem(opts = {}) {
    // The startupSyncDone guard makes the boot-time call cheap. Mutating endpoints
    // (install/uninstall/import/fork/update) must pass {force:true} to actually
    // re-scan disk and pick up catalog/imported/forked skills.
    if (startupSyncDone && !opts.force)
        return;
    startupSyncDone = true;
    try {
        const db = getDb();
        ensureKindColumn(db);
        const root = getProjectRoot();
        const skillsDir = path.join(root, 'skills');
        const skillFiles = await findSkillFiles(skillsDir);
        if (skillFiles.length === 0)
            return;
        const insert = db.prepare(`INSERT OR IGNORE INTO skills_registry
       (name, description, version, file_path, directory_path, required_tools, metadata, is_active, last_scanned, created_at, updated_at, kind)
       VALUES (?, ?, ?, ?, ?, '[]', '{}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`);
        // Backfill: existing rows that pre-date the kind column will get it on next sync.
        const updateKind = db.prepare(`UPDATE skills_registry SET kind = ? WHERE name = ? AND (kind IS NULL OR kind = '')`);
        let registered = 0;
        const liveNames = [];
        for (const filePath of skillFiles) {
            try {
                const content = await fs.readFile(filePath, 'utf-8');
                const meta = parseSkillFrontmatter(content);
                if (!meta.name)
                    continue;
                const relFilePath = path.relative(path.join(root, 'skills'), filePath);
                const relDirPath = path.dirname(relFilePath);
                const kindValue = meta.kind || null;
                const result = insert.run(meta.name, meta.description || `Skill: ${meta.name}`, meta.version || '1.0.0', relFilePath, relDirPath, kindValue);
                if (result.changes > 0)
                    registered++;
                if (kindValue)
                    updateKind.run(kindValue, meta.name);
                liveNames.push(meta.name);
            }
            catch { /* skip individual failures */ }
        }
        // Prune zombie rows: skills_registry entries whose SKILL.md is no longer on disk.
        // This catches skills that were archived/deleted outside the gateway's lifecycle
        // (manual rm, partial uninstall, archive moves) so the UI doesn't blow up trying
        // to load missing files.
        let pruned = 0;
        if (liveNames.length > 0) {
            const placeholders = liveNames.map(() => '?').join(',');
            const r = db.prepare(`DELETE FROM skills_registry WHERE name NOT IN (${placeholders})`).run(...liveNames);
            pruned = r.changes || 0;
        }
        if (registered > 0) {
            console.error(`[Skills] Auto-registered ${registered} skill(s) from filesystem`);
        }
        if (pruned > 0) {
            console.error(`[Skills] Pruned ${pruned} stale skills_registry row(s) (file no longer on disk)`);
        }
    }
    catch (err) {
        console.error('[Skills] Startup filesystem sync error:', err);
    }
}
function resolveSkillPath(filePath) {
    const root = getProjectRoot();
    if (path.isAbsolute(filePath))
        return filePath;
    return path.join(root, 'skills', filePath);
}
/** When DB has absolute path but file is missing (e.g. different env), try project root + skills + suffix. */
function resolveSkillPathFallback(filePath) {
    if (!path.isAbsolute(filePath))
        return null;
    const match = filePath.match(/[/\\]skills[/\\](.+)$/);
    if (!match)
        return null;
    return path.join(getProjectRoot(), 'skills', match[1]);
}
// GET /api/skills — list all skills
router.get('/', async (req, res) => {
    try {
        const db = getDb();
        // One-time backfill of required_tools from skill file content
        if (!backfillDone) {
            backfillDone = true;
            await backfillRequiredTools(db);
        }
        // Make sure the kind column exists before SELECTing it (one-shot, idempotent).
        ensureKindColumn(db);
        // Optional filter: ?active=1 or ?active=0
        const activeFilter = req.query.active;
        let query = 'SELECT id, name, description, version, file_path, directory_path, required_tools, metadata, is_active, last_scanned, created_at, kind FROM skills_registry';
        const params = [];
        if (activeFilter !== undefined) {
            query += ' WHERE is_active = ?';
            params.push(activeFilter === '1' ? 1 : 0);
        }
        query += ' ORDER BY is_active DESC, name';
        const skills = db.prepare(query).all(...params);
        // Add trigger phrase + derived source for each skill (used by Run button + UI badges)
        const triggerStmt = db.prepare("SELECT keyword FROM intent_mappings WHERE tool_name = 'vc_load_skill' AND keyword LIKE ? ORDER BY LENGTH(keyword) LIMIT 1");
        for (const skill of skills) {
            // Match skill name without oi- prefix, with dashes as wildcards
            const pattern = '%' + skill.name.replace(/^oi-/, '').replace(/-/g, '%') + '%';
            const row = triggerStmt.get(pattern);
            skill.trigger_phrase = row?.keyword || skill.name;
            skill.source = deriveSkillSource(skill.directory_path);
        }
        res.json(skills);
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// GET /api/skills/health — check skill dependency health (must be before /:name)
router.get('/health', (req, res) => {
    try {
        const db = getDb();
        const activeSkills = db.prepare("SELECT name, required_tools FROM skills_registry WHERE is_active = 1 AND required_tools IS NOT NULL AND required_tools != '[]'").all();
        const activeServers = db.prepare('SELECT name FROM mcp_servers WHERE active = 1').all();
        const activeServerNames = new Set(activeServers.map(s => s.name));
        const healthy = [];
        const broken = [];
        for (const skill of activeSkills) {
            let servers = [];
            try {
                servers = JSON.parse(skill.required_tools);
            }
            catch {
                continue;
            }
            if (!Array.isArray(servers) || servers.length === 0)
                continue;
            const missing = servers.filter(s => !activeServerNames.has(s));
            if (missing.length === 0) {
                healthy.push({ name: skill.name, servers });
            }
            else {
                broken.push({ name: skill.name, servers_needed: servers, servers_missing: missing });
            }
        }
        res.json({ healthy, broken });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// GET /api/skills/templates — list pre-built skill templates
router.get('/templates', async (_req, res) => {
    try {
        const templatesDir = path.join(getProjectRoot(), 'skills', 'templates');
        const entries = await fs.readdir(templatesDir, { withFileTypes: true }).catch(() => []);
        const templates = [];
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const skillPath = path.join(templatesDir, entry.name, 'SKILL.md');
            try {
                const content = await fs.readFile(skillPath, 'utf-8');
                // Parse frontmatter
                const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
                let name = entry.name;
                let description = '';
                if (fmMatch) {
                    const nameMatch = fmMatch[1].match(/name:\s*(.+)/);
                    const descMatch = fmMatch[1].match(/description:\s*(.+)/);
                    if (nameMatch)
                        name = nameMatch[1].trim();
                    if (descMatch)
                        description = descMatch[1].trim();
                }
                templates.push({ id: entry.name, name, description, file: skillPath });
            }
            catch { /* skip invalid */ }
        }
        res.json(templates);
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// GET /api/skills/available-tools — list MCP tools available for skill building
// ?schema=true includes input_schema for building arg forms in the visual builder
router.get('/available-tools', async (req, res) => {
    try {
        const db = getDb();
        const includeSchema = req.query.schema === 'true';
        const cols = includeSchema
            ? 'ms.name, ms.description, t.name as tool_name, t.description as tool_desc, t.input_schema'
            : 'ms.name, ms.description, t.name as tool_name, t.description as tool_desc';
        const servers = db.prepare(`SELECT ${cols} FROM mcp_servers ms JOIN tools t ON ms.id = t.server_id WHERE ms.active = 1 ORDER BY ms.name, t.name`).all();
        // Group by server
        const grouped = {};
        for (const row of servers) {
            if (!grouped[row.name]) {
                grouped[row.name] = { description: row.description || '', tools: [] };
            }
            const tool = { name: row.tool_name, description: row.tool_desc || '' };
            if (includeSchema && row.input_schema) {
                try {
                    tool.input_schema = JSON.parse(row.input_schema);
                }
                catch { }
            }
            grouped[row.name].tools.push(tool);
        }
        res.json(grouped);
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// POST /api/skills/generate — generate a skill with AGENT_ACTIONS from structured input
router.post('/generate', async (req, res) => {
    try {
        const { name, description, triggers, steps } = req.body;
        if (!name || !steps || !Array.isArray(steps)) {
            res.status(400).json({ error: 'name, description, and steps[] are required' });
            return;
        }
        // Build AGENT_ACTIONS JSON
        const actionSteps = steps.map((s, i) => ({
            id: `step_${i}`,
            server: s.server,
            tool: s.tool,
            args: s.args || {},
            ...(s.loop ? { loop: s.loop } : {}),
            ...(s.capture ? { capture: s.capture } : {}),
            ...(s.stream_progress ? { stream_progress: true } : {}),
        }));
        const agentActions = JSON.stringify({ label: description || name, vars: {}, steps: actionSteps }, null, 2);
        const triggerList = (triggers || [name]).join(', ');
        const unifiedActions = JSON.stringify({
            stopping_points: [{
                    id: 1,
                    title: 'Choose Your Action',
                    options: {
                        '1': { label: description || name, vars: {}, steps: actionSteps },
                    }
                }]
        }, null, 2);
        const skillContent = `---
name: ${name}
description: ${description || name}
version: 1.0.0
required_tools: ${JSON.stringify([...new Set(steps.map((s) => s.server))])}
---

# ${name}

${description || name}

**Triggers:** ${triggerList}

## Choose Your Action

1. Run the full workflow

<!-- AGENT_ACTIONS: ${unifiedActions} -->
`;
        res.json({ ok: true, content: skillContent, name });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// GET /api/skills/:name/actions — read actions.json (for visual builder)
router.get('/:name/actions', async (req, res) => {
    try {
        const db = getDb();
        const skill = db.prepare('SELECT directory_path FROM skills_registry WHERE name = ?')
            .get(req.params.name);
        if (!skill) {
            res.status(404).json({ error: 'Skill not found' });
            return;
        }
        const root = getProjectRoot();
        const actionsPath = path.join(root, 'skills', skill.directory_path, 'actions.json');
        try {
            const content = await fs.readFile(actionsPath, 'utf-8');
            res.json(JSON.parse(content));
        }
        catch {
            // Fallback: parse AGENT_ACTIONS from SKILL.md
            const skillPath = path.join(root, 'skills', skill.directory_path, 'SKILL.md');
            try {
                const md = await fs.readFile(skillPath, 'utf-8');
                const match = md.match(/<!-- AGENT_ACTIONS:\s*(\{[\s\S]*?\})\s*-->/);
                if (match)
                    res.json(JSON.parse(match[1]));
                else
                    res.json({ stopping_points: [] });
            }
            catch {
                res.json({ stopping_points: [] });
            }
        }
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// PUT /api/skills/:name/actions — write actions.json + layout.json + SKILL.md (from visual builder)
router.put('/:name/actions', async (req, res) => {
    try {
        const db = getDb();
        const skill = db.prepare('SELECT directory_path FROM skills_registry WHERE name = ?')
            .get(req.params.name);
        if (!skill) {
            res.status(404).json({ error: 'Skill not found' });
            return;
        }
        const root = getProjectRoot();
        const dir = path.join(root, 'skills', skill.directory_path);
        await fs.mkdir(dir, { recursive: true });
        // Write actions.json
        if (req.body.actions) {
            await fs.writeFile(path.join(dir, 'actions.json'), JSON.stringify(req.body.actions, null, 2), 'utf-8');
        }
        // Write layout.json for round-trip editing in visual builder
        if (req.body.layout) {
            await fs.writeFile(path.join(dir, 'layout.json'), JSON.stringify(req.body.layout), 'utf-8');
        }
        // Write SKILL.md if provided
        if (req.body.skillMd) {
            await fs.writeFile(path.join(dir, 'SKILL.md'), req.body.skillMd, 'utf-8');
        }
        // Auto-detect required servers from actions
        const servers = new Set();
        const walkSteps = (steps) => {
            for (const s of steps || []) {
                if (s.server && !s.server.startsWith('_') && s.server !== 'YOUR_SERVER') {
                    servers.add(s.server);
                }
            }
        };
        if (req.body.actions) {
            walkSteps(req.body.actions.initial_steps || []);
            for (const sp of req.body.actions.stopping_points || []) {
                for (const opt of Object.values(sp.options || {})) {
                    walkSteps(opt.steps || []);
                }
            }
        }
        db.prepare('UPDATE skills_registry SET required_tools = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?')
            .run(JSON.stringify([...servers]), req.params.name);
        res.json({ ok: true });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// GET /api/skills/:name/layout — read layout.json for visual builder canvas state
router.get('/:name/layout', async (req, res) => {
    try {
        const db = getDb();
        const skill = db.prepare('SELECT directory_path FROM skills_registry WHERE name = ?')
            .get(req.params.name);
        if (!skill) {
            res.status(404).json({ error: 'Skill not found' });
            return;
        }
        const root = getProjectRoot();
        const layoutPath = path.join(root, 'skills', skill.directory_path, 'layout.json');
        try {
            const content = await fs.readFile(layoutPath, 'utf-8');
            res.json(JSON.parse(content));
        }
        catch {
            res.json(null);
        }
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// GET /api/skills/:name/content — must be before /:name so "content" is not captured as name
router.get('/:name/content', async (req, res) => {
    try {
        const db = getDb();
        const skill = db.prepare('SELECT file_path FROM skills_registry WHERE name = ?').get(req.params.name);
        if (!skill) {
            res.status(404).json({ error: 'Skill not found' });
            return;
        }
        let fullPath = resolveSkillPath(skill.file_path);
        let content;
        try {
            content = await fs.readFile(fullPath, 'utf-8');
        }
        catch (err) {
            if (err?.code !== 'ENOENT')
                throw err;
            const fallback = resolveSkillPathFallback(skill.file_path);
            if (fallback && fallback !== fullPath) {
                content = await fs.readFile(fallback, 'utf-8');
            }
            else {
                res.status(404).json({ error: 'Skill file not found', path: fullPath });
                return;
            }
        }
        res.type('text/plain').send(content);
    }
    catch (error) {
        if (error?.code === 'ENOENT') {
            res.status(404).json({ error: 'Skill file not found' });
            return;
        }
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// POST /api/skills — create a new skill
router.post('/', async (req, res) => {
    try {
        const db = getDb();
        const { name, description, category } = req.body;
        if (!name || typeof name !== 'string') {
            res.status(400).json({ error: 'Skill name is required' });
            return;
        }
        // Validate name (alphanumeric, hyphens, underscores)
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
            res.status(400).json({ error: 'Skill name can only contain letters, numbers, hyphens, and underscores' });
            return;
        }
        // Check if already exists
        const existing = db.prepare('SELECT id FROM skills_registry WHERE name = ?').get(name);
        if (existing) {
            res.status(409).json({ error: `Skill "${name}" already exists` });
            return;
        }
        // Determine directory
        const categoryDir = category || 'my-skills';
        const skillDir = path.join(getProjectRoot(), 'skills', categoryDir, name);
        const skillFile = path.join(skillDir, 'SKILL.md');
        // Create directory
        await fs.mkdir(skillDir, { recursive: true });
        // Write template
        const desc = description || `Custom skill: ${name}`;
        const template = `---
name: ${name}
description: ${desc}
version: 1.0.0
required_tools: []
---

# ${name}

${desc}

## Instructions

Add your skill instructions here. This is what Vodou will follow when this skill is activated.

## Steps

1. Step one
2. Step two
3. Step three
`;
        await fs.writeFile(skillFile, template, 'utf-8');
        // Register in database with relative paths (portable across installs)
        const relFilePath = path.join(categoryDir, name, 'SKILL.md');
        const relDirPath = path.join(categoryDir, name);
        db.prepare(`INSERT INTO skills_registry (name, description, version, file_path, directory_path, required_tools, metadata, is_active, last_scanned, created_at, updated_at)
       VALUES (?, ?, '1.0.0', ?, ?, '[]', '{}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(name, desc, relFilePath, relDirPath);
        res.json({ ok: true, name, file_path: skillFile });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// PUT /api/skills/:name/content
router.put('/:name/content', async (req, res) => {
    try {
        const db = getDb();
        const skill = db.prepare('SELECT file_path FROM skills_registry WHERE name = ?').get(req.params.name);
        if (!skill) {
            res.status(404).json({ error: 'Skill not found' });
            return;
        }
        let fullPath = resolveSkillPath(skill.file_path);
        try {
            await fs.access(fullPath);
        }
        catch {
            const fallback = resolveSkillPathFallback(skill.file_path);
            if (fallback)
                fullPath = fallback;
        }
        const content = typeof req.body === 'string' ? req.body : (req.body?.content ?? '');
        await fs.writeFile(fullPath, content, 'utf-8');
        res.json({ ok: true, message: 'Saved' });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// =============================================================================
// Phase 4 — Catalog + import + lifecycle endpoints (must precede /:name route)
// =============================================================================
import { spawn as _spawn4 } from 'child_process';
const CATALOG_URL_P4 = process.env.VODOU_SKILLS_CATALOG_URL ||
    'https://raw.githubusercontent.com/VodouAI/vodou-skills-catalog/main/index.json';
async function bt4SkillP4(args) {
    const projectRoot = getProjectRoot();
    const bin = path.join(projectRoot, 'vodou-core');
    return new Promise((resolve) => {
        const proc = _spawn4(bin, ['skill', ...args], { cwd: projectRoot });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
            resolve({ ok: code === 0, stdout, stderr, exitCode: code ?? -1 });
        });
        proc.on('error', (err) => {
            resolve({ ok: false, stdout, stderr: stderr + String(err), exitCode: -1 });
        });
    });
}
router.get('/catalog', async (_req, res) => {
    try {
        const url = `${CATALOG_URL_P4}${CATALOG_URL_P4.includes('?') ? '&' : '?'}_=${Date.now()}`;
        const resp = await fetch(url);
        if (!resp.ok) {
            res.status(502).json({ error: `catalog fetch HTTP ${resp.status}` });
            return;
        }
        const index = await resp.json();
        const db = getDb();
        const rows = db.prepare('SELECT name FROM skills_registry').all();
        const installedNames = new Set(rows.map(r => r.name));
        const enriched = (index.entries || []).map(e => ({
            ...e,
            installed: installedNames.has(e.skill_name),
        }));
        res.json({
            catalog_version: index.catalog_version,
            updated_at: index.updated_at,
            catalog_url: CATALOG_URL_P4,
            entries: enriched,
            total: enriched.length,
        });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
router.post('/install', async (req, res) => {
    const source = (req.body?.id ?? req.body?.source ?? '').toString().trim();
    if (!source) {
        res.status(400).json({ error: 'missing id / source' });
        return;
    }
    const isCatalog = source.includes('.') && !source.includes('/') && !source.startsWith('http');
    const args = isCatalog ? ['install', source] : ['import', source];
    const result = await bt4SkillP4(args);
    if (!result.ok) {
        res.status(500).json({ error: 'install failed', exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout });
        return;
    }
    try {
        await syncSkillsFromFilesystem({ force: true });
    }
    catch { /* non-fatal */ }
    res.json({ ok: true, source, mode: isCatalog ? 'catalog' : 'import', stdout: result.stdout });
});
router.post('/import', async (req, res) => {
    const source = (req.body?.source ?? '').toString().trim();
    if (!source) {
        res.status(400).json({ error: 'missing source' });
        return;
    }
    const result = await bt4SkillP4(['import', source]);
    if (!result.ok) {
        res.status(500).json({ error: 'import failed', exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout });
        return;
    }
    try {
        await syncSkillsFromFilesystem({ force: true });
    }
    catch { /* non-fatal */ }
    res.json({ ok: true, source, stdout: result.stdout });
});
router.post('/uninstall', async (req, res) => {
    const name = (req.body?.name ?? '').toString().trim();
    if (!name) {
        res.status(400).json({ error: 'missing name' });
        return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        res.status(400).json({ error: 'invalid skill name' });
        return;
    }
    const result = await bt4SkillP4(['uninstall', name]);
    if (!result.ok) {
        res.status(500).json({ error: 'uninstall failed', exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout });
        return;
    }
    // Remove the skills_registry row directly — syncSkillsFromFilesystem only inserts.
    try {
        getDb().prepare('DELETE FROM skills_registry WHERE name = ?').run(name);
    }
    catch { /* non-fatal */ }
    // Defensive double-prune in case the deployed bt4 binary predates the §7
    // priority-filter removal — newer bt4 nukes all rows already, this is a
    // no-op then. json_extract avoids substring collisions with similarly-named skills.
    let extraPruned = 0;
    try {
        const r = getDb()
            .prepare("DELETE FROM intent_mappings WHERE tool_name = 'vc_load_skill' AND json_extract(tool_parameters, '$.skill_name') = ?")
            .run(name);
        extraPruned = r.changes || 0;
    }
    catch { /* non-fatal */ }
    try {
        await syncSkillsFromFilesystem({ force: true });
    }
    catch { /* non-fatal */ }
    const stdout = (result.stdout || '') + (extraPruned > 0 ? `\nPruned ${extraPruned} additional intent row(s).` : '');
    res.json({ ok: true, name, stdout, extra_pruned: extraPruned });
});
// Phase 5 — fork / update / diff
router.post('/fork', async (req, res) => {
    const name = (req.body?.name ?? '').toString().trim();
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
        res.status(400).json({ error: 'invalid or missing skill name' });
        return;
    }
    const result = await bt4SkillP4(['fork', name]);
    if (!result.ok) {
        res.status(500).json({ error: 'fork failed', exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout });
        return;
    }
    try {
        await syncSkillsFromFilesystem({ force: true });
    }
    catch { /* non-fatal */ }
    res.json({ ok: true, name, stdout: result.stdout });
});
router.post('/update', async (req, res) => {
    const name = (req.body?.name ?? '').toString().trim();
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
        res.status(400).json({ error: 'invalid or missing skill name' });
        return;
    }
    const result = await bt4SkillP4(['update', name]);
    if (!result.ok) {
        res.status(500).json({ error: 'update failed', exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout });
        return;
    }
    try {
        await syncSkillsFromFilesystem({ force: true });
    }
    catch { /* non-fatal */ }
    res.json({ ok: true, name, stdout: result.stdout });
});
router.get('/diff/:name', async (req, res) => {
    const name = (req.params.name ?? '').toString().trim();
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
        res.status(400).json({ error: 'invalid or missing skill name' });
        return;
    }
    const result = await bt4SkillP4(['diff', name]);
    res.json({
        ok: result.ok,
        name,
        diff: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
    });
});
/**
 * POST /api/skills/run-steps
 *
 * Body: { steps: [ {server, tool, args, capture?}, ... ], topic?: string, vars?: object }
 *
 * Executes a sequence of MCP tool calls deterministically via
 * `vodou-core call <server> <tool> '<json-args>'`.
 *
 * Substitutes {{TOPIC}}, {{NOW}}, and any captured-or-passed-in variables in
 * args before each call. Captures named fields from each call's JSON result
 * for later steps.
 *
 * Returns: { ok, results: [ {step, ok, stdout, stderr, exitCode} ] }
 */
router.post('/run-steps', async (req, res) => {
    const steps = Array.isArray(req.body?.steps) ? req.body.steps : null;
    const topic = (req.body?.topic ?? '').toString();
    const incomingVars = (typeof req.body?.vars === 'object' && req.body.vars) ? { ...req.body.vars } : {};
    if (!steps || steps.length === 0) {
        res.status(400).json({ error: 'missing steps[]' });
        return;
    }
    const captured = { TOPIC: topic, ...incomingVars };
    const substitute = (val) => {
        if (typeof val === 'string') {
            return val.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key) => {
                return captured[key] !== undefined ? String(captured[key]) : `{{${key}}}`;
            });
        }
        if (Array.isArray(val))
            return val.map(substitute);
        if (val && typeof val === 'object') {
            const out = {};
            for (const k of Object.keys(val))
                out[k] = substitute(val[k]);
            return out;
        }
        return val;
    };
    // Use runVodouCore (worker-socket path) instead of `bt4 call` CLI:
    // CLI path runs the parameter generator on empty args, which injects
    // empty-string defaults like {account:"", timeZone:""} that fail schema
    // validation. The worker socket sends args verbatim to the MCP tool.
    const { runVodouCore } = await import('../executor.js');
    const results = [];
    for (const step of steps) {
        const server = (step.server ?? '').toString();
        const tool = (step.tool ?? '').toString();
        if (!server || !tool) {
            results.push({ step, ok: false, error: 'missing server or tool' });
            break;
        }
        const argsObj = substitute(step.args || {});
        let stdout = '';
        let stderr = '';
        let ok = false;
        let exitCode = 0;
        try {
            stdout = await runVodouCore(server, tool, argsObj);
            ok = true;
        }
        catch (err) {
            stderr = err instanceof Error ? err.message : String(err);
            exitCode = -1;
            ok = false;
        }
        // Detect tool-level errors. MCP servers wrap errors in {content:[{text:"..."}], isError: true}
        // even when the transport call succeeded. Treat as a failure so we don't substitute garbage
        // into the next step.
        if (ok) {
            try {
                // Find the first JSON-shaped substring (works for both wrapped tool output and bare JSON)
                const jsonMatch = stdout.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (parsed && parsed.isError === true) {
                        ok = false;
                        const txt = parsed?.content?.[0]?.text;
                        if (typeof txt === 'string')
                            stderr = txt;
                        exitCode = 1;
                    }
                    // Capture: pull named fields out of the parsed result
                    if (ok && step.capture && typeof step.capture === 'object') {
                        // For tools that return {content:[{text:"..."}]} wrapping, try the inner text first
                        let captureSource = parsed;
                        const inner = parsed?.content?.[0]?.text;
                        if (typeof inner === 'string') {
                            try {
                                captureSource = JSON.parse(inner);
                            }
                            catch { /* leave as outer */ }
                        }
                        for (const [varName, fieldPath] of Object.entries(step.capture)) {
                            const val = (captureSource && typeof captureSource === 'object')
                                ? captureSource[fieldPath]
                                : undefined;
                            if (val !== undefined) {
                                const s = String(val);
                                captured[varName] = s;
                                // Convenience: for ISO-8601 timestamps with milliseconds and/or timezone
                                // offset, also expose a normalized naive form (no millis, no tz).
                                // Some MCP tools (e.g. google-calendar.list-events) require this.
                                const isoMatch = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/);
                                if (isoMatch)
                                    captured[`${varName}_NAIVE`] = isoMatch[1];
                            }
                        }
                    }
                }
            }
            catch { /* not JSON or no capture — fine */ }
        }
        results.push({
            server, tool, args: argsObj,
            ok, stdout, stderr, exitCode,
        });
        if (!ok)
            break;
    }
    res.json({
        ok: results.every(r => r.ok),
        results,
        captured,
    });
});
// GET /api/skills/:name — skill detail (keep AFTER specific routes above)
router.get('/:name', (req, res) => {
    try {
        const db = getDb();
        const skill = db.prepare('SELECT * FROM skills_registry WHERE name = ?').get(req.params.name);
        if (!skill) {
            res.status(404).json({ error: 'Skill not found' });
            return;
        }
        res.json(skill);
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// POST /api/skills/:name/toggle — toggle is_active
router.post('/:name/toggle', (req, res) => {
    try {
        const db = getDb();
        // Get current state
        const skill = db.prepare('SELECT id, is_active FROM skills_registry WHERE name = ?').get(req.params.name);
        if (!skill) {
            res.status(404).json({ error: 'Skill not found' });
            return;
        }
        const newState = skill.is_active ? 0 : 1;
        db.prepare('UPDATE skills_registry SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newState, skill.id);
        res.json({
            success: true,
            name: req.params.name,
            is_active: newState,
            message: `${req.params.name} ${newState ? 'activated' : 'deactivated'}`,
        });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
export { router as skillsRouter };
