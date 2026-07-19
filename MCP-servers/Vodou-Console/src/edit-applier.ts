/**
 * edit-applier.ts — model-agnostic forgiving edit applier (PLAN 0.6.4 #8 Bet-1.1).
 *
 * Pure string logic, NO filesystem / IO (fs-sandbox.ts owns confinement + atomic
 * write). This is "the differentiator": weak/cheap models (Qwen/DeepSeek/Kimi)
 * routinely get whitespace, indentation, and line-number details slightly wrong in
 * an `old_string`; requiring a byte-exact match turns those into hard edit failures
 * (Aider: removing flexible apply ⇒ ~9× more edit errors). So instead of one exact
 * compare we run a CONFIDENCE LADDER, highest-confidence first, and stop at the first
 * tier that yields a UNIQUE match:
 *
 *   1. exact                — verbatim substring (unique)
 *   2. line-number-stripped — drop stray "12: " / "12 | " prefixes the model echoed
 *   3. trailing-whitespace  — ignore trailing ws per line (line-aligned block)
 *   4. indent-flexible      — ignore leading indent; RE-INDENT new_string to the file
 *   5. fuzzy                — normalized-Levenshtein ≥ threshold, uniquely best, bounded
 *
 * Ambiguity is a hard error (never guess which of N spots to edit). `replace_all`
 * stays strictly exact/literal (you cannot fuzzily replace "all").
 */

export type EditErrorCode = 'no_match' | 'ambiguous' | 'bad_arg' | 'overlap';

export class EditError extends Error {
  code: EditErrorCode;
  constructor(code: EditErrorCode, message: string) {
    super(message);
    this.name = 'EditError';
    this.code = code;
  }
}

export interface ApplyOptions {
  replaceAll?: boolean;
  /** optional 1-based line hint to disambiguate when relaxed tiers find >1 candidate */
  startLine?: number;
}

export interface ApplyResult {
  updated: string;
  replacements: number;
  /** which ladder tier matched — surfaced to the model/user so a fuzzy edit is visible */
  strategy: string;
}

// Fuzzy tuning + guards.
const FUZZY_THRESHOLD = 0.9; // min normalized similarity to accept a fuzzy match
const FUZZY_MARGIN = 0.05; // best must beat the runner-up by this, else ambiguous
const FUZZY_MAX_FILE_LINES = 4000; // skip fuzzy on very large files (perf guard)
const FUZZY_MAX_SEARCH_LINES = 200;
const FUZZY_FIRSTLINE_PRUNE = 0.6; // only score windows whose first line is ≥ this similar

export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  opts: ApplyOptions = {},
): ApplyResult {
  const spans = computeSpans(content, oldString, newString, opts);
  return { updated: applySpans(content, spans), replacements: spans.length, strategy: spans[0].strategy };
}

/** One edit in a multi_edit call. */
export interface EditOp {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export interface MultiApplyResult {
  updated: string;
  edits: Array<{ replacements: number; strategy: string }>;
  totalReplacements: number;
}

/**
 * Apply MANY edits atomically + ORDER-INVARIANTLY. Every edit's span(s) are resolved
 * against the ORIGINAL content (not a progressively-mutated copy), so the order the
 * model emits hunks in is irrelevant and applying them can't shift each other's match
 * positions. Cross-edit overlaps are a hard error, and a no-match/ambiguous in ANY
 * edit throws before a single byte is written → all-or-nothing.
 */
const MAX_MULTI_EDITS = 100; // hard cap — bound per-call ladder/fuzzy work

export function applyMultiEdit(content: string, edits: EditOp[]): MultiApplyResult {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new EditError('bad_arg', 'edits must be a non-empty array');
  }
  if (edits.length > MAX_MULTI_EDITS) {
    throw new EditError('bad_arg', `too many edits (${edits.length} > ${MAX_MULTI_EDITS}) — split into multiple calls`);
  }
  const tagged: Array<ResolvedSpan & { editIndex: number }> = [];
  edits.forEach((e, idx) => {
    let spans: ResolvedSpan[];
    try {
      spans = computeSpans(content, e.oldString, e.newString, { replaceAll: e.replaceAll });
    } catch (err) {
      if (err instanceof EditError) throw new EditError(err.code, `edit[${idx}]: ${err.message}`);
      throw err;
    }
    for (const s of spans) tagged.push({ ...s, editIndex: idx });
  });

