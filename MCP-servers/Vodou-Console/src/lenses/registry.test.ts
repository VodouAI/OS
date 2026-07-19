import { describe, it, expect, beforeAll } from 'vitest';
import { ensureRegistryLoaded, getRegistry } from './registry.js';

describe('LensRegistry (dynamic filesystem scan)', () => {
  beforeAll(async () => {
    await ensureRegistryLoaded();
  });

  const reg = getRegistry();

  it('discovers and registers all built-in cards via filesystem scan', () => {
    const types = reg.listManifests().map(m => m.type);
    expect(types).toContain('debug.echo');
    expect(types).toContain('recipe.allrecipes');
    expect(types).toContain('image.preview');
    expect(types).toContain('map.directions');
    expect(types).toContain('github.pr');
    expect(types).toContain('wikipedia.article');
    expect(types).toContain('youtube.video');
    expect(types).toContain('hackernews.item');
    expect(types).toContain('arxiv.paper');
    expect(types).toContain('snippet.url');
  });

  it('looks up cards by type', () => {
    expect(reg.has('recipe.allrecipes')).toBe(true);
    expect(reg.has('does.not.exist')).toBe(false);
    expect(reg.get('github.pr')?.manifest.type).toBe('github.pr');
  });

  it('findCardsForUrl matches allrecipes URLs', () => {
    const matches = reg.findCardsForUrl('https://www.allrecipes.com/recipe/12345/grandma-pie');
    expect(matches.some(m => m.type === 'recipe.allrecipes')).toBe(true);
  });

  it('findCardsForUrl matches github PR URLs', () => {
    const matches = reg.findCardsForUrl('https://github.com/anthropic/claude/pull/42');
    expect(matches.some(m => m.type === 'github.pr')).toBe(true);
  });

  it('findCardsForUrl matches wikipedia URLs', () => {
    const matches = reg.findCardsForUrl('https://en.wikipedia.org/wiki/Topic');
    expect(matches.some(m => m.type === 'wikipedia.article')).toBe(true);
  });

  it('findCardsForUrl matches youtube URLs', () => {
    const matches = reg.findCardsForUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(matches.some(m => m.type === 'youtube.video')).toBe(true);
  });

  it('pickByUrl returns purpose-built card before snippet.url fallback', () => {
    const card = reg.pickByUrl('https://www.allrecipes.com/recipe/12345');
    expect(card?.manifest.type).toBe('recipe.allrecipes');
  });

  it('pickByUrl falls back to snippet.url for unknown URLs', () => {
    const card = reg.pickByUrl('https://random-blog.example.com/post/123');
    expect(card?.manifest.type).toBe('snippet.url');
  });

  it('every loaded card has motive + url_patterns + ttl_seconds', () => {
    for (const m of reg.listManifests()) {
      expect(m.motive.length).toBeGreaterThan(10);
      expect(Array.isArray(m.url_patterns)).toBe(true);
      expect(typeof m.ttl_seconds).toBe('number');
    }
  });

  it('exposes load errors (zero for built-ins)', () => {
    expect(reg.getLoadErrors()).toEqual([]);
  });
});
