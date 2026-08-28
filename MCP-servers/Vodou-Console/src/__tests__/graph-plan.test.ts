/**
 * The plan card's two guarantees (PLAN-GRAPH-SKILLS P1):
 *   1. building a plan never runs anything, and
 *   2. nothing that sends, posts or deletes gets past it unannounced (H8).
 *
 * (2) is the one that matters. The parameter engine auto-fills declared
 * booleans as TRUE, so a fan containing `slack_post_message` would post with
 * arguments nobody typed. These tests are the guard on that.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { findEngine, announceEngineSkip } from './_engine.js';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { isSideEffecting, buildPlan, renderPlanText } from '../graph-plan.js';

/**
 * `buildPlan` shells out to `vodou-core recipe compile` — that is the design
 * (one compiler, §15 Q1), so the test has to run a real binary.
 *
 * It must be a binary from THIS tree. The installed `./vodou-core` at the repo
 * root is whatever was last swapped in and may predate the subcommand; pointing
 * at it would make this suite report on a different build than the one being
 * changed. Pick the newest build here that actually has `recipe`, and FAIL
 * loudly if none does — a skipped test that silently passes is exactly the
 * absence-shaped metric that a total failure satisfies.
 */
const ENGINE = findEngine(['recipe', '--help'], /compile/);
const ENGINE_OK = ENGINE !== null;
if (!ENGINE_OK) announceEngineSkip('graph-plan', 'recipe compile');

beforeAll(() => {
  if (ENGINE) process.env.VC_PATH = ENGINE;
});

describe('side-effect detection — deliberately over-inclusive', () => {
  it.runIf(ENGINE_OK)('flags the verbs that change the world', () => {
    for (const t of [
      'slack_post_message', 'send_email', 'messages_send', 'create_event',
      'delete_file', 'update_row', 'board_create', 'sendEmail', 'postMessage',
      'schedule_task', 'charge_card', 'invite_user',
    ]) {
      expect(isSideEffecting(t), t).toBe(true);
    }
  });

  it.runIf(ENGINE_OK)('leaves read-only tools alone', () => {
    for (const t of [
      'list-events', 'messages_list', 'slack_search_messages', 'get_cpu_info',
      'board_list', 'search_conversation', 'read_file', 'get_host_info',
    ]) {
      expect(isSideEffecting(t), t).toBe(false);
    }
  });

  it.runIf(ENGINE_OK)('treats an unknown tool as harmless rather than guessing', () => {
    expect(isSideEffecting(undefined)).toBe(false);
    expect(isSideEffecting('')).toBe(false);
  });
});