  // Overlap detection across ALL edits' spans (resolved against the same original).
  const byStart = [...tagged].sort((a, b) => a.start - b.start);
  for (let i = 1; i < byStart.length; i++) {
    if (byStart[i].start < byStart[i - 1].end) {
      throw new EditError('overlap', `edit[${byStart[i - 1].editIndex}] and edit[${byStart[i].editIndex}] target overlapping regions`);
    }
  }

  return {
    updated: applySpans(content, tagged),
    edits: edits.map((_, i) => {
      const mine = tagged.filter((s) => s.editIndex === i);
      return { replacements: mine.length, strategy: mine[0]?.strategy ?? 'exact' };
    }),
    totalReplacements: tagged.length,
  };
}

interface ResolvedSpan { start: number; end: number; replacement: string; strategy: string }

/** Resolve an edit to its replacement span(s) against `content` (no mutation). */
function computeSpans(content: string, oldString: string, newString: string, opts: ApplyOptions): ResolvedSpan[] {
  if (typeof oldString !== 'string' || oldString.length === 0) {
    throw new EditError('bad_arg', 'old_string is required and must be non-empty');
  }
  const newStr = typeof newString === 'string' ? newString : '';
  // replace_all: strictly literal (no $-expansion, no fuzzy), every non-overlapping hit.
  if (opts.replaceAll) {
    const idxs = allIndexOf(content, oldString);
    if (idxs.length === 0) throw new EditError('no_match', 'old_string not found in file');
    return idxs.map((i) => ({ start: i, end: i + oldString.length, replacement: newStr, strategy: 'exact' }));
  }
  const m = resolveSpan(content, oldString, opts.startLine);
  const replacement = m.indentDelta ? reindent(newStr, m.indentDelta) : newStr;
  return [{ start: m.start, end: m.end, replacement, strategy: m.strategy }];
}

/** Splice spans into content. Spans MUST be non-overlapping; applied high→low so
 *  earlier (higher-offset) replacements never shift the offsets of later (lower) ones. */
function applySpans(content: string, spans: ResolvedSpan[]): string {
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  let out = content;
  for (const s of sorted) out = out.slice(0, s.start) + s.replacement + out.slice(s.end);
  return out;
}

// ── span resolution ───────────────────────────────────────────────────────────

interface Span { start: number; end: number; strategy: string; indentDelta?: string }
interface LineInfo { text: string; start: number; end: number } // end = offset just past the line text (before its '\n')

function resolveSpan(content: string, search: string, startLine?: number): Span {
  // 1. exact (unique, or startLine-disambiguated)
  {
    const idxs = allIndexOf(content, search);
    if (idxs.length === 1) return { start: idxs[0], end: idxs[0] + search.length, strategy: 'exact' };
    if (idxs.length > 1) {
      const pick = pickIdxByStartLine(content, idxs, startLine);
      if (pick != null) return { start: pick, end: pick + search.length, strategy: 'exact' };
      throw ambiguous(idxs.length);
    }
  }

  // 2. strip stray line-number prefixes, retry exact
  const deNum = stripLineNumberPrefixes(search);
  if (deNum !== search && deNum.length > 0) {
    const idxs = allIndexOf(content, deNum);
    if (idxs.length === 1) return { start: idxs[0], end: idxs[0] + deNum.length, strategy: 'line-number-stripped' };
    if (idxs.length > 1) {
      const pick = pickIdxByStartLine(content, idxs, startLine);
      if (pick != null) return { start: pick, end: pick + deNum.length, strategy: 'line-number-stripped' };
      throw ambiguous(idxs.length);
    }
  }

  // Line-aligned relaxed tiers operate on the search block minus a single trailing newline.
  const searchBody = search.endsWith('\n') ? search.slice(0, -1) : search;
  const searchLines = searchBody.split('\n');
  const lines = splitWithOffsets(content);

  // 3. trailing-whitespace-insensitive (unique window)
  {
    const w = uniqueWindow(lines, searchLines, startLine, (a, b) => rtrim(a) === rtrim(b));
    if (w) return { start: w.start, end: w.end, strategy: 'trailing-ws' };
  }

  // 4. indent-flexible: match on trimmed content, then RE-INDENT new_string by the
  //    delta between the file's actual indent and old_string's indent.
  {
    const w = uniqueWindow(lines, searchLines, startLine, (a, b) => a.trim() === b.trim());
    if (w) {
      const fileIndent = leadingWs(lines[w.lineIdx].text);
      const searchIndent = leadingWs(searchLines[0]);
      const delta = indentDelta(searchIndent, fileIndent);
      return { start: w.start, end: w.end, strategy: 'indent-flexible', indentDelta: delta };
    }
  }

  // 5. fuzzy (bounded, anchored, uniquely-best)
  const f = fuzzyWindow(lines, searchLines, startLine);
  if (f) {
    const fileIndent = leadingWs(lines[f.lineIdx].text);
    const searchIndent = leadingWs(searchLines[0]);
    return { start: f.start, end: f.end, strategy: `fuzzy(${f.score.toFixed(2)})`, indentDelta: indentDelta(searchIndent, fileIndent) };
  }

  throw new EditError('no_match', 'old_string not found (tried exact, line-number, whitespace, indent, and fuzzy matching)');
}

