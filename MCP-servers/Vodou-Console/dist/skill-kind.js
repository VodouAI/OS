/**
 * PLAN-SKILL-SYSTEMS-SEAM P1 — the only place allowed to answer
 * "which skill system is this?"
 *
 * Vodou has two things called "skill" that share the word and nothing else:
 *
 *   `file`    — a SKILL.md on disk, registered in `skills_registry`
 *               (vodou-core.db). 160 today; 50 carry an actions.json graph.
 *               Scheduled as a bare-named task with payload_type 'query'.
 *   `console` — a prompt template in `skills_meta` (gateway.db), run by the
 *               Skill Console on a cadence. 15 today. Scheduled as
 *               `skill:<name>` with payload_type 'skill_run'.
 *
 * Those two schedule spellings are where the seam actually cuts. Before this
 * module, FIVE files derived them independently (index.ts, api/scheduler.ts,
 * api/skill-console-handler.ts, api/skill-console-create.ts, graph-save via
 * the CLI) — the plan had guessed three, which is the point: nobody knew. The
 * catalog's schedule join matched only the `console` spelling and would never
 * have found a graph skill (PLAN-GRAPH-FRONTEND §4f); PLAN-ALPHA F5 was the same
 * seam hiding four standing agents from the skills view. Same bug, one cause.
 *
 * Rules, in order of how much they matter:
 *
 *   1. Ambiguity is an ERROR. A name that exists in both systems classifies as
 *      null with a reason, never as a coin flip. Silently preferring one is how
 *      F5 happened. Zero names collide today (measured 2026-08-27, 15 vs 160);
 *      the rule costs nothing now and holds when they do.
 *   2. Nothing outside this file spells 'skill_run', 'skill:', or the query
 *      lane's bare name. A test enforces it.
 *   3. This module does not merge the systems, does not migrate rows, and does
 *      not decide what a skill IS beyond which table answers for it. Unifying
 *      storage to unify a word makes both worse (§6 of the plan).
 */
import { getDb, getGatewayDb, getProjectRoot } from './db.js';
import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
/** The payload_type each lane's scheduler row carries. */
export const SCHEDULE_PAYLOAD_TYPE = { file: 'query', console: 'skill_run' };
/** The name prefix the console lane's scheduler row carries. */
export const CONSOLE_SCHEDULE_PREFIX = 'skill:';
function findFile(name) {
    try {
        const row = getDb()
            .prepare('SELECT name, file_path, COALESCE(is_active, 1) AS is_active FROM skills_registry WHERE name = ? LIMIT 1')
            .get(name);
        if (!row)
            return null;
        return { kind: 'file', name: row.name, path: row.file_path ?? undefined, active: row.is_active !== 0 };
    }
    catch {
        return null; // a missing table is "no such skill here", not an exception
    }
}
function findConsole(name) {
    try {
        const row = getGatewayDb()
            .prepare('SELECT id, name, schedule_cron, COALESCE(is_active, 1) AS is_active FROM skills_meta WHERE name = ? LIMIT 1')
            .get(name);
        if (!row)
            return null;
        return { kind: 'console', name: row.name, id: row.id, scheduleCron: row.schedule_cron, active: row.is_active !== 0 };
    }
    catch {
        return null;
    }
}
/**
 * Which system owns this name. Both tables are consulted every time — that is
 * what makes a collision detectable rather than silently won by whichever
 * table a caller happened to check first.
 */
export function classifySkill(name) {
    const n = String(name ?? '').trim();
    if (!n)
        return { ref: null, miss: { reason: 'not_found' } };
    const file = findFile(n);
    const console = findConsole(n);
    if (file && console) {
        console_error(`[skill-kind] "${n}" exists in BOTH skills_registry and skills_meta — refusing to guess`);
        return { ref: null, miss: { reason: 'ambiguous', file, console } };
    }
    const ref = file ?? console;
    return ref ? { ref } : { ref: null, miss: { reason: 'not_found' } };
}
/** The convenience form the plan names: the ref, or null for BOTH miss reasons. */
export function classify(name) {
    return classifySkill(name).ref;
}
/** The `scheduled_tasks.name` this skill's schedule row carries. */
export function scheduleNameFor(ref) {
    return ref.kind === 'console' ? `${CONSOLE_SCHEDULE_PREFIX}${ref.name}` : ref.name;
}
/** The `scheduled_tasks.payload_type` this skill's schedule row carries. */
export function schedulePayloadTypeFor(ref) {
    return SCHEDULE_PAYLOAD_TYPE[ref.kind];
}
/**
 * The reverse: which skill name a scheduler row belongs to, and which kind —
 * read off the row itself (name + payload_type), never by re-querying. This is
 * what a catalog or schedules listing should call instead of stripping
 * prefixes by hand, which is exactly the local derivation that went wrong.
 */
export function skillFromScheduleRow(row) {
    const name = String(row.name ?? '');
    if (row.payload_type === SCHEDULE_PAYLOAD_TYPE.console || name.startsWith(CONSOLE_SCHEDULE_PREFIX)) {
        const bare = name.startsWith(CONSOLE_SCHEDULE_PREFIX) ? name.slice(CONSOLE_SCHEDULE_PREFIX.length) : name;
        return bare ? { kind: 'console', name: bare } : null;
    }
    if (row.payload_type === SCHEDULE_PAYLOAD_TYPE.file)
        return name ? { kind: 'file', name } : null;
    return null; // heartbeat, mcp_tool, maintenance — not a skill's row
}
// Kept as a function so tests can assert it fired without capturing console.
function console_error(msg) { console.error(msg); }
/**
 * The scheduler row registered for a CONSOLE skill, by slug. Two files carried
 * this exact query as a string literal (`api/scheduler.ts`, `api/skill-console-create.ts`)
 * — the same lookup, the same seam, twice. `db` is passed in because the two
 * callers already hold different handles; this helper owns the spelling, not
 * the connection.
 */
