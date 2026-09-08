/**
 * P2b — the gateway's child registry, and the orphan that motivated it.
 *
 * `src/child_registry.rs` has tracked the engine's children since it was written.
 * The gateway had no equivalent across 98 spawn sites: nothing tracked a child,
 * nothing reaped one, and nothing could answer "what are we running".
 *
 * Measured while auditing this phase — not hypothetically — two `Vodou-channels`
 * servers parentless for FIFTEEN HOURS, from ordinary force-restarts the same day.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { registerChild, unregisterChild, activeChildren, killAllChildren, __resetChildRegistryForTest, } from '../child-registry.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Wait for a condition instead of guessing how long it takes.
 *
 * The fixed `sleep(300)` this replaces was enough for a spawn-and-exit on an
 * idle machine and not enough under a loaded suite: it failed once in a full
 * 144-file run and passed three times in a row in isolation. A flake in a
 * registry test reads as "the registry leaked a child", which is the exact
 * defect this file exists to catch — so the timing assumption had to go, not
 * the assertion.
 */
async function until(cond, whatFor, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
        if (Date.now() > deadline)
            throw new Error(`timed out after ${timeoutMs}ms waiting for: ${whatFor}`);
        await sleep(10);
    }
}
/** A child that will not exit on its own — the shape that orphans. */
const longRunner = () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)']);
describe('P2b — the child registry', () => {
    beforeEach(() => __resetChildRegistryForTest());
    it('answers the question nothing could answer: what are we running', async () => {
        const a = registerChild(longRunner(), 'test:alpha');
        const b = registerChild(longRunner(), 'test:beta');
        const running = activeChildren();
        expect(running.map((c) => c.label).sort()).toEqual(['test:alpha', 'test:beta']);
        expect(running.every((c) => c.ageMs >= 0), 'each carries how long it has been up').toBe(true);
        killAllChildren(0);
        await until(() => activeChildren().length === 0, 'both children to be reaped');
        for (const c of [a, b]) {
            try {
                c.kill('SIGKILL');
            }
            catch { /* gone */ }
        }
    });
    it('kills every registered child', async () => {
        const a = longRunner();
        const b = longRunner();
        registerChild(a, 'test:a');
        registerChild(b, 'test:b');
        expect(a.exitCode, 'alive before').toBeNull();
        const n = killAllChildren(0);
        expect(n, 'reports how many it signalled, so a caller can log it').toBe(2);
        const down = (c) => c.killed || c.exitCode !== null || c.signalCode !== null;
        await until(() => down(a) && down(b), 'both children to actually go down');
        expect(down(a), 'a is down').toBe(true);
        expect(down(b), 'b is down').toBe(true);
    });
    it('self-unregisters when a child exits on its own', async () => {
        const quick = spawn(process.execPath, ['-e', 'process.exit(0)']);
        registerChild(quick, 'test:quick');
        expect(activeChildren()).toHaveLength(1);
        // The hazard the Rust `unregister` exists for: a stale entry whose PID the OS
        // has since recycled would make `killAllChildren` shoot an innocent process.
        await until(() => activeChildren().length === 0, 'the exited child to leave no entry behind');
        expect(activeChildren()).toHaveLength(0);
    });
    it('a failed spawn is not tracked', () => {
        const dud = spawn('/nonexistent/definitely-not-a-binary-p2b', []);
        dud.on('error', () => { });
        registerChild(dud, 'test:dud');
        // No pid means nothing to kill; tracking it would be tracking nothing.
        expect(activeChildren().filter((c) => c.label === 'test:dud').length).toBe(0);
    });
    it('unregister is idempotent and tolerates unknown pids', () => {
        const c = longRunner();
        registerChild(c, 'test:u');
        const pid = c.pid;
        unregisterChild(pid);
        unregisterChild(pid);
        unregisterChild(999_999_99);
        expect(activeChildren()).toHaveLength(0);
        try {
            c.kill('SIGKILL');
        }
        catch { /* gone */ }
    });
    it('killing nothing is a no-op that says so', () => {
        expect(killAllChildren(0), 'no children → nothing signalled').toBe(0);
    });
});
/**
 * The channels bridge is NOT a registry case, and the test says why.
 *
 * It is `detached: true` + `unref()` on purpose — meant to outlive the gateway.
 * Registering it would kill it on exit and break the thing it exists to do. Its
 * invariant is "one bridge per channel", so the fix is to end the PREVIOUS one
 * before spawning, which is what was missing.
 */
describe('P2b — the channels bridge reconciles instead', () => {
    const src = readFileSync(join(__dirname, '../api/channels.ts'), 'utf-8');
    it('kills a live previous pid before respawning', () => {
        const fn = src.slice(src.indexOf('function spawnChannel'), src.indexOf('function parseToolOutput'));
        expect(fn, 'a live prior bridge must be ended, not abandoned').toContain('isProcessAlive(prior.pid)');
        expect(fn, 'and signalled').toContain("process.kill(prior.pid, 'SIGTERM')");
    });
    it('is still detached — the registry must NOT adopt it', () => {
        const fn = src.slice(src.indexOf('function spawnChannel'), src.indexOf('function parseToolOutput'));
        expect(fn, 'it outlives the gateway by design').toContain('detached: true');
        expect(fn, 'and is not registered').not.toContain('registerChild(');
    });
});
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
