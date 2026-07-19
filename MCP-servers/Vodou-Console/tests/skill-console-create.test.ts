import { describe, it, expect } from 'vitest';
import { slugifySkillConsoleName } from '../src/api/skill-console-create.js';

const NAME_RE = /^[a-z][a-z0-9-]{2,40}$/;

describe('slugifySkillConsoleName', () => {
  it('slugifies a title', () => {
    const s = slugifySkillConsoleName('My Daily Digest!');
    expect(NAME_RE.test(s)).toBe(true);
    expect(s).toMatch(/^my-daily-digest/);
  });

  it('prefixes when first char not letter', () => {
    const s = slugifySkillConsoleName('123 foo');
    expect(NAME_RE.test(s)).toBe(true);
    expect(s.startsWith('x-') || s.startsWith('skill-')).toBe(true);
  });

  it('returns valid slug for empty', () => {
    const s = slugifySkillConsoleName('   ');
    expect(NAME_RE.test(s)).toBe(true);
  });
});
