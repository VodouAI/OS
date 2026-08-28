/**
 * Skills are USER content — the directory layout belongs to whoever installed
 * them. Both graph endpoints once hardcoded exactly two levels and silently
 * missed 13 of 49 skills on the author's own machine. These tests pin the
 * property that matters: depth is discovered, never assumed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { findSkills, findSkill } from '../skill-discovery.js';
let root;
beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'skills-'));
    const mk = async (rel, files) => {
        const d = path.join(root, rel);
        await mkdir(d, { recursive: true });
        for (const f of files)
            await writeFile(path.join(d, f), f.endsWith('.json') ? '{}' : '# skill', 'utf-8');
    };
    await mk('top-level-skill', ['actions.json', 'SKILL.md']); // depth 1
    await mk('group/mid-skill', ['actions.json']); // depth 2 — the old limit
    await mk('group/sub/deep-skill', ['actions.json']); // depth 3 — was missed
    await mk('a/b/c/d/very-deep-skill', ['SKILL.md']); // depth 5
    await mk('group/md-only-skill', ['SKILL.md']); // no actions.json
    await mk('node_modules/pkg/fake-skill', ['actions.json']); // must be skipped
    await mk('.hidden/secret-skill', ['actions.json']); // must be skipped
    await mk('group/mid-skill/fixtures/nested', ['actions.json']); // inside a skill — not a skill
    await mkdir(path.join(root, 'empty-dir'), { recursive: true });
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
describe('findSkills', () => {
    it('finds skills at every depth, not just two levels', async () => {
        const names = (await findSkills(root)).map((s) => s.skill);
        expect(names).toContain('top-level-skill');
        expect(names).toContain('mid-skill');
        expect(names).toContain('deep-skill'); // the regression
        expect(names).toContain('very-deep-skill');
    });
    it('treats a directory with only SKILL.md as a skill, with a null actionsPath', async () => {
        const s = (await findSkills(root)).find((x) => x.skill === 'md-only-skill');
        expect(s).toBeDefined();
        expect(s.actionsPath).toBeNull();
        expect(s.skillMdPath).not.toBeNull();
    });
    it('reports the group as the path from skills/, so nesting is visible', async () => {
        const all = await findSkills(root);
        expect(all.find((s) => s.skill === 'top-level-skill').group).toBe('');
        expect(all.find((s) => s.skill === 'mid-skill').group).toBe('group');
        expect(all.find((s) => s.skill === 'deep-skill').group).toBe(path.join('group', 'sub'));
    });
    it('never descends into a skill — fixtures inside one are not skills', async () => {
        const names = (await findSkills(root)).map((s) => s.skill);
        expect(names).not.toContain('nested');
    });
    it('skips node_modules and dot-directories', async () => {
        const names = (await findSkills(root)).map((s) => s.skill);
        expect(names).not.toContain('fake-skill');
        expect(names).not.toContain('secret-skill');
    });
    it('returns [] for a missing root instead of throwing', async () => {
        expect(await findSkills(path.join(root, 'does-not-exist'))).toEqual([]);
    });
    it('respects maxDepth as a runaway guard', async () => {
        const shallow = (await findSkills(root, 1)).map((s) => s.skill);
        expect(shallow).toContain('top-level-skill');
        expect(shallow).not.toContain('very-deep-skill');
    });
    it('a symlink loop terminates rather than hanging', async () => {
        const loop = path.join(root, 'group', 'loop');
        await symlink(root, loop).catch(() => { });
        const found = await findSkills(root);
        expect(found.length).toBeGreaterThan(3);
    });
    it('findSkill locates one by name at any depth, and null when absent', async () => {
        expect((await findSkill(root, 'deep-skill'))?.skill).toBe('deep-skill');
        expect(await findSkill(root, 'no-such-skill')).toBeNull();
    });
});
describe('the real skills tree', () => {
    const repo = path.resolve(__dirname, '../../../..');
    it('finds every actions.json that `find` finds — no layout is assumed', async () => {
        const { execSync } = await import('child_process');
        const onDisk = execSync(`find ${repo}/skills -name actions.json | wc -l`, { encoding: 'utf8' }).trim();
        const found = (await findSkills(path.join(repo, 'skills'))).filter((s) => s.actionsPath);
        expect(found.length).toBe(Number(onDisk));
    });
});
