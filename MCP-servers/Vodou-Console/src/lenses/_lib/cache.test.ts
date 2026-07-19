import { describe, it, expect, beforeEach } from 'vitest';
import { cacheKey, coalesce } from './cache.js';

describe('cache key', () => {
  it('produces stable keys regardless of payload key order', () => {
    const a = cacheKey('recipe.allrecipes', 'https://x.com', { servings: 4, mode: 'metric' });
    const b = cacheKey('recipe.allrecipes', 'https://x.com', { mode: 'metric', servings: 4 });
    expect(a).toBe(b);
  });

  it('differs by type', () => {
    const a = cacheKey('recipe.allrecipes', 'https://x.com', {});
    const b = cacheKey('github.pr', 'https://x.com', {});
    expect(a).not.toBe(b);
  });

  it('differs by source_url', () => {
    const a = cacheKey('x', 'https://a.com', {});
    const b = cacheKey('x', 'https://b.com', {});
    expect(a).not.toBe(b);
  });
});

describe('coalesce', () => {
  it('runs the function once for concurrent identical keys', async () => {
    let calls = 0;
    const run = () => new Promise<number>(r => setTimeout(() => { calls++; r(calls); }, 30));
    const [a, b, c] = await Promise.all([
      coalesce('k1', run),
      coalesce('k1', run),
      coalesce('k1', run),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(c).toBe(1);
  });

  it('runs separately for different keys', async () => {
    let calls = 0;
    const run = () => new Promise<number>(r => setTimeout(() => { calls++; r(calls); }, 10));
    await Promise.all([
      coalesce('a', run),
      coalesce('b', run),
    ]);
    expect(calls).toBe(2);
  });
});
