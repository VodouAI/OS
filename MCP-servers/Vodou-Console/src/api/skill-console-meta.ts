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
  schedule_cron: string | null;
  skill_id: number;
};

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
                m.schedule_cron AS schedule_cron,
                m.id AS skill_id
         FROM skill_console_bindings b
         JOIN skills_meta m ON m.id = b.skill_id`
      )
      .all() as BindingRow[];

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
