/**
 * Scheduler API — CRUD for scheduled_tasks table
 */
import { Router } from 'express';
import { getDb } from '../db.js';
import { runVodouCoreCallTool } from '../executor.js';
import { slugifySkillConsoleName } from './skill-console-create.js';
import { getTaskProjectMap, setTaskProject } from '../projects-store.js';
import { ensureConversation, setConversationProject } from '../conversation-store.js';
export const schedulerRouter = Router();
/**
 * A task is "system/infra" (never project-scoped) unless it is a user-facing
 * skill console or has been explicitly tagged to a project. Skill consoles are
 * payload_type='skill_run' (or legacy `skill:` names). Everything else —
 * memory-*, vodou-heartbeat, skill-proposer/optimizer — is the shared brain's
 * own machinery and shows in a System section, not under any project.
 */
function isSystemTask(t, mapped) {
    if (mapped)
        return false;
    if (t.payload_type === 'skill_run')
        return false;
    if (typeof t.name === 'string' && t.name.startsWith('skill:'))
        return false;
    return true;
}
/** Annotate tasks with is_system + project_id (from the gateway mapping; unmapped
 *  user tasks default to proj_default; system tasks get null). */
function annotateTasks(tasks) {
    const map = getTaskProjectMap();
    for (const t of tasks) {
        const mappedProject = map.get(t.id);
        const system = isSystemTask(t, mappedProject !== undefined);
        t.is_system = system;
        t.project_id = system ? null : (mappedProject ?? 'proj_default');
    }
    return tasks;
}
// Valid payload types and their schemas
const PAYLOAD_TYPES = {
    query: { description: 'Natural language query routed through BrainLoader', payloadHint: 'Any natural language text' },
    gateway_chat: { description: 'POST to gateway /chat/heartbeat (LLM conversation)', payloadHint: 'Message text for the LLM' },
    skill: { description: 'Invoke a skill by name', payloadHint: 'skill_name [args]' },
    script: { description: 'Run a script via Vodou-script-executor', payloadHint: 'script command or path' },
    webhook: { description: 'HTTP request to a URL', payloadHint: 'URL or {"url":"...","method":"POST","headers":{},"body":"..."}' },
    health_check: { description: 'HTTP health check with expected status', payloadHint: 'URL or {"url":"...","expected_status":200}' },
    memory_query: { description: 'Search memory.db and alert on threshold', payloadHint: 'search term or {"pattern":"...","threshold":5}' },
    mcp_tool: { description: 'Call a tool on a connected integration', payloadHint: '{"server":"cloudflare","tool":"search","args":{...}}' },
};
// GET /api/scheduler/types — list available payload types
schedulerRouter.get('/types', (_req, res) => {
    res.json(PAYLOAD_TYPES);
});
function worstScheduleStatus(tasks) {
    const now = Date.now();
    let w = 'ok';
    for (const t of tasks) {
        if (!t.enabled)
            continue;
        if (!t.next_run_at)
            continue;
        const next = new Date(t.next_run_at).getTime();
        if (!Number.isFinite(next))
            continue;
        if (next < now - 120000)
            w = w === 'error' ? 'error' : 'warn';
    }
    return w;
}
// GET /api/scheduler — list all scheduled tasks + sidebar schedule summary
schedulerRouter.get('/', (req, res) => {
    try {
        const db = getDb();
        const tasks = db.prepare(`SELECT id, name, schedule, schedule_type, payload_type, payload,
              enabled, one_shot, next_run_at, created_at, last_run_at
       FROM scheduled_tasks
       ORDER BY name ASC`).all();
        // Tag each task with is_system + project_id so the client can split a
        // System section from per-project user tasks (PLAN-PROJECT-SCOPED-DOCK P2).
        annotateTasks(tasks);
        res.json({
            tasks,
            worst_schedule_status: worstScheduleStatus(tasks),
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// POST /api/scheduler — add new scheduled task
schedulerRouter.post('/', async (req, res) => {
    try {
        const db = getDb();
        const { name, schedule, schedule_type, payload_type, payload, enabled, one_shot, surface, project_id } = req.body;
        if (!name || !schedule || !payload) {
            res.status(400).json({ error: 'name, schedule, and payload are required' });
            return;
        }
        const ptype = payload_type || 'query';
        if (!PAYLOAD_TYPES[ptype]) {
            res.status(400).json({ error: `Invalid payload_type "${ptype}". Valid types: ${Object.keys(PAYLOAD_TYPES).join(', ')}` });
            return;
        }
        // Surface user-created `query` tasks as automated skill-console tabs (first
        // dock group, with Heartbeat/Board) so their runs are visible and results
        // render into a tab instead of being discarded. Routing through
        // vc_skills_create reuses the whole skill-console pipeline (skills_meta +
        // conversation + binding + a payload_type='skill_run' scheduled task with a
        // computed next_run_at). Opt-in flag defaults on; only meaningful for the
        // NL `query` type on a cron schedule. On any failure we fall through to the
        // plain insert so task creation never breaks.
        const wantsTab = surface !== false && ptype === 'query'
            && (!schedule_type || schedule_type === 'cron');
        if (wantsTab) {
            try {
                let tmpl = String(payload).trim();
                if (tmpl.length >= 20) {
                    if (!/\{\{\s*user_message\s*\}\}/i.test(tmpl)) {
                        tmpl = `${tmpl}\n\nUser message: {{user_message}}`;
                    }
                    const out = await runVodouCoreCallTool('vc_skills_create', {
                        name: slugifySkillConsoleName(String(name)),
                        display_name: String(name).slice(0, 80),
                        prompt_template: tmpl,
                        output_format: 'markdown',
                        delivery_mode: 'console',
                        schedule_cron: String(schedule),
                    });
                    const convMatch = /workbench:skill-console:[a-z0-9-]+/.exec(out);
                    const idMatch = /\(id=(\d+)\)/.exec(out);
                    // Scope this scheduled skill-console to the active project (P2): its
                    // dock tab (the conversation) AND its Scheduled-list row both follow
                    // the project it was created in. Best-effort — never break creation.
                    if (project_id && project_id !== 'proj_default') {
                        try {
                            if (convMatch) {
                                ensureConversation(convMatch[0], String(name).slice(0, 80), 'skill-console', undefined, project_id);
                                setConversationProject(convMatch[0], project_id);
                            }
                            const slug = slugifySkillConsoleName(String(name));
                            const taskRow = db.prepare("SELECT id FROM scheduled_tasks WHERE payload_type = 'skill_run' AND (name LIKE ? OR payload LIKE ?) ORDER BY id DESC LIMIT 1").get(`%${slug}%`, `%${slug}%`);
                            if (taskRow?.id)
                                setTaskProject(taskRow.id, project_id);
                        }
                        catch (e) {
                            console.error('[scheduler] project-tag surfaced skill-console failed:', e.message);
                        }
                    }
                    res.json({
                        ok: true,
                        surfaced: true,
                        name,
                        conversationId: convMatch ? convMatch[0] : null,
                        skillId: idMatch ? parseInt(idMatch[1], 10) : null,
                        raw: out,
                    });
                    return;
                }
                // payload too short to be a valid skill prompt — fall through to plain insert
            }
            catch (e) {
                console.error('[scheduler] surface-as-skill failed, falling back to plain task:', e.message);
                // fall through to plain insert below
            }
        }
        const result = db.prepare(`INSERT INTO scheduled_tasks (name, schedule, schedule_type, payload_type, payload, enabled, one_shot)
       VALUES (?, ?, ?, ?, ?, ?, ?)`).run(name, schedule, schedule_type || 'cron', ptype, payload, enabled !== undefined ? (enabled ? 1 : 0) : 1, one_shot ? 1 : 0);
        // Tag a plain (non-surfaced) user task with the active project (P2). We tag
        // even for proj_default — a mapping is what distinguishes a user task from
        // system/infra tasks (which are created by core, never through this route).
        if (project_id) {
            try {
                setTaskProject(Number(result.lastInsertRowid), project_id);
            }
            catch (e) {
                console.error('[scheduler] project-tag plain task failed:', e.message);
            }
        }
        const task = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(result.lastInsertRowid);
        res.json(task);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// PUT /api/scheduler/:id/project — move a task to a project ("" / proj_default = unassign).
schedulerRouter.put('/:id/project', (req, res) => {
    try {
        const db = getDb();
        const { id } = req.params;
        const task = db.prepare('SELECT id FROM scheduled_tasks WHERE id = ?').get(id);
        if (!task) {
            res.status(404).json({ error: `Task ${id} not found` });
            return;
        }
        setTaskProject(Number(id), (req.body || {}).project_id);
        res.json({ ok: true, task_id: Number(id), project_id: (req.body || {}).project_id || 'proj_default' });
    }
    catch (err) {
        res.status(400).json({ error: err.message });
    }
});
// POST /api/scheduler/:id/toggle — flip enabled
schedulerRouter.post('/:id/toggle', (req, res) => {
    try {
        const db = getDb();
        const { id } = req.params;
        const task = db.prepare('SELECT id, enabled FROM scheduled_tasks WHERE id = ?').get(id);
        if (!task) {
            res.status(404).json({ error: `Task ${id} not found` });
            return;
        }
        const newEnabled = task.enabled ? 0 : 1;
        db.prepare('UPDATE scheduled_tasks SET enabled = ? WHERE id = ?').run(newEnabled, id);
        res.json({ id: task.id, enabled: newEnabled });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// GET /api/scheduler/:id/history — execution history for a task
schedulerRouter.get('/:id/history', (req, res) => {
    try {
        const db = getDb();
        const { id } = req.params;
        const task = db.prepare('SELECT name FROM scheduled_tasks WHERE id = ?').get(id);
        if (!task) {
            res.status(404).json({ error: `Task ${id} not found` });
            return;
        }
        // Check work_logs for scheduler-related entries mentioning this task
        let history = [];
        try {
            history = db.prepare(`SELECT timestamp, message, metadata
         FROM work_logs
         WHERE (category = 'scheduler' OR category = 'schedule')
           AND (message LIKE ? OR message LIKE ?)
         ORDER BY timestamp DESC LIMIT 20`).all(`%${task.name}%`, `%task_id:${id}%`);
        }
        catch {
            // work_logs may not have these entries
        }
        // Also include task-level status info
        const taskInfo = db.prepare('SELECT last_run_at, next_run_at FROM scheduled_tasks WHERE id = ?').get(id);
        res.json({
            task_name: task.name,
            last_run_at: taskInfo?.last_run_at || null,
            next_run_at: taskInfo?.next_run_at || null,
            history,
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// POST /api/scheduler/:id/run — queue a task for immediate execution
schedulerRouter.post('/:id/run', (req, res) => {
    try {
        const db = getDb();
        const { id } = req.params;
        const task = db.prepare('SELECT id, name, enabled, one_shot, schedule, schedule_type FROM scheduled_tasks WHERE id = ?').get(id);
        if (!task) {
            res.status(404).json({ error: `Task ${id} not found` });
            return;
        }
        if (!task.enabled) {
            res.status(409).json({ error: `Task "${task.name}" is disabled. Enable it before running now.` });
            return;
        }
        // Queue the task to be picked up by the scheduler loop on the next tick.
        db.prepare('UPDATE scheduled_tasks SET next_run_at = datetime(\'now\') WHERE id = ?').run(id);
        res.json({
            ok: true,
            task_id: task.id,
            name: task.name,
            queued: true,
            note: 'Queued for immediate execution on next scheduler tick.',
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// DELETE /api/scheduler/:id — remove task
schedulerRouter.delete('/:id', (req, res) => {
    try {
        const db = getDb();
        const { id } = req.params;
        const result = db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
        if (result.changes === 0) {
            res.status(404).json({ error: `Task ${id} not found` });
            return;
        }
        // Drop any project mapping for the removed task (P2).
        try {
            setTaskProject(Number(id), null);
        }
        catch { /* best-effort */ }
        res.json({ success: true, deleted: parseInt(id) });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
