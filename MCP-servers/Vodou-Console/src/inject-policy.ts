/**
 * inject-policy.ts — the external-disclosure policy, enforced on the gateway side.
 *
 * WHY THIS EXISTS (PLAN-FACE-OWNS-SKILLS F2). The policy in `.vodou/inject-config.json`
 * — `scope_deny` and `leak_needles` — was written for `vodou-core mem context`, and the
 * Rust side (src/inject_select.rs) is the only place that enforced it. The Face lanes
 * replaced `mem context` with a full agentic `chat()` turn whose memory arrives over the
 * daemon socket UNFILTERED. So the guarantee "Vodou's own dev/telemetry/skill-
 * deliberation content never travels to a third-party AI" silently stopped holding for
 * exactly the path that sends text to ChatGPT.
 *
 * This module restores it in TypeScript, deliberately mirroring the Rust semantics
 * rather than inventing new ones (see scopeDenied) so the two layers agree. The config
 * file stays the single source of truth: a new denied scope is added in ONE place and
 * both layers get it.
 *
 * Scoped to the FACE lanes only (panel:/brainctx:). The web console is the user's own
 * surface — filtering their skill/workbench memory out of their own console would be
 * removing capability, not protecting anything.
 */

import { readFileSync, statSync } from 'fs';
import path from 'path';

export interface InjectPolicy {
  scope_deny: string[];
  leak_needles: string[];
}

// Matches src/inject_select.rs def_scope_deny / def_leak_needles, used when the file
// is missing so the guard fails CLOSED on the scopes that matter.
const DEFAULTS: InjectPolicy = {
  scope_deny: ['capture:ide:', 'skill', 'workbench:'],
  leak_needles: [],
};

let _cache: { at: number; mtimeMs: number; policy: InjectPolicy } | null = null;
const RELOAD_MS = 5000;

/**
 * Read the live policy. The file is documented as editable without a restart, so this
 * re-reads on mtime change (cheap stat, 5s floor) rather than caching for the process.
 */
export function loadInjectPolicy(projectRoot: string): InjectPolicy {
  const file = path.join(projectRoot, '.vodou', 'inject-config.json');
  try {
    const st = statSync(file);
    if (_cache && _cache.mtimeMs === st.mtimeMs && Date.now() - _cache.at < RELOAD_MS) {
      return _cache.policy;
    }
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const policy: InjectPolicy = {
      scope_deny: Array.isArray(raw.scope_deny) ? raw.scope_deny.map(String) : DEFAULTS.scope_deny,
      leak_needles: Array.isArray(raw.leak_needles) ? raw.leak_needles.map(String) : [],
    };
    _cache = { at: Date.now(), mtimeMs: st.mtimeMs, policy };
    return policy;
  } catch {
    return DEFAULTS;   // no config → still deny the built-in system scopes
  }
}

/**
 * Port of inject_select.rs::scope_denied — a trailing ':' is a PREFIX match, a bare
 * name is an EXACT match. Keeping the two implementations identical matters: a config
 * entry that means one thing in Rust and another here is worse than no guard.
 */
export function scopeDenied(scope: string, policy: InjectPolicy): boolean {
  const s = String(scope || '');
  return policy.scope_deny.some((d) => (d.endsWith(':') ? s.startsWith(d) : s === d));
}

/** Port of inject_select.rs::is_leak — case-insensitive substring match. */
export function isLeak(text: string, policy: InjectPolicy): boolean {
  const t = String(text || '').toLowerCase();
  return policy.leak_needles.some((n) => t.includes(n.toLowerCase()));
}

/**
 * Remove denied chunks from the daemon's `additional_context` block.
 *
 * The block is a formatted text list (`- [path] snippet`); the structured
 * `memory_recall_debug.results[]` alongside it carries `chunk_scope` + `text` per
 * chunk. We match on the chunk's own text, so a line is dropped for what it IS rather
 * than where it appeared to come from.
 */
export function filterMemoryContext(
  additionalContext: string,
  debugResults: Array<{ chunk_scope?: string; text?: string }> | null | undefined,
  policy: InjectPolicy,
): { text: string; removed: number; scopes: string[] } {
  const ctx = String(additionalContext || '');
  if (!ctx.trim()) return { text: ctx, removed: 0, scopes: [] };

  const banned: string[] = [];
  const scopes = new Set<string>();
  for (const r of debugResults || []) {
    const scope = String(r?.chunk_scope || '');
    const text = String(r?.text || '').trim();
    if (!text) continue;
    if (scopeDenied(scope, policy) || isLeak(text, policy)) {
      banned.push(text);
      if (scope) scopes.add(scope);
    }
  }
  if (!banned.length) return { text: ctx, removed: 0, scopes: [] };

  // Drop any line carrying a banned chunk's text. Compare on a normalised form so
  // the daemon's own truncation/whitespace doesn't let a denied chunk slip through.
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const bannedNorm = banned.map(norm).filter((b) => b.length > 12); // too-short = unsafe to match on
  let removed = 0;
  const kept = ctx.split('\n').filter((line) => {
    if (!line.trim().startsWith('- [')) return true;      // only memory lines are subject to this
    const ln = norm(line);
    const hit = bannedNorm.some((b) => ln.includes(b) || b.includes(norm(line.replace(/^- \[[^\]]*\]\s*/, ''))));
    if (hit) removed++;
    return !hit;
  });

  return { text: kept.join('\n'), removed, scopes: [...scopes] };
}

/**
 * Last line of defence on text about to LEAVE for a third-party model: drop any
 * paragraph carrying a reasoning-leak phrase. Paragraph-level, not whole-text, so one
 * stray sentence doesn't discard an otherwise good answer.
 */
export function stripLeaks(text: string, policy: InjectPolicy): string {
  if (!policy.leak_needles.length) return text;
  const parts = String(text || '').split(/\n\s*\n/);
  const kept = parts.filter((p) => !isLeak(p, policy));
  return (kept.length ? kept : parts).join('\n\n').trim();
}
