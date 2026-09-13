/**
 * PLAN-MEMORY-PAGE-SAYS-WHAT-IT-IS gate 6 — the Memory page's "Workspace files"
 * row lists what the daemon REGENERATES, not every `.md` in a directory.
 *
 * It used to list the directory. That is how the operating manual ended up on a
 * memory page with an Edit button, and it would put the same invitation on any
 * file a person happens to drop in the workspace. Two halves, both checked here
 * because they can drift apart: the API must classify each file honestly, and
 * the view must filter on that classification rather than render everything.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
let ROOT = '';
vi.mock('../db.js', () => ({
    getProjectRoot: () => ROOT,
    getMemoryDb: () => {
        throw new Error('the timeline route must not need memory.db');
    },
}));
const BANNER = '<!-- rendered by vodou-core memory_render at 2026-09-10 03:00 -->';
async function seedWorkspace() {
    ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-chips-'));
    const ws = path.join(ROOT, '.vodou', 'workspace');
    await fs.mkdir(ws, { recursive: true });
    // The three the daemon writes, each carrying its renderer's banner.
    await fs.writeFile(path.join(ws, 'MEMORY.md'), `# MEMORY.md\n${BANNER}\n- a fact\n`);
    await fs.writeFile(path.join(ws, 'TOOLS.md'), `# TOOLS.md\n${BANNER}\n- a verb\n`);
    await fs.writeFile(path.join(ws, 'HEARTBEAT.md'), `# HEARTBEAT.md\n${BANNER}\n- a directive\n`);
    // Two that nothing renders: a leftover from an older install, and a note a
    // person dropped in the folder themselves.
    await fs.writeFile(path.join(ws, 'USER.md'), '# USER.md\nName: Chad\n');
    await fs.writeFile(path.join(ws, 'NOTES.md'), '# my scratch notes\n- buy milk\n');
}
describe('the workspace chip row', () => {
    let app;
    beforeEach(async () => {
        await seedWorkspace();
        const { memoryRouter } = await import('../api/memory.js');
        app = express();
        app.use('/api/memory', memoryRouter);
    });
    afterEach(async () => {
        if (ROOT)
            await fs.rm(ROOT, { recursive: true, force: true });
        vi.resetModules();
    });
    it('flags exactly the files a renderer wrote, by their banner', async () => {
        const res = await request(app).get('/api/memory/timeline?days=1').expect(200);
        const byName = Object.fromEntries(res.body.workspaceFiles.map((f) => [f.name, f]));
        for (const name of ['MEMORY.md', 'TOOLS.md', 'HEARTBEAT.md']) {
            expect(byName[name], `${name} missing from the API`).toBeTruthy();
            expect(byName[name].generated, `${name} should be generated`).toBe(true);
            // The bound the chip colours on — gate 8 checks it against the engine's.
            expect(byName[name].freshness_secs).toBe(60);
        }
        for (const name of ['USER.md', 'NOTES.md']) {
            expect(byName[name].generated, `${name} is not written by a renderer`).toBe(false);
            expect(byName[name].freshness_secs, `${name} has no renderer, so no bound`).toBeUndefined();
        }
    });
    it('does not put a chip on a file nothing renders', async () => {
        const res = await request(app).get('/api/memory/timeline?days=1').expect(200);
        // The view's filter, applied to the API's own answer. Keeping the predicate
        // here in the shape the view uses is deliberate: if someone widens one, this
        // fails rather than quietly re-inviting people to edit a file no session reads.
        const chips = res.body.workspaceFiles
            .filter((f) => f.generated)
            .map((f) => f.name)
            .sort();
        expect(chips).toEqual(['HEARTBEAT.md', 'MEMORY.md', 'TOOLS.md']);
        expect(chips).not.toContain('NOTES.md');
        expect(chips).not.toContain('USER.md');
        expect(chips).not.toContain('AGENTS.md');
    });
    it('the view filters on `generated`, so the API answer is the whole story', async () => {
        const view = await fs.readFile(path.join(process.cwd(), 'public', 'js', 'views', 'memory.js'), 'utf-8');
        expect(view.includes('data.workspaceFiles.filter((x) => x.generated)'), 'the chip loop stopped filtering on `generated` — it is listing a directory again').toBe(true);
    });
});
