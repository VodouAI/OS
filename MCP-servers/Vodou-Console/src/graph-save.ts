/**
 * `graph-save` — turn a plan card into a saved, optionally scheduled skill.
 *
 * PLAN-GRAPH-FRONTEND §5.2. `[Save + schedule]` was a chat-message shim: it sent
 * the string "save this as a skill and schedule it" and hoped a model would do
 * the right thing with it. That is the button most likely to be pressed after
 * `[Run once]`, and hoping is not a mechanism.
 *
 * What this writes is deliberately the same shape `create_skill` produces, for
 * one reason learned the hard way on 2026-08-25: **a sidecar `actions.json`
 * alone does not drive the engine from chat.** `detectWorkflow` reads the INLINE
 * `<!-- AGENT_ACTIONS: … -->` block, so a skill saved with only a sidecar gets
 * executed by the LLM via Bash — no run record, no graph events, no card. Both
 * forms are written, with the recipe kept in the body as the source a human
 * edits.
 */
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { compileRecipe } from './executor.js';
import { getProjectRoot } from './db.js';

const run = promisify(execFile);

export interface SaveRequest {
  recipe: string;
  name: string;
  /** Phrases that should load this skill. The first gets the higher priority. */
  triggers?: string[];
  /** `every 1d`, `at 09:00`, a cron string — anything `schedule add` accepts. */
  schedule?: string;
  description?: string;
}

export interface SaveResult {
  name: string;
  path: string;
  triggers: string[];
  scheduled: string | null;
  /** Set when the skill saved but the schedule did not — a partial success that
   *  must be reported as one rather than rounded up to "done". */
  scheduleError?: string;
}

/** `My Weekly Digest` → `my-weekly-digest`. Same normalisation as create_skill. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export async function saveRecipeAsSkill(req: SaveRequest): Promise<SaveResult> {
  const name = slugify(req.name || 'workflow');
  if (!name) throw new Error('a name is required');
  if (!req.recipe?.trim()) throw new Error('a recipe is required');

  // Compile FIRST. Writing a skill whose recipe does not compile would create
  // something that looks saved and cannot run — and the compiler is what makes
  // an unguarded send or a join that drops a branch impossible to express.
  const compiled = await compileRecipe(req.recipe);

  const root = getProjectRoot();
  const dir = path.join(root, 'skills', 'my-skills', name);
  await mkdir(dir, { recursive: true });

  const description = (req.description || '').trim() || `Saved from a plan card on ${new Date().toISOString().slice(0, 10)}`;
  const triggers = (req.triggers || []).map((t) => t.trim().toLowerCase()).filter(Boolean);

  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    ...(triggers.length ? ['trigger_phrases:', ...triggers.map((t) => `  - ${t}`)] : []),
    '---',
    '',
    `# ${req.name}`,
    '',
    'Saved from a plan card. The **recipe below is the source** — edit the words,',
    'not the JSON; `vodou-core recipe compile` regenerates the rest.',
    '',
    '## Shape',
    '',
    ...req.recipe.trimEnd().split('\n').map((l) => `    ${l}`),
    '',
    // The inline block is what `detectWorkflow` reads. Without it the engine
    // never runs this skill; the LLM does, via Bash.
    `<!-- AGENT_ACTIONS: ${JSON.stringify(compiled.actions)} -->`,
    '',
  ].join('\n');

  const skillPath = path.join(dir, 'SKILL.md');
  await writeFile(skillPath, frontmatter, 'utf-8');
  await writeFile(path.join(dir, 'actions.json'), JSON.stringify(compiled.actions, null, 2), 'utf-8');

  // Intent mappings, so the trigger phrases actually load it. Written only after
  // the files exist — P1-6 was the reverse, and registered triggers for a skill
  // that had not been written.
  if (triggers.length) {
    const { getDb } = await import('./db.js');
    const db = getDb();
    for (let i = 0; i < triggers.length; i++) {
      db.prepare(
        `INSERT OR REPLACE INTO intent_mappings
           (keyword, server_name, tool_name, priority, execution_type, tool_parameters)
         VALUES (?, 'vodou-core', 'vc_load_skill', ?, 'mcp', ?)`,
      ).run(triggers[i], i === 0 ? 10 : 9, JSON.stringify({ skill_name: name }));
    }
  }

  let scheduled: string | null = null;
  let scheduleError: string | undefined;
  if (req.schedule?.trim()) {
    // The scheduler's own CLI, one spawn. The payload is the trigger phrase,
    // because that is exactly what a person would type to run it.
    const payload = triggers[0] || name;
    try {
      await run(path.join(root, 'vodou-core'), ['schedule', 'add', name, req.schedule.trim(), payload], {
        cwd: root,
        timeout: 20_000,
      });
      scheduled = req.schedule.trim();
    } catch (err) {
      // The skill IS saved. Reporting "done" here would be the more convenient
      // lie; the caller needs to know the schedule is the part that failed.
      scheduleError = err instanceof Error ? err.message : String(err);
      console.error(`[GraphSave] saved "${name}" but scheduling failed:`, scheduleError);
    }
  }

  return { name, path: skillPath, triggers, scheduled, ...(scheduleError ? { scheduleError } : {}) };
}
