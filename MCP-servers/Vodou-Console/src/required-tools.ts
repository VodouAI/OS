/**
 * required-tools.ts — PLAN-ALPHA F3: make `skills_meta.required_tools` a contract.
 *
 * It was advisory metadata the UI displayed and nothing read at run time. A
 * scheduled skill could declare six tools, call none of them, and report `ok` —
 * which is how `daily-competitor-intel` produced 0 bytes on 2026-08-19 while the
 * old free-text log said `ok (skill_id=7, 0 chars)`.
 *
 * Two independent wins from the same declaration:
 *
 *   1. FAIL BEFORE SPENDING. A skill naming a tool that no longer resolves (a
 *      deregistered server, a renamed tool, a revoked integration) is a broken
 *      skill. Discovering that after a multi-minute LLM turn wastes the turn and
 *      buries the cause in prose. Resolve first, refuse to fire, say which tool.
 *
 *   2. BOUND THE TURN. Passing the resolved set as the turn's allowlist takes
 *      tool selection from 1-of-942 to 1-of-6 — and, because the bound is read
 *      from the DB before the model sees any content, an instruction injected
 *      into a fetched page cannot reach a tool the author never declared.
 *      ("Reads broad, writes narrow" — PLAN-WHAT-IS-THE-PRODUCT §6A.4b.)
 *
 * NOT declaring anything stays legal and unrestricted. Two of the four live
 * agents declare nothing, and a skill must never be punished for that — the
 * contract binds what it promises, it does not invent promises.
 */

import type { DatabaseSync as DB } from 'node:sqlite';

export interface ResolvedRequiredTools {
  /** `server/tool` strings as declared, in declaration order. */
  declared: string[];
  /** Declared entries with no active server+tool row behind them. */
  missing: string[];
  /** True when the skill declared nothing — unrestricted, not an error. */
  unrestricted: boolean;
}

/**
 * Parse `required_tools` leniently.
 *
 * Accepts a JSON array (how the UI writes it) or a comma/whitespace separated
 * string (how humans write it), because a skill refusing to run over a
 * formatting difference would be the contract working against its own purpose.
 * Anything unparseable is treated as "declared nothing" rather than an error:
 * a malformed field must not take a working agent offline.
 */
export function parseRequiredTools(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
  const text = String(raw).trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
    } catch { /* fall through to the separated form */ }
  }
  return text.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Resolve each declared `server/tool` against the live registry.
 *
 * `mcp_servers.active = 1` matters as much as the tool existing: a server that
 * is registered but deactivated cannot answer, and letting the skill fire
 * against it would reproduce the exact failure this gate exists to prevent.
 *
 * An entry without a `/` cannot be resolved to a server and is reported missing
 * rather than silently skipped — a typo that disables the bound is worse than a
 * typo that stops the run, because the first is invisible.
 */
export function resolveRequiredTools(coreDb: DB, raw: unknown): ResolvedRequiredTools {
  const declared = parseRequiredTools(raw);
  if (declared.length === 0) {
    return { declared: [], missing: [], unrestricted: true };
  }

  const stmt = coreDb.prepare(
    `SELECT COUNT(*) AS n
       FROM tools t
       JOIN mcp_servers s ON s.id = t.server_id
      WHERE s.name = ? AND t.name = ? AND s.active = 1`
  );

  const missing: string[] = [];
  for (const entry of declared) {
    const slash = entry.indexOf('/');
    if (slash <= 0 || slash === entry.length - 1) {
      missing.push(entry);
      continue;
    }
    const server = entry.slice(0, slash);
    const tool = entry.slice(slash + 1);
    let n = 0;
    try {
      const row = stmt.get(server, tool) as { n?: number } | undefined;
      n = Number(row?.n ?? 0);
    } catch {
      // A registry read failure is not evidence the tool is missing. Treating it
      // as missing would take every declaring skill offline the moment the DB
      // hiccups, so an unreadable registry leaves the entry resolved.
      n = 1;
    }
    if (n < 1) missing.push(entry);
  }

  return { declared, missing, unrestricted: false };
}

/**
 * Which declared tools did the turn actually call?
 *
 * `toolCalls` arrive in assorted shapes across providers, so accept a
 * `server/tool` string or an object carrying server+tool.
 */
export function summariseToolUsage(
  declared: string[],
  toolCalls: unknown[]
): { called: string[]; declaredCalled: string[]; undeclaredCalled: string[] } {
  const called: string[] = [];
  for (const c of toolCalls ?? []) {
    let label = '';
    if (typeof c === 'string') label = c;
    else if (c && typeof c === 'object') {
      const o = c as Record<string, unknown>;
      const server = o.server ?? o.serverName;
      const tool = o.tool ?? o.toolName ?? o.name;
      if (server && tool) label = `${String(server)}/${String(tool)}`;
      else if (tool) label = String(tool);
    }
    label = label.trim();
    if (label && !called.includes(label)) called.push(label);
  }
  const declaredSet = new Set(declared);
  return {
    called,
    declaredCalled: called.filter((c) => declaredSet.has(c)),
    undeclaredCalled: called.filter((c) => !declaredSet.has(c)),
  };
}

