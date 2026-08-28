/**
 * projects-store.ts — PLAN-GATEWAY-PROJECTS Phase 1.
 *
 * A "project" is a pointer to a working directory. Adding one writes nothing
 * into that directory — it stores one row in the gateway DB. The brain
 * (MCP servers, credentials, daemon/worker, memory) stays shared; a project
 * only scopes conversations, the file root (Phase 2), and instructions.
 *
 * Instruction storage policy (PLAN §4a):
 *   - Default: instructions live in the DB; the directory stays pristine.
 *   - Read-existing: if the dir has .vodou/project.md / CLAUDE.md / AGENTS.md,
 *     that file is the source of truth (resolveProjectInstructions, mtime-cached).
 *   - Opt-in disk-sync: saveInstructionsToDisk() writes back to the existing
 *     doc, else creates .vodou/project.md. The only path that writes into a dir.
 *
 * Mirrors conversation-store.ts: thin, typed, getGatewayDb()-backed.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { getGatewayDb, getProjectRoot } from './db.js';
/** Priority order for an existing on-disk instructions doc. First match wins. */
const INSTRUCTION_DOCS = ['.vodou/project.md', 'CLAUDE.md', 'AGENTS.md'];
const INSTRUCTION_CAP = 16 * 1024; // 16KB
function rowToProject(r) {
    return {
        id: r.id,
        name: r.name,
        rootPath: r.root_path,
        instructions: r.instructions,
        color: r.color,
        archivedAt: r.archived_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}
function newProjectId() {
    return 'proj_' + randomUUID().replace(/-/g, '').slice(0, 8);
}
/** Validate a candidate root_path. Returns the normalized absolute path or throws. */
function validateRootPath(rootPath) {
    if (typeof rootPath !== 'string' || !rootPath.trim()) {
        throw new Error('root_path is required');
    }
    const abs = path.resolve(rootPath.trim());
    let st;
    try {
        st = fs.statSync(abs);
    }
    catch {
        throw new Error(`directory does not exist: ${abs}`);
    }
    if (!st.isDirectory()) {
        throw new Error(`not a directory: ${abs}`);
    }
    return abs;
}
// ───────────────────────── CRUD ─────────────────────────
export function listProjects(includeArchived = false) {
    const db = getGatewayDb();
    const sql = includeArchived
        ? 'SELECT * FROM projects ORDER BY (id = \'proj_default\') DESC, updated_at DESC'
        : 'SELECT * FROM projects WHERE archived_at IS NULL ORDER BY (id = \'proj_default\') DESC, updated_at DESC';
    return db.prepare(sql).all().map(rowToProject);
}
export function getProject(id) {
    if (!id)
        return null;
    const db = getGatewayDb();
    const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    return r ? rowToProject(r) : null;
}
export function createProject(input) {
    const name = (input.name || '').trim();
    if (!name)
        throw new Error('name is required');
    const root = validateRootPath(input.rootPath);
    // Auto-detect instructions from an on-disk doc if the caller didn't supply any.
    let instructions = typeof input.instructions === 'string' ? input.instructions : null;
    if (instructions === null) {
        instructions = detectProjectDoc(root)?.instructions ?? null;
    }
    const db = getGatewayDb();
    const id = newProjectId();
    db.prepare(`INSERT INTO projects (id, name, root_path, instructions, color)
     VALUES (?, ?, ?, ?, ?)`).run(id, name, root, instructions, input.color ?? null);
    return getProject(id);
}
export function updateProject(id, patch) {
    const existing = getProject(id);
    if (!existing)
        return null;
    const name = patch.name !== undefined ? (patch.name || '').trim() || existing.name : existing.name;
    const root = patch.rootPath !== undefined ? validateRootPath(patch.rootPath) : existing.rootPath;
    const instructions = patch.instructions !== undefined ? patch.instructions : existing.instructions;
    const color = patch.color !== undefined ? patch.color : existing.color;
    const db = getGatewayDb();
    db.prepare(`UPDATE projects SET name = ?, root_path = ?, instructions = ?, color = ?, updated_at = unixepoch()
     WHERE id = ?`).run(name, root, instructions, color, id);
    return getProject(id);
}
/** Soft-archive. The Default project cannot be archived. */
export function archiveProject(id) {
    if (id === 'proj_default')
        throw new Error('the Default project cannot be archived');
    const db = getGatewayDb();
    db.prepare('UPDATE projects SET archived_at = unixepoch(), updated_at = unixepoch() WHERE id = ?').run(id);
}
// ─────────────── resolution helpers (used by the turn) ───────────────
/** Project's working directory, or the install root for NULL/Default/unknown. */
export function resolveProjectRoot(id) {
    const p = getProject(id);
    if (p && p.rootPath)
        return p.rootPath;
    return getProjectRoot();
}
const _docCache = new Map();
/**
 * Find an on-disk instructions doc in `rootPath` (priority order). Returns the
 * content + which file, or null. mtime-cached so re-reading every turn is cheap
 * (mirrors the workspace-bootstrap mtime pattern). Pass `null` rootPath → null.
 */
export function detectProjectDoc(rootPath) {
    if (!rootPath)
        return null;
    for (const rel of INSTRUCTION_DOCS) {
        const full = path.join(rootPath, rel);
        let st;
        try {
            st = fs.statSync(full);
        }
        catch {
            continue;
        }
        if (!st.isFile())
            continue;
        const cached = _docCache.get(full);
        if (cached && cached.mtimeMs === st.mtimeMs) {
            return { source: rel, instructions: cached.content };
        }
        try {
            let content = fs.readFileSync(full, 'utf-8');
            if (content.length > INSTRUCTION_CAP)
                content = content.slice(0, INSTRUCTION_CAP);
            _docCache.set(full, { mtimeMs: st.mtimeMs, content, source: rel });
            return { source: rel, instructions: content };
        }
        catch {
            continue;
        }
    }
    return null;
}
/**
 * Instructions for a turn. Precedence (PLAN §4a.4): an on-disk doc wins (live,
 * mtime-cached); otherwise the DB instructions field. Returns '' when neither.
 */
export function resolveProjectInstructions(id) {
    const p = getProject(id);
    if (!p)
        return '';
    const onDisk = detectProjectDoc(p.rootPath);
    if (onDisk)
        return onDisk.instructions;
    return p.instructions ?? '';
}
// ─────────────── per-project skill filtering (PLAN-PROJECT-SCOPED-DOCK) ───────────────
/**
 * Skill names surfaced for a project's dock, or `null` when there is no filter.
 * Curate-down semantics: the Default project and any uncurated project (zero
 * associations) return `null` = "show everything". Only a project with ≥1
 * explicit association returns a (non-empty) allow-list. Skills are keyed by
 * name because they live in a different DB (vodou-core.db) with its own ids.
 */
export function projectSkillNames(id) {
    if (!id || id === 'proj_default')
        return null;
    const db = getGatewayDb();
    const rows = db
        .prepare('SELECT skill_name FROM project_skills WHERE project_id = ?')
        .all(id);
    if (rows.length === 0)
        return null; // uncurated → no filter
    return rows.map((r) => r.skill_name);
}
/** Raw assignment list for the editor UI (`[]` when none). */
export function listProjectSkills(id) {
    const db = getGatewayDb();
    const rows = db
        .prepare('SELECT skill_name FROM project_skills WHERE project_id = ? ORDER BY skill_name')
        .all(id);
    return rows.map((r) => r.skill_name);
}
/** Replace a project's skill set transactionally. Empty array = uncurated (show all). */
export function setProjectSkills(id, names) {
    if (!getProject(id))
        throw new Error('project not found');
    const list = Array.isArray(names)
        ? Array.from(new Set(names.map((n) => String(n).trim()).filter(Boolean)))
        : [];
    const db = getGatewayDb();
    db.exec('BEGIN');
    try {
        db.prepare('DELETE FROM project_skills WHERE project_id = ?').run(id);
        const ins = db.prepare('INSERT OR IGNORE INTO project_skills (project_id, skill_name) VALUES (?, ?)');
        for (const n of list)
            ins.run(id, n);
        db.exec('COMMIT');
    }
    catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
    return list;
}
// ─────────────── per-project scope pinning (PLAN-UNIFIED-PROJECT-SCOPE §2.4) ───────────────
// Same curate-down contract as the skills trio above: [] = uncurated = everywhere.
// These are the READ side of project_scopes; scope.ts owns what the answer MEANS.
/** Projects a scope is pinned to. `[]` = unpinned = visible in every project. */
export function scopeProjectIds(scope) {
    const db = getGatewayDb();
    const rows = db
        .prepare('SELECT project_id FROM project_scopes WHERE scope = ? ORDER BY project_id')
        .all(scope);
    return rows.map((r) => r.project_id);
}
/** Every scope pinned into one project (`[]` when none) — for the editor UI. */
export function listProjectScopes(id) {
    const db = getGatewayDb();
    const rows = db
        .prepare('SELECT scope FROM project_scopes WHERE project_id = ? ORDER BY scope')
        .all(id);
    return rows.map((r) => r.scope);
}
/** Replace a project's pinned scopes transactionally. Empty array = uncurated. */
export function setProjectScopes(id, scopes) {
    if (!getProject(id))
        throw new Error('project not found');
    const list = Array.isArray(scopes)
        ? Array.from(new Set(scopes.map((s) => String(s).trim()).filter(Boolean)))
        : [];
    const db = getGatewayDb();
    db.exec('BEGIN');
    try {
        db.prepare('DELETE FROM project_scopes WHERE project_id = ?').run(id);
        const ins = db.prepare('INSERT OR IGNORE INTO project_scopes (project_id, scope) VALUES (?, ?)');
        for (const s of list)
            ins.run(id, s);
        db.exec('COMMIT');
    }
    catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
    return list;
}
/** Single-row pin for the dock context menu. Idempotent (PK conflict swallowed). */
export function pinScope(id, scope) {
    if (!getProject(id))
        throw new Error('project not found');
    getGatewayDb()
        .prepare('INSERT OR IGNORE INTO project_scopes (project_id, scope) VALUES (?, ?)')
        .run(id, scope);
}
/** Single-row unpin. A scope with no rows left is uncurated ⇒ visible EVERYWHERE
 *  again, never hidden — that is what makes unpin a real undo (INV-5). */
export function unpinScope(id, scope) {
    getGatewayDb()
        .prepare('DELETE FROM project_scopes WHERE project_id = ? AND scope = ?')
        .run(id, scope);
}
/** A conversation's project, or null. The `owned` leg of scopeVisibility(). */
export function conversationProjectId(convId) {
    const db = getGatewayDb();
    const row = db
        .prepare('SELECT project_id FROM gateway_conversations WHERE id = ?')
        .get(convId);
    return row?.project_id ?? null;
}
/**
 * Bind the three stores to the live DB — in ONE place, so no caller invents a
 * fourth mechanism. This function existing is the point of the plan.
 */
export function liveMembershipStores() {
    return {
        conversationProject: conversationProjectId,
        skillProjects: (name) => {
            const db = getGatewayDb();
            const rows = db
                .prepare('SELECT project_id FROM project_skills WHERE skill_name = ? ORDER BY project_id')
                .all(name);
            return rows.map((r) => r.project_id);
        },
        scopeProjects: scopeProjectIds,
    };
}
// ─────────────── per-project scheduled tasks (PLAN-PROJECT-SCOPED-DOCK Phase 2) ───────────────
/** Map of task_id → project_id for every tagged scheduled task. */
export function getTaskProjectMap() {
    const db = getGatewayDb();
    const rows = db.prepare('SELECT task_id, project_id FROM project_tasks').all();
    return new Map(rows.map((r) => [r.task_id, r.project_id]));
}
/**
 * Tag a scheduled task with its owning project. A real project id (INCLUDING
 * 'proj_default') upserts the mapping — the presence of a mapping is what marks
 * a task "user-created" vs system/infra (which is never tagged). Only a null /
 * empty id clears the mapping (used on task delete).
 */
export function setTaskProject(taskId, projectId) {
    const db = getGatewayDb();
    if (!projectId) {
        db.prepare('DELETE FROM project_tasks WHERE task_id = ?').run(taskId);
        return;
    }
    if (!getProject(projectId))
        throw new Error('project not found');
    db.prepare(`INSERT INTO project_tasks (task_id, project_id) VALUES (?, ?)
     ON CONFLICT(task_id) DO UPDATE SET project_id = excluded.project_id`).run(taskId, projectId);
}
/**
 * Opt-in disk-sync (PLAN §4a.3). Writes the project's current instructions to
 * the existing on-disk doc if present, else creates .vodou/project.md. The only
 * function here that writes into a project directory. Returns the written relpath.
 */
export function saveInstructionsToDisk(id) {
    const p = getProject(id);
    if (!p)
        throw new Error('project not found');
    const text = p.instructions ?? '';
    // Prefer an existing doc so we don't create a competing file next to CLAUDE.md.
    let rel = null;
    for (const candidate of INSTRUCTION_DOCS) {
        if (fs.existsSync(path.join(p.rootPath, candidate))) {
            rel = candidate;
            break;
        }
    }
    if (!rel)
        rel = '.vodou/project.md';
    const full = path.join(p.rootPath, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, 'utf-8');
    _docCache.delete(full); // force re-read on next resolve
    return rel;
}
