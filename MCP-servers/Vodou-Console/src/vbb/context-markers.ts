/**
 * PLAN-MEMORY-FOLLOWS-YOU — the injected-context markers and their strip.
 *
 * `vodou-core mem context` is the ONLY producer of these blocks; this module
 * is the gateway-side strip so transcripts persisted by the capture lanes
 * (handleCaptureTurn — netcap + manual clips) never store an echoed block.
 * The Rust extractor has its own belt-and-suspenders strip at row-load time
 * (gateway_extractor::strip_vodou_context) so nothing marker-fenced can ever
 * become memory, whichever lane carried it. Keep the markers in sync with
 * src/main.rs (VODOU_CONTEXT_OPEN/CLOSE).
 *
 * Version-tolerant: matches the open PREFIX (not "v1"). An unterminated
 * block drops the remainder (fail closed — better to lose a tail than to
 * distil leaked context).
 */

const OPEN_PREFIX = '⟦vodou:context';
const CLOSE = '⟦/vodou:context⟧';

/** The fence as written — src/main.rs VODOU_CONTEXT_OPEN/CLOSE, spelled once for TS. */
export const VODOU_CONTEXT_OPEN = '⟦vodou:context v1⟧';
export const VODOU_CONTEXT_CLOSE = CLOSE;

/**
 * Fence a block of Vodou's own injected context. A second producer besides
 * `mem context` since 2026-09-14: the CLI families carry memory on the USER
 * prompt, which the child's hook hands back to the daemon — and the daemon's
 * search-query cleaner (`clean_prompt_for_search`) strips exactly this fence,
 * so memory never becomes the query for more memory.
 */
export function wrapVodouContext(text: string): string {
  return `${VODOU_CONTEXT_OPEN}\n${text}\n${VODOU_CONTEXT_CLOSE}`;
}

export function stripVodouContext(text: string): string {
  if (!text || !text.includes(OPEN_PREFIX)) return text;
  let out = '';
  let rest = text;
  for (;;) {
    const i = rest.indexOf(OPEN_PREFIX);
    if (i === -1) {
      out += rest;
      break;
    }
    out += rest.slice(0, i);
    const j = rest.indexOf(CLOSE, i + OPEN_PREFIX.length);
    if (j === -1) break; // unterminated — drop remainder
    rest = rest.slice(j + CLOSE.length);
  }
  return out.trim();
}
