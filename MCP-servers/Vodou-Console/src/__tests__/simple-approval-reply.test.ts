import { describe, it, expect } from 'vitest';
import { createApproval, consumeApproval, latestPending, parseApprovalReply, pendingCount } from '../approvals.js';

// M2b (PLAN-MVP-CHAT-TO-LOCAL §13/§14) — the text "yes"/"no" approval lane.
// On the /simple page and on channels there is no approve/deny card: the ONLY
// approval UI is a bare word in the reply box. Two things are pinned here:
//
//  1. The grammar is tiny on purpose (same contract as parseLoopControl): a
//     bare control word counts, a sentence never does. "yes" approves;
//     "yes, and change the subject line" is a message for the LLM.
//  2. `latestPending` answers with the NEWEST parked approval and consumes
//     nothing — the person is answering the question they were just asked,
//     and an older approval stays reachable through its own token.

describe('parseApprovalReply — bare words only', () => {
  it('approves on the words a person actually types', () => {
    for (const w of ['yes', 'Yes', 'YES', 'y', 'yep', 'yeah', 'ok', 'okay', 'go ahead', 'do it', 'approve', 'yes.', 'yes!']) {
      expect(parseApprovalReply(w), w).toBe('approve');
    }
  });

  it('denies on the words a person actually types', () => {
    for (const w of ['no', 'No', 'n', 'nope', 'deny', 'stop', 'skip', "don't", 'no thanks']) {
      expect(parseApprovalReply(w), w).toBe('deny');
    }
  });

  it('a sentence is a message, not a decision', () => {
    for (const w of [
      'yes, but change the subject line first',
      'no idea what you mean',
      'yes that is my address',
      'okay so what happened yesterday?',
      'not yet — show me the draft',
      '',
      '   ',
    ]) {
      expect(parseApprovalReply(w), JSON.stringify(w)).toBeNull();
    }
  });

  it('a leading slash is tolerated (channel habit), same as loop controls', () => {
    expect(parseApprovalReply('/yes')).toBe('approve');
    expect(parseApprovalReply('/no')).toBe('deny');
  });
});

describe('latestPending — newest wins, nothing consumed', () => {
  it('returns null when nothing is parked', () => {
    expect(latestPending('conv-with-nothing')).toBeNull();
  });

  it('returns the newest pending for the conversation and leaves it in the store', () => {
    const conv = `conv-${Math.random()}`;
    const older = createApproval(conv, 'send_email', { to: 'sam@example.com' }, 'communicate', 1_000);
    const newer = createApproval(conv, 'run_command', { command: 'ls' }, 'system', 2_000);
    // Another conversation's approval must never bleed in.
    createApproval(`${conv}-other`, 'write_file', {}, 'files', 3_000);

    const got = latestPending(conv, 2_500);
    expect(got?.token).toBe(newer.token);
    expect(got?.toolName).toBe('run_command');
    // Peek, not consume: both of this conversation's approvals still stand.
    expect(pendingCount(conv)).toBe(2);

    // The text lane then consumes exactly the one it answered.
    expect(consumeApproval(conv, got!.token, 2_500)?.toolName).toBe('run_command');
    expect(pendingCount(conv)).toBe(1);
    expect(latestPending(conv, 2_500)?.token).toBe(older.token);
  });

  it('an expired approval cannot be answered', () => {
    const conv = `conv-${Math.random()}`;
    createApproval(conv, 'send_email', {}, 'communicate', 1_000);
    // 31 minutes later (TTL is 30) the "yes" must fall through to the LLM.
    expect(latestPending(conv, 1_000 + 31 * 60 * 1000)).toBeNull();
  });
});
