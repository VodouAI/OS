import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { textingStyleRider, TEXTING_THREAD, TEXTING_STYLE_TEXT } from '../texting-style.js';

// T1 (PLAN-TEXTING-FEEL): answers in the texting thread read like texts — on
// the phone AND in /simple, which is the same conversation.
describe('texting style rider', () => {
  it('applies to the texting thread (phone texts and /simple share it)', () => {
    expect(textingStyleRider(TEXTING_THREAD, false)).toBe(TEXTING_STYLE_TEXT);
    const simple = readFileSync(join(__dirname, '../../public/simple/index.html'), 'utf8');
    expect(simple).toContain(`var convId = '${TEXTING_THREAD}'`);
  });
  it('nowhere else, and never on a menu reply or guest turn', () => {
    expect(textingStyleRider('web:default', false)).toBe('');
    expect(textingStyleRider('workbench:channel:slack', false)).toBe('');
    expect(textingStyleRider(TEXTING_THREAD, true)).toBe('');
  });
  it('asks for texting shape: answer first, short, no headers/tables/lists', () => {
    expect(TEXTING_STYLE_TEXT).toMatch(/Answer first/);
    expect(TEXTING_STYLE_TEXT).toMatch(/No headers, tables, bold or bullet lists/);
    expect(TEXTING_STYLE_TEXT).toMatch(/400 characters/);
  });
  it('is wired at BOTH prompt-building sites and declared as a lane', () => {
    const llm = readFileSync(join(__dirname, '../llm.ts'), 'utf8');
    expect(llm.match(/noteUserBodyLane\(conversationId, 'texting_style'/g)?.length).toBe(2);
    const lanes = readFileSync(join(__dirname, '../../../../lanes.toml'), 'utf8');
    expect(lanes).toMatch(/name = "texting_style"/);
  });
});
