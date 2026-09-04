import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * GATE — PLAN-SEAMS §41: every one-shot completion is either on a turn or says
 * why it is not.
 *
 * `rawLLMCall` logs its prompt and reply under a turn when it is given a
 * `conversationId` (directly, or via `rawLLMCallPooled`). A call that passes
 * none is invisible to the log — "model-visible ⟺ logged" broken for that
 * completion. That was every site in the tree until 2026-09-03. This test does
 * not forbid turnless calls; the setup wizard genuinely runs before any turn.
 * It forbids UNDECLARED ones: a site with no conversation id must carry a
 * `// TURNLESS: <why>` line within the three lines above it.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (name === '__tests__' || name === 'node_modules') continue;
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const CALL = /\brawLLMCall(?:Pooled|Strict)?\(/g;

describe('GATE — a one-shot completion is on a turn, or says why it is not', () => {
  it('every call site outside llm.ts carries a conversation id or a TURNLESS line', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      if (file.endsWith(path.join('src', 'llm.ts'))) continue;   // the definitions
      const text = readFileSync(file, 'utf-8');
      const lines = text.split('\n');
      for (const m of text.matchAll(CALL)) {
        const at = text.slice(0, m.index).split('\n').length;   // 1-based line
        const line = lines[at - 1].trim();
        if (line.startsWith('//') || line.startsWith('*') || /^(import|export)\b/.test(line)) continue;
        if (/^const\s+rawLLMCall\w*\s*:/.test(line)) continue;           // a typed re-export shim
        const above = lines.slice(Math.max(0, at - 4), at - 1).join('\n');
        if (/TURNLESS:/.test(above)) continue;
        const call = text.slice(m.index!, m.index! + 400);
        if (/conversationId/.test(call)) continue;
        offenders.push(`${path.relative(SRC, file)}:${at}  ${line.slice(0, 80)}`);
      }
    }
    expect(offenders, 'one-shot completions with no turn and no TURNLESS reason').toEqual([]);
  });

  it('the wrapper logs when given a conversation, and the pooled variant always passes one', () => {
    const llm = readFileSync(path.join(SRC, 'llm.ts'), 'utf-8');
    expect(llm).toMatch(/export async function rawLLMCall\([\s\S]{0,400}opts\?: RawLLMCallOpts/);
    expect(llm).toMatch(/kind: 'tool\/call'[\s\S]{0,200}server: 'llm'/);
    expect(llm).toMatch(/kind: 'tool\/result'[\s\S]{0,200}server: 'llm'/);
    expect(llm).toMatch(/rawLLMCall\(prompt, systemPrompt, \{ conversationId, agent \}\)/);
  });
});
