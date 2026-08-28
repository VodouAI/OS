/**
 * Asking the model for a recipe instead of JSON (PLAN-GRAPH-SKILLS P1).
 *
 * The behaviour worth testing is not "it calls an LLM". It is:
 *   - a model that returns fenced, chatty output still produces a skill,
 *   - a model that gets it WRONG gets the compiler's own words back and one
 *     more try, and
 *   - a model that cannot be repaired yields null so the caller falls back,
 *     rather than writing a broken skill.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { findEngine, announceEngineSkip } from './_engine.js';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import {
  authorRecipe,
  extractRecipe,
  recipeBlock,
  extractRecipeBlock,
  RECIPE_SYNTAX,
} from '../skill-recipe-author.js';

const ENGINE = findEngine(['recipe', '--help'], /compile/);
const ENGINE_OK = ENGINE !== null;
if (!ENGINE_OK) announceEngineSkip('skill-recipe-author', 'recipe compile');

beforeAll(() => {
  if (ENGINE) process.env.VC_PATH = ENGINE;
});

const GOOD = [
  'together sources:',
  '  cal: google-calendar.list-events {"calendarId":"primary"}',
  '  mail: gmail.messages_list {"maxResults":5}',
  'then:',
  '  need: 1 of 2',
  '  brief: write a briefing from {cal, mail}',
  '',
].join('\n');

describe('extractRecipe — models do not follow "output only the recipe"', () => {
  it.runIf(ENGINE_OK)('strips code fences', () => {
    expect(extractRecipe('```yaml\n' + GOOD + '```')).toContain('together sources:');
  });
  it.runIf(ENGINE_OK)('strips chatty preamble before the first block', () => {
    const out = extractRecipe("Sure! Here's the recipe you asked for:\n\n" + GOOD);
    expect(out.startsWith('together sources:')).toBe(true);
  });
  it.runIf(ENGINE_OK)('leaves a clean recipe alone apart from trailing whitespace', () => {
    expect(extractRecipe(GOOD)).toBe(GOOD);
  });
  it.runIf(ENGINE_OK)('returns something harmless for junk rather than throwing', () => {
    expect(() => extractRecipe('I cannot help with that.')).not.toThrow();
  });
});

describe('authorRecipe', () => {
  const input = { name: 'test-briefing', description: 'brief me', requiredTools: 'gmail,google-calendar' };

  it.runIf(ENGINE_OK)('compiles a good first answer and reports it was not repaired', async () => {
    const out = await authorRecipe(input, async () => '```\n' + GOOD + '```');
    expect(out).not.toBeNull();
    expect(out!.repaired).toBe(false);
    const steps = (out!.actions as { initial_steps: Array<Record<string, unknown>> }).initial_steps;
    expect(steps.filter((s) => s.parallel_group)).toHaveLength(2);
    expect(steps.find((s) => s.kind === 'join')?.min_success).toBe(1);
  });

  it.runIf(ENGINE_OK)("hands the compiler's own error back and accepts the repair", async () => {
    const calls: string[] = [];
    const out = await authorRecipe(input, async (prompt) => {
      calls.push(prompt);
      // First answer references a branch that does not exist.
      if (calls.length === 1) return 'together s:\n  a: x.y\nthen:\n  b: use {ghost}\n';
      return GOOD;
    });
    expect(out).not.toBeNull();
    expect(out!.repaired).toBe(true);
    expect(calls).toHaveLength(2);
    // The repair prompt must carry the compiler's exact words — they name the fix.
    expect(calls[1]).toContain('ghost');
    expect(calls[1]).toContain('no earlier step produces');
    expect(calls[1]).toContain('COMPILER ERROR');
  });

  it.runIf(ENGINE_OK)('gives up rather than writing a broken skill', async () => {
    const out = await authorRecipe(input, async () => 'together s:\n  a: x.y\nthen:\n  b: use {ghost}\n');
    expect(out).toBeNull();
  });

  it.runIf(ENGINE_OK)('gives up on an empty model response', async () => {
    expect(await authorRecipe(input, async () => '')).toBeNull();
  });

  it.runIf(ENGINE_OK)('a model that writes a check: gets a real gate (P2), not a refusal', async () => {
    // Until P2 the compiler refused check: and this fell back to the JSON path.
    // Now the model can ask for a gate and get one.
    const withCheck = 'together s:\n  a: mcp-monitor.get_cpu_info\ncheck:\n  - is it sourced?\n';
    const out = await authorRecipe(input, async () => withCheck);
    expect(out).not.toBeNull();
    const steps = (out!.actions as { initial_steps: Array<Record<string, unknown>> }).initial_steps;
    expect(steps.find((s) => s.kind === 'verifier')?.fresh_context).toBe(true);
  });

  it.runIf(ENGINE_OK)('the prompt tells the model the same syntax the compiler enforces', async () => {
    let seen = '';
    await authorRecipe(input, async (p) => { seen = p; return GOOD; });
    expect(seen).toContain(RECIPE_SYNTAX);
    expect(seen).toContain('Free-text arguments are rejected');
    expect(seen).toContain('need: N of M');
    expect(seen).toContain('sends, posts or deletes');
  });
});

describe('the recipe stored in SKILL.md', () => {
  it.runIf(ENGINE_OK)('round-trips out of the markdown block', () => {
    const md = `# a skill\n\n## Shape\n\n${recipeBlock(GOOD)}\n`;
    expect(extractRecipeBlock(md)).toBe(GOOD);
  });
  it.runIf(ENGINE_OK)('returns null when a skill has no recipe (the whole existing corpus)', () => {
    expect(extractRecipeBlock('# plain skill\n\nno graph here\n')).toBeNull();
  });
});