export function findConsoleScheduleRow(db, slug) {
    return db
        .prepare(`SELECT id FROM scheduled_tasks WHERE payload_type = '${SCHEDULE_PAYLOAD_TYPE.console}' AND (name LIKE ? OR payload LIKE ?) ORDER BY id DESC LIMIT 1`)
        .get(`%${slug}%`, `%${slug}%`);
}
/** skills/ root, resolved once per call — the registry stores paths relative to it. */
function skillsRoot() { return path.join(getProjectRoot(), 'skills'); }
/** frontmatter name → every SKILL.md dir (relative to skills/) carrying it. */
let _namesOnDisk = null;
function namesOnDisk() {
    if (_namesOnDisk)
        return _namesOnDisk;
    const out = new Map();
    const root = skillsRoot();
    const SKIP = new Set(['node_modules', 'dist', 'build', '__tests__', '__pycache__', 'fixtures', 'assets', 'vendor']);
    const walk = (dir, depth) => {
        if (depth > 6)
            return;
        // `readdirSync` is IMPORTED, not require()d. This module is ESM
        // (package.json "type": "module"); `require` is undefined there, the old
        // `catch { return }` swallowed the ReferenceError, and the walk found
        // NOTHING in production — `duplicateOf` was null for every ref while the
        // test passed, because vitest transpiles to CJS where require exists.
        // Proven 2026-08-27 by running the built dist directly. A test that runs
        // under a different module system than production proves nothing about
        // production.
        let entries = [];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        const md = path.join(dir, 'SKILL.md');
        if (existsSync(md)) {
            const m = /^name:\s*(.+)$/m.exec(readFileSync(md, 'utf-8').slice(0, 4000));
            if (m) {
                const n = m[1].trim();
                const rel = path.relative(root, dir);
                (out.get(n) ?? out.set(n, []).get(n)).push(rel);
            }
            return;
        }
        for (const e of entries)
            if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
                walk(path.join(dir, e.name), depth + 1);
    };
    walk(root, 0);
    _namesOnDisk = out;
    return out;
}
/** Tests call this after changing the tree. */
export function _resetSkillDiskCache() { _namesOnDisk = null; }
export function listFileSkills() {
    try {
        const rows = getDb()
            .prepare('SELECT name, file_path, COALESCE(is_active,1) AS is_active, lifecycle_state, origin FROM skills_registry ORDER BY name')
            .all();
        const onDisk = namesOnDisk();
        return rows.map((r) => {
            const p = String(r.file_path ?? '');
            const dir = p.replace(/\/?SKILL\.md$/, '');
            const abs = p.startsWith('/') ? p : path.join(skillsRoot(), p);
            const others = (onDisk.get(r.name) ?? []).filter((d) => d !== dir);
            return {
                kind: 'file', name: r.name, path: p, dir, active: r.is_active !== 0,
                lifecycle: r.lifecycle_state, origin: r.origin,
                outsideSkillsRoot: p.startsWith('/'),
                stale: !existsSync(abs),
                duplicateOf: others[0] ?? null,
            };
        });
    }
    catch {
        return [];
    }
}
export function listConsoleSkills() {
    try {
        const rows = getGatewayDb()
            .prepare('SELECT id, name, display_name, schedule_cron, COALESCE(is_active,1) AS is_active FROM skills_meta ORDER BY name')
            .all();
        return rows.map((r) => ({
            kind: 'console', name: r.name, id: r.id, displayName: r.display_name || r.name,
            scheduleCron: r.schedule_cron, active: r.is_active !== 0,
        }));
    }
    catch {
        return [];
    }
}
/**
 * The union. A name present in BOTH systems is reported ONCE, under a
 * `collisions` list, and appears in neither lane — the same ambiguity rule
 * `classifySkill` applies, so a listing cannot show a skill the classifier
 * refuses to identify.
 */
export function listAllSkills() {
    const files = listFileSkills();
    const consoles = listConsoleSkills();
    const fileNames = new Set(files.map((f) => f.name));
    const collisions = consoles.filter((c) => fileNames.has(c.name)).map((c) => c.name);
    const bad = new Set(collisions);
    return {
        skills: [...files.filter((f) => !bad.has(f.name)), ...consoles.filter((c) => !bad.has(c.name))],
        collisions,
    };
}
/**
 * Registry name for a skill found on DISK by `skill-discovery` (which keys on
 * directory). This is the bridge that makes the two identities agree: the
 * three `templates/` skills resolve to their frontmatter names through it.
 */
export function registryNameForDir(dir) {
    const want = dir.replace(/\/+$/, '');
    const hit = listFileSkills().find((f) => f.dir === want || f.dir.endsWith('/' + want));
    if (hit)
        return hit.name;
    // The registry does not point here. Read what the directory SAYS it is; if a
    // row exists under that name, this directory is a duplicate of it — which is
    // reported on the ref, not hidden by resolving. `board-worker` twice on disk.
    const md = path.join(skillsRoot(), want, 'SKILL.md');
    if (!existsSync(md))
        return null;
    const m = /^name:\s*(.+)$/m.exec(readFileSync(md, 'utf-8').slice(0, 4000));
    const named = m ? m[1].trim() : null;
    return named && classify(named)?.kind === 'file' ? named : null;
}