describe('buildPlan', () => {
  const READ_ONLY = [
    'together sources:',
    '  calendar: google-calendar.list-events {"calendarId":"primary"}',
    '  mail: gmail.messages_list {"maxResults":5}',
    'then:',
    '  need: 1 of 2',
    '  brief: write a briefing from {calendar, mail}',
    '',
  ].join('\n');

  it.runIf(ENGINE_OK)('describes the graph with resolved server·tool on every row', async () => {
    const plan = await buildPlan(READ_ONLY);
    const together = plan.rows.filter((r) => r.block === 'together');
    expect(together.map((r) => r.id)).toEqual(['calendar', 'mail']);
    expect(together[0].server).toBe('google-calendar');
    expect(together[0].tool).toBe('list-events');
    expect(plan.needed).toBe(1);
    expect(plan.rows.some((r) => r.block === 'then' && r.id === 'brief')).toBe(true);
    expect(plan.guard).toBeUndefined();
  });

  it.runIf(ENGINE_OK)('adds an approval gate to the ACTIONS when a step sends (H8)', async () => {
    const sending = [
      'together sources:',
      '  mail: gmail.messages_list {"maxResults":5}',
      '  ping: slack.slack_post_message {"channel":"#daily","text":"hi"}',
      '',
    ].join('\n');
    const plan = await buildPlan(sending);
    expect(plan.guard).toBeTruthy();
    expect(plan.guard).toContain('slack·slack_post_message');
    expect(plan.guard).toContain('without asking');
    // The gate must exist in what would RUN, not only on the card — a warning
    // the engine does not honour is decoration.
    const sps = (plan.actions as { stopping_points?: Array<{ title?: string }> }).stopping_points ?? [];
    expect(sps[0]?.title).toContain('slack_post_message');
    expect(plan.rows.find((r) => r.tool === 'slack_post_message')?.sideEffecting).toBe(true);
  });

  it.runIf(ENGINE_OK)('honours an explicit opt-out, because that is the user overriding a default', async () => {
    const sending = [
      'together sources:',
      '  ping: slack.slack_post_message {"channel":"#daily","text":"hi"}',
      '  mail: gmail.messages_list {"maxResults":1}',
      'then:',
      '  note: post it without asking',
      '',
    ].join('\n');
    const plan = await buildPlan(sending);
    expect(plan.guard).toBeUndefined();
  });

  /**
   * This test used to assert `guard` was UNDEFINED when the author wrote their
   * own `ask me:` — the reasoning being "they handled it, do not add a second
   * gate". That reasoning was the N13 hole: the author's ask did not gate
   * anything either, because the send sat in `initial_steps` and ran before any
   * stopping point was presented. `Vodou-Recall.memory_store` executed and the
   * run then parked to ask permission for it.
   *
   * The compiler now attaches the sends to the author's OWN ask, so there is one
   * gate and it holds the send. Both halves are asserted.
   */
  it.runIf(ENGINE_OK)('attaches the send to the gate the author wrote, without adding a second', async () => {
    const sending = [
      'together sources:',
      '  ping: slack.slack_post_message {"channel":"#d","text":"hi"}',
      '  mail: gmail.messages_list {"maxResults":1}',
      'ask me:',
      '  - post to #daily?',
      '',
    ].join('\n');
    const plan = await buildPlan(sending);
    const asks = plan.rows.filter((r) => r.block === 'ask');
    expect(asks).toHaveLength(1);
    // The card explains the hold, because there genuinely is one now.
    expect(plan.guard).toContain('slack·slack_post_message');
    // And the send is held BY that ask rather than running before it.
    const acts = plan.actions as {
      initial_steps?: Array<{ id?: string }>;
      stopping_points?: Array<{ title?: string; options?: Record<string, { steps?: Array<{ id?: string }> }> }>;
    };
    const upFront = (acts.initial_steps ?? []).map((s) => s.id);
    expect(upFront).not.toContain('ping');
    const held = (acts.stopping_points ?? []).flatMap((sp) => (sp.options?.['1']?.steps ?? []).map((s) => s.id));
    expect(held).toContain('ping');
  });

  it.runIf(ENGINE_OK)("surfaces the compiler's own words on a bad recipe, because they name the fix", async () => {
    await expect(buildPlan('together:\n  a: s.t\nthen:\n  x: use {ghost}\n')).rejects.toThrow(/ghost/);
    await expect(buildPlan('together:\n  a: s.t\nthen:\n  need: 9 of 1\n')).rejects.toThrow(
      /unsatisfiable/,
    );
  });

  it.runIf(ENGINE_OK)('does not wrap a compile error in parser noise', async () => {
    // The CLI prints errors to STDOUT (stderr goes to system.log), so a
    // JSON-sniffing error path reported "unparseable output: Error: …" —
    // burying the one sentence that tells the user what to change.
    await expect(buildPlan('together:\n  a: gmail.messages_list unread mail\n')).rejects.toThrow(
      /^line 2: `gmail.messages_list` has free-text arguments/,
    );
  });

  it.runIf(ENGINE_OK)('shows a check as a gate, not as a step with no tool', async () => {
    // A verifier carries depends_on like any dependent step, so treating it as
    // one rendered `• check  ·` — a tool row with no tool. Found end-to-end.
    const plan = await buildPlan('together:\n  a: s.t\ncheck:\n  - every item names its source\n');
    const check = plan.rows.find((r) => r.block === 'check');
    expect(check?.id).toBe('has_source');
    expect(check?.label).toBe('every item names its source');
    expect(plan.rows.some((r) => r.block === 'then' && !r.server && !r.label)).toBe(false);
    const text = renderPlanText(plan);
    expect(text).toContain('check — fresh eyes');
    expect(text).toContain('[has_source]');
  });

  it.runIf(ENGINE_OK)('compiles a check: block into a gate (P2) rather than refusing it', async () => {
    // Until P2 this was an explicit refusal — "will NOT be silently dropped".
    // Now it becomes a verifier, and the plan card must show it, because a gate
    // the user cannot see is one they cannot trust.
    const plan = await buildPlan(
      'together:\n  a: s.t\ncheck:\n  - every item names its source\n',
    );
    const steps = (plan.actions as { initial_steps: Array<Record<string, unknown>> }).initial_steps;
    const v = steps.find((s) => s.kind === 'verifier');
    expect(v).toBeTruthy();
    expect(v!.fresh_context).toBe(true);
    expect(v!.on_fail).toBe('block');
  });

  it.runIf(ENGINE_OK)('carries the fake-edge note through to the card', async () => {
    const src = 'together:\n  a: s.t\n  b: s2.t\nthen:\n  c: unrelated work\n';
    const plan = await buildPlan(src);
    expect(plan.notes.join(' ')).toContain("doesn't use anything");
    expect(plan.rows.filter((r) => r.block === 'together')).toHaveLength(3);
  });

  it.runIf(ENGINE_OK)('shows gated work rather than an empty card (ask first:)', async () => {
    // `initial_steps` is empty for a gated recipe — the work sits behind the
    // go-menu so it can see the answers. Reading only initial_steps rendered a
    // blank card for exactly the recipes that stop and ask, which are the ones
    // a plan card is most useful for.
    const grill = [
      'ask first:',
      '  TASK: what should I plan?',
      'together draft:',
      '  plan: draft an approach for {{TASK}}',
      'then:',
      '  grill: attack this plan {plan}',
      'ask me:',
      '  - proceed?',
      '',
    ].join('\n');
    const plan = await buildPlan(grill);
    expect(plan.rows.some((r) => r.id === 'plan')).toBe(true);
    expect(plan.rows.some((r) => r.id === 'grill')).toBe(true);
    expect(plan.rows.find((r) => r.block === 'join')?.label).toContain('1 of 1');
    // The question asked BEFORE anything runs is on the card, and marked so.
    const first = plan.rows.find((r) => r.label?.includes('asked first'));
    expect(first?.id).toBe('TASK');
    expect(renderPlanText(plan)).toContain('proceed?');
  });

  it.runIf(ENGINE_OK)('renders a text form for surfaces with no DOM', async () => {
    const plan = await buildPlan(READ_ONLY);
    const text = renderPlanText(plan);
    expect(text).toContain("these don't need each other");
    expect(text).toContain('needs 1 of 2');
    expect(text).toContain('google-calendar·list-events');
  });
});
