import { describe, it, expect } from 'vitest';
import { parseDraftJson } from '../src/api/skill-console-create.js';

describe('parseDraftJson', () => {
  it('parses a clean object', () => {
    expect(parseDraftJson('{"name":"x","n":1}')).toEqual({ name: 'x', n: 1 });
  });

  it('ignores prose AFTER the closing brace (the old parser threw here)', () => {
    const raw = '{"name":"daily-digest"}\n\nHope that helps! Let me know if you want changes.';
    expect(parseDraftJson(raw)).toEqual({ name: 'daily-digest' });
  });

  it('ignores reasoning BEFORE the object', () => {
    const raw = 'Sure, here is the skill definition you asked for:\n{"name":"x"}';
    expect(parseDraftJson(raw)).toEqual({ name: 'x' });
  });

  it('strips a ```json fence', () => {
    expect(parseDraftJson('```json\n{"a":true}\n```')).toEqual({ a: true });
  });

  it('strips a <thinking> block', () => {
    const raw = '<thinking>The user wants a daily skill...</thinking>\n{"name":"x"}';
    expect(parseDraftJson(raw)).toEqual({ name: 'x' });
  });

  it('tolerates trailing commas', () => {
    expect(parseDraftJson('{"a":1,"b":[1,2,],}')).toEqual({ a: 1, b: [1, 2] });
  });

  it('does not split on braces inside string values', () => {
    const raw = '{"prompt_template":"use {{user_message}} and reply"}';
    expect(parseDraftJson(raw)).toEqual({ prompt_template: 'use {{user_message}} and reply' });
  });

  it('throws a helpful error on empty / no-object input', () => {
    expect(() => parseDraftJson('')).toThrow(/empty/i);
    expect(() => parseDraftJson('no json here')).toThrow(/no JSON object/i);
  });
});
