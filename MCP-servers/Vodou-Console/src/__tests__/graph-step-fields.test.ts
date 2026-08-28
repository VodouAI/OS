/**
 * The parser must not drop the fields the executor needs.
 *
 * `actions.json` → parsed steps was five hand-written object literals, each
 * naming its fields explicitly. A field added to the schema had to be remembered
 * in all five, and was silently dropped everywhere it was forgotten. That cost
 * two incidents:
 *
 *   1. `prompt` — `execdesk-action-weekly-brief` reached the executor with
 *      neither tool nor prompt and could only no-op.
 *   2. every schema-1.1 field — `parallel_group`, `kind`, `min_success` and the
 *      rest were in the schema, validated, compiled, handled by the executor,
 *      and stripped in between. The morning briefing ran its three sources one
 *      at a time and logged `skipping non-tool step join_sources`, because by
 *      the time the executor saw them they were plain tool steps and an object
 *      with no server, no tool and no prompt. `graph_runs` had zero rows from a
 *      real request for exactly that reason.
 *
 * Every one of those was invisible to the type checker (the mappers build from
 * `any`) and to every existing test. This asserts the round trip a step actually
 * takes.
 */
import { describe, it, expect } from 'vitest';
import { stoppingPointsFromParsedUnified } from '../workflow-driver.js';

const ACTIONS = {
  schema_version: '1.1',
  initial_steps: [
    {
      id: 'calendar',
      server: 'google-calendar',
      tool: 'list-events',
      args: { calendarId: 'primary' },
      parallel_group: 'sources',
      on_fail: 'skip',
      timeout_ms: 30000,
      capture: { CAL: 'items' },
    },
    { id: 'mail', server: 'gmail', tool: 'messages_list', args: {}, parallel_group: 'sources' },
    {
      id: 'join_sources',
      kind: 'join',
      in: ['calendar', 'mail'],
      mode: 'all_settled',
      min_success: 1,
      on_partial: 'continue_with_warning',
    },
    { id: 'brief', prompt: 'write it from {calendar, mail}', depends_on: ['join_sources'] },
    {
      id: 'check',
      kind: 'verifier',
      fresh_context: true,
      checks: [{ rule: 'every item names its source', check: 'has_source' }],
      in: ['brief'],
      on_fail: 'block',
    },
  ],
  stopping_points: [
    { id: 1, title: 'post it?', type: 'menu', options: { '1': { label: 'Yes', vars: {}, steps: [] } } },
  ],
};

describe('parsed steps keep the fields the executor reads', () => {
  const parsed = stoppingPointsFromParsedUnified(ACTIONS as never);
  const steps = parsed?.initialSteps ?? [];

  it('parses every step', () => {
    expect(steps).toHaveLength(5);
  });

  it('keeps parallel_group — without it a fan runs one step at a time', () => {
    expect(steps[0].parallel_group).toBe('sources');
    expect(steps[1].parallel_group).toBe('sources');
  });

  it('keeps kind — without it a join is "a step with no server or tool" and gets skipped', () => {
    expect(steps[2].kind).toBe('join');
    expect(steps[4].kind).toBe('verifier');
  });

  it('keeps the join contract, so the count means something', () => {
    expect(steps[2].in).toEqual(['calendar', 'mail']);
    expect(steps[2].min_success).toBe(1);
    expect(steps[2].mode).toBe('all_settled');
    expect(steps[2].on_partial).toBe('continue_with_warning');
  });

  it('keeps on_fail and timeout_ms — a failure is a value the join routes', () => {
    expect(steps[0].on_fail).toBe('skip');
    expect(steps[0].timeout_ms).toBe(30000);
    expect(steps[4].on_fail).toBe('block');
  });

  it('keeps fresh_context and checks — a verifier without them is REFUSED at run time', () => {
    expect(steps[4].fresh_context).toBe(true);
    expect(steps[4].checks?.[0]?.check).toBe('has_source');
  });

  it('keeps depends_on and prompt', () => {
    expect(steps[3].prompt).toBe('write it from {calendar, mail}');
    expect(steps[3].depends_on).toEqual(['join_sources']);
  });

  it('keeps the fields that predate schema 1.1', () => {
    expect(steps[0].capture).toEqual({ CAL: 'items' });
    expect(steps[0].args).toEqual({ calendarId: 'primary' });
    expect(steps[0].id).toBe('calendar');
  });

  it('option steps go through the same mapper as initial steps', () => {
    // Four of the five old copies were option-step mappers, so a field could
    // survive in initial_steps and vanish in an option.
    const withOption = {
      ...ACTIONS,
      stopping_points: [
        {
          id: 1,
          title: 'again?',
          options: {
            '1': { label: 'Run', vars: {}, steps: [ACTIONS.initial_steps[0], ACTIONS.initial_steps[2]] },
          },
        },
      ],
    };
    const p = stoppingPointsFromParsedUnified(withOption as never);
    const optSteps = p?.stoppingPoints[0].options['1'].steps ?? [];
    expect(optSteps[0].parallel_group).toBe('sources');
    expect(optSteps[1].kind).toBe('join');
    expect(optSteps[1].min_success).toBe(1);
  });
});
