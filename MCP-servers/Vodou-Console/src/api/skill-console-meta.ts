/**
 * Skill Console — aggregate schedule hints for web UI (next run, cron expr).
 * Joins gateway.db (skills_meta + bindings) with vodou-core scheduled_tasks.
 */

import { Router, Request, Response } from 'express';
import { getDb, getGatewayDb } from '../db.js';
import { skillConsoleCreateRouter } from './skill-console-create.js';

export const skillConsoleMetaRouter = Router();

type BindingRow = {
  conversation_id: string;
  skill_name: string;
  display_name: string | null;
  schedule_cron: string | null;
  skill_id: number;
};

/**
 * Stamp `source = 'skill-console'` (and a real title) on every BOUND
 * conversation that is missing it.
 *
 * The dock decides what a tab IS from `gateway_conversations.source`, and only
 * ONE writer ever set it: the create wizard (`skill-console-create.ts`). A skill
 * registered any other way — SQL, a migration, an agent inserting into
 * skills_meta + skill_console_bindings — got its conversation row auto-created
 * by the first delivered message as a plain `source='web'` / 'New Chat' row, so
 * it never appeared in the dock's skill tier even though the binding, the
 * schedule and the runs were all correct. A guard in one producer is not a rule.
 *
 * Idempotent, and deliberately conservative on the title: only a blank or
 * default 'New Chat'/'Chat 2' title is overwritten, so a title the user set by
 * hand survives.
 */
function healBoundConversations(gdb: ReturnType<typeof getGatewayDb>, bindings: BindingRow[]): number {
  let healed = 0;
  const get = gdb.prepare('SELECT source, title FROM gateway_conversations WHERE id = ?');
  const fixSource = gdb.prepare("UPDATE gateway_conversations SET source = 'skill-console' WHERE id = ?");
  const fixTitle = gdb.prepare('UPDATE gateway_conversations SET title = ? WHERE id = ?');
  for (const b of bindings) {
    const row = get.get(b.conversation_id) as { source?: string; title?: string } | undefined;
    if (!row) continue; // conversation not created yet — nothing to stamp
    if (row.source !== 'skill-console') {
      fixSource.run(b.conversation_id);
      healed++;
    }
    const title = String(row.title || '').trim();
    const isDefaultTitle = !title || /^(new chat|chat\s*\d*)$/i.test(title);
    const display = (b.display_name || '').trim();
    if (isDefaultTitle && display) fixTitle.run(display.slice(0, 80), b.conversation_id);
  }
  if (healed > 0) {
    console.error(`[skill-console] healed ${healed} bound conversation(s) missing source='skill-console'`);
  }
  return healed;
}

type TaskRow = {
  name: string;
  schedule: string | null;
  next_run_at: string | null;
  enabled: number | null;
};

