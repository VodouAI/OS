/**
 * Read-tool unit tests: board_show, board_list, board_search, board_assignees.
 * Uses _closeReadDb() between tests to reset the memoized db.ts handle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeBoardDb, type BoardDbHandle } from './fixtures.js';
import { _closeReadDb } from '../src/db.js';
import { handleShow } from '../src/tools/show.js';
import { handleList } from '../src/tools/list.js';
import { handleSearch } from '../src/tools/search.js';
import { handleAssignees } from '../src/tools/assignees.js';

let handle: BoardDbHandle | null = null;

beforeEach(() => {
  process.env.VODOU_BOARD_TASK = 't_test001';
});

afterEach(() => {
  _closeReadDb();  // reset memoized read connection
  delete process.env.VODOU_BOARD_TASK;
  handle?.cleanup();
  handle = null;
});

describe('board_show', () => {
  it('returns the full worker_context for an existing task', async () => {
    handle = makeBoardDb([
      { id: 't_test001', title: 'spike test', body: 'verify show', status: 'running', assignee: 'researcher', priority: 70 },
    ]);
    const r = await handleShow({});
    const ctx = JSON.parse(r.content[0].text);

    expect(ctx.task.id).toBe('t_test001');
    expect(ctx.task.title).toBe('spike test');
    expect(ctx.task.body).toBe('verify show');
    expect(ctx.task.assignee).toBe('researcher');
    expect(ctx.task.priority).toBe(70);
    expect(ctx.prior_attempts).toEqual([]);
    expect(ctx.parent_handoffs).toEqual([]);
    expect(ctx.role_history).toEqual([]);
    expect(ctx.comments).toEqual([]);
    expect(ctx.memory).toEqual([]);
    // QA-B3: the worker default is the CLI's `sonnet` ALIAS, on purpose — a
    // dated id (claude-sonnet-4-20250514) retired and 404'd every worker
    // (1606dfe6, src/board/spawn.rs DEFAULT_MODEL). The contract is "a model
    // string `claude -p --model` accepts": an alias or a full id, never empty.
    expect(ctx.model).toMatch(/^(sonnet|opus|haiku|claude-)/);
  });

  it('returns error for non-existent task', async () => {
    handle = makeBoardDb([]);
    process.env.VODOU_BOARD_TASK = 't_does_not_exist';
    const r = await handleShow({});
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.error).toMatch(/not found/);
  });

  it('respects explicit task_id arg over env var', async () => {
    handle = makeBoardDb([
      { id: 't_test001', title: 'from env', status: 'running' },
      { id: 't_other', title: 'from arg', status: 'todo' },
    ]);
    const r = await handleShow({ task_id: 't_other' });
    const ctx = JSON.parse(r.content[0].text);
    expect(ctx.task.id).toBe('t_other');
    expect(ctx.task.title).toBe('from arg');
  });
});

describe('board_list', () => {
  it('returns all tasks (default filter excludes archived)', async () => {
    handle = makeBoardDb([
      { id: 't_aa', title: 'ready task', status: 'ready', priority: 80 },
      { id: 't_bb', title: 'todo task', status: 'todo', priority: 60 },
      { id: 't_cc', title: 'archived task', status: 'archived', priority: 90 },
    ]);
    const r = await handleList({});
    const data = JSON.parse(r.content[0].text);
    expect(data.count).toBe(2);
    const ids = data.tasks.map((t: any) => t.id);
    expect(ids).toContain('t_aa');
    expect(ids).toContain('t_bb');
    expect(ids).not.toContain('t_cc');
  });

  it('filters by status string', async () => {
    handle = makeBoardDb([
      { id: 't_r', title: 'r', status: 'ready' },
      { id: 't_t', title: 't', status: 'todo' },
    ]);
    const r = await handleList({ status: 'ready' });
    const data = JSON.parse(r.content[0].text);
    expect(data.count).toBe(1);
    expect(data.tasks[0].id).toBe('t_r');
  });

  it('filters by status array', async () => {
    handle = makeBoardDb([
      { id: 't_r', title: 'r', status: 'ready' },
      { id: 't_t', title: 't', status: 'todo' },
      { id: 't_d', title: 'd', status: 'done' },
    ]);
    const r = await handleList({ status: ['ready', 'todo'] });
    const data = JSON.parse(r.content[0].text);
    expect(data.count).toBe(2);
  });

  it('filters by assignee', async () => {
    handle = makeBoardDb([
      { id: 't_w', title: 'writer task', status: 'ready', assignee: 'writer' },
      { id: 't_r', title: 'researcher task', status: 'ready', assignee: 'researcher' },
    ]);
    const r = await handleList({ assignee: 'writer' });
    const data = JSON.parse(r.content[0].text);
    expect(data.count).toBe(1);
    expect(data.tasks[0].id).toBe('t_w');
  });

  it('orders by priority DESC then updated_at DESC', async () => {
    handle = makeBoardDb([
      { id: 't_lo', title: 'low', status: 'ready', priority: 30 },
      { id: 't_hi', title: 'high', status: 'ready', priority: 90 },
      { id: 't_mid', title: 'mid', status: 'ready', priority: 50 },
    ]);
    const r = await handleList({});
    const data = JSON.parse(r.content[0].text);
    expect(data.tasks[0].id).toBe('t_hi');
    expect(data.tasks[1].id).toBe('t_mid');
    expect(data.tasks[2].id).toBe('t_lo');
  });

  it('respects limit', async () => {
    handle = makeBoardDb([
      { id: 't_1', title: '1', status: 'ready' },
      { id: 't_2', title: '2', status: 'ready' },
      { id: 't_3', title: '3', status: 'ready' },
    ]);
    const r = await handleList({ limit: 2 });
    const data = JSON.parse(r.content[0].text);
    expect(data.count).toBe(2);
  });
});

describe('board_search', () => {
  it('finds matches via FTS5', async () => {
    handle = makeBoardDb([
      { id: 't_aa', title: 'launch announcement', body: 'four wow-moments', status: 'todo' },
      { id: 't_bb', title: 'research ICP', body: 'NA + EU', status: 'ready' },
    ]);
    const r = await handleSearch({ query: 'launch' });
    const data = JSON.parse(r.content[0].text);
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0].id).toBe('t_aa');
  });

  it('returns empty matches for no-match query', async () => {
    handle = makeBoardDb([
      { id: 't_aa', title: 'launch', body: 'announcement', status: 'todo' },
    ]);
    const r = await handleSearch({ query: 'nonexistent' });
    const data = JSON.parse(r.content[0].text);
    expect(data.matches).toEqual([]);
  });

  it('handles whitespace-only query gracefully', async () => {
    handle = makeBoardDb([]);
    const r = await handleSearch({ query: '   ' });
    const data = JSON.parse(r.content[0].text);
    expect(data.matches).toEqual([]);
  });

  it('strips control chars without crashing', async () => {
    handle = makeBoardDb([
      { id: 't_aa', title: 'launch', body: 'x', status: 'todo' },
    ]);
    const r = await handleSearch({ query: 'launch\x00\x07' });
    const data = JSON.parse(r.content[0].text);
    expect(data.matches.length).toBeGreaterThanOrEqual(0);
  });
});

describe('board_assignees', () => {
  it('returns distinct assignees with in_flight counts (fallback: no core.db)', async () => {
    handle = makeBoardDb([
      { id: 't_w1', title: 'w1', status: 'ready', assignee: 'writer' },
      { id: 't_w2', title: 'w2', status: 'running', assignee: 'writer' },
      { id: 't_r1', title: 'r1', status: 'ready', assignee: 'researcher' },
      { id: 't_done', title: 'done one', status: 'done', assignee: 'writer' },
    ]);
    const r = await handleAssignees({});
    const data = JSON.parse(r.content[0].text);

    const byName = Object.fromEntries(data.assignees.map((a: any) => [a.name, a]));
    expect(byName.writer.in_flight).toBe(2);
    expect(byName.researcher.in_flight).toBe(1);
  });

  it('returns empty list when no tasks have assignees in flight', async () => {
    handle = makeBoardDb([
      { id: 't_done', title: 'done', status: 'done', assignee: 'writer' },
    ]);
    const r = await handleAssignees({});
    const data = JSON.parse(r.content[0].text);
    expect(data.count).toBe(0);
  });
});
