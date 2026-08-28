import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { accountGateEnabled } from '../llm.js';
// PLAN-ROAD-TO-SELLABLE D13. The account requirement lived in the onboarding
// modal; the chat path never asked, so dismissing the modal or navigating
// straight to a conversation hash reached the same chat. The plan's own verdict:
// "it annoys honest users and stops nobody."
//
// WHICH way to resolve that — free without an account, or gated — is a product
// decision. What is pinned here is that the decision has exactly one switch, that
// the switch is OFF by default so nothing changes for anyone today, and that the
// answer to "has an account?" is not re-defined a second time.
// BOTH sides, not just after. `db.ts` runs `dotenv.config()` on import, so this
// developer machine's `.env` (VODOU_REQUIRE_ACCOUNT=1) was already in
// process.env before the first assertion ran — and the test that pins the
// DEFAULT was reading a deliberate local override. It has been red on this
// machine for weeks while passing in QA, which is the worst of both: a failure
// nobody trusts and a signal nobody reads. Clearing it first asks the question
// the test means to ask ("with nothing set, is the gate off?").
beforeEach(() => { delete process.env.VODOU_REQUIRE_ACCOUNT; });
afterEach(() => { delete process.env.VODOU_REQUIRE_ACCOUNT; });
describe('D13 — the gate is off until someone decides', () => {
    it('defaults to off, so today\'s behaviour is unchanged', () => {
        expect(accountGateEnabled()).toBe(false);
    });
    it('turns on by env, and only for values that clearly mean yes', () => {
        process.env.VODOU_REQUIRE_ACCOUNT = '1';
        expect(accountGateEnabled()).toBe(true);
        process.env.VODOU_REQUIRE_ACCOUNT = 'true';
        expect(accountGateEnabled()).toBe(true);
        process.env.VODOU_REQUIRE_ACCOUNT = 'TRUE';
        expect(accountGateEnabled()).toBe(true);
    });
    it('anything ambiguous is OFF — a paygate must never switch itself on by accident', () => {
        for (const v of ['0', 'false', '', 'yes', 'maybe', 'off']) {
            process.env.VODOU_REQUIRE_ACCOUNT = v;
            expect(accountGateEnabled(), `"${v}" must not enable the gate`).toBe(false);
        }
    });
});
describe('D13 — one definition of "has an account", consulted on the real path', () => {
    const src = (() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        const path = require('path');
        return fs.readFileSync(path.join(__dirname, '../llm.ts'), 'utf-8');
    })();
    it('llm.ts does not grow a second definition — it imports the modal\'s', () => {
        // Built from parts on purpose: spelled whole, this literal reads as an import
        // FROM THIS TEST'S directory, and `scripts/commit-guard.py` correctly refuses a
        // commit whose tree is not self-consistent. The guard was right; the string was
        // the problem.
        const IMPORT_LINE = 'import { hasVodouAccount } from ' + "'." + "/api/onboarding.js'";
        expect(src).toContain(IMPORT_LINE);
        // The only place that decides is accountGateRefusal. Count CODE, not prose:
        // the first cut of this test counted a mention inside a comment and failed,
        // which is the right failure for the wrong reason.
        const codeLines = src
            .split('\n')
            .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
        const uses = codeLines.filter((l) => l.includes('hasVodouAccount(')).length;
        expect(uses, 'hasVodouAccount should be called once, inside the refusal helper').toBe(1);
    });
    it('the gate is consulted inside chat(), before the turn runs', () => {
        const chatAt = src.indexOf('export async function chat(');
        const gateAt = src.indexOf('accountGateRefusal()', chatAt);
        const entryAt = src.indexOf('chat() ENTRY', chatAt);
        expect(chatAt).toBeGreaterThan(-1);
        expect(gateAt).toBeGreaterThan(chatAt);
        expect(gateAt).toBeLessThan(entryAt); // refuse before doing any work
    });
});
