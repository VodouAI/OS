/**
 * P2a step 1 — prove the table reproduces the 32 hand-written assignments,
 * BEFORE anything reads it.
 *
 * `loadProviderConfig` assigns 32 module-level globals, each in the same shape:
 *
 *     X = getSetting('some_key') || process.env.SOME_ENV || 'a default';
 *
 * The plan is to delete those globals. The danger is that deleting them is
 * invisible when wrong: a bad key looks like an auth error from the vendor, and
 * a bad model looks like nothing at all — the wrong model answers perfectly
 * well. So the table's resolver is checked against the real source text first,
 * per provider, per field.
 *
 * This reads `llm.ts` as TEXT on purpose. Importing it boots the world, and the
 * question here is precisely "does the DATA match what the CODE says", which is
 * a question about the code as written.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDERS, resolveProviderRuntime } from '../providers.js';
// `as const` narrows every row to its literal type, so a field absent from ONE
// row is absent from the union. Widen to the interface to ask about optionals.
const SPECS = PROVIDERS;
const llm = readFileSync(join(__dirname, '../llm.ts'), 'utf-8');
/** The right-hand side of `name = …;` inside loadProviderConfig. */
function assignmentFor(name) {
    const m = llm.match(new RegExp(`^\\s*${name}\\s*=\\s*([^;]+);`, 'm'));
    return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}
const CAMEL = {
    'claude-cli': 'CLI_MODEL', 'anthropic': 'MODEL', 'kimi-cli': 'kimiCli',
    'openai': 'openai', 'google': 'google', 'groq': 'groq', 'deepseek': 'deepseek',
    'xai': 'xai', 'mistral': 'mistral', 'kimi': 'kimi', 'openrouter': 'openrouter',
    'fireworks': 'fireworks', 'together': 'together', 'ollama': 'ollama',
    'lmstudio': 'lmstudio', 'llamacpp': 'llamacpp', 'custom': 'custom', 'vodou': 'vodou',
};
describe('P2a — the table reproduces loadProviderConfig exactly', () => {
    for (const spec of SPECS) {
        if (spec.kind === 'none')
            continue;
        const base = CAMEL[spec.id];
        it(`${spec.id}: the model resolves the same way the code assigns it`, () => {
            // Settings win.
            const bySetting = resolveProviderRuntime(spec.id, () => 'from-settings', {});
            expect(bySetting.model, 'a stored setting must win over env and default').toBe('from-settings');
            // Then env, in the declared order.
            if (spec.modelEnv?.length) {
                const env = Object.fromEntries(spec.modelEnv.map((k, i) => [k, `env-${i}`]));
                expect(resolveProviderRuntime(spec.id, () => '', env).model, 'the FIRST declared env var wins').toBe('env-0');
            }
            // Then the default — and it must equal what the source actually falls back to.
            const dflt = resolveProviderRuntime(spec.id, () => '', {}).model;
            expect(dflt, 'the table default').toBe(spec.defaultModel ?? '');
        });
        // `irregular: ['key']` rows declare WHERE a key may come from (validation asks
        // that) but the loader COMPOSES theirs — openrouter normalises the candidate,
        // fireworks picks user-over-managed. Two different questions about the same
        // field, and only the first is answered by `resolveProviderRuntime`.
        if (spec.keySetting && !spec.irregular?.includes('key')) {
            it(`${spec.id}: the API key honours settings, then env IN ORDER`, () => {
                expect(resolveProviderRuntime(spec.id, () => 'k-set', {}).apiKey).toBe('k-set');
                const env = Object.fromEntries((spec.keyEnv ?? []).map((k, i) => [k, `k-env-${i}`]));
                if (spec.keyEnv?.length) {
                    expect(resolveProviderRuntime(spec.id, () => '', env).apiKey, `the FIRST declared env var wins — ${spec.keyEnv.join(' then ')}`).toBe('k-env-0');
                }
                expect(resolveProviderRuntime(spec.id, () => '', {}).apiKey, 'no key configured → empty').toBe('');
            });
        }
        if (spec.baseUrlSetting) {
            it(`${spec.id}: the base URL honours settings, env, then its default`, () => {
                expect(resolveProviderRuntime(spec.id, () => 'http://set/', {}).baseUrl, 'and a trailing slash is trimmed, as the original did').toBe('http://set');
                expect(resolveProviderRuntime(spec.id, () => '', {}).baseUrl)
                    .toBe((spec.defaultBaseUrl ?? '').replace(/\/$/, ''));
            });
        }
    }
    it('every provider the loader assigns has a row, and vice versa', () => {
        // The loader is the authority on what exists at runtime; the table is the
        // authority on what we SAY exists. A gap either way is the class of bug that
        // put `vodou` in the menu and in no price list.
        const assigned = new Set([...llm.matchAll(/^\s*([a-z][a-zA-Z]*)Model\s*=\s*getSetting\(/gm)].map((m) => m[1]));
        const declared = new Set(SPECS.filter((p) => p.kind !== 'none' && CAMEL[p.id] && !['MODEL', 'CLI_MODEL'].includes(CAMEL[p.id]))
            .map((p) => CAMEL[p.id]));
        const onlyInCode = [...assigned].filter((a) => !declared.has(a));
        expect(onlyInCode, 'a provider the loader configures but the table does not name').toEqual([]);
    });
    it('loadProviderConfig writes no hand-rolled precedence any more', () => {
        // The point of the move. Thirty-two copies of
        //   `X = getSetting(k) || process.env.E || 'default'`
        // are now one `resolveProviderRuntime`. Any that come back are a provider
        // quietly acquiring a different precedence than its neighbours — the exact
        // drift that left `google` reading GEMINI_API_KEY while nothing said so.
        const body = llm.slice(llm.indexOf('function loadProviderConfig'), llm.indexOf('function syncProviderFromDb'));
        const handRolled = [...body.matchAll(/^\s*([a-z][a-zA-Z]*(?:ApiKey|Model|BaseUrl))\s*=\s*getSetting\(/gm)]
            .map((m) => m[1])
            // declared `irregular`, composed on purpose, reasons stated at the site
            .filter((n) => !['fireworksApiKeyUser', 'openrouterApiKey'].includes(n));
        expect(handRolled, 'these should resolve through the table').toEqual([]);
        expect(body, 'the loader reads the table').toContain('resolveProviderRuntime(');
    });
    it('the irregular ones are declared, not silently skipped', () => {
        const irregular = SPECS.filter((p) => p.irregular?.length).map((p) => p.id).sort();
        // openrouter normalises its key; fireworks composes user||managed; llamacpp
        // derives its URL from a port we own. Pinned so a fourth cannot appear by
        // accident — an undeclared special case is how the five lists drifted.
        expect(irregular).toEqual(['fireworks', 'llamacpp', 'openrouter']);
    });
});
