import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { DB } from '../src/db.js';

const vodouMocks = vi.hoisted(() => ({
  listSchedule: vi.fn().mockResolvedValue({ tasks: [] as Array<{ id: number; name: string }> }),
  removeScheduleTask: vi.fn().mockResolvedValue(undefined),
  addScheduleTask: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/core-client.js', () => ({
  VodouCore: {
    listSchedule: (...args: unknown[]) => vodouMocks.listSchedule(...args),
    removeScheduleTask: (...args: unknown[]) => vodouMocks.removeScheduleTask(...args),
    addScheduleTask: (...args: unknown[]) => vodouMocks.addScheduleTask(...args),
    callTool: vi.fn(async () => ({ result: '{}' })),
    memoryRecall: vi.fn(async () => ({ items: [] })),
  },
}));

import {
  lookupSkillBinding,
  renderTemplate,
  loadHistoryWindow,
  parseDeliveryTarget,
  disableEphemeralSkill,
  handleSlashCommand,
  buildSkillChatArgs,
  type SkillRow,
} from '../src/api/skill-console-handler.js';

const BASE_TEMPLATE =
  'You are a test skill. User: {{user_message}} (min len for gates)';

function createGatewaySchema(raw: DatabaseSync): void {
  raw.exec(`
    CREATE TABLE skills_meta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      prompt_template TEXT NOT NULL,
      schedule_cron TEXT,
      output_format TEXT NOT NULL DEFAULT 'markdown',
      is_active INTEGER NOT NULL DEFAULT 1,
      principal_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      prompt_history TEXT,
      prefer_model TEXT,
      delivery_mode TEXT NOT NULL DEFAULT 'console',
      delivery_target TEXT,
      required_tools TEXT,
      parameters_json TEXT,
      param_overrides_json TEXT,
      on_complete_hook TEXT,
      history_window INTEGER NOT NULL DEFAULT 0,
      ephemeral INTEGER NOT NULL DEFAULT 0,
      stopping_points_json TEXT,
      current_phase INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE skill_console_bindings (
      conversation_id TEXT PRIMARY KEY,
      skill_id INTEGER NOT NULL UNIQUE,
      FOREIGN KEY (skill_id) REFERENCES skills_meta(id) ON DELETE CASCADE
    );
    CREATE TABLE gateway_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL
    );
    CREATE TABLE gateway_conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      source TEXT,
      sender_name TEXT,
      conversation_type TEXT DEFAULT 'chat',
      principal_id TEXT
    );
  `);
}

function insertSkill(
  raw: DatabaseSync,
  opts: { name?: string; ephemeral?: number; history_window?: number } = {},
): { convId: string; db: DB } {
  const name = opts.name ?? 'test-skill';
  const convId = `workbench:skill-console:${name}`;
  raw
    .prepare(
      `INSERT INTO skills_meta (
        name, display_name, prompt_template, principal_id, is_active,
        history_window, ephemeral, parameters_json, param_overrides_json, on_complete_hook,
        stopping_points_json, current_phase
      ) VALUES (?, ?, ?, ?, 1, ?, ?, NULL, NULL, NULL, NULL, 0)`,
    )
    .run(
      name,
      'Test Skill',
      BASE_TEMPLATE,
      'principal-test',
      opts.history_window ?? 0,
      opts.ephemeral ?? 0,
    );
  const row = raw.prepare(`SELECT id FROM skills_meta WHERE name = ?`).get(name) as { id: number };
  raw.prepare(`INSERT INTO skill_console_bindings (conversation_id, skill_id) VALUES (?, ?)`).run(
    convId,
    row.id,
  );
  return { convId, db: raw as unknown as DB };
}

describe('skill-console-handler routing helpers', () => {
  let raw: DatabaseSync;

  beforeEach(() => {
    raw = new DatabaseSync(':memory:');
    createGatewaySchema(raw);
    vi.clearAllMocks();
    vodouMocks.listSchedule.mockResolvedValue({ tasks: [] });
  });

  it('lookupSkillBinding returns null when unbound', () => {
    const db = raw as unknown as DB;
    expect(lookupSkillBinding(db, 'workbench:skill-console:nope')).toBeNull();
  });

  it('lookupSkillBinding returns skill row including disabled skills', () => {
    const { convId, db } = insertSkill(raw);
    raw.prepare(`UPDATE skills_meta SET is_active = 0 WHERE name = 'test-skill'`).run();
    const row = lookupSkillBinding(db, convId);
    expect(row).not.toBeNull();
    expect(row!.is_active).toBe(0);
    expect(row!.name).toBe('test-skill');
  });

  it('renderTemplate substitutes user_message history and conversation_id', () => {
    const out = renderTemplate('{{user_message}} | {{history}} | {{conversation_id}}', {
      userMessage: 'hi',
      conversationId: 'c1',
      history: 'H',
    });
    expect(out).toContain('hi');
    expect(out).toContain('H');
    expect(out).toContain('c1');
  });

  it('loadHistoryWindow formats recent gateway_messages', () => {
    const { convId, db } = insertSkill(raw);
    raw
      .prepare(`INSERT INTO gateway_messages (conversation_id, role, content) VALUES (?, 'user', ?)`)
      .run(convId, 'first');
    raw
      .prepare(`INSERT INTO gateway_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)`)
      .run(convId, 'second');
    const hist = loadHistoryWindow(db, convId, 2);
    expect(hist).toContain('User: first');
    expect(hist).toContain('Assistant: second');
  });

  it('parseDeliveryTarget parses source:recipient', () => {
    expect(parseDeliveryTarget('slack:C123')).toEqual({ source: 'slack', recipient: 'C123' });
    expect(parseDeliveryTarget('bad')).toBeNull();
    expect(parseDeliveryTarget(null)).toBeNull();
  });

  it('disableEphemeralSkill flips is_active for ephemeral rows', () => {
    const { db } = insertSkill(raw, { ephemeral: 1 });
    const skill = lookupSkillBinding(db, `workbench:skill-console:test-skill`)!;
    expect(disableEphemeralSkill(db, skill.id)).toBe(true);
    const after = lookupSkillBinding(db, `workbench:skill-console:test-skill`)!;
    expect(after.is_active).toBe(0);
  });
});

