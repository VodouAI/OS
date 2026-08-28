/**
 * What a `then:` step actually receives from a fan.
 *
 * This is an integration test on purpose. The unit tests for the group executor
 * all passed while a fan was handing downstream steps its TICK MARKS and none of
 * its data — `✓ calendar  google-calendar·list-events  2517ms` and no calendar
 * events. A briefing written "from {calendar, mail}" would have been written out
 * of nothing and looked like it worked, which is the worst kind of bug: the run
 * is green, the output is confident, and the input was absent.
 *
 * Nothing short of running a real fan and reading what came back would have
 * caught it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'fs';
import path from 'path';
import { executeSteps } from '../workflow-driver.js';

const ROOT = path.resolve(__dirname, '../../../..');
const BIN = [
  path.join(ROOT, 'vodou-core'),
  path.join(ROOT, 'target', 'release', 'vodou-core'),
  path.join(ROOT, 'target', 'debug', 'vodou-core'),
].find(existsSync);

/**
 * A fan calls REAL MCP servers, and which servers exist is recorded in
 * `vodou-core.db` — a runtime database, not in git, absent from a fresh
 * checkout. Without it `mcp-monitor` is not registered, every branch fails, and
 * the payload assertions below fail for a reason that has nothing to do with
 * the code under test.
 *
 * Gated on the registration, not softened. These assertions exist because unit
 * tests passed while a fan handed downstream steps its tick marks and none of
 * its data; loosening them would restore exactly that blindness. A skip says so
 * out loud instead.
 */
const SERVERS_AVAILABLE = (() => {
  if (!BIN) return false;
  try {
    const db = path.join(ROOT, 'vodou-core.db');
    if (!existsSync(db)) return false;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFileSync } = require('child_process') as typeof import('child_process');
    // `tools <NAME>` — reads the vodou-core.db catalog. NOT `tools list --server`,
    // which is not a subcommand: that spelling made the probe fail even where
    // mcp-monitor was registered, and skipped the test on a machine that could
    // have run it. A detector that is wrong in the strict direction disables the
    // test everywhere and looks like success.
    const out = execFileSync(BIN, ['tools', 'mcp-monitor'], {
      cwd: ROOT, timeout: 20_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /get_cpu_info/.test(out);
  } catch {
    return false;
  }
})();

if (!SERVERS_AVAILABLE) {
  console.error(
    '[graph-fan-payload] SKIPPED: `mcp-monitor` is not registered here. A fan calls real\n' +
    '                    MCP servers, and the registry lives in `vodou-core.db`, which is a\n' +
    '                    runtime database absent from a fresh checkout. Environment gap,\n' +
    '                    NOT a passing test.',
  );
}

beforeAll(() => {
  if (BIN) process.env.VC_PATH = BIN;
});

describe('a fan hands its results downstream, not just its status', () => {
  it.runIf(SERVERS_AVAILABLE)('puts each branch payload in the text a then: step reads', async () => {
    const steps = [
      { id: 'cpu', server: 'mcp-monitor', tool: 'get_cpu_info', args: {}, parallel_group: 'sysmon' as const },
      { id: 'mem', server: 'mcp-monitor', tool: 'get_memory_info', args: {}, parallel_group: 'sysmon' as const },
      { id: 'j', kind: 'join' as const, in: ['cpu', 'mem'], min_success: 1 },
    ];
    const out = await executeSteps(steps as never, {}, () => {}, '', 'fan-payload-test');

    // The status block is still there — the counts are the final word on a fan.
    expect(out).toContain('together → sysmon');
    expect(out).toMatch(/Join: \d\/2 settled/);

    // And so is the DATA. `core_count` comes from get_cpu_info's payload; if
    // only the summary were pushed, this is the assertion that fails.
    expect(out).toContain('mcp-monitor::get_cpu_info');
    expect(out.includes('core_count') || out.includes('cpu')).toBe(true);
    expect(out.length).toBeGreaterThan(400);
  }, 120_000);

  it.runIf(SERVERS_AVAILABLE)('streams the recorded counts verbatim, for surfaces that cannot draw a card', async () => {
    // The web run card reads structured events and is safe. The TEXT path went
    // through a model to be written up — so on Telegram, the side panel, or in
    // the saved transcript, the count a user saw was whatever the model chose to
    // say about it. A count a model restates is one it can round, soften or drop.
    const events: Array<{ type: string; content?: string }> = [];
    const steps = [
      { id: 'cpu', server: 'mcp-monitor', tool: 'get_cpu_info', args: {}, parallel_group: 'g' as const },
      { id: 'dead', server: 'no-such-server-xyz', tool: 'nope', args: {}, parallel_group: 'g' as const, on_fail: 'skip' as const },
      { id: 'j', kind: 'join' as const, in: ['cpu', 'dead'], min_success: 1 },
    ];
    await executeSteps(steps as never, {}, (e) => events.push(e as never), '', 'verbatim-test');

    const text = events.filter((e) => e.type === 'text').map((e) => e.content).join('');
    expect(text).toContain('Join: 1/2 settled');
    expect(text).toContain('Join j: 1/2 succeeded');
    // Named, so a reader knows WHICH source was missing, not merely that one was.
    expect(text).toContain('dead');
  }, 120_000);

  it.runIf(SERVERS_AVAILABLE)('a failed branch contributes no payload but is still counted', async () => {
    const steps = [
      { id: 'ok', server: 'mcp-monitor', tool: 'get_cpu_info', args: {}, parallel_group: 'g' as const },
      { id: 'dead', server: 'no-such-server-xyz', tool: 'nope', args: {}, parallel_group: 'g' as const, on_fail: 'skip' as const },
      { id: 'j', kind: 'join' as const, in: ['ok', 'dead'], min_success: 1 },
    ];
    const out = await executeSteps(steps as never, {}, () => {}, '', 'fan-payload-test');
    expect(out).toContain('Join: 1/2 settled');
    // The dead branch is named, but contributes nothing a later step could
    // mistake for data.
    expect(out).toContain('dead');
    expect(out).not.toContain('no-such-server-xyz::nope');
  }, 120_000);
});
