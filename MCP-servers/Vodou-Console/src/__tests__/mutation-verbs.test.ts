/**
 * SW-9 — one list of verbs that mean "this tool changes something".
 *
 * There were three copies and they disagreed. `graph_recipe.rs::is_side_effecting`
 * calls itself "THE authority for the whole system" and was missing `execute`,
 * `run` and `exec` — so `execute_script`, the audit's own example, was not
 * side-effecting and could be auto-run from a routed query with guessed
 * parameters. The two TypeScript copies had those three and were missing `pay`,
 * `charge`, `publish`, `invite`, `rename` and `share`.
 *
 * `mutation-verbs.json` is the source now. Rust embeds it with `include_str!`
 * (compile time, no runtime file). These two modules keep literal arrays —
 * required-tools.ts is imported by the fs sandbox and the executor and must stay
 * dependency-free — so this test is the gate that stops them drifting.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { looksLikeWrite } from '../required-tools.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const source = JSON.parse(fs.readFileSync(path.join(repoRoot, 'mutation-verbs.json'), 'utf8'));
const VERBS: string[] = source.verbs;

/** Pull a literal string array out of a TS source file. */
function literalArray(file: string, name: string): string[] {
  const src = fs.readFileSync(path.join(here, '..', file), 'utf8');
  const at = src.indexOf(`const ${name} = [`);
  expect(at, `${name} not found in ${file}`).toBeGreaterThan(-1);
  const body = src.slice(at + `const ${name} = [`.length, src.indexOf('];', at));
  return [...body.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
}

describe('SW-9 — the mutation verb list has one source', () => {
  it('the JSON source is well formed', () => {
    expect(Array.isArray(VERBS)).toBe(true);
    expect(VERBS.length).toBeGreaterThan(20);
    expect(new Set(VERBS).size, 'no duplicates').toBe(VERBS.length);
    expect([...VERBS].sort()).toEqual(VERBS.map((v) => v)); // stays sorted-ish per file order
  });

  it('required-tools.ts matches the source exactly', () => {
    expect(literalArray('required-tools.ts', 'WRITE_VERBS')).toEqual(VERBS);
  });

  it('project-context.ts matches the source exactly', () => {
    expect(literalArray('project-context.ts', 'WRITE_VERBS_LOCAL')).toEqual(VERBS);
  });

  it('the Rust authority reads the same file rather than keeping its own list', () => {
    const rs = fs.readFileSync(path.join(repoRoot, 'src', 'graph_recipe.rs'), 'utf8');
    const fn = rs.slice(rs.indexOf('pub fn is_side_effecting'), rs.indexOf('fn step_of'));
    expect(fn, 'embeds the shared source').toContain('include_str!("../mutation-verbs.json")');
    expect(fn, 'no hand-kept list left behind').not.toContain('"send", "post", "create"');
  });

  // The finding's own example. `execute_script` with guessed parameters is
  // exactly what "show servers" could auto-run.
  it('classifies the tools the disagreement let through', () => {
    for (const t of ['execute_script', 'run_command', 'exec_sql', 'kill_job']) {
      expect(looksLikeWrite(t), t).toBe(true);
    }
    for (const t of ['send_email', 'postMessage', 'memory_store', 'pay_invoice', 'share_doc']) {
      expect(looksLikeWrite(t), t).toBe(true);
    }
  });

  it('still matches on token boundaries, not substrings', () => {
    // The reason the list is verbs-as-tokens: these are nouns and must not trip.
    for (const t of ['posting_frequency', 'created_at', 'settings_list', 'sender_name']) {
      expect(looksLikeWrite(t), t).toBe(false);
    }
    expect(looksLikeWrite('list_threads')).toBe(false);
    expect(looksLikeWrite('search_jobs')).toBe(false);
  });
});
