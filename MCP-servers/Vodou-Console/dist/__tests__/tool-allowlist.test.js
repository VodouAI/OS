import { describe, it, expect } from 'vitest';
import { enterProjectContext, toolCallRefusal, turnToolAllowlist } from '../project-context.js';
import { AsyncLocalStorage } from 'async_hooks';
/**
 * PLAN-ALPHA F3 step 2 — the turn's tool bound.
 *
 * The bound is enforced at the executor choke point rather than in the prompt,
 * because a prompt-level restriction is a request and this is a bound. It is set
 * from the DB before the model sees any content, so an instruction injected into
 * a fetched page cannot widen it. These tests pin the two directions that matter:
 * a bound turn refuses what it did not declare, and an UNBOUND turn (web chat,
 * channels, undeclared skills — the overwhelming majority) is untouched.
 */
describe('turn tool allowlist', () => {
    it('fails OPEN when no allowlist is bound', () => {
        // Every existing caller has none. Defaulting to deny would break all of them.
        const store = new AsyncLocalStorage();
        store.run(1, () => {
            expect(toolCallRefusal('anything', 'at_all')).toBeNull();
            expect(turnToolAllowlist()).toBeUndefined();
        });
    });
    it('allows a declared tool and refuses an undeclared one', async () => {
        await new Promise((resolve) => {
            const als = new AsyncLocalStorage();
            als.run(1, () => {
                enterProjectContext({ toolAllowlist: ['gmail/threads_list', 'exa/web_search_exa'] });
                expect(toolCallRefusal('gmail', 'threads_list')).toBeNull();
                expect(toolCallRefusal('exa', 'web_search_exa')).toBeNull();
                const refusal = toolCallRefusal('Vodou-channels', 'send_message');
                expect(refusal).not.toBeNull();
                resolve();
            });
        });
    });
    it('names the declared set in the refusal so the model can recover', async () => {
        await new Promise((resolve) => {
            const als = new AsyncLocalStorage();
            als.run(1, () => {
                enterProjectContext({ toolAllowlist: ['gmail/threads_list'] });
                const refusal = toolCallRefusal('shell', 'exec') ?? '';
                // Without the declared set the model retries blindly and burns the turn.
                expect(refusal).toContain('gmail/threads_list');
                expect(refusal).toContain('shell/exec');
                expect(refusal.toLowerCase()).toContain('do not retry');
                resolve();
            });
        });
    });
    it('treats an empty allowlist as unrestricted, not as deny-everything', async () => {
        // A skill declaring [] must behave like a skill declaring nothing. Reading
        // it as deny-all would silently disable the agent.
        await new Promise((resolve) => {
            const als = new AsyncLocalStorage();
            als.run(1, () => {
                enterProjectContext({ toolAllowlist: [] });
                expect(toolCallRefusal('gmail', 'threads_list')).toBeNull();
                resolve();
            });
        });
    });
});
/**
 * PLAN-ALPHA F5 — dry-run read-only mode.
 *
 * Chad chose "mandatory dry run, arm the cron anyway": every new skill is
 * test-fired once and the result shown, but the schedule is armed regardless.
 * That makes the read-only guarantee the load-bearing part — the skill WILL be
 * scheduled, so the preview must not have already sent anything on his behalf.
 */
describe('dry run is read-only', () => {
    const withCtx = (ctx, fn) => new Promise((resolve) => {
        new AsyncLocalStorage().run(1, () => { enterProjectContext(ctx); fn(); resolve(); });
    });
    it('refuses a write-shaped tool even when it IS declared', async () => {
        // The important direction: declaring `gmail/send` must not let the preview
        // send mail. Checked before the allowlist, or a declared write sails through.
        await withCtx({ readOnly: true, toolAllowlist: ['gmail/send_message'] }, () => {
            const r = toolCallRefusal('gmail', 'send_message');
            expect(r).not.toBeNull();
            expect(r).toContain('DRY RUN');
        });
    });
    it('still allows reads during a dry run', async () => {
        await withCtx({ readOnly: true, toolAllowlist: ['gmail/threads_list'] }, () => {
            expect(toolCallRefusal('gmail', 'threads_list')).toBeNull();
        });
    });
    it('catches the write verbs that actually matter', async () => {
        await withCtx({ readOnly: true }, () => {
            for (const t of ['send_email', 'create_event', 'delete_message', 'update_row',
                'post_message', 'slack_post', 'execute_script', 'memory_store']) {
                expect(toolCallRefusal('x', t), `${t} should be refused`).not.toBeNull();
            }
        });
    });
    it('does not refuse reads whose names merely contain a verb substring', async () => {
        // Token-boundary matching: `posting_frequency` is a noun, not a post.
        await withCtx({ readOnly: true }, () => {
            for (const t of ['list_threads', 'get_events', 'search_messages',
                'posting_frequency', 'created_at', 'web_search_exa']) {
                expect(toolCallRefusal('x', t), `${t} should be allowed`).toBeNull();
            }
        });
    });
    it('is inert when readOnly is not set', async () => {
        await withCtx({ toolAllowlist: ['gmail/send_message'] }, () => {
            expect(toolCallRefusal('gmail', 'send_message')).toBeNull();
        });
    });
});
