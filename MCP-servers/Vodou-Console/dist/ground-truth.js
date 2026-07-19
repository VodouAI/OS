/**
 * ground-truth.ts — PLAN-CONTEXT-GROUND-TRUTH (0.6.13).
 *
 * Per-turn deterministic facts block ("VODOU GROUND TRUTH") fetched from the
 * Rust daemon's `cmd:"context"` verb — the single ContextGroundTruth emitter
 * that also serves `vodou-core context-truth` and heartbeat pre-flight. The
 * gateway passes what only it knows (the turn's spawn cwd + project binding);
 * the daemon computes the rest (git, MCP health, skills, intents, memory).
 *
 * Design rule (plan §0): facts the agent cannot misread beat prose it can
 * misinterpret. So when the daemon is down we do NOT skip injection — we build
 * a minimal block from values the gateway can compute locally (cwd, install
 * root, project binding), clearly labeled as partial. Never inject a guess.
 *
 * dispatchToProvider() fetches once per turn and stashes the block in a
 * per-conversation map; provider paths read it synchronously:
 *   - claude-cli / kimi-cli → injected into the per-turn user prompt (their
 *     system prompt is cached / fixed at pooled-session spawn, so it would go
 *     stale there — the exact bug this plan kills)
 *   - SDK / OpenAI-compat / ollama / etc. → prepended to memoryContext, which
 *     those paths rebuild into the system prompt (or late context turn) every
 *     call
 */
import { sockConnectTarget } from './cli-portability.js';
import net from 'net';
import path from 'path';
import { getProjectRoot } from './db.js';
// Must exceed the daemon's worst-case internal build budget (git snapshot
// ceiling, now 800ms, + cold-catalog rebuild). At 1500ms a cold catalog or a
// just-restarted worker would blow past this and inject a false "daemon DOWN"
// fallback while the daemon actually finished ~0.5s later. 2500ms clears it.
const FETCH_TIMEOUT_MS = 2500;
// A healthy daemon read is ~50ms, so a first-attempt miss is almost always a
// transient race (mid-recycle socket blip, cold tick) rather than a real outage.
// We retry once after this short delay before emitting the UNKNOWN fallback —
// that converts nearly every transient miss into a full block instead of a false
// degraded turn. Keep it small: 2 * (delay + timeout) must stay within the
// caller's budget, and a genuinely-down daemon should still fail fast-ish.
const RETRY_DELAY_MS = 150;
/**
 * One socket attempt against the daemon. Resolves to the block string on success,
 * or `{ block: null, reason }` on any transient failure (socket error, timeout,
 * empty/unparseable response) so the caller decides whether to retry or fall back.
 * Never rejects — the reason is carried for logging.
 */
function attemptGroundTruthFetch(sockPath, request) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (r) => { if (!settled) {
            settled = true;
            resolve(r);
        } };
        try {
            const client = net.createConnection({ path: sockConnectTarget(sockPath) }, () => {
                client.write(request);
                client.end();
            });
            client.setTimeout(FETCH_TIMEOUT_MS);
            let data = '';
            client.on('data', (chunk) => { data += chunk.toString(); });
            client.on('end', () => {
                try {
                    const resp = JSON.parse(data.trim());
                    const block = resp?.data?.block;
                    if (typeof block === 'string' && block) {
                        finish({ ok: true, block });
                    }
                    else {
                        finish({ ok: false, reason: 'daemon returned empty/invalid block' });
                    }
                }
                catch {
                    finish({ ok: false, reason: 'daemon response unparseable' });
                }
            });
            client.on('error', (err) => {
                finish({ ok: false, reason: `socket error (${err?.message ?? 'unknown'})` });
            });
            client.on('timeout', () => {
                client.destroy();
                finish({ ok: false, reason: `timed out at ${FETCH_TIMEOUT_MS}ms` });
            });
        }
        catch (err) {
            finish({ ok: false, reason: `connect threw (${err?.message ?? 'unknown'})` });
        }
    });
}
/**
 * Fetch the rendered ground-truth block from the daemon; UNKNOWN fallback if it
 * stays unreachable. Tries once, and on a transient miss retries once after a
 * short delay before degrading — so a mid-recycle blip or cold tick no longer
 * produces a false degraded turn when the daemon is actually fine.
 */
export async function fetchGroundTruth(opts) {
    const sockPath = path.join(getProjectRoot(), '.vodou', 'daemon.sock');
    const payload = {};
    if (opts.cwd)
        payload.cwd = opts.cwd;
    if (opts.projectId)
        payload.project_id = opts.projectId;
    if (opts.projectRoot)
        payload.project_root = opts.projectRoot;
    if (opts.projectName)
        payload.project_name = opts.projectName;
    if (opts.conversationId)
        payload.conversation_id = opts.conversationId;
    const request = JSON.stringify({ cmd: 'context', payload }) + '\n';
    const first = await attemptGroundTruthFetch(sockPath, request);
    if (first.ok)
        return first.block;
    // Transient miss — pause briefly so a mid-recycle daemon/worker or cold catalog
    // can settle, then try once more before giving up.
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    const second = await attemptGroundTruthFetch(sockPath, request);
    if (second.ok) {
        console.warn(`[ground-truth] first probe missed (${first.reason}); retry succeeded → full block served`);
        return second.block;
    }
    console.warn(`[ground-truth] both probes missed (1: ${first.reason}; 2: ${second.reason}) → UNKNOWN (degraded) block injected; daemon may still be fine`);
    return localFallbackBlock(opts);
}
/**
 * Ambiguous-probe fallback (#2, the fail-safe): the daemon socket didn't answer
 * in time, errored, or returned an unparseable/empty block. That is NOT proof
 * the daemon is down — the far more common cause is a probe that lost a race
 * (cold catalog, a just-restarted worker, or the gateway/daemon caught
 * mid-recycle). A single ambiguous read used to declare "daemon DOWN — memory
 * recall + MCP/skill facts unavailable" *with override authority* ("THIS BLOCK
 * WINS"), so one flaky turn made the agent tell the user memory was offline when
 * it was fine. That intermittent-lie-with-authority is the worst possible shape.
 *
 * So we emit UNKNOWN, not DOWN: assert only the facts the gateway genuinely
 * holds in-process (cwd, install root, project binding) with authority, and
 * explicitly de-authorize the daemon status to "unverified this turn" — the
 * agent must NOT conclude any capability is unavailable from this block alone.
 */