/**
 * Does this tool name suggest it CHANGES something?
 *
 * Used only to make a dry run read-only. Deliberately a name heuristic and
 * deliberately over-eager: the cost of wrongly refusing a read during a dry run
 * is a slightly thinner preview, while the cost of wrongly allowing a write is
 * a real email sent, a real row deleted, or a real message posted by a skill the
 * author has not approved yet. Those are not comparable, so this errs toward
 * refusing.
 *
 * It is NOT a security boundary — a determined tool named `fetch_and_email`
 * slips through. The security boundary is the F3 allowlist, which is a closed
 * set read from the DB. This is a second, narrower filter applied on top of it
 * during dry runs only.
 */
/**
 * SW-9 — kept in sync with `mutation-verbs.json`, the one source, by a test.
 *
 * Three copies of this list existed and disagreed. `graph_recipe.rs`, which
 * calls itself the authority, was missing `execute`/`run`/`exec` — so
 * `execute_script` was not classified as changing anything and could be
 * auto-run from a routed query. These two TypeScript copies were missing
 * `pay`/`charge`/`publish`/`invite`/`rename`/`share`.
 *
 * A literal array rather than a file read on purpose: this module is imported
 * by the fs sandbox and the executor and must stay dependency-free. The gate is
 * `mutation-verbs.test.ts`, which fails if this drifts from the JSON.
 */
const WRITE_VERBS = [
  'add', 'archive', 'cancel', 'charge', 'connect', 'copy', 'create',
  'delete', 'exec', 'execute', 'insert', 'invite', 'kill', 'move', 'patch',
  'pay', 'post', 'publish', 'put', 'remove', 'rename', 'reply', 'run',
  'save', 'schedule', 'send', 'set', 'share', 'speak', 'store', 'update',
  'upload', 'write',
];

/**
 * Token split shared in shape with `graph_recipe.rs::is_side_effecting` (SW-9).
 *
 * camelCase must split: the Rust side handled `postMessage` and `sendEmail`
 * explicitly and these copies did not, so the same tool name classified
 * differently depending on which side asked. Splitting on the lower->upper
 * boundary before lowercasing makes both agree without a second rule.
 */
function mutationTokens(tool: string): string[] {
  return tool
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function looksLikeWrite(tool: string): boolean {
  // Match on token boundaries so `update_event`, `event.update` and
  // `postMessage` all hit while `posting_frequency` and `created_at` (nouns)
  // do not.
  const tokens = mutationTokens(tool);
  return WRITE_VERBS.some((v) => tokens.includes(v) || tokens.some((t) => t === `${v}s`));
}

/**
 * SW-7 — tell the model what it is bound to.
 *
 * `required_tools` was a refusal bound and a grade, and never an instruction.
 * Nothing in the rendered prompt named the declared tools, so the model chose
 * from whatever it could see, got refused by the allowlist, and the run closed
 * `degraded: declared N tools, called 0` — 6 of the last 12 non-success runs at
 * the time this was written (CO-7 is this defect's symptom, not a separate bug).
 *
 * Followed up 2026-09-06, after this prompt shipped: CO-7 is still happening (63
 * runs in 14 days, three of them that day), and the reason string was ALSO wrong.
 * A live example — `getting-started-pulse`, declared `exa/web_search_exa`, called
 * `Bash`, produced 1,479 chars. It did the job with a native tool instead of the
 * integration it named. "called 0" says nothing ran, which sends an operator
 * after a broken scheduler rather than a skill whose declaration and behaviour
 * disagree. `scheduler.rs` now names what was actually called.
 *
 * A bound the model cannot see is a trap, not a contract. This is the sentence
 * that turns it into one.
 *
 * It says INTEGRATION tools, precisely, because the bound is not general. The
 * first draft read "a call to anything else is refused before it runs", which is
 * false: the enforcement — `toolCallRefusal` and the PreToolUse hook — covers
 * `server/tool` and `./vodou-core call`, never the CLI's own Bash, Read or
 * WebSearch. The nine live skills that declare tools call Bash between 3 and 16
 * times per run, so an instruction the model read literally would have stopped
 * them doing legitimate work — a prompt that lies about the guard is its own
 * outage.
 *
 * Returns '' for an unrestricted skill: a skill that declared nothing must not
 * be handed a list of nothing and told to prefer it.
 */
export function declaredToolsInstruction(resolved: ResolvedRequiredTools): string {
  if (resolved.unrestricted || resolved.declared.length === 0) return '';
  const list = resolved.declared.map((t) => `  - ${t}`).join('\n');
  return (
    `\n\n<declared_tools>\n` +
    `This skill declared these INTEGRATION tools, and the turn is bound to them:\n\n` +
    `${list}\n\n` +
    `Call them as \`server/tool\`, or from a shell as ` +
    `\`./vodou-core call <server> <tool> '<json-args>'\` — both paths are bound the ` +
    `same way, so a Vodou integration that is not on the list will be refused ` +
    `either way.\n` +
    `The bound covers Vodou integrations ONLY. Your ordinary tools — Bash, Read, ` +
    `Write, Grep, WebSearch and the rest — are unaffected; use them normally.\n` +
    `If no listed integration can answer the question, say so plainly rather than ` +
    `substituting a different one.\n` +
    `</declared_tools>`
  );
}