skillConsoleMetaRouter.get('/meta', (_req: Request, res: Response) => {
  try {
    const gdb = getGatewayDb();
    const bindings = gdb
      .prepare(
        `SELECT b.conversation_id AS conversation_id,
                m.name AS skill_name,
                m.display_name AS display_name,
                m.schedule_cron AS schedule_cron,
                m.id AS skill_id
         FROM skill_console_bindings b
         JOIN skills_meta m ON m.id = b.skill_id`
      )
      .all() as BindingRow[];

    // The dock reads `source` to decide a tab is a skill console; stamp any
    // binding whose conversation was created by another writer. See above.
    healBoundConversations(gdb, bindings);

    let tasks: TaskRow[] = [];
    try {
      tasks = getDb()
        .prepare(
          `SELECT name, schedule, next_run_at, enabled
           FROM scheduled_tasks
           WHERE name GLOB 'skill:*'`
        )
        .all() as TaskRow[];
    } catch {
      tasks = [];
    }

    const taskBySkill = new Map<string, TaskRow>();
    for (const t of tasks) {
      if (!t.name || !t.name.startsWith('skill:')) continue;
      taskBySkill.set(t.name.slice('skill:'.length), t);
    }

    const items = bindings.map((b) => {
      const t = taskBySkill.get(b.skill_name);
      return {
        conversationId: b.conversation_id,
        skillName: b.skill_name,
        skillId: b.skill_id,
        scheduleCron: b.schedule_cron ?? (t?.schedule ?? null),
        nextRunAt: t?.next_run_at ?? null,
        scheduleEnabled: t?.enabled === undefined || t?.enabled === null ? null : !!t.enabled,
      };
    });

    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * PLAN-ALPHA F5 — the standing agents, with their last outcome.
 *
 * `public/js/views/skills.js` reads `/api/skills` (the skills_registry lane) and
 * had ZERO references to `skills_meta`. So the four things this product is
 * actually about — morning-briefing, daily-cto-job-search, vodou-channel-finder,
 * daily-competitor-intel — did not appear anywhere in the Skills view. A
 * stranger opening it saw everything except the agents that were running.
 *
 * Distinct from /meta, which answers "when does this fire next" for the console
 * tab. This answers "what do I have, and did it work last time" — which needs
 * `scheduled_task_runs`, the outcome table added in step 3.
 */
skillConsoleMetaRouter.get('/list', (_req: Request, res: Response) => {
  try {
    const gdb = getGatewayDb();
    const skills = gdb
      .prepare(
        `SELECT m.id, m.name, m.display_name, m.schedule_cron, m.delivery_mode,
                m.delivery_target, m.is_active, m.required_tools,
                b.conversation_id AS conversation_id
           FROM skills_meta m
           LEFT JOIN skill_console_bindings b ON b.skill_id = m.id
          ORDER BY m.is_active DESC, m.name`
      )
      .all() as Array<Record<string, unknown>>;

    // Last outcome per skill. Read best-effort: this table arrived in migration
    // 086, and an install that has not run it yet must still see its agents
    // rather than a 500 — the list is the point, the outcome is the garnish.
    const lastRun = new Map<string, Record<string, unknown>>();
    try {
      const rows = getDb()
        .prepare(
          `SELECT task_name, status, reason, output_chars, delivery_ok, lateness_s, started_at
             FROM scheduled_task_runs
            WHERE id IN (SELECT MAX(id) FROM scheduled_task_runs GROUP BY task_name)`
        )
        .all() as Array<Record<string, unknown>>;
      for (const r of rows) {
        const n = String(r.task_name ?? '');
        if (n.startsWith('skill:')) lastRun.set(n.slice('skill:'.length), r);
      }
    } catch { /* table not present yet — omit outcomes */ }

    let tasks: TaskRow[] = [];
    try {
      tasks = getDb()
        .prepare(`SELECT name, schedule, next_run_at, enabled FROM scheduled_tasks WHERE name GLOB 'skill:*'`)
        .all() as TaskRow[];
    } catch { tasks = []; }
    const taskBySkill = new Map<string, TaskRow>();
    for (const t of tasks) {
      if (t.name?.startsWith('skill:')) taskBySkill.set(t.name.slice('skill:'.length), t);
    }

    const items = skills.map((m) => {
      const name = String(m.name ?? '');
      const t = taskBySkill.get(name);
      const r = lastRun.get(name);
      let declaredTools: string[] = [];
      try {
        const parsed = JSON.parse(String(m.required_tools ?? '[]'));
        if (Array.isArray(parsed)) declaredTools = parsed.map(String);
      } catch { declaredTools = []; }
      return {
        id: m.id,
        name,
        displayName: m.display_name ?? name,
        conversationId: m.conversation_id ?? null,
        // The SCHEDULER's copy wins, because it is the one that actually fires.
        // These two records can disagree — morning-briefing carries `0 13 * * *`
        // in skills_meta while scheduled_tasks says `5 13 * * *`, and 13:05 is
        // what really happens. Showing the skills_meta value would print a time
        // the product does not honour, which is worse than showing nothing.
        scheduleCron: t?.schedule ?? m.schedule_cron ?? null,
        // Surfaced rather than silently resolved: a disagreement between the two
        // records is a finding about this install, not a display detail.
        scheduleCronMismatch:
          t?.schedule && m.schedule_cron && t.schedule !== m.schedule_cron
            ? String(m.schedule_cron)
            : null,
        nextRunAt: t?.next_run_at ?? null,
        scheduleEnabled: t?.enabled === undefined || t?.enabled === null ? null : !!t.enabled,
        isActive: !!m.is_active,
        deliveryMode: m.delivery_mode ?? 'console',
        deliveryTarget: m.delivery_target ?? null,
        declaredTools,
        lastRun: r
          ? {
              status: r.status,
              reason: r.reason ?? null,
              outputChars: r.output_chars ?? null,
              deliveryOk: r.delivery_ok === null || r.delivery_ok === undefined ? null : !!r.delivery_ok,
              latenessS: r.lateness_s ?? null,
              startedAt: r.started_at ?? null,
            }
          : null,
      };
    });

    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** For /refine confirmation UI — current live template vs proposed body. */
skillConsoleMetaRouter.get('/prompt-template', (req: Request, res: Response) => {
  const raw = req.query.conversationId;
  const conversationId = typeof raw === 'string' ? raw.trim() : '';
  if (!conversationId.startsWith('workbench:skill-console:')) {
    res.status(400).json({ error: 'conversationId must be a skill-console workbench id' });
    return;
  }
  try {
    const gdb = getGatewayDb();
    const row = gdb
      .prepare(
        `SELECT m.prompt_template AS prompt_template,
                m.name AS skill_name,
                m.display_name AS display_name
         FROM skill_console_bindings b
         JOIN skills_meta m ON m.id = b.skill_id
         WHERE b.conversation_id = ?
         LIMIT 1`
      )
      .get(conversationId) as
      | { prompt_template: string; skill_name: string; display_name: string | null }
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'No skill bound to this conversation' });
      return;
    }
    res.json({
      conversationId,
      skillName: row.skill_name,
      displayName: row.display_name,
      promptTemplate: row.prompt_template ?? '',
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Create + draft POST routes — nested so one `app.use('/api/skill-console', …)` mount always dispatches. */
skillConsoleMetaRouter.use(skillConsoleCreateRouter);
