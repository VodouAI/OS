/**
 * PLAN-AUTOMATIONS-WATCH-WHAT-VODOU-KNOWS P2 — the proposer must not learn an
 * automation back as a skill. The first deployed summary run (2026-09-10,
 * workbench:automation:10) made 23 tool calls and recorded a trajectory,
 * because the console's `source` column holds the conversation id, not
 * "automation", so NON_LEARNABLE_SOURCES never matched. The prefix check
 * returns before any DB access, which is why this test needs no database.
 */
import { describe, it, expect } from 'vitest';
import { isLearnableConversation } from '../db.js';

describe('automation consoles are never learnable', () => {
  it('excludes workbench:automation:* by prefix, before the source lookup', () => {
    expect(isLearnableConversation('workbench:automation:10')).toBe(false);
    expect(isLearnableConversation('workbench:automation:9')).toBe(false);
  });
  it('still excludes the scheduled-skill consoles and the heartbeat', () => {
    expect(isLearnableConversation('workbench:skill-console:growth-signal')).toBe(false);
    expect(isLearnableConversation('vodou-heartbeat')).toBe(false);
    expect(isLearnableConversation('')).toBe(false);
  });
});
