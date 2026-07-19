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
