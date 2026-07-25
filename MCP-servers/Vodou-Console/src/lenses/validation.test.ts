import { describe, it, expect } from 'vitest';
import { card as recipe } from './recipe.allrecipes/index.js';
import { card as image } from './image.preview/index.js';
import { card as map } from './map.directions/index.js';
import { card as pr } from './github.pr/index.js';
import { card as echo } from './debug.echo/index.js';

describe('card validate()', () => {
  it('debug.echo accepts any payload', () => {
    expect(echo.validate({ foo: 'bar' })).toBe(true);
    expect(echo.validate({})).toBe(true);
    expect(echo.validate(undefined as any)).toBe(false);
  });

  it('recipe.allrecipes requires an allrecipes URL', () => {
    expect(recipe.validate({}, 'https://www.allrecipes.com/recipe/12345/grandma-pie')).toBe(true);
    expect(recipe.validate({}, 'https://allrecipes.com/recipe/9999')).toBe(true);
    expect(recipe.validate({}, 'https://www.foodnetwork.com/recipe/12345')).toBe(false);
    expect(recipe.validate({}, undefined)).toBe(false);
  });

  it('image.preview requires a valid URL', () => {
    expect(image.validate({}, 'https://example.com/x.png')).toBe(true);
    expect(image.validate({}, 'not a url')).toBe(false);
    expect(image.validate({}, undefined)).toBe(false);
  });

  it('map.directions requires origin + destination', () => {
    expect(map.validate({ origin: 'A', destination: 'B' })).toBe(true);
    expect(map.validate({ origin: 'A' })).toBe(false);
    expect(map.validate({})).toBe(false);
  });

  it('github.pr requires a PR URL', () => {
    expect(pr.validate({}, 'https://github.com/anthropic/claude/pull/42')).toBe(true);
    expect(pr.validate({}, 'https://github.com/anthropic/claude/issues/42')).toBe(false);
    expect(pr.validate({}, 'https://gitlab.com/x/y/pull/1')).toBe(false);
  });
});

describe('card synthesizeUrl()', () => {
  it('map.directions synthesizes a Google Maps URL', () => {
    const url = map.synthesizeUrl!({ origin: 'Detroit, MI', destination: 'Grand Rapids, MI', mode: 'driving' });
    expect(url).toContain('google.com/maps');
    expect(url).toContain('Detroit%2C%20MI');
    expect(url).toContain('Grand%20Rapids');
  });

  it('debug.echo synthesizes a vodou:// URL', () => {
    const url = echo.synthesizeUrl!({ x: 1 });
    expect(url).toMatch(/^vodou:\/\/debug-echo\//);
  });
});

describe('manifest defaults', () => {
  it('cards declare Apache-2.0 license', () => {
    for (const c of [recipe, image, map, pr, echo]) {
      expect(c.manifest.license).toBe('Apache-2.0');
    }
  });

  it('cards have non-empty motives', () => {
    for (const c of [recipe, image, map, pr]) {
      expect(c.manifest.motive.length).toBeGreaterThan(20);
    }
  });
});
