/**
 * Scheduler API — CRUD for scheduled_tasks table
 */

import { Router, Request, Response } from 'express';
import { getDb } from '../db.js';

export const schedulerRouter = Router();

// Valid payload types and their schemas
const PAYLOAD_TYPES: Record<string, { description: string; payloadHint: string }> = {
  query:        { description: 'Natural language query routed through BrainLoader', payloadHint: 'Any natural language text' },
  gateway_chat: { description: 'POST to gateway /chat/heartbeat (LLM conversation)', payloadHint: 'Message text for the LLM' },
  skill:        { description: 'Invoke a skill by name', payloadHint: 'skill_name [args]' },
  script:       { description: 'Run a script via Vodou-script-executor', payloadHint: 'script command or path' },
  webhook:      { description: 'HTTP request to a URL', payloadHint: 'URL or {"url":"...","method":"POST","headers":{},"body":"..."}' },
  health_check: { description: 'HTTP health check with expected status', payloadHint: 'URL or {"url":"...","expected_status":200}' },
  memory_query: { description: 'Search memory.db and alert on threshold', payloadHint: 'search term or {"pattern":"...","threshold":5}' },
  mcp_tool:     { description: 'Call a tool on a connected integration', payloadHint: '{"server":"cloudflare","tool":"search","args":{...}}' },
};

// GET /api/scheduler/types — list available payload types
schedulerRouter.get('/types', (_req: Request, res: Response) => {
  res.json(PAYLOAD_TYPES);
});

function worstScheduleStatus(tasks: { enabled?: number; next_run_at?: string | null }[]): 'ok' | 'warn' | 'error' {
  const now = Date.now();
  let w: 'ok' | 'warn' | 'error' = 'ok';
  for (const t of tasks) {
    if (!t.enabled) continue;
    if (!t.next_run_at) continue;
    const next = new Date(t.next_run_at).getTime();
    if (!Number.isFinite(next)) continue;
    if (next < now - 120000) w = w === 'error' ? 'error' : 'warn';
  }
  return w;
}

// GET /api/scheduler — list all scheduled tasks + sidebar schedule summary
schedulerRouter.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tasks = db.prepare(
      `SELECT id, name, schedule, schedule_type, payload_type, payload,
              enabled, one_shot, next_run_at, created_at, last_run_at
       FROM scheduled_tasks
       ORDER BY name ASC`
    ).all() as { enabled?: number; next_run_at?: string | null }[];

    res.json({
      tasks,
      worst_schedule_status: worstScheduleStatus(tasks),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/scheduler — add new scheduled task
schedulerRouter.post('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { name, schedule, schedule_type, payload_type, payload, enabled, one_shot } = req.body;

    if (!name || !schedule || !payload) {
      res.status(400).json({ error: 'name, schedule, and payload are required' });
      return;
    }

    const ptype = payload_type || 'query';
    if (!PAYLOAD_TYPES[ptype]) {
      res.status(400).json({ error: `Invalid payload_type "${ptype}". Valid types: ${Object.keys(PAYLOAD_TYPES).join(', ')}` });
      return;
    }

    const result = db.prepare(
      `INSERT INTO scheduled_tasks (name, schedule, schedule_type, payload_type, payload, enabled, one_shot)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      name,
      schedule,
      schedule_type || 'cron',
      ptype,
      payload,
      enabled !== undefined ? (enabled ? 1 : 0) : 1,
      one_shot ? 1 : 0
    );

    const task = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(result.lastInsertRowid);
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/scheduler/:id/toggle — flip enabled
schedulerRouter.post('/:id/toggle', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { id } = req.params;

    const task = db.prepare('SELECT id, enabled FROM scheduled_tasks WHERE id = ?').get(id) as any;
    if (!task) {
      res.status(404).json({ error: `Task ${id} not found` });
      return;
    }

    const newEnabled = task.enabled ? 0 : 1;
    db.prepare('UPDATE scheduled_tasks SET enabled = ? WHERE id = ?').run(newEnabled, id);

    res.json({ id: task.id, enabled: newEnabled });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/scheduler/:id/history — execution history for a task
schedulerRouter.get('/:id/history', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { id } = req.params;

    const task = db.prepare('SELECT name FROM scheduled_tasks WHERE id = ?').get(id) as any;
    if (!task) {
      res.status(404).json({ error: `Task ${id} not found` });
      return;
    }

    // Check work_logs for scheduler-related entries mentioning this task
    let history: any[] = [];
    try {
      history = db.prepare(
        `SELECT timestamp, message, metadata
         FROM work_logs
         WHERE (category = 'scheduler' OR category = 'schedule')
           AND (message LIKE ? OR message LIKE ?)
         ORDER BY timestamp DESC LIMIT 20`
      ).all(`%${task.name}%`, `%task_id:${id}%`);
    } catch {
      // work_logs may not have these entries
    }

    // Also include task-level status info
    const taskInfo = db.prepare(
      'SELECT last_run_at, next_run_at FROM scheduled_tasks WHERE id = ?'
    ).get(id) as any;

    res.json({
      task_name: task.name,
      last_run_at: taskInfo?.last_run_at || null,
      next_run_at: taskInfo?.next_run_at || null,
      history,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/scheduler/:id — remove task
schedulerRouter.delete('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { id } = req.params;

    const result = db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
    if (result.changes === 0) {
      res.status(404).json({ error: `Task ${id} not found` });
      return;
    }

    res.json({ success: true, deleted: parseInt(id) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
