import { describe, it, expect } from 'vitest';
import { liveTurnTail, type BufferedStreamEvent } from '../stream-live-tail.js';

const NOW = 1_000_000;
const IDLE = 10 * 60 * 1000;
const ev = (seq: number, type: string, ago = 0): BufferedStreamEvent => ({ seq, ts: NOW - ago, payload: { type } });
const seqs = (evs: BufferedStreamEvent[]) => evs.map((e) => e.seq);

describe('liveTurnTail', () => {
  it('an empty buffer has no live turn', () => {
    expect(liveTurnTail([], NOW, IDLE)).toEqual([]);
  });

  it('a buffer ending on done has no live turn', () => {
    expect(liveTurnTail([ev(1, 'tool_start'), ev(2, 'chunk'), ev(3, 'done')], NOW, IDLE)).toEqual([]);
  });

  it('returns only the events after the previous turn finished', () => {
    const buf = [ev(1, 'chunk'), ev(2, 'done'), ev(3, 'usage'), ev(4, 'tool_start'), ev(5, 'tool_end')];
    expect(seqs(liveTurnTail(buf, NOW, IDLE))).toEqual([3, 4, 5]);
  });

  it('stopped and error end a turn just like done', () => {
    expect(liveTurnTail([ev(1, 'chunk'), ev(2, 'stopped')], NOW, IDLE)).toEqual([]);
    expect(seqs(liveTurnTail([ev(1, 'error'), ev(2, 'tool_start')], NOW, IDLE))).toEqual([2]);
  });

  it('a buffer with no terminal event is all one live turn (its start was trimmed)', () => {
    expect(seqs(liveTurnTail([ev(7, 'tool_start'), ev(8, 'tool_end')], NOW, IDLE))).toEqual([7, 8]);
  });

  // The turn that prompted this: tools at 20:31, silence until 20:39, text at 20:40.
  it('a long silent tool call inside the idle window is still live', () => {
    const buf = [ev(1, 'done', 11 * 60_000), ev(2, 'tool_start', 9 * 60_000), ev(3, 'tool_end', 60_000)];
    expect(seqs(liveTurnTail(buf, NOW, IDLE))).toEqual([2, 3]);
  });

  it('a tail silent past the idle window is dead, not live', () => {
    expect(liveTurnTail([ev(1, 'tool_start', IDLE + 1)], NOW, IDLE)).toEqual([]);
  });
});
