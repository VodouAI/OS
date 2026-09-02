/**
 * P2a — the LLM seam. This gate goes FIRST and RED, the way P9's did.
 *
 * Provider knowledge is spelled out in five independent places, and they do not
 * agree. Measured 2026-08-29, before any refactor:
 *
 *     type union      19 ids
 *     context limits  16 ids
 *     display names   18 ids
 *     PRICING         15 ids
 *     frontend list   17 ids
 *
 * Six providers appear in some lists and not others, and the omissions are not
 * cosmetic:
 *
 *   - `vodou` — the HOSTED PAID PROXY — is in no PRICING entry at all, and
 *     `resolvePricing` ends `?? { input: 0, output: 0 }`. Every turn through
 *     Vodou's own provider reports $0.00 COGS.
 *   - `vodou` and `together` are missing from CONTEXT_LIMITS, and the three
 *     call sites fall back to TWO DIFFERENT numbers — 200_000 twice and 64_000
 *     once. The same provider has two context limits depending on which line
 *     of code asks.
 *
 * That is the disease P2a exists to cure: not "a switch statement is untidy",
 * but "one provider is two different providers depending who you ask".
 *
 * This test reads the SOURCE rather than importing, because importing `llm.ts`
 * boots the world. It is a seam gate, not a unit test — the same shape as
 * `receipt-lanes.test.ts` and the P0 emission gate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const read = (p) => readFileSync(join(__dirname, p), 'utf-8');
/** The ids named in `type LLMProvider = …`. */
function typeUnion(llm) {
    const m = llm.match(/type LLMProvider = ([^;]+);/);
    if (!m)
        throw new Error('LLMProvider union not found — the seam moved');
    return new Set([...m[1].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]));
}
function contextLimits(llm) {
    const start = llm.indexOf('CONTEXT_LIMITS');
    const block = llm.slice(start, llm.indexOf('};', start));
    return new Set([...block.matchAll(/'([a-z0-9-]+)':\s*[0-9_]+/g)].map((x) => x[1]));
}
function pricingIds(usage) {
    const block = usage.slice(usage.indexOf('const PRICING'));
    return new Set([...block.matchAll(/^\s*'([a-z0-9-]+)::/gm)].map((x) => x[1]));
}
describe('P2a — one provider table, or none', () => {
    const llm = read('../llm.ts');
    const usage = read('../usage-tracking.ts');
    it('the hosted `vodou` provider costs something — it is the one we BILL for', async () => {
        // Asserted as BEHAVIOUR, not table contents: `vodou` is priced by aliasing to
        // `fireworks`, because the hosted tier IS Fireworks underneath and two tables
        // of the same numbers is the drift this phase exists to end.
        //
        // $0.00 COGS on the paid provider is not a rounding error — it is the revenue
        // side of the product reporting nothing.
        const { computeCogs } = await import('../usage-tracking.js');
        const usd = computeCogs('vodou', 'accounts/fireworks/models/kimi-k2p6', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
        expect(usd, 'a million tokens through the hosted tier must not cost $0').toBeGreaterThan(0);
        // and it must agree with the provider it actually runs on
        const asFireworks = computeCogs('fireworks', 'accounts/fireworks/models/kimi-k2p6', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
        expect(usd, 'the hosted tier is Fireworks — the COGS is the same COGS').toBe(asFireworks);
        expect(pricingIds(usage).size, 'the PRICING table is still the one source').toBeGreaterThan(10);
    });
    it('llm.ts no longer keeps its own context-limit map', () => {
        // The map that used to live here was one of the five places that separately
        // knew about providers — and the one that gave `vodou` two different windows
        // depending which of three call sites asked. It is table data now.
        expect(llm, 'a second context table is a second thing to forget')
            .not.toContain('const CONTEXT_LIMITS');
    });
    it('every context-limit read goes through the table', () => {
        const direct = [...llm.matchAll(/CONTEXT_LIMITS\[/g)].length;
        expect(direct, 'no call site may index a local map').toBe(0);
        expect(llm, 'they call the table instead').toContain('contextLimitFor(');
    });
});
/**
 * P2a — the mutate/restore, and why it never worked on the default provider.
 *
 * `dispatchToProvider` swapped nine module-level model globals, called the
 * provider arm, then restored them immediately — on the stated assumption that
 * "model vars are read synchronously at function entry".
 *
 * That is true only for the OpenAI-compat arms, which take the model as an
 * ARGUMENT (evaluated at call time). It is false for the two that matter most:
 *
 *   chatWithCLI  starts 6455 · first await 6463 · reads CLI_MODEL at 6649, 6686
 *   chatWithSDK  starts 7329 · first await 7348 · reads MODEL     at 7417, 7481, 7485
 *
 * Both read the global ~200 lines and many awaits after suspending, by which
 * time the caller has already restored it. So Smart Routing's cheap-model swap
 * and Skill Console's `prefer_model` override were silently no-ops on
 * `claude-cli` (the DEFAULT provider) and on `anthropic`.
 *
 * The fix is `resolveModel(conversationId, fallback)`: a per-turn override map,
 * read at the point of use, cleared when the turn actually ends. Nothing global
 * is mutated, so nothing has to be restored, so await timing stops mattering.
 */
describe('P2a — no provider arm races a restored global', () => {
    const llm = read('../llm.ts');
    it('no model global is mutated-and-restored around a dispatch', () => {
        const saved = [...llm.matchAll(/let saved[A-Z]\w*Model\b/g)].map((m) => m[0]);
        expect(saved, 'a save/restore pair means the value is live across an await').toEqual([]);
    });
    it('the effective model is RESOLVED, not read from a swapped global', () => {
        expect(llm, 'resolveModel is the seam that replaces the swap').toContain('function resolveModel(');
    });
});
/**
 * The behavioural half: the override must survive an await.
 *
 * That single property is what the old mutate/restore could not provide, and it
 * is why Smart Routing and `prefer_model` were no-ops on `claude-cli`. The arm
 * suspends; the caller restores; the arm wakes and reads the ORIGINAL model.
 */
describe('P2a — the model override survives suspension', () => {
    it('a swapped model is still the swapped model after an await', async () => {
        const { setModelOverride, clearModelOverride, resolveModel, resolveCliModel } = await import('../llm.js');
        const conv = 'p2a-await-' + Math.random().toString(36).slice(2);
        expect(resolveModel(conv, 'opus'), 'no override → the global').toBe('opus');
        setModelOverride(conv, 'haiku', 'haiku-cli');
        // The exact shape of the bug: yield the event loop, the way a provider arm
        // does on its first await, then read.
        await new Promise((r) => setTimeout(r, 0));
        await Promise.resolve();
        expect(resolveModel(conv, 'opus'), 'the swap must outlive the await').toBe('haiku');
        expect(resolveCliModel(conv, 'opus'), 'the CLI id is carried separately').toBe('haiku-cli');
        clearModelOverride(conv);
        expect(resolveModel(conv, 'opus'), 'cleared at turn end → back to the global').toBe('opus');
    });
    it('one conversation\'s override never leaks into another', async () => {
        const { setModelOverride, resolveModel, clearModelOverride } = await import('../llm.js');
        setModelOverride('conv-a', 'haiku');
        expect(resolveModel('conv-b', 'opus'), 'a global swap leaked across conversations before').toBe('opus');
        clearModelOverride('conv-a');
    });
});
/**
 * The table is the source, and these prove the copies now agree with it.
 *
 * A `switch` per fact cannot enforce coverage — nothing makes two switches list
 * the same providers, which is exactly how `vodou` came to be in the menu, in
 * the type union, and in neither the price list nor the context map. A table
 * plus `satisfies` makes coverage structural.
 */
describe('P2a — the table is the one source', () => {
    const llm = read('../llm.ts');
    it('every id in the type union has a row, and every row is in the union', async () => {
        const { providerIds } = await import('../providers.js');
        expect(new Set(providerIds()), 'the table and the union must name the same providers')
            .toEqual(typeUnion(llm));
    });
    it('every provider that is not "none" has a context window', async () => {
        // `as const satisfies readonly ProviderSpec[]` means TypeScript ALREADY
        // narrows this filter to `never` — the compiler proves the invariant, and a
        // row added without a window fails the build rather than this test. Kept as
        // a runtime check anyway: the table is also read by JavaScript callers, and
        // "the compiler would have caught it" is not evidence that it did.
        const { PROVIDERS } = await import('../providers.js');
        const missing = PROVIDERS
            .filter((p) => p.kind !== 'none' && p.contextLimit === undefined)
            .map((p) => p.id);
        expect(missing, 'no window means the fallback decides, which is how this broke').toEqual([]);
    });
    it('the hosted tier prices under the provider it actually runs on', async () => {
        const { pricingIdFor } = await import('../providers.js');
        expect(pricingIdFor('vodou'), 'vodou IS fireworks underneath').toBe('fireworks');
        expect(pricingIdFor('openai'), 'everything else prices as itself').toBe('openai');
    });
    it('every openai-compat provider has an endpoint or is configured locally', async () => {
        const { PROVIDERS } = await import('../providers.js');
        const bad = PROVIDERS.filter((p) => p.kind === 'openai-compat' && !('endpoint' in p) &&
            !['vodou', 'openai', 'custom'].includes(p.id)).map((p) => p.id);
        expect(bad, 'an openai-compat provider with no endpoint cannot be reached').toEqual([]);
    });
});
/**
 * P2a — the frontend's hard-coded list, the fifth copy.
 *
 * `settings.js` carried a literal array of seventeen provider ids and fanned out
 * a model fetch per id. It was one of the five lists that disagreed — it is the
 * one missing `custom`, and it had no way to learn about a new provider except
 * someone remembering to edit it.
 *
 * A list the server serves cannot disagree with the server.
 */
describe('P2a — the frontend does not keep its own provider list', () => {
    const settingsJs = readFileSync(join(__dirname, '../../public/js/views/settings.js'), 'utf-8');
    it('the only literal provider list is the offline FALLBACK', () => {
        // Honest version. A first cut asserted "no literal array remains" and passed
        // — but only because the regex excluded newlines and the fallback array
        // spans three lines. A gate that passes by accident of regex is the thing
        // this suite exists to refuse, so it asserts what is actually true instead:
        // there is exactly one such array, and it is unreachable unless the fetch
        // fails.
        const lists = [...settingsJs.matchAll(/\[[^\]]*'claude-cli'[^\]]*\]/g)]
            .map((m) => m[0])
            .filter((a) => /'(anthropic|openai|google|ollama|fireworks)'/.test(a));
        expect(lists, 'one list, and one only').toHaveLength(1);
        const idx = settingsJs.indexOf(lists[0]);
        const preceding = settingsJs.slice(Math.max(0, idx - 200), idx);
        expect(preceding, 'and it lives in a .catch — a fallback, not a source')
            .toContain('.catch(');
    });
    it('it asks the server instead', () => {
        expect(settingsJs, 'fetches /api/providers').toContain('/api/providers');
    });
});
/**
 * P2a — identity checks that were really PROPERTY checks.
 *
 * Eighteen `currentProvider === '…'` comparisons were counted. They are NOT all
 * duplication, and treating them as such is how a refactor introduces bugs:
 *
 *   - SIX asked `=== 'vodou'`, and every one meant "is this the managed tier?" —
 *     quota enforcement, the rolling-summary default, the stable-prefix default,
 *     two governor base defaults. The id was standing in for a property, so a
 *     second managed tier would have silently skipped all six behaviours. These
 *     become `isHostedTier()`.
 *
 *   - The REST are genuine identity, and must stay. `claude-cli`'s auth probe
 *     runs the `claude` binary; its warm-session pool is that binary's pool.
 *     Collapsing them into `kind === 'cli'` would sweep in `kimi-cli`, which is
 *     a different binary with different auth — a bug wearing the costume of a
 *     cleanup.
 *
 *   - `rawLLMCall`'s if/else chain over anthropic/ollama/claude-cli/kimi-cli is
 *     a SECOND dispatch, and real duplication. It is not fixed by a predicate;
 *     it is fixed by routing through the seam, which is its own slice.
 */
describe('P2a — a property is not an id', () => {
    const llm = read('../llm.ts');
    it('nothing compares against the hosted-tier id directly any more', () => {
        expect(llm.match(/currentProvider === 'vodou'/g), 'ask isHostedTier() instead').toBeNull();
        expect(llm, 'and the predicate is used').toContain('isHostedTier(currentProvider)');
    });
    it('the managed tier is a declared property, not a name', async () => {
        const { isHostedTier } = await import('../providers.js');
        expect(isHostedTier('vodou'), 'vodou is the managed tier today').toBe(true);
        expect(isHostedTier('fireworks'), 'BYOK fireworks is NOT — the user pays').toBe(false);
        expect(isHostedTier('claude-cli')).toBe(false);
        expect(isHostedTier('nonsense'), 'an unknown id is not privileged').toBe(false);
    });
    it('the claude-cli identity checks SURVIVE, deliberately', () => {
        // Pinned so a future pass does not "finish the job" by collapsing these into
        // a kind check. `kimi-cli` is also kind:'cli' and is a different binary with
        // different auth; the auth probe and the session pool are claude-specific.
        expect(llm, "the CLI auth probe is claude-cli's own")
            .toContain("currentProvider === 'claude-cli' && (_claudeCliAuth");
        expect(llm, "the warm session pool is claude-cli's own")
            .toContain("currentProvider === 'claude-cli' && _cliSessions");
    });
});
/**
 * P2a — the sixth list, and the one that had already quietly disagreed.
 *
 * `getOpenAICompatConfig` is the one-shot path's routing, and it was a
 * sixteen-arm switch carrying the same endpoint URLs as the table and as the
 * main dispatch. Compared arm by arm before the change, the nine STATIC ones
 * agreed exactly — luck, not design, and precisely the state the other five
 * lists were in before they drifted apart.
 *
 * One did not agree. `openai`'s endpoint lived in that switch and NOWHERE else,
 * because its chat path goes through `chatWithOpenAI`. The table was quietly
 * incomplete for exactly one provider, and only the duplicate knew.
 */
describe('P2a — the one-shot path routes from the table too', () => {
    const llm = read('../llm.ts');
    it('no static endpoint URL is written twice', () => {
        // Any https:// literal inside the config switch is a URL the table should own.
        const body = llm.slice(llm.indexOf('function getOpenAICompatConfig'), llm.indexOf('function freshEnvVars'));
        const literals = [...body.matchAll(/'https:\/\/[^']+'/g)].map((m) => m[0]);
        expect(literals, 'these belong on the provider row').toEqual([]);
    });
    it('every openai-compat provider the switch serves has an endpoint on its row', async () => {
        const { providerSpec } = await import('../providers.js');
        // The ids the switch answers statically — dynamic ones are install facts.
        for (const id of ['openai', 'google', 'groq', 'deepseek', 'xai', 'mistral',
            'kimi', 'openrouter', 'fireworks', 'together']) {
            expect(providerSpec(id)?.endpoint, `${id} must carry its own endpoint`).toBeTruthy();
        }
    });
    it('the dynamic ones stay explicit, because they are facts about the INSTALL', () => {
        const body = llm.slice(llm.indexOf('function getOpenAICompatConfig'), llm.indexOf('function freshEnvVars'));
        // A user-set base URL, two local servers on ports, and the managed proxy's
        // env-supplied URL. None of these is a property of the provider.
        for (const dyn of ['customBaseUrl', 'lmstudioBaseUrl', 'llamacppBaseUrl', 'VODOU_LLM_PROXY_URL']) {
            expect(body, `${dyn} cannot come from a static table`).toContain(dyn);
        }
    });
});
/**
 * P2a — the validator and the loader disagreed, and the operator found out.
 *
 * Settings validation was a twelve-arm switch. FIVE arms consulted `process.env`
 * and SEVEN did not. So with `OPENAI_API_KEY` exported — a key
 * `loadProviderConfig` would happily use — saving OpenAI as the provider was
 * rejected with "OpenAI API key is required".
 *
 * Seven providers affected: openai, google, groq, deepseek, xai, mistral, custom.
 * Nothing was wrong with either side on its own; they simply answered the same
 * question differently, which is what a second copy is FOR.
 */
describe('P2a — one answer to "is a key configured"', () => {
    it('an env var counts, for every provider that declares one', async () => {
        const { hasConfiguredKey, PROVIDERS, type: _t } = await import('../providers.js');
        const withKeys = PROVIDERS
            .filter((p) => p.keySetting && p.keyEnv?.length);
        expect(withKeys.length, 'several providers declare env fallbacks').toBeGreaterThan(5);
        for (const p of withKeys) {
            const env = { [p.keyEnv[0]]: 'from-env' };
            expect(hasConfiguredKey(p.id, () => '', undefined, env), `${p.id}: an exported ${p.keyEnv[0]} must count as configured — it is what the loader uses`)
                .toBe(true);
            expect(hasConfiguredKey(p.id, () => '', undefined, {}), `${p.id}: nothing anywhere is genuinely unconfigured`).toBe(false);
            expect(hasConfiguredKey(p.id, () => 'from-settings', undefined, {}), `${p.id}: a stored setting counts`).toBe(true);
            expect(hasConfiguredKey(p.id, () => '', 'from-request', {}), `${p.id}: the value being saved right now counts`).toBe(true);
        }
    });
    it('a provider that needs no key is never blocked', async () => {
        const { hasConfiguredKey } = await import('../providers.js');
        for (const id of ['claude-cli', 'kimi-cli', 'ollama', 'lmstudio', 'llamacpp', 'vodou']) {
            expect(hasConfiguredKey(id, () => '', undefined, {}), `${id} has no keySetting — it must not be gated on one`).toBe(true);
        }
    });
    it('the operator-facing wording is unchanged', async () => {
        // These strings are already in front of users. "Kimi (Moonshot)" and
        // "Together.ai" are not derivable from the label, and rewording them to make
        // a refactor tidier would be changing the product to suit the code.
        const { providerKeyLabel } = await import('../providers.js');
        expect(providerKeyLabel('kimi')).toBe('Kimi (Moonshot)');
        expect(providerKeyLabel('together')).toBe('Together.ai');
        expect(providerKeyLabel('google')).toBe('Google Gemini');
        expect(providerKeyLabel('xai')).toBe('xAI');
    });
    it('settings.ts no longer keeps its own per-provider key switch', () => {
        const settings = readFileSync(join(__dirname, '../api/settings.ts'), 'utf-8');
        const block = settings.slice(settings.indexOf('Validate required fields per provider'), settings.indexOf('Validate required fields per provider') + 2000);
        expect(block, 'it asks the shared predicate').toContain('hasConfiguredKey(');
        expect(block, 'and does not re-list providers').not.toContain("case 'anthropic':");
    });
});
/**
 * P2a — the seventh copy, and the four ways it disagreed.
 *
 * `model-catalog.ts` kept its own `providerKey` switch. Measured against the
 * loader before the change:
 *
 *   google      catalog accepted GOOGLE_API_KEY;  loader did not
 *   kimi        catalog KIMI→MOONSHOT;            loader MOONSHOT→KIMI
 *   fireworks   catalog missed VODOU_FIREWORKS_KEY, the canonical one
 *   openrouter  catalog had no case at all
 *
 * Every one is the same user-visible shape: the model DROPDOWN and the actual
 * CALL disagreeing about whether a provider is usable.
 */
describe('P2a — the model catalog reads the same key as the caller', () => {
    it('model-catalog keeps no key switch of its own', () => {
        const mc = readFileSync(join(__dirname, '../api/model-catalog.ts'), 'utf-8');
        const fn = mc.slice(mc.indexOf('function providerKey'), mc.indexOf('function fetchLive'));
        expect(fn, 'it asks the table').toContain('declaredKeyFor(');
        expect(fn, 'and does not re-list providers').not.toContain('openai_api_key');
    });
    it('google accepts GOOGLE_API_KEY as well as GEMINI_API_KEY, and prefers GEMINI', async () => {
        const { declaredKeyFor } = await import('../providers.js');
        expect(declaredKeyFor('google', () => '', { GOOGLE_API_KEY: 'g' }), 'a user with only GOOGLE_API_KEY had a populated dropdown and a dead provider').toBe('g');
        expect(declaredKeyFor('google', () => '', { GEMINI_API_KEY: 'a', GOOGLE_API_KEY: 'b' }), 'GEMINI wins — it is what the loader has always used').toBe('a');
    });
    it('kimi resolves in ONE order, and fireworks sees its canonical var', async () => {
        const { declaredKeyFor } = await import('../providers.js');
        expect(declaredKeyFor('kimi', () => '', { KIMI_API_KEY: 'k', MOONSHOT_API_KEY: 'm' }), 'MOONSHOT first — the order the caller uses').toBe('m');
        expect(declaredKeyFor('fireworks', () => '', { VODOU_FIREWORKS_KEY: 'v' }), 'the canonical var the catalog could not see').toBe('v');
        expect(declaredKeyFor('openrouter', () => '', { OPENROUTER_API_KEY: 'o' }), 'openrouter had no case in the catalog at all').toBe('o');
    });
});
/**
 * The `/skill` chip pointed at a parser that could not read it.
 *
 * `public/index.html` renders a clickable `data-shortcut="/skill"` chip; clicking
 * it inserts "/skill " into the composer. The user types a name, and the slash
 * parser took the FIRST word after the slash — so `/skill qa-report` asked
 * BrainLoader for a skill literally named "skill". No match, no error, and an
 * ordinary model answer with nothing anywhere to say the skill never ran.
 *
 * This is why the W1 P9.1 verification row was unrunnable: the row named the
 * surface the UI advertises, and that surface did not work.
 */
describe('the skill invocation the UI advertises actually parses', () => {
    const SLASH = /^\s*\/(?:skill\s+)?([a-zA-Z0-9_-]+)(?:\s|$)/;
    it('reads the form the composer chip produces', () => {
        expect('/skill qa-report'.match(SLASH)?.[1], 'the chip inserts "/skill " and the user types a name')
            .toBe('qa-report');
        expect('/skill uml-diagram sequence for login'.match(SLASH)?.[1]).toBe('uml-diagram');
    });
    it('still reads the direct form, which is what actually worked', () => {
        expect('/uml-diagram sequence for login'.match(SLASH)?.[1]).toBe('uml-diagram');
        expect('/qa-report'.match(SLASH)?.[1]).toBe('qa-report');
    });
    it('a bare /skill is the same harmless no-match it always was', () => {
        expect('/skill'.match(SLASH)?.[1]).toBe('skill');
        expect('not a slash command'.match(SLASH)).toBeNull();
    });
    it('llm.ts uses this exact pattern', () => {
        const llm = read('../llm.ts');
        expect(llm, 'the parser must accept both forms').toContain('/^\\s*\\/(?:skill\\s+)?([a-zA-Z0-9_-]+)(?:\\s|$)/');
    });
});
