import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
/**
 * HH-7 — `src/core-api.ts` is GENERATED, and nothing noticed when it stopped
 * matching what it is generated from.
 *
 * It is produced by `npm run gen:core-api`, which points openapi-typescript at
 * the running daemon's `/openapi.json`. That means regenerating requires a live
 * daemon, so in practice it happened once and then did not: the file went 125
 * days without a regeneration, and what it was missing was not incidental. The
 * two absent paths were **both** `/api/v2/*` routes — the chokepoints that
 * exist precisely so external callers thread `principal_id` through the public
 * contract instead of bypassing the continuity primitive. The types did not
 * know about the two endpoints that matter most, and both were called by bare
 * string, so a rename on the Rust side would have surfaced as a 404 at runtime
 * and nowhere earlier.
 *
 * This test needs no daemon. The spec's SOURCE is a Rust file that declares
 * every path as `m.insert("<path>".into(), json!({...}))`, so the declared set
 * can be read statically and compared with the generated file's path keys.
 *
 * It is the same shape as `rules-guard` (CLAUDE.md from templates/) and
 * `env-example-guard` (.env.example from its manifest): a generated artifact
 * that has a source, and a check that says so out loud when they disagree.
 */
const here = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..', '..', '..');
const OPENAPI_RS = path.join(REPO, 'src', 'api_http', 'openapi.rs');
const CORE_API_TS = path.resolve(here, '..', 'core-api.ts');
/** Paths the Rust spec declares — the source of truth. */
function declaredPaths() {
    const rs = fs.readFileSync(OPENAPI_RS, 'utf8');
    return new Set([...rs.matchAll(/m\.insert\(\s*"([^"]+)"\s*\.into\(\)/g)].map((m) => m[1]));
}
/** Paths the generated TypeScript knows about. */
function generatedPaths() {
    const ts = fs.readFileSync(CORE_API_TS, 'utf8');
    return new Set([...ts.matchAll(/^ {4}"(\/[^"]+)": \{$/gm)].map((m) => m[1]));
}
describe('HH-7 — the generated core API types match the spec they come from', () => {
    it('reads both sides at all', () => {
        // A guard that silently measures nothing passes forever. If either regex
        // stops matching — a rustfmt change, a generator upgrade that reindents —
        // this fails first and names which side went quiet, rather than letting the
        // comparison below succeed on two empty sets.
        expect(declaredPaths().size, `no paths parsed out of ${OPENAPI_RS}`).toBeGreaterThan(20);
        expect(generatedPaths().size, `no paths parsed out of ${CORE_API_TS}`).toBeGreaterThan(20);
    });
    it('declares every path the daemon serves, and no others', () => {
        const declared = declaredPaths();
        const generated = generatedPaths();
        const missing = [...declared].filter((p) => !generated.has(p)).sort();
        const extra = [...generated].filter((p) => !declared.has(p)).sort();
        expect({ missing, extra }, 'src/core-api.ts has drifted from src/api_http/openapi.rs. ' +
            'Start the daemon and run `npm run gen:core-api` in MCP-servers/Vodou-Console, ' +
            'then commit the regenerated file with whatever changed openapi.rs.').toEqual({ missing: [], extra: [] });
    });
    it('still carries the two v2 chokepoints, which is what went missing', () => {
        // Named explicitly, not just covered by the set comparison: these are the
        // ones whose absence had a consequence, and a future refactor that drops
        // them from BOTH files would satisfy the comparison above.
        const generated = generatedPaths();
        expect(generated.has('/api/v2/memory/recall')).toBe(true);
        expect(generated.has('/api/v2/channels/turns')).toBe(true);
    });
});
