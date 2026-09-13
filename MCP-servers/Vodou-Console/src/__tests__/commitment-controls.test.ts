/**
 * PLAN-COMMITMENTS-LANE P2 — the reply grammar, as tests.
 *
 * The risk this file exists for is not "does `done` close a loop" — it is the
 * opposite: a person types the word "done" inside a real sentence every day,
 * and a parser that eats those has broken chat to save a keystroke. So most of
 * what is asserted here is what must NOT be treated as a control.
 */
import { describe, it, expect } from 'vitest';
import { parseLoopControl, platformOf } from '../commitment-controls.js';

describe('P2 — a control word is one word, not a sentence', () => {
  it('recognises the words a person actually types', () => {
    for (const t of ['done', 'Done', 'done.', ' DONE ', '/done', 'finished', 'did it', 'sent', '✅']) {
      expect(parseLoopControl(t)?.action, t).toBe('done');
    }
    for (const t of ['drop', 'forget it', 'never mind', 'nevermind', '/drop']) {
      expect(parseLoopControl(t)?.action, t).toBe('drop');
    }
  });

  it('reads a snooze with and without a phrase', () => {
    expect(parseLoopControl('snooze')).toEqual({ action: 'snooze', when: '' });
    expect(parseLoopControl('later')).toEqual({ action: 'snooze', when: '' });
    expect(parseLoopControl('snooze 2h')).toEqual({ action: 'snooze', when: '2h' });
    expect(parseLoopControl('snooze until friday')).toEqual({ action: 'snooze', when: 'friday' });
    expect(parseLoopControl('snooze in 30m')).toEqual({ action: 'snooze', when: '30m' });
    expect(parseLoopControl('remind me tomorrow')).toEqual({ action: 'snooze', when: 'tomorrow' });
  });

  it('leaves ordinary messages alone — this is the failure that matters', () => {
    for (const t of [
      'done with the migration, what next?',
      'is that done?',
      'I dropped the database, help',
      'can you remind me how the scheduler works',
      'the deck is finished but I have not sent it',
      'what does done mean here',
      '',
      '   ',
      'snooze the whole idea of reminders because I find them irritating and would rather not',
    ]) {
      expect(parseLoopControl(t), t).toBeNull();
    }
  });

  it('only channel turns can carry a control', () => {
    expect(platformOf('telegram', 'workbench:channel:telegram')).toBe('telegram');
    expect(platformOf('slack', 'workbench:channel:slack')).toBe('slack');
    expect(platformOf(undefined, 'workbench:channel:discord')).toBe('discord');
    // web chat, skills and the board are not channels: a control there is text
    expect(platformOf('web', 'conv-123')).toBe('');
    expect(platformOf(undefined, 'workbench:skill-console:qa')).toBe('');
    expect(platformOf(null, undefined)).toBe('');
  });
});
