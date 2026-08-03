#!/usr/bin/env node
// Verify what the Save button ACTUALLY stored, per site.
//
// The browser probes used while deriving each selector set proved extraction works
// in the page. This proves the round trip: extension → bridge → gateway →
// `mem import <src> --stdin-json` → gateway.db. Those are different things, and the
// gap between them is where the last three failures lived (empty extractor
// registry, stale binary, and before that a gateway that rejected the source).
//
// Reads text, never counts. Every defect this sweep found — eighteen sites,
// eighteen distinct defects — produced a plausible turn count. A count check would
// have passed all of them.
//
//   node scripts/verify-web-captures.mjs            # every site with a save block
//   node scripts/verify-web-captures.mjs kimi grok  # just these
//
// Exit 1 if any saved conversation fails an assertion, so it can gate a release.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GW = join(ROOT, 'MCP-servers', 'Vodou-Console', 'gateway.db');
const SITES = join(ROOT, 'extension', 'Store-vodou-bridge', 'sites.js');

function sql(query) {
  // -json so content with newlines/pipes cannot be mistaken for column separators.
  // The earlier hand-written checks used the default pipe format and a message
  // containing " | " would have split into phantom columns.
  const out = execFileSync('sqlite3', ['-json', GW, query], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
  return out ? JSON.parse(out) : [];
}

const ctx = {};
vm.createContext(ctx);
vm.runInContext(readFileSync(SITES, 'utf8'), ctx);
const sites = (ctx.VODOU_SITES || []).filter((s) => s.save && s.save.user);

// Phrases that must never appear in stored text, per site. Derived from what was
// actually observed while deriving each selector set — not guessed.
const LEAKS = {
  gemini: ['You said'],
  grok: ['Worked for', 'thinking'],
  kimi: ['The user is asking', 'Let me check the memory'],
  qwen: ['Thinking completed'],
  zai: ['Thought Process'],
  copilot: ['Copilot said', 'You said'],
  mistral: [/\b\d{1,2}:\d{2}\s*(am|pm)\b/i],
  notebooklm: ['keep_pin', 'copy_all', 'thumb_up', 'Save to note'],
  huggingface: ['Get PRO', 'agentic', 'Kimi-K2'],
  poe: ['Assistant\n'],
  metaai: ['Show thinking'],
  you: [],
  t3: [],
  perplexity: [],
  deepseek: [],
  aistudio: ['more_vert'],
  manus: [],
  character: [],
};

const want = process.argv.slice(2);
let failures = 0;
let checked = 0;

for (const site of sites) {
  const slug = site.capture;
  if (want.length && !want.includes(site.key) && !want.includes(slug)) continue;

  const convs = sql(
    `SELECT id, title FROM gateway_conversations WHERE id LIKE 'import:${slug}:%' ORDER BY rowid DESC LIMIT 1;`,
  );
  if (!convs.length) {
    console.log(`  ·  ${site.label.padEnd(14)} not saved yet`);
    continue;
  }

  checked++;
  const conv = convs[0];
  const msgs = sql(
    `SELECT role, content FROM gateway_messages WHERE conversation_id = '${conv.id.replace(/'/g, "''")}' ORDER BY rowid;`,
  );
  const problems = [];
  const warnings = [];

  if (!msgs.length) problems.push('conversation row exists but has NO messages');

  // Roles must alternate. A site whose selectors overlap stores every user turn
  // twice (T3's nesting bug) and a site whose role test is inverted stores them all
  // as one speaker — both look fine as a count.
  const runs = msgs.filter((m, i) => i > 0 && m.role === msgs[i - 1].role).length;
  if (runs > 0) problems.push(`${runs} consecutive same-role turn(s) — duplication or role inversion`);

  if (msgs.some((m) => !m.content || !m.content.trim())) problems.push('empty message stored');

  // Paragraph welding: the detached-clone bug produced text with no blank lines at
  // all in replies long enough to need them.
  const longReplies = msgs.filter((m) => m.role === 'assistant' && m.content.length > 400);
  if (longReplies.length && longReplies.every((m) => !/\n\s*\n/.test(m.content) && !/\n/.test(m.content))) {
    problems.push('long replies contain no line breaks — paragraphs may be welded together');
  }

  for (const pat of LEAKS[site.key] || []) {
    const hit = msgs.find((m) => (pat instanceof RegExp ? pat.test(m.content) : m.content.includes(pat)));
    if (hit) problems.push(`leak: ${pat} — found in a ${hit.role} turn`);
  }

  const u = msgs.filter((m) => m.role === 'user').length;
  const a = msgs.filter((m) => m.role === 'assistant').length;
  const summary = `${msgs.length} msgs (${u}u/${a}a)`;

  // A one-sided conversation is what a selector matching NOTHING looks like, and the
  // alternation check above cannot see it: with one message there are no consecutive
  // runs to find. Character.AI legitimately produces 0u/1a — the character speaks
  // first and the user may not have replied — so this warns rather than fails, but it
  // must not pass in silence. That distinction is the whole reason this file reads
  // text instead of counts.
  if (msgs.length && (u === 0 || a === 0)) {
    warnings.push(
      `one-sided: ${u} user / ${a} assistant turn(s). Real if the chat genuinely has ` +
      `only an opening message; identical to a selector that matched nothing otherwise. ` +
      `Check the text above before trusting it.`,
    );
  }

  if (problems.length) {
    failures++;
    console.log(`  ✗  ${site.label.padEnd(14)} ${summary}  "${(conv.title || '').slice(0, 34)}"`);
    for (const p of problems) console.log(`       ${p}`);
  } else if (warnings.length) {
    console.log(`  ?  ${site.label.padEnd(14)} ${summary}  "${(conv.title || '').slice(0, 34)}"`);
    for (const w of warnings) console.log(`       ${w}`);
  } else {
    console.log(`  ✓  ${site.label.padEnd(14)} ${summary}  "${(conv.title || '').slice(0, 34)}"`);
  }
}

const saved = checked;
const pending = sites.length - saved - (want.length ? sites.length - want.length : 0);
console.log(
  `\n${saved}/${want.length || sites.length} checked, ${failures} failing` +
  (pending > 0 && !want.length ? `, ${sites.length - saved} not saved yet` : ''),
);
if (!existsSync(GW)) console.log('gateway.db not found — is this the repo root?');
process.exit(failures ? 1 : 0);
