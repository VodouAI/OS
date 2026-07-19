#!/usr/bin/env node
/**
 * operator-guard-hook.cjs — Claude Code PreToolUse hook enforcing the
 * PLAN-OPERATOR-SURFACE §3.9 NEVER-tier command ban on the gateway's Bash lane.
 *
 * The gateway spawns claude-cli / kimi-cli with --dangerously-skip-permissions,
 * so prompt prose is the only thing standing between a confused model and
 * `vodou-core brain` (zombie spawn), live tool rediscovery (minutes of MCP
 * spawn + re-embed), or a mem drain (LLM-call loops / destructive bulk writes).
 * Prompts guide; this guard guarantees (design rule §2.4). Belt-and-suspenders:
 * the PRIMARY backstop is the vodou-core binary itself (`tools` is DB-default
 * behind --live since cb9ebcf); this regex layer catches the rest.
 *
 * Contract (same as project-jail-hook.cjs): hook JSON on stdin; exit 2 with the
 * reason on stderr blocks the call and feeds the reason back to the model;
 * exit 0 allows. Fail-open on parse errors — this is a foot-gun guard for a
 * single-user local product, not a security sandbox.
 *
 * Kill switch: VODOU_OPERATOR_GUARD=0.
 */
'use strict';

// Each entry: [regex over the Bash command string, refusal naming the alternative].
// Derives from the canonical NEVER list in PLANS/0.6.18/PLAN-OPERATOR-SURFACE.md §3.9
// — update BOTH together. `mem extract-status` is explicitly allowed (read-only Orient verb).
const DENY = [
  [/\bvodou-core\s+(all-tools|find-tool|reconnect(?:-all)?)\b/,
    'live MCP rediscovery is not a mid-turn action — use `./vodou-core list-tools-db --server <name>` (instant catalog); refresh via Capabilities UI'],
  [/\bvodou-core\s+tools\s+\S+.*--live\b/,
    'live tool rediscovery (--live) is a deliberate operator action, not mid-turn — the bare `tools <server>` DB read is fine'],
  [/\bvodou-core\s+brain\b/,
    'BrainLoader already ran for this turn; running it again spawns an unresponsive zombie subprocess — use `./vodou-core call <server> <tool>` directly'],
  [/(?:^|[;&|(]\s*)\.\/(?:oi|do|vodou)\s/,
    'the launcher spawns a full BrainLoader subprocess tree inside the gateway — use `./vodou-core call <server> <tool>` instead'],
  [/\bvodou-core\s+mem\s+(keygen|reextract|extract-gateway|extract-import|janitor|reembed|health|retrieval-bench|recall-bench|bench-extract|capture-ide|import-undo|import|scan)\b/,
    'mem drains/benches spawn LLM-call loops or bulk writes and are operator-only — mid-turn memory verbs are `mem search|get|store|similar|profile|refs` (and `mem extract-status` for ledger status)'],
  [/\bvodou-core\s+mem\s+vault\s+delete\b/,
    'vault deletion is a confirmation-gated operator action — never mid-turn'],
  [/\bvodou-core\s+mem\s+reject\b/,
    'mem reject deletes chunks and is confirmation-gated — surface the chunk to the user instead'],
];

function main() {
  if (process.env.VODOU_OPERATOR_GUARD === '0') process.exit(0);

  let raw = '';
  try {
    raw = require('fs').readFileSync(0, 'utf8');
  } catch {
    process.exit(0); // no stdin → nothing to judge
  }

  let hook;
  try {
    hook = JSON.parse(raw);
  } catch {
    process.exit(0); // unparseable → fail open
  }

  if ((hook.tool_name || hook.toolName) !== 'Bash') process.exit(0);
  const cmd = String((hook.tool_input || hook.toolInput || {}).command || '');
  if (!cmd) process.exit(0);

  for (const [re, why] of DENY) {
    if (re.test(cmd)) {
      process.stderr.write(`Operator guard: blocked NEVER-tier command mid-turn — ${why}. (PLAN-OPERATOR-SURFACE §3.9)`);
      process.exit(2);
    }
  }
  process.exit(0);
}

main();
