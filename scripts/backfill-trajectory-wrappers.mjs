#!/usr/bin/env node
/**
 * backfill-trajectory-wrappers.mjs — PLAN-ALPHA F4.
 *
 * `gateway_tool_trajectories.prompt_excerpt` stored the system wrapper instead
 * of what the user typed, so the overnight skill-proposer clustered on
 * packaging: its top recurring "intent" was a piece of XML. No real intent could
 * then reach OPT_MIN_DECIDED=3, which is why skill_metrics stayed empty (D11).
 *
 * The gateway now strips wrappers before storage. This repairs the rows written
 * before that.
 *
 * IMPORTANT: the damage is not always repairable. `prompt_excerpt` is truncated
 * to 280 chars at insert and the CLI preamble alone is ~250, so for many rows
 * the user's actual words were never stored at all — there is nothing to
 * recover. Those rows are reported as UNRECOVERABLE and left alone rather than
 * blanked: an honest wrapper is better than a fabricated intent, and the
 * proposer's filter now skips them anyway.
 *
 * Dry-run by default. Pass --apply to write.
 *
 *   node scripts/backfill-trajectory-wrappers.mjs
 *   node scripts/backfill-trajectory-wrappers.mjs --apply
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB = join(ROOT, 'MCP-servers', 'Vodou-Console', 'gateway.db');
const APPLY = process.argv.includes('--apply');

if (!existsSync(DB)) {
  console.error(`gateway.db not found at ${DB}`);
  process.exit(2);
}

// Same logic as trajectory-capture.ts stripPromptWrappers. Duplicated because
// this is a one-shot node script that must not import the gateway's TS build.
function strip(raw) {
  if (!raw) return raw;
  let text = raw;
  const openTag = /^\s*<untrusted_channel_message[^>]*>\s*/i;
  if (openTag.test(text)) {
    text = text.replace(openTag, '');
    const close = text.search(/<\/untrusted_channel_message>/i);
    if (close >= 0) text = text.slice(0, close);
  }
  text = text.replace(/^\s*\[Vodou[^\]]*\]\s*/i, '');
  const cleaned = text.trim();
  return cleaned.length > 0 ? cleaned : raw;
}

const db = new DatabaseSync(DB);
const rows = db
  .prepare(
    `SELECT id, prompt_excerpt FROM gateway_tool_trajectories
      WHERE prompt_excerpt IS NOT NULL
        AND (prompt_excerpt LIKE '<%' OR prompt_excerpt LIKE '[Vodou%')`
  )
  .all();

let recovered = 0;
let unrecoverable = 0;
const samples = [];
const updates = [];

for (const r of rows) {
  const out = strip(r.prompt_excerpt);
  if (out === r.prompt_excerpt) {
    // Stripping changed nothing — the excerpt is wrapper all the way down,
    // because truncation cut the real text off before it was ever stored.
    unrecoverable++;
    continue;
  }
  recovered++;
  updates.push({ id: r.id, text: out });
  if (samples.length < 5) samples.push({ before: r.prompt_excerpt.slice(0, 60), after: out.slice(0, 60) });
}

console.log(`wrapper rows found : ${rows.length}`);
console.log(`  recoverable      : ${recovered}`);
console.log(`  unrecoverable    : ${unrecoverable}  (real text truncated away at insert; left as-is)`);
if (samples.length) {
  console.log('\nsamples:');
  for (const s of samples) {
    console.log(`  - ${JSON.stringify(s.before)}…`);
    console.log(`    → ${JSON.stringify(s.after)}…`);
  }
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to update.');
  process.exit(0);
}

if (updates.length === 0) {
  console.log('\nNothing to write.');
  process.exit(0);
}

const backup = `${DB}.bak-pre-trajectory-backfill-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
copyFileSync(DB, backup);
console.log(`\nbackup: ${backup}`);

const stmt = db.prepare('UPDATE gateway_tool_trajectories SET prompt_excerpt = ? WHERE id = ?');
db.exec('BEGIN');
try {
  for (const u of updates) stmt.run(u.text, u.id);
  db.exec('COMMIT');
  console.log(`updated ${updates.length} row(s).`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('rolled back:', e.message);
  process.exit(1);
}
