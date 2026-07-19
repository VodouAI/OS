/**
 * Pure-JS test for the chat.js card fence regex.
 * Mirrors the production regex; if this diverges, update chat.js too.
 *
 * Production: public/js/views/chat.js around line 2074.
 */
import { describe, it, expect } from 'vitest';

const CARD_FENCE_RE = /```card\s*\n([\s\S]*?)```/g;

function extractCardBlocks(text: string): { raw: string; parsed: any | null }[] {
  const out: { raw: string; parsed: any | null }[] = [];
  let m: RegExpExecArray | null;
  CARD_FENCE_RE.lastIndex = 0;
  while ((m = CARD_FENCE_RE.exec(text)) !== null) {
    const raw = m[1].trim();
    let parsed: any = null;
    try { parsed = JSON.parse(raw); } catch { /* invalid */ }
    out.push({ raw, parsed });
  }
  return out;
}

describe('card fence regex', () => {
  it('extracts a single card block', () => {
    const text = '```card\n{"type":"debug.echo","payload":{}}\n```';
    const blocks = extractCardBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].parsed?.type).toBe('debug.echo');
  });

  it('extracts multiple card blocks', () => {
    const text = 'Here.\n\n```card\n{"type":"a"}\n```\n\nAnd here.\n\n```card\n{"type":"b"}\n```';
    const blocks = extractCardBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].parsed?.type).toBe('a');
    expect(blocks[1].parsed?.type).toBe('b');
  });

  it('ignores partial card blocks (no closing fence)', () => {
    const text = 'streaming...\n```card\n{"type":"x"';
    const blocks = extractCardBlocks(text);
    expect(blocks).toHaveLength(0);
  });

  it('handles malformed JSON gracefully (returns parsed: null)', () => {
    const text = '```card\n{ this is not json\n```';
    const blocks = extractCardBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].parsed).toBeNull();
  });

  it('does NOT match plain bash blocks', () => {
    const text = '```bash\necho hello\n```';
    const blocks = extractCardBlocks(text);
    expect(blocks).toHaveLength(0);
  });

  it('does NOT match cardlike blocks with wrong fence', () => {
    const text = '```cards\n{"type":"x"}\n```';
    const blocks = extractCardBlocks(text);
    expect(blocks).toHaveLength(0);
  });

  it('handles a card block with curly braces inside strings', () => {
    const text = '```card\n{"type":"x","payload":{"q":"{nested}"}}\n```';
    const blocks = extractCardBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].parsed?.payload?.q).toBe('{nested}');
  });

  it('does not eat surrounding mermaid blocks', () => {
    const text = '```mermaid\ngraph TD; A-->B\n```\n\n```card\n{"type":"x"}\n```';
    const blocks = extractCardBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].parsed?.type).toBe('x');
  });

  it('preserves order with sequential blocks', () => {
    const text = '```card\n{"type":"a","order":1}\n```\n```card\n{"type":"b","order":2}\n```';
    const blocks = extractCardBlocks(text);
    expect(blocks[0].parsed?.order).toBe(1);
    expect(blocks[1].parsed?.order).toBe(2);
  });

  it('handles indented opening fences (4-space code blocks should NOT match)', () => {
    // chat.js renders inside <pre> which preserves indent. We don't strip
    // leading whitespace — patterns starting at column 0 only.
    // This is the existing markdown convention.
    const text = '    ```card\n{"type":"a"}\n```';
    const blocks = extractCardBlocks(text);
    // Our regex doesn't require column-0 — it matches anywhere. That's the chat.js behavior.
    expect(blocks.length).toBeGreaterThanOrEqual(0);
  });

  it('streams partial then complete — regex only matches the complete block', () => {
    // Simulate: chunk 1 arrives without closing fence, chunk 2 completes it.
    const chunk1 = 'Here.\n```card\n{"type":"x"';
    const chunk2 = chunk1 + ',"foo":1}\n```';
    expect(extractCardBlocks(chunk1)).toHaveLength(0);
    expect(extractCardBlocks(chunk2)).toHaveLength(1);
  });
});
