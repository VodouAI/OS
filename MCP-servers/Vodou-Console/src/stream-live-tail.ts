/**
 * The events of a turn that is still running, taken from a conversation's
 * stream buffer.
 *
 * A turn's assistant message reaches gateway.db only on `done`, so a
 * `switch_conversation` that answers with DB history alone draws a running
 * turn as idle: the person clicks away, comes back, and the chat looks like it
 * stopped while the model is still working. The switch handler replays this
 * tail after the history snapshot so the view shows where the turn is now.
 *
 * The tail is everything after the newest terminal event (`done` / `stopped` /
 * `error`). A buffer that ends on a terminal event has no live turn. A tail
 * whose newest event is older than `maxIdleMs` is treated as dead rather than
 * live — a turn that died without a terminal event must not spin forever. Size
 * `maxIdleMs` to the longest silent tool call you expect (an 8-minute test run
 * inside one turn is normal).
 */
export interface BufferedStreamEvent {
  seq: number;
  ts: number;
  payload: { type?: unknown };
}

const TERMINAL_TYPES = new Set(['done', 'stopped', 'error']);

export function liveTurnTail<T extends BufferedStreamEvent>(
  buf: readonly T[],
  now: number,
  maxIdleMs: number,
): T[] {
  if (buf.length === 0) return [];
  let start = 0;
  for (let i = buf.length - 1; i >= 0; i--) {
    if (TERMINAL_TYPES.has(String(buf[i].payload?.type))) {
      start = i + 1;
      break;
    }
  }
  if (start >= buf.length) return [];
  const newest = buf[buf.length - 1];
  if (now - newest.ts > maxIdleMs) return [];
  return buf.slice(start);
}
