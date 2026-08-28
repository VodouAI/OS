import { describe, it, expect } from 'vitest';
import {
  outboundLimitFor,
  chunkTextForOutbound,
} from '../channel-chunk.js';

/**
 * The defect under test, in full.
 *
 * On 2026-08-19 the `morning-briefing` scheduled task produced 4,942 chars and
 * reported success. Telegram rejected it with HTTP 400 "message is too long"
 * (hard cap 4,096) and the user received nothing. `scheduled_task_runs` row 2
 * recorded status=degraded / delivery_ok=0 — the run outcome work caught it —
 * but the briefing itself never arrived, so `funnel.first_automation` could not
 * fire. Every non-WhatsApp outbound path did `substring(0, 4000)`, which fails
 * the other way: it "succeeds" while throwing the tail away.
 *
 * These tests assert the two properties that actually matter to a user:
 *   1. nothing is ever dropped  (truncation bug)
 *   2. nothing ever exceeds the channel's cap  (rejection bug)
 */

const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
const rejoin = (parts: string[]) => norm(parts.join('\n'));

// A chunk that spans a code block gets a synthetic closing fence and the next
// gets a matching reopening one, so raw reassembly is deliberately NOT byte
// equal to the input. Strip fence markers from both sides to compare content —
// the property under test is that no PROSE or CODE was dropped.
const content = (t: string) => norm(t.replace(/```[^\n`]*/g, ' '));

describe('outboundLimitFor', () => {
  it('keeps every channel under its provider hard cap', () => {
    expect(outboundLimitFor('telegram')).toBeLessThan(4096);
    expect(outboundLimitFor('discord')).toBeLessThan(2000);
    // An unknown channel must not default to "unlimited" — that is the shape
    // of the original bug, where an unhandled path sent the raw string.
    expect(outboundLimitFor('some-future-channel')).toBeLessThanOrEqual(4096);
  });
});

describe('chunkTextForOutbound', () => {
  it('passes short text through as a single chunk', () => {
    const parts = chunkTextForOutbound('hello world', 3900);
    expect(parts).toEqual(['hello world']);
  });

  it('splits the real 4,942-char briefing so Telegram accepts every part', () => {
    // Reconstructed to the failing shape: prose paragraphs, no fences.
    const para = 'The overnight run surfaced four items worth your attention today. ';
    const briefing = Array.from({ length: 75 }, (_, i) => `${i + 1}. ${para}`).join('\n\n');
    expect(briefing.length).toBeGreaterThan(4096);

    const limit = outboundLimitFor('telegram');
    const parts = chunkTextForOutbound(briefing, limit);

    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(limit);
    // Nothing dropped — this is what substring(0, 4000) got wrong.
    expect(rejoin(parts)).toBe(briefing.replace(/\s+/g, ' ').trim());
  });

  it('never emits a chunk over the limit even when a code fence forces a re-split', () => {
    // The fence handler PREPENDS a carry to the following chunk, which can push
    // an already-near-limit chunk back over. Without the bounding pass this is
    // the same HTTP 400, reintroduced by the fix for a different bug.
    const code = Array.from({ length: 200 }, (_, i) => `const x${i} = ${i};`).join('\n');
    const text = `Here is the report:\n\n\`\`\`ts\n${code}\n\`\`\`\n\nAnd some trailing prose.`;
    const limit = 800;
    const parts = chunkTextForOutbound(text, limit);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(limit);
    expect(content(parts.join('\n'))).toBe(content(text));
  });

  it('does not leave a code fence open across a chunk boundary', () => {
    const code = Array.from({ length: 120 }, (_, i) => `line ${i} of code`).join('\n');
    const text = `Intro paragraph.\n\n\`\`\`\n${code}\n\`\`\`\n\nOutro paragraph.`;
    const parts = chunkTextForOutbound(text, 900);
    // An odd fence count in a chunk means it opened a block it never closed,
    // which renders as unstyled soup from there to the end of the message.
    const offenders = parts.filter((p) => ((p.match(/```/g) || []).length % 2) === 1);
    expect(offenders).toEqual([]);
  });

  it('handles text with no break opportunity at all', () => {
    const wall = 'x'.repeat(10_000);
    const parts = chunkTextForOutbound(wall, 3900);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(3900);
    expect(parts.join('')).toBe(wall);
  });

  it('drops nothing for a message exactly one char over the limit', () => {
    const text = 'a'.repeat(3901);
    const parts = chunkTextForOutbound(text, 3900);
    expect(parts.join('')).toBe(text);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(3900);
  });
});
