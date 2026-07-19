import path from 'path';
import os from 'os';
import { existsSync, unlinkSync } from 'fs';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { closeGatewayDbOnly } from '../src/db.js';
import { parseSkillToolPolicy } from '../src/llm.js';
import { executeOITool } from '../src/executor.js';

// #7 Item 2 (chat-side) — a loaded skill's enforced tool policy. The RS
// `format_skill_output` emits `Allowed Tools:`/`Disallowed Tools:` header lines;
// the gateway parses them (parseSkillToolPolicy) into the per-conversation active
// skill, threads them to executeOITool as `activeToolPolicy`, and the executor
// refuses tools outside the allow-list / in the deny-list (per-skill SCOPE,
// composes with the Bet #2 category RISK tier).

describe('parseSkillToolPolicy', () => {
  it('parses Allowed/Disallowed Tools from the header only (body prose ignored)', () => {
    const content =
      '# SKILL: x\nDescription: y\nAllowed Tools: read_file, web_search\nDisallowed Tools: write_file, Bash\n' +
      '\n## Skill Instructions:\n\nAllowed Tools: this body line must NOT match';
    const p = parseSkillToolPolicy(content);
    expect(p.allowed).toEqual(['read_file', 'web_search']);
    expect(p.disallowed).toEqual(['write_file', 'Bash']);
  });

  it('empty when no policy lines', () => {
    const p = parseSkillToolPolicy('# SKILL: x\nDescription: y\n\n## Skill Instructions:\n\nbody');
    expect(p.allowed).toEqual([]);
    expect(p.disallowed).toEqual([]);
  });
});

describe('executeOITool — active-skill policy gate', () => {
  let gwDb: string;
  beforeEach(() => {
    closeGatewayDbOnly();
    gwDb = path.join(os.tmpdir(), `gw-pol-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    process.env.GATEWAY_DB_PATH = gwDb;
  });
  afterAll(() => {
    closeGatewayDbOnly();
    if (gwDb && existsSync(gwDb)) { try { unlinkSync(gwDb); } catch { /* */ } }
  });

  it('refuses a tool not in allowed-tools', async () => {
    const r = await executeOITool('write_file', { path: 'x', content: 'y' },
      { conversationId: 'pol-1', activeToolPolicy: { allowed: ['read_file'], disallowed: [] } });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not in the active skill's allowed-tools/);
  });

  it('refuses a tool in disallowed-tools (even when allow-list is empty)', async () => {
    const r = await executeOITool('Bash', { command: 'ls' },
      { conversationId: 'pol-2', activeToolPolicy: { allowed: [], disallowed: ['Bash'] } });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/disallowed-tools/);
  });

  it('allows a tool that IS in allowed-tools (passes the policy gate)', async () => {
    // read_file is permitted → the policy gate does NOT deny it (it may proceed to
    // other gates, but the error must not be the skill-policy refusal).
    const r = await executeOITool('read_file', { path: 'x' },
      { conversationId: 'pol-3', activeToolPolicy: { allowed: ['read_file'], disallowed: [] } });
    expect(r.error || '').not.toMatch(/active skill's/);
  });

  it('no policy → the skill gate never fires', async () => {
    const r = await executeOITool('write_file', { path: 'x', content: 'y' }, { conversationId: 'pol-4' });
    expect(r.error || '').not.toMatch(/active skill's/);
  });
});
