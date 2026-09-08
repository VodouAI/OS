/**
 * SW-8 — the declared tool bound reaches the SHELL lane.
 *
 * `required_tools` bound the gateway's own tool dispatch. The model reaches
 * tools through `Bash → ./vodou-core call <server> <tool>`, and that path never
 * saw the bound — so a skill declaring one read-only tool could shell out to any
 * of the 942 registered ones, and the run still graded as if the contract held.
 *
 * Driven through the real hook process, because the hook IS the enforcement: a
 * unit test of a predicate would not have caught that `--settings` is inline
 * JSON a hook cannot read back, which is how the first cut of this was wrong.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const HOOK = path.join(here, '..', '..', 'scripts', 'operator-guard-hook.cjs');

/** Run the hook exactly as Claude Code does: JSON on stdin, exit code is the verdict. */
function guard(command: string, allowlist?: string[]): { code: number; stderr: string } {
  const env = { ...process.env };
  if (allowlist) env.VODOU_TOOL_ALLOWLIST = JSON.stringify(allowlist);
  else delete env.VODOU_TOOL_ALLOWLIST;
  try {
    execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer };
    return { code: err.status ?? -1, stderr: String(err.stderr ?? '') };
  }
}

describe('SW-8 — a skill cannot shell around its own declaration', () => {
  it('refuses an undeclared tool called through the shell', () => {
    const r = guard('./vodou-core call gmail send_message {}', ['exa/web_search_exa']);
    expect(r.code, 'exit 2 blocks the call and feeds the reason back').toBe(2);
    expect(r.stderr).toContain('gmail/send_message');
    expect(r.stderr, 'names what IS declared, so the model can retry correctly').toContain('exa/web_search_exa');
  });

  it('allows a declared tool called through the shell', () => {
    expect(guard('./vodou-core call exa web_search_exa {}', ['exa/web_search_exa']).code).toBe(0);
  });

  it('leaves an unrestricted session alone', () => {
    // A skill that declared nothing must not be punished for it — the contract
    // binds what a skill promises, it does not invent promises.
    expect(guard('./vodou-core call gmail send_message {}').code).toBe(0);
    expect(guard('./vodou-core call gmail send_message {}', []).code).toBe(0);
  });

  it('does not interfere with ordinary shell work', () => {
    for (const cmd of ['ls -la', 'git status', 'cat README.md']) {
      expect(guard(cmd, ['exa/web_search_exa']).code, cmd).toBe(0);
    }
  });

  it('catches an undeclared call anywhere in a compound command', () => {
    const r = guard(
      './vodou-core call exa web_search_exa {} && ./vodou-core call gmail send_message {}',
      ['exa/web_search_exa'],
    );
    expect(r.code, 'the second call is still a call').toBe(2);
    expect(r.stderr).toContain('gmail/send_message');
  });

  it('still blocks NEVER-tier commands, bound or not', () => {
    // The pre-existing operator guard must keep working: a banned command stays
    // banned whether or not the skill declared it.
    expect(guard('./vodou-core brain "hello"', ['exa/web_search_exa']).code).toBe(2);
    expect(guard('./vodou-core brain "hello"').code).toBe(2);
  });

  it('the kill switch does not silently disable the tool bound alone', () => {
    // VODOU_OPERATOR_GUARD=0 turns the whole hook off — documented, and the
    // operator's call. Asserted so nobody assumes the bound survives it.
    const env = { ...process.env, VODOU_OPERATOR_GUARD: '0', VODOU_TOOL_ALLOWLIST: '["exa/web_search_exa"]' };
    let code = 0;
    try {
      execFileSync(process.execPath, [HOOK], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: './vodou-core call gmail send_message {}' } }),
        env, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) { code = (e as { status?: number }).status ?? -1; }
    expect(code, 'the documented kill switch turns off the whole hook').toBe(0);
  });
});
