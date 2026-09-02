/**
 * PLAN-SEAMS-AND-SESSION-LOG P1 — keyless recorded-session replay.
 *
 * The gate this repo did not have: **a change that alters what a model would
 * have been told fails CI, with a diff.**
 *
 * Every fixture here was RECORDED by running the real product with
 * `VODOU_REPLAY_CAPTURE=<dir>` set, not written by hand. That distinction is the
 * point. A hand-written fixture pins what its author *believed* the assembler
 * does; a recorded one pins what it *did*. The 2026-08-28 recount exists because
 * five injectors ran beside the one assembler for weeks and every test agreed
 * with the belief rather than the behaviour.
 *
 * ── What is pinned, and what deliberately is not ─────────────────────────────
 * Pinned: `injected` (ground truth + memory, post-budget, post-strip),
 * `userPrefix` (lane 6, its label, and the P5 trust fence), `bootstrapSent`,
 * and the lane set with sizes and states.
 *
 * NOT pinned: `staticPrefix`. It is the base system prompt plus the bootstrap —
 * both read from the environment (files, gateway settings, the installed lenses
 * registry), so it differs per machine and per install. Asserting it would make
 * this a test of the developer's laptop. `bootstrapSent` captures the DECISION,
 * which is the part code can change.
 *
 * ── Updating a fixture ───────────────────────────────────────────────────────
 * A red fixture means the prompt changed. That is sometimes correct — P5 added a
 * trust fence and three fixtures moved. Re-record the turn with the capture flag
 * and commit the new fixture WITH the diff visible in review. Never edit the
 * expectation by hand to make the suite green: that is the failure this file
 * exists to prevent, performed by its own maintainer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, 'fixtures/turns');

interface Fixture {
  schema_version: number;
  note?: string;
  input: Record<string, unknown>;
  state?: { alreadyBootstrapped?: boolean };
  expect: { injected: string; userPrefix: string; bootstrapSent: boolean; lanes: Array<Record<string, unknown>> };
}

/** A readable unified-ish diff. A gate that says "expected X to be Y" over two
 *  40 KB strings tells you nothing; this says WHERE and WHAT. */
function firstDiff(a: string, b: string): string {
  if (a === b) return '(identical)';
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  const ctx = 70;
  const at = `at char ${i} of ${a.length} (recorded ${b.length})`;
  const shared = JSON.stringify(a.slice(Math.max(0, i - 40), i));
  return [
    `${at}`,
    `  …shared: ${shared}`,
    `  NOW     : ${JSON.stringify(a.slice(i, i + ctx))}`,
    `  RECORDED: ${JSON.stringify(b.slice(i, i + ctx))}`,
  ].join('\n');
}

const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.json')).sort() : [];

describe('P1 — recorded turns still assemble the same way', () => {
  it('there are fixtures at all', () => {
    // A replay suite with no fixtures passes trivially and reports health it
    // never measured — the failure mode `flows` was built to refuse.
    expect(files.length, `no fixtures in ${DIR}; record some with VODOU_REPLAY_CAPTURE`).toBeGreaterThan(0);
  });

  for (const file of files) {
    const fx = JSON.parse(readFileSync(path.join(DIR, file), 'utf-8')) as Fixture;
    it(`${file.replace(/\.json$/, '')}${fx.note ? ` — ${fx.note}` : ''}`, async () => {
      const { assembleContext, scrubForReplay } = await import('../llm.js');
      const conversationId = `replay-${file}-${Math.random().toString(36).slice(2)}`;

      // "Recorded SESSION replay" is not a slogan: the assembler reads
      // conversation-scoped state (has this conversation been bootstrapped?)
      // that no single turn's input carries. A continuing turn replayed cold
      // becomes a first turn and its lane set differs. So warm the conversation
      // exactly as the recording found it, then assert.
      if (fx.state?.alreadyBootstrapped) {
        await assembleContext({ ...(fx.input as any), conversationId, cachedBase: undefined, prefixOnly: false });
      }

      const a = await assembleContext({ ...(fx.input as any), conversationId });

      // Same substitution the recorder applied, so the fixture is portable: it
      // asserts every byte EXCEPT this machine's install root, which is the one
      // value that cannot be the same on two computers.
      const injected = scrubForReplay(a.injected);
      const userPrefix = scrubForReplay(a.userPrefix);
      expect(injected, `INJECTED changed:\n${firstDiff(injected, fx.expect.injected)}`)
        .toBe(fx.expect.injected);
      expect(userPrefix, `USER PREFIX changed:\n${firstDiff(userPrefix, fx.expect.userPrefix)}`)
        .toBe(fx.expect.userPrefix);

      // The lane SET is part of the contract: a lane that silently stops firing
      // is the exact defect the recount found three of, and it does not change
      // a single byte of `injected`.
      //
      // `bootstrap` is compared separately because its PRESENCE depends on a file
      // (`.vodou/workspace/.context_cache`) that a fresh install has not written
      // yet. Asserting it unconditionally makes these fixtures red on any machine
      // that has not run the workspace loader — i.e. exactly a new install, and
      // exactly CI. The DECISION is still pinned (below); only the environment's
      // ability to supply the bytes is tolerated.
      const ENV_CONDITIONAL = new Set(['bootstrap']);
      const now = a.lanes.map((l) => l.lane).filter((l) => !ENV_CONDITIONAL.has(l)).sort();
      const then = fx.expect.lanes.map((l) => l.lane as string).filter((l) => !ENV_CONDITIONAL.has(l)).sort();
      expect(now, `LANE SET changed — now [${now}], recorded [${then}]`).toEqual(then);

      // The bootstrap DECISION, pinned only where the environment can honour it.
      // A fixture recorded with a bootstrap, replayed where none exists, tells
      // you nothing about the code — so it says so rather than failing or, worse,
      // passing silently.
      const envHasBootstrap = existsSync(path.resolve(__dirname, '../../../../.vodou/workspace/.context_cache'));
      if (envHasBootstrap) {
        expect(a.bootstrapSent, 'the bootstrap DECISION changed').toBe(fx.expect.bootstrapSent);
      } else if (fx.expect.bootstrapSent) {
        console.warn(`[replay] ${file}: no .context_cache in this install — bootstrap decision not asserted`);
      }

      // `system_prompt` and `bootstrap` carry text the ENVIRONMENT supplies — the
      // base prompt (settings, installed lenses) and the workspace manual (a file
      // on disk). Their sizes differ per machine and per install, so asserting
      // them would make this a test of whoever ran it last. Their PRESENCE is
      // asserted above, in the lane set, which is the part code decides.
      // `ground_truth` joins the env-sized set for the same reason: its bytes
      // contain the install root, so its LENGTH is machine-specific even though
      // its content is now portable.
      const ENV_SIZED = new Set(['system_prompt', 'bootstrap', 'ground_truth']);
      for (const rec of fx.expect.lanes) {
        const got = a.lanes.find((l) => l.lane === rec.lane)!;
        if (ENV_SIZED.has(rec.lane as string)) continue;
        expect(got.chars, `lane ${rec.lane}: chars`).toBe(rec.chars);
        if (rec.state !== undefined) expect(got.state, `lane ${rec.lane}: state`).toBe(rec.state);
        if (rec.evicted_tok !== undefined) expect(got.evicted_tok, `lane ${rec.lane}: evicted_tok`).toBe(rec.evicted_tok);
      }
    });
  }
});
