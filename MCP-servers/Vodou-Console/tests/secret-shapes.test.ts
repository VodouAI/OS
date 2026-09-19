import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasSecretShape, redactOutboundSecrets } from '../src/lenses-policy.js';
import { isLeak, type InjectPolicy } from '../src/inject-policy.js';

// FU-26 (PLAN-MEMORIES-ARE-FACTS-NOT-WORK-LOGS P4) — the gateway half of the
// credential-shape guard. The engine's twin (src/inject_select.rs secret_shaped)
// reads the same fixture; firing cases are built from parts so no key-shaped
// literal lives in the tree.
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../tests/fixtures/secret-shapes.json', import.meta.url)), 'utf8'),
);
const NO_NEEDLES: InjectPolicy = { scope_deny: [], leak_needles: [] };
const textOf = (c: { text?: string; make?: [string, string, number] }): string =>
  typeof c.text === 'string' ? c.text : String(c.make![0]) + String(c.make![1]).repeat(Number(c.make![2]));

describe('secret shapes — one fixture for engine and gateway', () => {
  it('has enough cases', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(15);
  });
  for (const c of fixture.cases) {
    it(`${c.fire ? 'fires' : 'stays quiet'}: ${c.why}`, () => {
      const t = textOf(c);
      expect(hasSecretShape(t)).toBe(c.fire);
      expect(isLeak(t, NO_NEEDLES)).toBe(c.fire);
    });
  }
  it('no longer blanks an ordinary hyphenated name in an outbound reply', () => {
    expect(redactOutboundSecrets('the execdesk-agent-configuration-runner-v2 job').redactions).toBe(0);
  });
});
