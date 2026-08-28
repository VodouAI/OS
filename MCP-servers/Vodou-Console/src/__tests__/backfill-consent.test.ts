import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

// PLAN-HISTORY-BACKFILL / PLAN-EXECUTION-SHELF-FUNNEL §8 — backfill's consent path.
//
// Backfill reads conversations from BEFORE install. Its entire value is day one, and
// until now the only place to turn it on was several clicks deep in the extension
// panel — precisely where a brand-new install never looks. So the gateway now owns
// the choice too, mirroring the armed-flag contract.
//
// These are source-level guards because the path crosses four files and two runtimes
// (onboarding page → gateway API → bridge command → extension storage), and the
// failure mode is silent: a question asked and an answer that never arrives anywhere.

const CONSOLE = 'src/';
const R = (f: string) => fs.readFileSync(new URL('../../' + f, import.meta.url), 'utf8');

describe('backfill consent path', () => {
  it('onboarding asks the question, at the moment it matters', () => {
    const s = R('public/js/views/onboarding.js');
    expect(s).toMatch(/ob-mem-backfill/);
    // Worded for a person, and it must state the facts that make it safe to say yes.
    expect(s).toMatch(/only chats you open yourself/);
    expect(s).toMatch(/stays on this machine/);

    // AND IT MUST NOT PROMISE SOMETHING THE CODE DOES NOT DO.
    //
    // This test used to REQUIRE the phrase "no extra requests", which locked a
    // false claim in place: `inject.js` issues credentialed snapshot GETs to the
    // site's own API to assemble a complete thread (`pullGptSnapshot`,
    // `pullClaudeSnapshot`). The claim was written when capture read only the
    // streamed response, and the snapshot lane arrived later.
    //
    // Found by the P1 CWS compliance sweep (PLAN-MEMORY-ON-EVERY-PAGE Appendix B
    // item 8), which flagged the panel's copy; this second copy in onboarding was
    // not in the plan's list and was being ENFORCED by the assertion above. An
    // inaccurate privacy claim is the class of finding that got .52 rejected, so
    // the guard now runs the other way.
    expect(s, 'the backfill lane DOES make requests to the site; do not promise otherwise')
      .not.toMatch(/no extra requests/i);
    expect(s).not.toMatch(/nothing new is fetched/i);
  });

  it('the answer is SAVED, not just rendered', () => {
    const s = R('public/js/views/onboarding.js');
    expect(s).toMatch(/settings\['capture\.web\.backfill'\]/);
  });

  it('the settings API accepts the key — an unlisted key is silently dropped', () => {
    const s = R(CONSOLE + 'api/memory-capture.ts');
    expect(s).toMatch(/'capture\.web\.backfill'/);
  });

  it('has NO env override — consent must not be armable by an environment variable', () => {
    const s = R(CONSOLE + 'api/memory-capture.ts');
    const line = s.split('\n').find((l) => l.includes("'capture.web.backfill'"));
    expect(line).toBeTruthy();
    expect(line).toMatch(/envKey:\s*''/);
  });

  it('writing it pushes to the extension immediately', () => {
    const s = R(CONSOLE + 'api/memory-capture.ts');
    expect(s).toMatch(/pushBackfill/);
  });

  it('and converges again on every bridge_ready, so answering before install works', () => {
    const s = R(CONSOLE + 'vbb/bridge.ts');
    expect(s).toMatch(/syncBackfillToExtension/);
    expect(s).toMatch(/set_backfill/);
  });

  it('a NEVER-SET gateway value does not disarm a panel-armed extension', () => {
    // The extension panel is the older source of truth. A gateway with no opinion
    // must stay silent rather than push `false` over someone's existing choice.
    const s = R(CONSOLE + 'vbb/bridge.ts');
    const i = s.indexOf('async function syncBackfillToExtension');
    const block = s.slice(i, i + 700);
    expect(block).toMatch(/if \(v === null\) return;/);
  });

  it('the extension writes the SAME key the panel toggle writes', () => {
    // Two surfaces, one value. If these diverged, the panel and onboarding would
    // each believe a different answer and the user would be unable to tell which won.
    const s = fs.readFileSync(new URL('../../../../extension/Store-vodou-bridge/background.js', import.meta.url), 'utf8');
    const i = s.indexOf("case 'set_backfill'");
    expect(i).toBeGreaterThan(0);
    const block = s.slice(i, i + 800);
    expect(block).toMatch(/vodou_inject_settings/);
    expect(block).toMatch(/backfill: !!msg\.enabled/);
  });
});
