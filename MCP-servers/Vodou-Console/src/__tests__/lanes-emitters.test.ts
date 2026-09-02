/**
 * GATE — a registered lane must say where it actually lands, and be right.
 *
 * `coherence-guard` Rule 8 already enforces one direction: no lane literal
 * without a `lanes.toml` stanza. This is the other direction, and it is the one
 * that was missing: **no stanza without a producer.**
 *
 * Measured 2026-08-30 — nine declared lanes had ZERO `turn_events` rows, and
 * lumping them was the mistake. There were three causes:
 *
 *   dead        hook_intent, lenses, rolling_summary — zero mentions in the
 *               source. Declared and written by nothing.
 *   receipt     skill, automation — reach `turn_receipts.lanes` and never the
 *               log. The user sees a lane the log does not have, which is the
 *               drift §26 measured from the other side.
 *   unexercised page_context, doc_attach, api_tool, api_message — an emitter
 *               exists (noteUserBodyLane, the API-family mapper); nobody had
 *               pasted a page or run an API-family turn since the log shipped.
 *
 * A registry that cannot tell "dead" from "unexercised" is the same defect as a
 * `*_count` nothing writes: a claim the product cannot back. So the stanza now
 * carries `emits`, and this asserts the claim against the tree.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../..');
const SRC = path.resolve(__dirname, '..');

function sources(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = path.join(dir, e);
    if (statSync(f).isDirectory()) {
      if (e === '__tests__' || e === 'node_modules') continue;
      sources(f, acc);
    } else if (e.endsWith('.ts') || e.endsWith('.rs')) acc.push(f);
  }
  return acc;
}
// BOTH sides of the seam. The first draft scanned TypeScript only and flagged
// `hook_memory` as unwritten — it is emitted by the DAEMON, in Rust
// (`src/daemon.rs`). A gate that can only see half the producers reports the
// half it cannot see as a defect, which is the failure mode it exists to catch.
const CODE = [
  ...sources(SRC),
  ...sources(path.join(ROOT, 'src')).filter((f) => f.endsWith('.rs')),
].map((f) => readFileSync(f, 'utf-8')).join('\n');

/** Every stanza as `{ name, emits }`; `emits` defaults to 'log'. */
function lanes(): Array<{ name: string; emits: string }> {
  const toml = readFileSync(path.join(ROOT, 'lanes.toml'), 'utf-8');
  const out: Array<{ name: string; emits: string }> = [];
  let cur: { name: string; emits: string } | null = null;
  for (const line of toml.split('\n')) {
    const n = line.match(/^name\s*=\s*"([^"]+)"/);
    if (n) { cur = { name: n[1], emits: 'log' }; out.push(cur); continue; }
    const e = line.match(/^emits\s*=\s*"([^"]+)"/);
    if (e && cur) cur.emits = e[1];
  }
  return out;
}

/** Does ANY producer write this lane name? */
const written = (lane: string) =>
  new RegExp(`lane:\\s*'${lane}'|"lane":\\s*"${lane}"|'${lane}'\\s*,|\\bnoteUserBodyLane\\([^)]*'${lane}'|return '${lane}'|Some\\("${lane}"\\)|"${lane}"\\.to_string`).test(CODE);

describe('GATE — lanes.toml says where each lane lands, and the tree agrees', () => {
  it('every stanza declares a valid `emits`', () => {
    for (const l of lanes()) {
      expect(['log', 'receipt', 'none'], `lane ${l.name}`).toContain(l.emits);
    }
  });

  // The direction Rule 8 does not cover. A lane claiming to reach the log with
  // nothing writing it is a registry entry that cannot be true.
  it('a lane claiming `log` or `receipt` has a producer in the source', () => {
    const liars = lanes().filter((l) => l.emits !== 'none' && !written(l.name));
    expect(liars.map((l) => `${l.name} (emits=${l.emits})`),
      'declared as written, but nothing writes it — either wire it or set emits = "none"')
      .toEqual([]);
  });

  // And the reverse, so a dead lane cannot quietly come back to life unlabelled.
  it('a lane marked `none` really is written by nothing', () => {
    const alive = lanes().filter((l) => l.emits === 'none' && written(l.name));
    expect(alive.map((l) => l.name),
      'marked dead but something writes it — update `emits` to log or receipt')
      .toEqual([]);
  });

  // The three that were dead when this gate was written. Pinned by NAME so that
  // wiring one is a deliberate act that updates this list, not a silent drift.
  it('the known-dead set is exactly what it was measured to be', () => {
    const dead = lanes().filter((l) => l.emits === 'none').map((l) => l.name).sort();
    expect(dead).toEqual(['hook_intent', 'lenses', 'rolling_summary']);
  });
});
