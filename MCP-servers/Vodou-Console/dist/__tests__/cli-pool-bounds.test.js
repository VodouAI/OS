/**
 * GW-5 / GW-10 — the pooled `claude` processes had no ceiling and no reaper.
 *
 * `_cliSessions` is one entry per conversation and each entry is a real
 * `claude` process holding a model context. Nothing capped how many existed;
 * the only thing that ever removed one was a 10-minute idle timer. And when one
 * WAS removed, `proc.kill('SIGTERM')` signalled a single pid — while the child
 * is spawned `detached: true`, so its own children (a turn's Bash steps, the
 * `vodou-core` invocations under them) are in a process group nothing
 * signalled. They kept running, holding database handles, unreaped.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { __cliPoolInternals } from '../llm.js';
const { maxCliSessions, cliSessionIsIdle, pickCliEvictionVictim, CLI_KILL_ESCALATION_MS } = __cliPoolInternals;
const session = (id, lastActivityAt, busy = false) => ({
    conversationId: id,
    lastActivityAt,
    pending: busy ? {} : null,
    queue: [],
});
const prevEnv = process.env.VODOU_GATEWAY_MAX_CLI_SESSIONS;
afterEach(() => {
    if (prevEnv === undefined)
        delete process.env.VODOU_GATEWAY_MAX_CLI_SESSIONS;
    else
        process.env.VODOU_GATEWAY_MAX_CLI_SESSIONS = prevEnv;
});
describe('GW-5 — the pool has a ceiling', () => {
    it('has a finite default', () => {
        delete process.env.VODOU_GATEWAY_MAX_CLI_SESSIONS;
        const n = maxCliSessions();
        expect(n).toBeGreaterThan(0);
        expect(Number.isFinite(n)).toBe(true);
    });
    it('is configurable, and refuses a nonsense value rather than becoming 0', () => {
        process.env.VODOU_GATEWAY_MAX_CLI_SESSIONS = '3';
        expect(maxCliSessions()).toBe(3);
        // 0 or garbage would mean "evict everything, always" — every turn would
        // spawn and immediately be evicted.
        for (const bad of ['0', '-1', 'lots', '']) {
            process.env.VODOU_GATEWAY_MAX_CLI_SESSIONS = bad;
            expect(maxCliSessions(), bad).toBeGreaterThanOrEqual(1);
        }
    });
    it('evicts the LEAST recently used session', () => {
        const sessions = [session('aaa', 5000), session('bbb', 1000), session('ccc', 9000)];
        expect(pickCliEvictionVictim(sessions, 'new')?.conversationId).toBe('bbb');
    });
    // THE PROPERTY THAT MATTERS. A cap that can kill a live turn is worse than no
    // cap: the user loses an answer they are watching stream, for a limit they
    // cannot see.
    it('never evicts a session with a turn in flight', () => {
        const sessions = [session('busy-and-oldest', 1, true), session('idle-but-newer', 9000)];
        expect(pickCliEvictionVictim(sessions, 'new')?.conversationId).toBe('idle-but-newer');
    });
    it('never evicts a session with work queued', () => {
        const queued = { ...session('queued-oldest', 1), queue: [{}] };
        const sessions = [queued, session('idle', 9000)];
        expect(pickCliEvictionVictim(sessions, 'new')?.conversationId).toBe('idle');
    });
    it('returns null when every session is busy — the caller goes over the cap instead', () => {
        const sessions = [session('a', 1, true), session('b', 2, true)];
        expect(pickCliEvictionVictim(sessions, 'new')).toBeNull();
    });
    it('never evicts the conversation it is making room for', () => {
        // Re-entry for the same conversation must not kill its own predecessor out
        // from under the turn that is arriving.
        const sessions = [session('mine', 1)];
        expect(pickCliEvictionVictim(sessions, 'mine')).toBeNull();
    });
    it('idleness is exactly "nothing pending and nothing queued"', () => {
        expect(cliSessionIsIdle(session('x', 0))).toBe(true);
        expect(cliSessionIsIdle(session('x', 0, true))).toBe(false);
        expect(cliSessionIsIdle({ ...session('x', 0), queue: [{}] })).toBe(false);
    });
});
describe('GW-10 — the kill reaches the group', () => {
    it('gives the group time to exit before SIGKILL', () => {
        // Long enough for a `vodou-core` child to finish a write (including a
        // busy_timeout retry), short enough not to make a recycle feel slow.
        expect(CLI_KILL_ESCALATION_MS).toBeGreaterThanOrEqual(1000);
        expect(CLI_KILL_ESCALATION_MS).toBeLessThanOrEqual(10000);
    });
    it('the source signals the process GROUP, not just the pid', async () => {
        // A behaviour test would have to spawn a real detached tree; the defect was
        // a missing minus sign, so assert on the source that it is there and that
        // both phases exist.
        const fs = await import('node:fs');
        const url = await import('node:url');
        const path = await import('node:path');
        const here = path.dirname(url.fileURLToPath(import.meta.url));
        const src = fs.readFileSync(path.join(here, '..', 'llm.ts'), 'utf8');
        const fn = src.slice(src.indexOf('function killCliProcessGroup'), src.indexOf('function killCliSession'));
        expect(fn, 'SIGTERM to the group').toContain("process.kill(-pid, 'SIGTERM')");
        expect(fn, 'SIGKILL escalation to the group').toContain("process.kill(-pid, 'SIGKILL')");
        expect(fn, 'a single-pid fallback for Windows / non-leaders').toContain("session.proc.kill('SIGTERM')");
        expect(fn, 'the escalation timer must not hold the gateway open').toContain('unref');
    });
});
