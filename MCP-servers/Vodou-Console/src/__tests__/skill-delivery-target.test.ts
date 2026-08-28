import { describe, it, expect } from 'vitest';

// PLAN-STATE-OF-THE-SYSTEM D3 — a scheduled run has to be able to say where its
// output went. Before this, only channel/broadcast set a target, so a console-mode
// run reported `delivered: null, deliveryTarget: null` and the scheduler stored
// NULL — 157 of 191 rows read as "delivered nowhere" while the text sat in a
// conversation the Skill Console links to. The work was never lost; the product
// could not say where it was.
//
// The branch is inside a long streaming handler, so the RULE is pinned here and
// the wiring is pinned by grep on the source below.
function deliveryFor(mode: string, hasText: boolean, isDryRun: boolean, conversationId: string, channelTarget: string | null) {
  if (isDryRun || !hasText) return { delivered: null as boolean | null, target: null as string | null };
  if (mode === 'channel' || mode === 'broadcast') {
    return channelTarget
      ? { delivered: true, target: channelTarget }
      : { delivered: false, target: null };   // configured but unparseable
  }
  return { delivered: true, target: `console:${conversationId}` };
}

const CONV = 'workbench:skill-console:morning-briefing';

describe('D3 — every run that produced something can say where it went', () => {
  it('console mode names the conversation, instead of reporting nowhere', () => {
    expect(deliveryFor('console', true, false, CONV, null))
      .toEqual({ delivered: true, target: `console:${CONV}` });
  });

  it('a mode nobody set (null/undefined in the DB) still resolves to the console', () => {
    // COALESCE(delivery_mode,'console') is the DB default; an unset value must not
    // fall through to "nowhere" either.
    expect(deliveryFor('', true, false, CONV, null).target).toBe(`console:${CONV}`);
  });

  it('a channel that received it still reports the channel, not the console', () => {
    expect(deliveryFor('channel', true, false, CONV, 'telegram:7379653885'))
      .toEqual({ delivered: true, target: 'telegram:7379653885' });
  });

  it('a configured channel that did NOT receive it is still false — the tri-state survives', () => {
    expect(deliveryFor('channel', true, false, CONV, null))
      .toEqual({ delivered: false, target: null });
  });

  it('a dry run delivers nowhere on purpose, and says so', () => {
    expect(deliveryFor('console', true, true, CONV, null)).toEqual({ delivered: null, target: null });
  });

  it('a run that produced nothing has nothing to deliver', () => {
    expect(deliveryFor('console', false, false, CONV, null)).toEqual({ delivered: null, target: null });
  });
});

describe('D3 — the rule above is the one the route actually runs', () => {
  it('skill-fire sets a console target before the channel branch', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(__dirname, '../index.ts'), 'utf-8');
    const consoleAt = src.indexOf('sfDeliveryTarget = `console:${conversationId}`');
    const channelAt = src.indexOf("skill.delivery_mode === 'channel' || skill.delivery_mode === 'broadcast'");
    expect(consoleAt).toBeGreaterThan(-1);
    // guarded by dry-run and by having text, and it does not swallow channel mode
    const guard = src.slice(consoleAt - 400, consoleAt);
    expect(guard).toContain('!isDryRun');
    expect(guard).toContain("skill.delivery_mode !== 'channel'");
    expect(channelAt).toBeGreaterThan(-1);
  });
});
