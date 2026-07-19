import { describe, it, expect } from 'vitest';
import { stripVodouContext } from '../vbb/context-markers.js';

// PLAN-MEMORY-FOLLOWS-YOU loop guard — must mirror the Rust twin
// (gateway_extractor::strip_vodou_context) exactly.
describe('stripVodouContext', () => {
  it('removes a fenced block', () => {
    const t = 'before ⟦vodou:context v1⟧\n- secret\n⟦/vodou:context⟧ after';
    expect(stripVodouContext(t)).toBe('before  after');
  });
  it('removes multiple blocks and tolerates future versions', () => {
    const t = '⟦vodou:context v1⟧a⟦/vodou:context⟧ mid ⟦vodou:context v9⟧b⟦/vodou:context⟧ end';
    expect(stripVodouContext(t)).toBe('mid  end');
  });
  it('fails closed on an unterminated block', () => {
    expect(stripVodouContext('keep ⟦vodou:context v1⟧ leaked')).toBe('keep');
  });
  it('passes plain text through untouched', () => {
    expect(stripVodouContext('plain text')).toBe('plain text');
  });
});
