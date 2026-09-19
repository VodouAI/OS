/**
 * WHERE the CLI writes its session logs — not just how it prunes them.
 *
 * `quiet.ts` resolved its root as `process.env.VODOU_PROJECT_PATH || process.cwd()`,
 * so the logs landed wherever the CLI was launched from. Running the compiled CLI
 * from inside `MCP-servers/Vodou-Console` (what a dev or a test does — the
 * `bin/vodou-cli` launcher exports the variable, so it was never the culprit)
 * built a whole `.vodou/workspace/` there.
 *
 * Found 2026-09-16: 173 zero-byte `cli-<pid>.log` files under the console, 173
 * more inherited by a directory copy, and a third tree at
 * `.vodou/workspace/.vodou/` holding an abandoned `console.token` — a credential
 * sitting at a path nothing audits. Rotation was never the bug; it prunes by
 * mtime in the directory it is given, and it worked. The location was the bug.
 *
 * Same family as the test-isolation cascade fixed the same day: a root derived
 * from where the process happened to be standing rather than from something that
 * proves it is a project root.
 *
 * The rule these tests hold: the answer never depends on the caller's cwd, and an
 * env var is trusted only when it really points at a project root (the guard
 * `db.ts` already applies — mirrored, not shared, because `quiet.ts` is imported
 * before `db.js` on purpose and must not trigger its startup side effects).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { projectRoot } from '../cli/quiet.js';
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
let saved;
let cwd;
const made = [];
beforeEach(() => {
    saved = process.env.VODOU_PROJECT_PATH;
    cwd = process.cwd();
});
afterEach(() => {
    process.chdir(cwd);
    if (saved === undefined)
        delete process.env.VODOU_PROJECT_PATH;
    else
        process.env.VODOU_PROJECT_PATH = saved;
    for (const d of made.splice(0)) {
        try {
            fs.rmSync(d, { recursive: true, force: true });
        }
        catch { /* best effort */ }
    }
});
/** A directory that looks like a project root (holds a vodou-core.db). */
function fakeRoot() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cliroot-'));
    fs.writeFileSync(path.join(d, 'vodou-core.db'), '');
    made.push(d);
    return d;
}
/** A directory that does not (the trap: "empty" is not "invalid" to a cwd fallback). */
function notARoot() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clinotroot-'));
    made.push(d);
    return d;
}
describe('CLI session logs land in the project root, not the launch directory', () => {
    it('ignores cwd entirely — the bug that filled the console dir with 173 husks', () => {
        delete process.env.VODOU_PROJECT_PATH;
        const fromRepo = projectRoot();
        process.chdir(path.join(REPO, 'MCP-servers/Vodou-Console'));
        const fromConsole = projectRoot();
        expect(fromConsole).toBe(fromRepo);
        expect(path.resolve(fromConsole)).toBe(path.resolve(REPO));
        expect(fromConsole).not.toContain('MCP-servers');
    });
    it('honours VODOU_PROJECT_PATH when it really is a project root', () => {
        const root = fakeRoot();
        process.env.VODOU_PROJECT_PATH = root;
        expect(projectRoot()).toBe(root);
    });
    it('REJECTS VODOU_PROJECT_PATH when the directory holds no vodou-core.db', () => {
        // A stale path (the iCloud "folder 2" case db.ts documents) must not become
        // the place credentials and logs get written.
        const bogus = notARoot();
        process.env.VODOU_PROJECT_PATH = bogus;
        const got = projectRoot();
        expect(got).not.toBe(bogus);
        expect(path.resolve(got)).toBe(path.resolve(REPO));
    });
    it('gives the same answer from anywhere, with or without the env var', () => {
        const tmp = notARoot();
        delete process.env.VODOU_PROJECT_PATH;
        process.chdir(tmp);
        const a = projectRoot();
        process.chdir(path.join(REPO, 'MCP-servers'));
        const b = projectRoot();
        expect(a).toBe(b);
        expect(path.resolve(a)).toBe(path.resolve(REPO));
    });
});
