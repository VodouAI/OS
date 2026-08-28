/**
 * PARITY — `src/page-id.ts` (TS) must agree with `src/memory/page_id.rs` (Rust).
 *
 * PLAN-MEMORY-ON-EVERY-PAGE P0. Two implementations of one identity exist because
 * Rust WRITES the key and the gateway READS it, and routing every keystroke of the
 * typing lane through a process spawn is not viable.
 *
 * That duplication is a liability, so this test is the whole mitigation: the same
 * table goes through the TS side here and through `#[test]`s over there, and the
 * expectations below are copied verbatim from the Rust tests. If the two ever
 * disagree, a memory written under one key stops matching a visit resolved under
 * the other — and the failure mode is silence, not an error.
 */

import { describe, it, expect } from 'vitest';
import { normalizeUrl, hostOf } from '../page-id.js';

const key = (u: string) => {
  const r = normalizeUrl(u);
  if (!r) throw new Error(`expected ${u} to parse`);
  return r.pageKey;
};

describe('page-id parity with page_id.rs', () => {
  it('strips scheme, www and trailing slash; preserves path case', () => {
    expect(key('https://www.Example.com/Docs/')).toBe('example.com/Docs');
    expect(key('http://example.com')).toBe('example.com/');
    // Many sites are case-sensitive below the host — collapsing case would merge
    // two real pages into one.
    expect(key('https://example.com/A')).not.toBe(key('https://example.com/a'));
  });

  it('treats a fragment as a scroll position, not a document', () => {
    expect(key('https://example.com/post#section-3')).toBe(key('https://example.com/post'));
  });

  it('does not let tracking params fork a page', () => {
    expect(key('https://example.com/post?utm_source=twitter&utm_campaign=x')).toBe(key('https://example.com/post'));
    expect(key('https://example.com/p?fbclid=abc')).toBe(key('https://example.com/p'));
    expect(key('https://example.com/p?si=xyz&ref=hn')).toBe(key('https://example.com/p'));
  });

  it('keeps meaningful params and sorts them', () => {
    expect(key('https://example.com/s?b=2&a=1')).toBe('example.com/s?a=1&b=2');
    expect(key('https://example.com/s?a=1&b=2')).toBe(key('https://example.com/s?b=2&a=1'));
    expect(key('https://example.com/s?q=rust')).not.toBe(key('https://example.com/s'));
  });

  it('makes the conversation the page on a chat host', () => {
    expect(key('https://chatgpt.com/c/abc-123')).toBe('chatgpt.com/c/abc-123');
    expect(key('https://chatgpt.com/c/abc-123?model=gpt4')).toBe('chatgpt.com/c/abc-123');
    expect(key('https://chatgpt.com/c/one')).not.toBe(key('https://chatgpt.com/c/two'));
    expect(key('https://claude.ai/chat/xyz/')).toBe('claude.ai/chat/xyz');
    expect(key('https://gemini.google.com/app/deadbeef')).toBe('gemini.google.com/app/deadbeef');
    expect(key('https://chatgpt.com/')).toBe('chatgpt.com/');
  });

  it('handles ports, userinfo and case in the host', () => {
    expect(hostOf('https://WWW.Example.com:8443/x')).toBe('example.com');
    expect(hostOf('http://user:pw@example.com/x')).toBe('example.com');
    expect(hostOf('http://127.0.0.1:8765/api')).toBe('127.0.0.1');
  });

  it('rejects what is not an http page', () => {
    for (const u of ['file:///etc/passwd', 'chrome://extensions', 'javascript:alert(1)', '', 'not a url']) {
      expect(normalizeUrl(u), u).toBeNull();
      expect(hostOf(u), u).toBeNull();
    }
  });

  it('resolves the same page two ways to ONE key', () => {
    // The property the whole feature rests on.
    expect(key('https://www.example.com/blog/post/?utm_source=x#top')).toBe(key('http://example.com/blog/post'));
  });
});
