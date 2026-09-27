/**
 * Withdrawn Fireworks models must resolve to ones that answer.
 *
 * 2026-09-26: Fireworks took Kimi K2.6 (the hosted-tier default), K2.7 Code and
 * DeepSeek V4 Pro/Flash off serverless. A default change alone fixes only fresh
 * installs — settings pages and onboarding save the FULL model id, so an install
 * that ever saved one would keep asking for a 404 forever. The retired map is
 * applied on the resolved model, whatever its source.
 */
import { describe, it, expect } from 'vitest';
import { resolveProviderRuntime, currentModelId, providerSpec } from '../providers.js';
import { computeCogs } from '../usage-tracking.js';

const K2 = 'accounts/fireworks/models/kimi-k2p6';
const K3 = 'accounts/fireworks/models/kimi-k3';
const FLASH = 'accounts/fireworks/models/deepseek-v4p1-flash';

describe('retired Fireworks models', () => {
  it('the hosted tier and Fireworks both default to Kimi K3', () => {
    expect(providerSpec('vodou')?.defaultModel).toBe(K3);
    expect(providerSpec('fireworks')?.defaultModel).toBe(K3);
  });

  it('a saved K2.6 resolves to K3, for both providers', () => {
    for (const id of ['vodou', 'fireworks']) {
      const saved = (k: string) => (k === `${id}_model` ? K2 : '');
      expect(resolveProviderRuntime(id, saved, {}).model).toBe(K3);
    }
  });

  it('an env var naming a withdrawn model resolves too', () => {
    expect(resolveProviderRuntime('fireworks', () => '', { FIREWORKS_MODEL: 'accounts/fireworks/models/deepseek-v4-flash-0731' }).model).toBe(FLASH);
  });

  it('a model that still answers is left alone', () => {
    const saved = (k: string) => (k === 'vodou_model' ? 'accounts/fireworks/models/gpt-oss-120b' : '');
    expect(resolveProviderRuntime('vodou', saved, {}).model).toBe('accounts/fireworks/models/gpt-oss-120b');
    expect(currentModelId('together', 'moonshotai/Kimi-K2.6')).toBe('moonshotai/Kimi-K2.6'); // another vendor's id
  });

  it('K3 and V4.1 Flash are priced, not billed at the provider fallback', () => {
    const u = { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0 };
    expect(computeCogs('vodou', K3, u)).toBeCloseTo(18.0, 5);
    expect(computeCogs('vodou', FLASH, u)).toBeCloseTo(1.5, 5);
  });
});