function ambiguous(n: number): EditError {
  return new EditError('ambiguous', `old_string matches ${n} places — include more surrounding context to make it unique, or pass replace_all:true`);
}

// ── line-window matching ────────────────────────────────────────────────────────

interface WindowMatch { start: number; end: number; lineIdx: number }

/**
 * Find the UNIQUE window of consecutive content lines (length = searchLines.length)
 * where every line pair satisfies `eq`. Returns null if none; throws `ambiguous`
 * if >1 — unless a startLine hint picks exactly one of them.
 */
function uniqueWindow(
  lines: LineInfo[],
  searchLines: string[],
  startLine: number | undefined,
  eq: (contentLine: string, searchLine: string) => boolean,
): WindowMatch | null {
  const n = searchLines.length;
  if (n === 0 || n > lines.length) return null;
  const hits: WindowMatch[] = [];
  for (let i = 0; i + n <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (!eq(lines[i + j].text, searchLines[j])) { ok = false; break; }
    }
    if (ok) hits.push({ start: lines[i].start, end: lines[i + n - 1].end, lineIdx: i });
  }
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];
  const picked = disambiguateByStartLine(hits, startLine);
  if (picked) return picked;
  throw ambiguous(hits.length);
}

function disambiguateByStartLine(hits: WindowMatch[], startLine?: number): WindowMatch | null {
  if (!startLine || startLine < 1) return null;
  const target = startLine - 1; // to 0-based line index
  const exact = hits.filter((h) => h.lineIdx === target);
  return exact.length === 1 ? exact[0] : null;
}

// ── fuzzy ─────────────────────────────────────────────────────────────────────

function fuzzyWindow(lines: LineInfo[], searchLines: string[], startLine?: number): (WindowMatch & { score: number }) | null {
  const n = searchLines.length;
  if (n === 0 || n > lines.length) return null;
  if (lines.length > FUZZY_MAX_FILE_LINES || n > FUZZY_MAX_SEARCH_LINES) return null; // perf guard
  const searchNorm = searchLines.map(normalizeLine);
  const searchJoined = searchNorm.join('\n');
  if (searchJoined.length === 0) return null;
  const firstSearch = searchNorm[0];

  const cands: Array<WindowMatch & { score: number }> = [];
  for (let i = 0; i + n <= lines.length; i++) {
    // cheap prune: first line must be roughly similar before we pay for the block score
    if (similarity(normalizeLine(lines[i].text), firstSearch) < FUZZY_FIRSTLINE_PRUNE) continue;
    const windowJoined = lines.slice(i, i + n).map((l) => normalizeLine(l.text)).join('\n');
    const score = similarity(windowJoined, searchJoined);
    if (score >= FUZZY_THRESHOLD) cands.push({ start: lines[i].start, end: lines[i + n - 1].end, lineIdx: i, score });
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => b.score - a.score);

  // A startLine hint is authoritative: if exactly one above-threshold candidate
  // begins on that line, take it (resolves ties the margin rule would reject).
  if (startLine && startLine >= 1) {
    const onLine = cands.filter((c) => c.lineIdx === startLine - 1);
    if (onLine.length === 1) return onLine[0];
  }
  // Otherwise require the best to clearly beat the runner-up — never guess between near-ties.
  if (cands.length === 1) return cands[0];
  return cands[0].score - cands[1].score >= FUZZY_MARGIN ? cands[0] : null;
}

