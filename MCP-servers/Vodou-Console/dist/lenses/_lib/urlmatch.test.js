import { describe, it, expect } from 'vitest';
import { urlMatch } from './urlmatch.js';
describe('urlMatch', () => {
    it('matches exact host', () => {
        expect(urlMatch('github.com', 'https://github.com/anything')).toBe(true);
        expect(urlMatch('github.com', 'https://api.github.com/x')).toBe(false);
    });
    it('matches *. host suffix including bare apex', () => {
        expect(urlMatch('*.allrecipes.com/recipe/*', 'https://www.allrecipes.com/recipe/12345')).toBe(true);
        expect(urlMatch('*.allrecipes.com/recipe/*', 'https://allrecipes.com/recipe/12345')).toBe(true);
        expect(urlMatch('*.allrecipes.com/recipe/*', 'https://other.com/recipe/12345')).toBe(false);
    });
    it('matches path globs without crossing / (single *)', () => {
        // Single * does NOT span /. GitHub PRs are owner/repo so need two segments before /pull/
        expect(urlMatch('github.com/*/*/pull/*', 'https://github.com/foo/bar/pull/42')).toBe(true);
        expect(urlMatch('github.com/*/pull/*', 'https://github.com/foo/pull/42')).toBe(true);
        // First * is one segment, can't be "foo/bar"
        expect(urlMatch('github.com/*/pull/*', 'https://github.com/foo/bar/pull/42')).toBe(false);
        expect(urlMatch('github.com/*/*/pull/*', 'https://github.com/foo/bar/issues/42')).toBe(false);
    });
    it('matches universal *', () => {
        expect(urlMatch('*', 'https://anything.example')).toBe(true);
        expect(urlMatch('*', 'http://localhost:1234/x')).toBe(true);
    });
    it('returns false for invalid URLs', () => {
        expect(urlMatch('github.com', 'not a url')).toBe(false);
    });
    it('handles trailing /* as single segment', () => {
        // `*` does not span `/` — for "match everything" use `**`
        expect(urlMatch('example.com/*', 'https://example.com/foo')).toBe(true);
        expect(urlMatch('example.com/*', 'https://example.com/foo/bar')).toBe(false);
        expect(urlMatch('example.com/**', 'https://example.com/foo/bar')).toBe(true);
        expect(urlMatch('example.com/*', 'https://example.com/')).toBe(true);
    });
});
