/**
 * Both CLI renderers answer the same slash commands.
 *
 * They did not. The Ink TUI implemented ten commands and guarded unknown ones
 * ("don't ship it to the LLM as a prompt"); `--plain` implemented five, had no
 * guard, and forwarded everything else — so `/skills` in plain mode reached the
 * model as the literal text `/skills` and came back as an improvised paragraph
 * about skills instead of the 148 rows in the registry. `commands.ts` had been
 * written as the shared data layer and only one renderer ever imported it.
 *
 * The parity check is textual on purpose: it reads the shipped renderers rather
 * than a re-implementation, so it fails when someone adds a command to one and
 * not the other — which is the only way this regresses.
 */
import { describe, it, expect } from 'vitest';
import { hasLive, skipNote } from './_live.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLAIN = readFileSync(path.resolve(HERE, '../cli/renderers/plain.ts'), 'utf8');
const TUI = readFileSync(path.resolve(HERE, '../cli/renderers/tui.tsx'), 'utf8');
/** Commands named in the canonical help, which both renderers print. */
async function helpCommands() {
    const { CLI_HELP } = await import('../cli/commands.js');
    return [...CLI_HELP.matchAll(/\/([a-z]+)/g)].map((m) => m[1]).filter((c, i, a) => a.indexOf(c) === i);
}
describe('CLI slash-command parity', () => {
    it('every command in /help is handled by BOTH renderers', async () => {
        const { isServerSideCommand } = await import('../cli/commands.js');
        const missing = [];
        for (const cmd of await helpCommands()) {
            // A command the GATEWAY owns (`/workflow`) is handled by deliberately
            // falling through to the turn, so there is no branch to find in either
            // renderer — the guard test below is what pins that path.
            if (isServerSideCommand(`/${cmd}`))
                continue;
            // Either handled inline, or reachable through the shared dispatcher.
            const inPlain = PLAIN.includes(`'/${cmd}'`) || PLAIN.includes(`/${cmd} `) || PLAIN.includes('readOnlyCommand');
            const inTui = TUI.includes(`'/${cmd}'`) || TUI.includes(`/${cmd} `) || TUI.includes('readOnlyCommand');
            if (!inPlain)
                missing.push(`plain: /${cmd}`);
            if (!inTui)
                missing.push(`tui: /${cmd}`);
        }
        expect(missing, 'a command in CLI_HELP that a renderer does not handle reaches the MODEL as prose').toEqual([]);
    });
    it('neither renderer forwards an unknown slash to the model', () => {
        for (const [name, src] of [['plain', PLAIN], ['tui', TUI]]) {
            expect(/unknown command/.test(src), `${name} must refuse an unrecognised /command instead of sending it as a prompt`).toBe(true);
        }
    });
    it('the help text has exactly one definition', () => {
        // The literal list lived in tui.tsx and a shorter one in plain.ts. Both now
        // print CLI_HELP; a re-inlined list here is the drift starting again.
        for (const [name, src] of [['plain', PLAIN], ['tui', TUI]]) {
            expect(src.includes('CLI_HELP'), `${name} should print the shared CLI_HELP`).toBe(true);
            expect(/'commands:\\n/.test(src), `${name} inlines its own command list again — put it in CLI_HELP`).toBe(false);
        }
    });
    it('lets the GATEWAY\'s own slash commands through instead of refusing them', async () => {
        // The guard was "any / I do not handle myself is unknown". But `chat()` has
        // its own vocabulary: `/workflow` (added this cycle — it works in the
        // console chat and NEVER worked in the CLI, because this guard ate it) and
        // `/<skill-name>` for every registered skill. Refusing those locally is the
        // CLI answering a question the server was supposed to answer.
        const { isServerSideCommand } = await import('../cli/commands.js');
        // No database needed — /workflow is matched by pattern.
        expect(isServerSideCommand('/workflow every morning summarize my mail')).toBe(true);
        expect(isServerSideCommand('/wf do a thing')).toBe(true);
        expect(isServerSideCommand('/WORKFLOW shouting')).toBe(true);
        expect(isServerSideCommand('hello there')).toBe(false); // not a slash at all
    });
    /**
     * Telling a TYPO from a skill name requires the skill registry, and
     * `isServerSideCommand` deliberately fails OPEN when it cannot read one —
     * blocking a real skill because SQLite is unavailable is worse than letting a
     * typo reach the router. That is the intended behaviour, and it makes this
     * assertion live-data-dependent: `/helpp` is only `false` on a machine that
     * HAS the registry.
     *
     * CI has no vodou-core.db (gitignored, engine-owned schema), so the ungated
     * version passed locally and failed there — the exact trap `_live.ts` was
     * written for, walked into by the person who had just finished reading it.
     */
    describe('typo vs. skill name (needs the skill registry)', () => {
        const live = hasLive('core', 'skills_registry');
        it.skipIf(!live)('refuses a typo locally instead of forwarding it', async () => {
            const { isServerSideCommand } = await import('../cli/commands.js');
            expect(isServerSideCommand('/helpp')).toBe(false);
            expect(isServerSideCommand('/typo-xyz')).toBe(false);
        });
        if (!live) {
            it('SKIPPED — no skill registry on this machine', () => {
                console.warn(skipNote('cli-command-parity', 'core', 'skills_registry'));
                expect(live).toBe(false);
            });
        }
    });
    it('both guards consult isServerSideCommand before refusing', () => {
        for (const [name, src] of [['plain', PLAIN], ['tui', TUI]]) {
            expect(/startsWith\('\/'\)\s*&&\s*!isServerSideCommand/.test(src), `${name}'s unknown-slash guard must let /workflow and /<skill> reach the turn`).toBe(true);
        }
    });
    it('offers the model aliases the installed binary actually accepts', async () => {
        // The hint was `<sonnet|opus|haiku|...>` in BOTH renderers — written before
        // Fable existed, so the CLI never offered the flagship. Reading the hint and
        // typing `fable` then cost a turn and returned confident nonsense, because a
        // bare word is a prompt. Third frozen list in this CLI (after the banner
        // date and the two /help texts), so this one is derived from `claude --help`.
        const { modelAliases, modelHint, bareModelName } = await import('../cli/commands.js');
        const aliases = modelAliases();
        expect(aliases.length).toBeGreaterThan(0);
        expect(modelHint()).toContain('/model');
        // Exact-match only: a model name is a command hint, prose is not.
        expect(bareModelName(aliases[0])).toBe(aliases[0]);
        expect(bareModelName(aliases[0].toUpperCase())).toBe(aliases[0]);
        expect(bareModelName(`what is ${aliases[0]}`)).toBeNull();
        expect(bareModelName('summarize my inbox')).toBeNull();
        expect(bareModelName('')).toBeNull();
    });
    it('neither renderer hardcodes a model list', () => {
        for (const [name, src] of [['plain', PLAIN], ['tui', TUI]]) {
            expect(/sonnet\|opus\|haiku/.test(src), `${name} has a hand-written model list again — derive it in modelAliases()`).toBe(false);
            expect(src.includes('modelHint()'), `${name} should print the derived hint`).toBe(true);
        }
    });
    it('the shared dispatcher answers data commands and declines the rest', async () => {
        const { readOnlyCommand } = await import('../cli/commands.js');
        // Not asserting row counts — those are this machine's data. Asserting SHAPE:
        // a handled command returns text, an unhandled one returns null so the
        // caller can fall through to its own branches.
        expect(typeof readOnlyCommand('/server', 'cli:test')).toBe('string');
        expect(typeof readOnlyCommand('/tools', 'cli:test')).toBe('string');
        expect(typeof readOnlyCommand('/skills', 'cli:test')).toBe('string');
        expect(readOnlyCommand('/skills deploy-thing', 'cli:test')).toBeNull(); // RUNS a skill; caller owns it
        expect(readOnlyCommand('/compress', 'cli:test')).toBeNull(); // needs a turn
        expect(readOnlyCommand('what is my cpu', 'cli:test')).toBeNull(); // ordinary prompt
    });
});