/** normalized similarity in [0,1] via Levenshtein on whitespace-collapsed text. */
function similarity(a: string, b: string): number {
  const x = a.replace(/\s+/g, ' ').trim();
  const y = b.replace(/\s+/g, ' ').trim();
  if (x === y) return 1;
  const max = Math.max(x.length, y.length);
  if (max === 0) return 1;
  return 1 - levenshtein(x, y) / max;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[n];
}

// ── small helpers ───────────────────────────────────────────────────────────────

/** 1-based line number containing char offset `off`. */
function offsetToLine(content: string, off: number): number {
  let line = 1;
  for (let i = 0; i < off && i < content.length; i++) if (content[i] === '\n') line++;
  return line;
}

/** From multiple match offsets, pick the one starting on `startLine` (1-based) iff exactly one does. */
function pickIdxByStartLine(content: string, idxs: number[], startLine?: number): number | null {
  if (!startLine || startLine < 1) return null;
  const on = idxs.filter((i) => offsetToLine(content, i) === startLine);
  return on.length === 1 ? on[0] : null;
}

function allIndexOf(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = hay.indexOf(needle);
  while (i !== -1) { out.push(i); i = hay.indexOf(needle, i + needle.length); }
  return out;
}

/** Build per-line text + char offsets. `end` is the offset just past the line text. */
function splitWithOffsets(content: string): LineInfo[] {
  const out: LineInfo[] = [];
  let start = 0;
  for (let i = 0; i <= content.length; i++) {
    if (i === content.length || content[i] === '\n') {
      out.push({ text: content.slice(start, i), start, end: i });
      start = i + 1;
      if (i === content.length) break;
    }
  }
  return out;
}

/** Strip leading line-number gutters like "12: ", "  12 | ", "12\t" from each line. */
function stripLineNumberPrefixes(s: string): string {
  const lines = s.split('\n');
  let any = false;
  const out = lines.map((ln) => {
    const m = ln.match(/^\s*\d+\s*(?:[:|\t]|│)\s?/); // "12:", "12 |", "12\t", "12 │"
    if (m) { any = true; return ln.slice(m[0].length); }
    return ln;
  });
  return any ? out.join('\n') : s;
}

function rtrim(s: string): string { return s.replace(/[ \t]+$/, ''); }
function leadingWs(s: string): string { const m = s.match(/^[ \t]*/); return m ? m[0] : ''; }
function normalizeLine(s: string): string { return s.trim(); }

/**
 * Indentation delta to apply to new_string: the difference between the file's actual
 * indent and the indent the model used in old_string's first line. Returns a string
 * to PREPEND to each non-empty new line (positive delta), or a count of chars to
 * STRIP encoded as a negative-prefixed sentinel handled by reindent().
 */
function indentDelta(searchIndent: string, fileIndent: string): string | undefined {
  if (searchIndent === fileIndent) return undefined;
  // Only re-indent for a clean PREFIX relationship, which preserves the relative
  // indentation BETWEEN new_string's lines (add/strip a common prefix to all):
  //   ADD:<str>  — file is more indented; prepend the extra prefix to each line
  //   STRIP:<n>  — file is less indented; remove up to n leading ws chars per line
  if (fileIndent.startsWith(searchIndent)) return 'ADD:' + fileIndent.slice(searchIndent.length);
  if (searchIndent.startsWith(fileIndent)) return 'STRIP:' + (searchIndent.length - fileIndent.length);
  // Non-prefix (mixed tabs/spaces) — any uniform re-indent would FLATTEN a multi-line
  // new_string's relative indentation (silent corruption). Apply new_string verbatim
  // (the model wrote it to match its own old_string indentation) — safer than guessing.
  return undefined;
}

function reindent(text: string, delta: string): string {
  if (!delta) return text;
  const lines = text.split('\n');
  if (delta.startsWith('ADD:')) {
    const pad = delta.slice(4);
    return lines.map((l) => (l.length ? pad + l : l)).join('\n');
  }
  if (delta.startsWith('STRIP:')) {
    const n = parseInt(delta.slice(6), 10) || 0;
    return lines.map((l) => stripLeading(l, n)).join('\n');
  }
  return text;
}

function stripLeading(line: string, n: number): string {
  let i = 0;
  while (i < n && i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return line.slice(i);
}
