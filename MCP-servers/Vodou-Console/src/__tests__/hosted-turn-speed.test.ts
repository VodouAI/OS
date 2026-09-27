import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { reasoningEffortFor } from '../llm.js';

// First-hour lab on hosted K3 (2026-09-26): "remember this…" took 26 s. Two
// causes: K3 thinks by default (7.8–11.1 s vs 2.1–2.4 s with 'none', same
// answer), and a plain first-round answer was thrown away and regenerated.
describe('hosted turn speed', () => {
  it("Kimi via Fireworks or the Vodou proxy gets reasoning_effort 'none' by default", () => {
    expect(reasoningEffortFor('https://api.fireworks.ai/inference/v1/chat/completions', 'accounts/fireworks/models/kimi-k3', {})).toEqual({ reasoning_effort: 'none' });
    expect(reasoningEffortFor('https://llm.vodou.ai/v1/chat', 'accounts/fireworks/models/kimi-k3', {})).toEqual({ reasoning_effort: 'none' });
    expect(reasoningEffortFor('http://127.0.0.1:9/p', 'accounts/fireworks/models/kimi-k3', { VODOU_LLM_PROXY_URL: 'http://127.0.0.1:9/p' } as any)).toEqual({ reasoning_effort: 'none' });
  });
  it('overridable, and never sent where it would be rejected', () => {
    expect(reasoningEffortFor('https://api.fireworks.ai/x', 'kimi-k3', { VODOU_REASONING_EFFORT: 'low' } as any)).toEqual({ reasoning_effort: 'low' });
    expect(reasoningEffortFor('https://api.fireworks.ai/x', 'kimi-k3', { VODOU_REASONING_EFFORT: 'default' } as any)).toEqual({});
    expect(reasoningEffortFor('https://api.openai.com/v1/chat/completions', 'gpt-4o', {})).toEqual({});
    expect(reasoningEffortFor('https://api.fireworks.ai/x', 'accounts/fireworks/models/gpt-oss-120b', {})).toEqual({});
  });
  it('a plain first-round answer is used, not regenerated (one model call)', () => {
    const src = readFileSync(join(__dirname, '../llm.ts'), 'utf8');
    expect(src).not.toMatch(/if \(directText && iterations === 0\)/);
    expect(src).toContain('emit usage (direct answer)');
    expect(src.match(/\.\.\.reasoningEffortFor\(endpoint, model\)/g)?.length).toBe(3);
  });
});