export function localFallbackBlock(opts) {
    const install = getProjectRoot();
    const cwd = opts.cwd || opts.projectRoot || install;
    const lines = [];
    lines.push('─── VODOU GROUND TRUTH · degraded (daemon probe unanswered) ───');
    if (cwd === install) {
        lines.push(`CWD:      ${cwd}   (= Vodou install root)`);
    }
    else {
        lines.push(`CWD:      ${cwd}   ← your working directory ("here")`);
        lines.push(`INSTALL:  ${install}   (Vodou install root — NOT your cwd)`);
    }
    if (opts.projectId || opts.projectName) {
        lines.push(`PROJECT:  ${[opts.projectId, opts.projectName ? `"${opts.projectName}"` : ''].filter(Boolean).join(' ')}`);
    }
    else {
        lines.push('PROJECT:  (none — Default/global)');
    }
    if (opts.conversationId)
        lines.push(`CONVO:    ${opts.conversationId}`);
    lines.push('VODOU:    daemon status UNKNOWN this turn — the ground-truth probe did not');
    lines.push('          answer in time. This is NOT proof the daemon is down; memory');
    lines.push('          recall, MCP tools, and skills may well be live. Absence of a');
    lines.push('          fact here means "unverified this turn", not "unavailable".');
    lines.push('RULE:     The CWD / INSTALL / PROJECT lines above are authoritative. The');
    lines.push('          UNKNOWN daemon status is NOT — do NOT tell the user a capability');
    lines.push('          is offline based on this block; try the tool/recall and see.');
    lines.push('─────────────────────────────────────────────────────');
    return lines.join('\n');
}
// ── Pre-warm (PLAN-CONTEXT-GROUND-TRUTH · event-loop-contention fix) ─────────
//
// The probe used to fire ONLY at the provider chokepoint (dispatchToProvider),
// which is the busiest instant of the turn: the gateway is mid-assembly of the
// LLM request, right after the synchronous memory+brain work. On a single Node
// event loop the probe's connect/data/end callbacks starve behind that CPU work
// and BOTH attempts hit the 2500ms wall — a false degraded turn even though the
// daemon answers the CLI on the same socket in ~30ms. (Proof: gateway.log showed
// every degrade as "both probes missed (timed out; timed out)", retry saves = 0.)
//
// Fix: launch the probe at TURN INGRESS (chat(), before the memory+brain awaits)
// so its socket round-trip OVERLAPS that work — every await there yields the loop,
// giving the daemon's 30ms reply room to land. By the time dispatch reaches the
// chokepoint 2–5s later, the promise is already resolved → a synchronous hit,
// full block, every turn. The retry stays as the genuine-outage backstop.
//
// Must be launched inside the turn's AsyncLocalStorage scope (enterProjectContext
// via _store.enterWith) so agentCwd()/projectContext*() resolve the real values —
// which they do from chat() onward through the whole turn.
const _prewarm = new Map();
/**
 * Kick off the ground-truth probe early, without awaiting it, and stash the
 * in-flight promise keyed by conversationId. fetchGroundTruth never rejects, so
 * the stored promise always settles (full block or UNKNOWN fallback).
 */
export function prewarmGroundTruth(opts) {
    const key = opts.conversationId;
    if (!key)
        return;
    const p = fetchGroundTruth(opts);
    _prewarm.set(key, { p, at: Date.now() });
    if (_prewarm.size > 500) {
        const cutoff = Date.now() - BLOCK_TTL_MS;
        for (const [k, v] of _prewarm) {
            if (v.at < cutoff)
                _prewarm.delete(k);
        }
    }
}
/**
 * Consume the turn's pre-warmed probe if one is in-flight (the overlap win);
 * otherwise fetch fresh (heartbeat / skill / any path that didn't pre-warm).
 * Deletes the entry so it can't leak into a later turn.
 */
export async function consumeGroundTruth(opts) {
    const key = opts.conversationId;
    if (key) {
        const entry = _prewarm.get(key);
        _prewarm.delete(key);
        if (entry && Date.now() - entry.at < BLOCK_TTL_MS)
            return entry.p;
    }
    return fetchGroundTruth(opts);
}
// ── Per-conversation stash (set once per turn in dispatchToProvider) ─────────
const _blocks = new Map();
const BLOCK_TTL_MS = 5 * 60_000; // safety: never serve a stale turn's facts
export function setGroundTruthBlock(conversationId, block) {
    _blocks.set(conversationId, { block, at: Date.now() });
    // Opportunistic sweep so long-running gateways don't accumulate entries.
    if (_blocks.size > 500) {
        const cutoff = Date.now() - BLOCK_TTL_MS;
        for (const [k, v] of _blocks) {
            if (v.at < cutoff)
                _blocks.delete(k);
        }
    }
}
/** The block fetched for this conversation's current turn, or '' if none/stale. */
export function groundTruthFor(conversationId) {
    const entry = _blocks.get(conversationId);
    if (!entry)
        return '';
    if (Date.now() - entry.at > BLOCK_TTL_MS) {
        _blocks.delete(conversationId);
        return '';
    }
    return entry.block;
}
