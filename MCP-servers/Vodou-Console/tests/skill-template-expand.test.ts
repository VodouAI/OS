import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { DB } from '../src/db.js';
import {
  mergeSkillParams,
  parseInvokePipeArgs,
  parseRunCommand,
  expandSkillPrompt,
} from '../src/api/skill-template-expand.js';

describe('mergeSkillParams', () => {
  it('merges schema defaults, saved overrides, then run', () => {
    const params = JSON.stringify([{ name: 'topic', default: 'x' }]);
    const over = JSON.stringify({ topic: 'saved' });
    const m = mergeSkillParams(params, over, { topic: 'run' });
    expect(m.topic).toBe('run');
  });
  it('object-shaped parameters_json', () => {
    const params = JSON.stringify({ city: 'Boston' });
    expect(mergeSkillParams(params, null, {}).city).toBe('Boston');
  });
});

describe('parseInvokePipeArgs', () => {
  it('parses pipe segments', () => {
    expect(parseInvokePipeArgs('topic=foo|user_message=bar')).toEqual({
      topic: 'foo',
      user_message: 'bar',
    });
  });
  it('ignores invalid keys', () => {
    expect(parseInvokePipeArgs('bad key=1')).toEqual({});
  });
});

describe('parseRunCommand', () => {
  it('extracts k=v pairs and rest', () => {
    const r = parseRunCommand('/run topic=hello there world');
    expect(r).not.toBeNull();
    expect(r!.overrides.topic).toBe('hello');
    expect(r!.rest).toBe('there world');
  });
  it('returns null for non-/run', () => {
    expect(parseRunCommand('hello')).toBeNull();
  });
});

describe('expandSkillPrompt', () => {
  let db: DB;

  beforeEach(() => {
    const raw = new DatabaseSync(':memory:');
    raw.exec(`
      CREATE TABLE skills_meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        prompt_template TEXT,
        parameters_json TEXT,
        param_overrides_json TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        principal_id TEXT NOT NULL
      );
    `);
    db = raw as unknown as DB;
    raw
      .prepare(
        `INSERT INTO skills_meta (name, prompt_template, parameters_json, param_overrides_json, is_active, principal_id)
         VALUES ('child', 'Child says: {{user_message}}', NULL, NULL, 1, 'p1')`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO skills_meta (name, prompt_template, parameters_json, param_overrides_json, is_active, principal_id)
         VALUES ('parent', 'P {{invoke_skill:child}} end', NULL, NULL, 1, 'p1')`,
      )
      .run();
  });

  it('expands invoke_skill inline', () => {
    const parent = (db as unknown as DatabaseSync)
      .prepare(`SELECT id FROM skills_meta WHERE name = 'parent'`)
      .get() as { id: number };
    const out = expandSkillPrompt(db, {
      template: 'P {{invoke_skill:child}} end',
      conversationId: 'workbench:skill-console:parent',
      userMessage: 'hi',
      history: '',
      principalId: 'p1',
      parametersJson: null,
      paramOverridesJson: null,
      runParamOverrides: {},
      skillId: parent.id,
    });
    expect(out).toBe('P Child says: hi end');
  });

  it('substitutes param placeholders', () => {
    const row = (db as unknown as DatabaseSync)
      .prepare(`SELECT id FROM skills_meta WHERE name = 'parent'`)
      .get() as { id: number };
    (db as unknown as DatabaseSync)
      .prepare(`UPDATE skills_meta SET prompt_template = ? WHERE id = ?`)
      .run('Topic: {{param:topic}}', row.id);
    const out = expandSkillPrompt(db, {
      template: 'Topic: {{param:topic}}',
      conversationId: 'c',
      userMessage: '',
      history: '',
      principalId: 'p1',
      parametersJson: JSON.stringify([{ name: 'topic', default: 'none' }]),
      paramOverridesJson: JSON.stringify({ topic: 'AI' }),
      runParamOverrides: {},
      skillId: row.id,
    });
    expect(out).toBe('Topic: AI');
  });
});
