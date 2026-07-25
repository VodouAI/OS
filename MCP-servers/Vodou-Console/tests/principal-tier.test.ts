/**
 * S-PRINCIPAL regression guard — PLAN-MASTER-EXECUTION-ORDER item 2.
 *
 * The failure this protects against is SILENT: a guest turn that ends up with
 * owner tool grants produces no error and no log, it just means a stranger in a
 * shared Slack channel can run shell commands as the owner. If anything here
 * starts failing, treat it as a live security regression, not a flaky test.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { enterProjectContext, turnPrincipal, turnIsGuest, turnGuestVault } from '../src/project-context.js';
import { cliToolGrantsFor } from '../src/llm.js';

afterEach(() => {
  enterProjectContext({}); // reset the async-local store between cases
});

describe('turn principal defaults', () => {
  it('defaults to owner when nothing is set — no existing caller loses capability', () => {
    enterProjectContext({});
    expect(turnPrincipal()).toBe('owner');
    expect(turnIsGuest()).toBe(false);
  });

  it('treats an explicit owner as owner', () => {
    enterProjectContext({ principal: 'owner' });
    expect(turnIsGuest()).toBe(false);
  });

  it('demotes only on the exact string "guest"', () => {
    enterProjectContext({ principal: 'guest' });
    expect(turnIsGuest()).toBe(true);
  });

  it('does NOT demote on a near-miss value (fail toward owner, never silently guest)', () => {
    enterProjectContext({ principal: 'Guest' as any });
    expect(turnPrincipal()).toBe('owner');
    enterProjectContext({ principal: 'GUEST' as any });
    expect(turnPrincipal()).toBe('owner');
    enterProjectContext({ principal: '' as any });
    expect(turnPrincipal()).toBe('owner');
  });

  it('carries the guest vault, and treats blank as unset', () => {
    enterProjectContext({ principal: 'guest', guestVault: 'team-shared' });
    expect(turnGuestVault()).toBe('team-shared');
    enterProjectContext({ principal: 'guest', guestVault: '   ' });
    expect(turnGuestVault()).toBeUndefined();
  });

  it('keeps principal and project context in one store (set atomically)', () => {
    enterProjectContext({ principal: 'guest', projectId: 'proj_x', guestVault: '*' });
    expect(turnIsGuest()).toBe(true);
    expect(turnGuestVault()).toBe('*');
  });
});

describe('cliToolGrantsFor — the tool-grant decision', () => {
  it('gives a guest NO tools, in every shell mode', () => {
    for (const mode of ['restricted', 'verify', 'full'] as const) {
      const g = cliToolGrantsFor(mode, true);
      expect(g.allowedTools).toBe('none');
      expect(g.allowedTools).not.toMatch(/Bash/);
      expect(g.maxTurns).toBe('1');
    }
  });

  it('leaves the owner exactly as before in every shell mode', () => {
    expect(cliToolGrantsFor('full', false).allowedTools).toBe('Bash,Read,Write,Edit,Grep,Glob');
    expect(cliToolGrantsFor('verify', false).allowedTools).toBe('Bash,Read,Grep,Glob');
    expect(cliToolGrantsFor('restricted', false).allowedTools).toBe('Bash');
  });

  it('does not let shellMode restricted masquerade as a guest tier (it still grants Bash)', () => {
    // This is why the guest tier could not simply reuse `restricted`.
    expect(cliToolGrantsFor('restricted', false).allowedTools).toContain('Bash');
    expect(cliToolGrantsFor('restricted', true).allowedTools).toBe('none');
  });

  it('caps guest turn count so an ask-only turn cannot loop', () => {
    expect(cliToolGrantsFor('full', true).maxTurns).toBe('1');
    expect(Number(cliToolGrantsFor('full', false).maxTurns)).toBeGreaterThan(1);
  });
});
