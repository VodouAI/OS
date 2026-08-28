/**
 * Find skills on disk, however the user has arranged them.
 *
 * Both graph endpoints used to hardcode `skills/<group>/<skill>/actions.json` —
 * exactly two levels. Measured on this repo 2026-08-26 that missed **13 of 49**
 * skills, every one of them under a sub-group (`skills/agents/fundraising/…`),
 * and it would miss more for anyone who nests differently. Skills are user
 * content: the layout is theirs, not ours, so the only correct rule is to look.
 *
 * A directory IS a skill when it directly contains `actions.json` or `SKILL.md`.
 * We never descend INTO one, so a skill that ships fixtures or a nested example
 * cannot register phantom children.
 */

import { readdir } from 'fs/promises';
import path from 'path';

export interface FoundSkill {
  /** Directory name — the skill's identity everywhere else in the system. */
  skill: string;
  /** Path from `skills/` to its parent, e.g. `agents/fundraising`. `''` at top level. */
  group: string;
  dir: string;
  actionsPath: string | null;
  skillMdPath: string | null;
}

/** Never worth walking into, at any depth. */
const SKIP = new Set(['node_modules', 'dist', 'build', '__tests__', '__pycache__', 'fixtures', 'assets', 'vendor']);

/**
 * `maxDepth` is a runaway guard, not a layout assumption — 6 is far past any
 * arrangement a person would choose, and it stops a symlink loop from hanging
 * a request. Nothing about the shape of the tree is assumed below it.
 */
export async function findSkills(skillsRoot: string, maxDepth = 6): Promise<FoundSkill[]> {
  const out: FoundSkill[] = [];

  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    if (!entries.length) return;

    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    const isSkill = names.has('actions.json') || names.has('SKILL.md');
    if (isSkill) {
      out.push({
        skill: path.basename(dir),
        group: path.dirname(rel) === '.' ? '' : path.dirname(rel),
        dir,
        actionsPath: names.has('actions.json') ? path.join(dir, 'actions.json') : null,
        skillMdPath: names.has('SKILL.md') ? path.join(dir, 'SKILL.md') : null,
      });
      return; // a skill's own subdirectories are its business, not more skills
    }

    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
      await walk(path.join(dir, e.name), rel ? path.join(rel, e.name) : e.name, depth + 1);
    }
  }

  await walk(skillsRoot, '', 0);
  out.sort((a, b) => a.skill.localeCompare(b.skill));
  return out;
}

/** One skill by name, wherever it lives. `null` when there is no such skill. */
export async function findSkill(skillsRoot: string, name: string): Promise<FoundSkill | null> {
  const all = await findSkills(skillsRoot);
  return all.find((s) => s.skill === name) ?? null;
}
