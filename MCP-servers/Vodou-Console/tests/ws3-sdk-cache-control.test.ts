import { describe, it, expect } from 'vitest';
import { anthropicCacheSystem, anthropicCacheTools } from '../src/llm.js';

// WS3 (PLAN-GATEWAY-STATE-LAYER): the direct `anthropic` SDK provider gets no prompt
// caching without explicit cache_control breakpoints. Lock the request-shape contract
// (no Anthropic key needed to verify the structure we send).

describe('WS3 anthropicCacheSystem', () => {
  it('wraps the system string in a single cache_control text block', () => {
    const s = anthropicCacheSystem('SYSTEM PROMPT TEXT');
    expect(Array.isArray(s)).toBe(true);
    expect(s).toHaveLength(1);
    expect(s[0]).toEqual({ type: 'text', text: 'SYSTEM PROMPT TEXT', cache_control: { type: 'ephemeral' } });
  });
});

describe('WS3 anthropicCacheTools', () => {
  const TOOLS = [
    { name: 'a', description: 'A', input_schema: { type: 'object' } },
    { name: 'b', description: 'B', input_schema: { type: 'object' } },
    { name: 'c', description: 'C', input_schema: { type: 'object' } },
  ];

  it('breakpoints ONLY the last tool', () => {
    const out = anthropicCacheTools(TOOLS)!;
    expect((out[0] as any).cache_control).toBeUndefined();
    expect((out[1] as any).cache_control).toBeUndefined();
    expect((out[2] as any).cache_control).toEqual({ type: 'ephemeral' });
  });

  it('does NOT mutate the shared registry objects', () => {
    const before = JSON.stringify(TOOLS);
    anthropicCacheTools(TOOLS);
    expect(JSON.stringify(TOOLS)).toBe(before); // originals untouched (clone-on-write)
  });

  it('handles empty / undefined tools without throwing', () => {
    expect(anthropicCacheTools(undefined)).toBeUndefined();
    expect(anthropicCacheTools([])).toEqual([]);
  });

  it('a single tool still gets the breakpoint', () => {
    const out = anthropicCacheTools([{ name: 'only' }])!;
    expect((out[0] as any).cache_control).toEqual({ type: 'ephemeral' });
  });
});