describe('handleSlashCommand', () => {
  let raw: DatabaseSync;
  let db: DB;
  let skill: SkillRow;
  const convId = 'workbench:skill-console:slash-skill';

  beforeEach(() => {
    raw = new DatabaseSync(':memory:');
    createGatewaySchema(raw);
    raw
      .prepare(
        `INSERT INTO skills_meta (
        name, display_name, prompt_template, principal_id, is_active,
        history_window, ephemeral, parameters_json, param_overrides_json, on_complete_hook,
        stopping_points_json, current_phase
      ) VALUES ('slash-skill', 'Slash', ?, 'p1', 1, 0, 0, NULL, NULL, NULL, NULL, 0)`,
      )
      .run(BASE_TEMPLATE);
    const { id } = raw.prepare(`SELECT id FROM skills_meta WHERE name = 'slash-skill'`).get() as {
      id: number;
    };
    raw.prepare(`INSERT INTO skill_console_bindings (conversation_id, skill_id) VALUES (?, ?)`).run(
      convId,
      id,
    );
    db = raw as unknown as DB;
    skill = lookupSkillBinding(db, convId)!;
    vi.clearAllMocks();
    vodouMocks.listSchedule.mockResolvedValue({ tasks: [] });
  });

  it('returns null for non-slash messages (caller uses generic chat)', async () => {
    expect(await handleSlashCommand(db, skill, convId, 'hello')).toBeNull();
  });

  it('/help includes skill name and slash list', async () => {
    const r = await handleSlashCommand(db, skill, convId, '/help');
    expect(r).not.toBeNull();
    expect(r!.response).toContain('slash-skill');
    expect(r!.response).toContain('/refine');
  });

  it('unknown slash returns null (falls through to LLM/server routing)', async () => {
    const r = await handleSlashCommand(db, skill, convId, '/nope');
    expect(r).toBeNull();
  });

  it('/refine updates prompt_template and appends prompt_history', async () => {
    const newT =
      '{{user_message}} refined template body xxxxxxxxxxxxxxxxxxxxx';
    const r = await handleSlashCommand(db, skill, convId, `/refine ${newT}`);
    expect(r!.skillRefreshed).toBe(true);
    const row = raw.prepare(`SELECT prompt_template, prompt_history FROM skills_meta WHERE id = ?`).get(
      skill.id,
    ) as { prompt_template: string; prompt_history: string | null };
    expect(row.prompt_template).toBe(newT);
    expect(row.prompt_history).toContain(BASE_TEMPLATE);
  });

  it('/refine auto-appends {{user_message}} when the template omits it', async () => {
    const noPlaceholder = 'Summarize the latest project status in three bullets.';
    const r = await handleSlashCommand(db, skill, convId, `/refine ${noPlaceholder}`);
    expect(r!.skillRefreshed).toBe(true);
    const row = raw.prepare(`SELECT prompt_template FROM skills_meta WHERE id = ?`).get(
      skill.id,
    ) as { prompt_template: string };
    expect(row.prompt_template).toContain('{{user_message}}');
    expect(row.prompt_template.startsWith(noPlaceholder)).toBe(true);
  });

  it('/disable then /enable toggles is_active', async () => {
    let r = await handleSlashCommand(db, skill, convId, '/disable');
    expect(r!.skillRefreshed).toBe(true);
    let bound = lookupSkillBinding(db, convId)!;
    expect(bound.is_active).toBe(0);

    r = await handleSlashCommand(db, bound, convId, '/enable');
    expect(r!.skillRefreshed).toBe(true);
    bound = lookupSkillBinding(db, convId)!;
    expect(bound.is_active).toBe(1);
  });

  it('/cron @hourly registers schedule via VodouCore', async () => {
    const r = await handleSlashCommand(db, skill, convId, '/cron @hourly');
    expect(r!.skillRefreshed).toBe(true);
    expect(vodouMocks.addScheduleTask).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'skill:slash-skill',
        schedule_type: 'cron',
        payload_type: 'skill_run',
      }),
    );
    const cron = raw.prepare(`SELECT schedule_cron FROM skills_meta WHERE id = ?`).get(skill.id) as {
      schedule_cron: string;
    };
    expect(cron.schedule_cron).toBe('@hourly');
  });
});

describe('buildSkillChatArgs (simple template path)', () => {
  it('injects user message into template without LLM', async () => {
    const raw = new DatabaseSync(':memory:');
    createGatewaySchema(raw);
    const { convId, db } = insertSkill(raw);
    const skill = lookupSkillBinding(db, convId)!;
    const built = await buildSkillChatArgs(db, convId, 'yo', skill, {});
    expect(built.renderedPrompt).toContain('yo');
    expect(built.renderedPrompt).not.toContain('{{user_message}}');
  });
});
