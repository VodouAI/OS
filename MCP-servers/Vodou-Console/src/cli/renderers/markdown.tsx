/**
 * markdown.tsx — dependency-free, Ink-native markdown + syntax + hyperlink rendering
 * for the TUI's assistant text.
 *
 * WHY no deps: per CLAUDE.md, `npm install <name>` inside MCP-servers/* can prune the
 * vendored @vodou/* links, so we hand-roll instead of pulling ink-markdown/cli-highlight.
 *
 * WHY Ink-native (parse → <Text> elements, not ANSI strings): Ink measures text width for
 * its layout; raw ANSI/OSC escapes in a string can throw off wrapping. Parsing to <Text>
 * with props keeps Ink in control. (OSC 8 link escapes ARE safe to embed because Ink's
 * width math goes through string-width→strip-ansi, which strips OSC sequences — verified
 * those libs are present.)
 *
 * Classification is PER LINE with an explicit code-fence flag threaded by the caller — the
 * TUI commits one line at a time into <Static> (the scrollback fix), so the renderer never
 * sees a whole block at once. classifyLine() returns the next fence state to thread along.
 */

import React from 'react';
import { Text } from 'ink';

export interface Seg {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;     // inline `code` span → cyan
  href?: string;      // hyperlink target
  color?: string;     // explicit color (syntax highlighting)
}

export type MdLine =
  | { kind: 'fence'; raw: string }
  | { kind: 'code'; segs: Seg[] }
  | { kind: 'header'; level: number; segs: Seg[] }
  | { kind: 'text'; segs: Seg[] };

// ─── OSC 8 hyperlinks ────────────────────────────────────────────────────────
const OSC = ']8;;';
const BEL = '';
function osc8(url: string, label: string): string { return `${OSC}${url}${BEL}${label}${OSC}${BEL}`; }

/** Conservative capability check — emit clickable escapes only where they're known to work,
 *  otherwise fall back to visible `text (url)`. Terminal.app lacks OSC 8 (auto-links bare
 *  URLs for ⌘-click instead), so it falls through to the readable fallback. */
export function supportsHyperlinks(): boolean {
  if (process.env.VODOU_TUI_NO_LINKS === '1') return false;
  if (process.env.FORCE_HYPERLINK && process.env.FORCE_HYPERLINK !== '0') return true;
  const tp = process.env.TERM_PROGRAM;
  if (tp === 'iTerm.app' || tp === 'WezTerm' || tp === 'Hyper' || tp === 'vscode') return true;
  if (process.env.KITTY_WINDOW_ID) return true;
  if (process.env.VTE_VERSION && Number(process.env.VTE_VERSION) >= 5000) return true;
  return false;
}

// ─── inline parsing ──────────────────────────────────────────────────────────
// Trailing punctuation is excluded so "see https://x.io." doesn't swallow the period.
const BARE_URL = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g;

/** Split a plain-text run, turning bare http(s) URLs into href segments. */
function linkifyBare(text: string): Seg[] {
  const segs: Seg[] = [];
  const re = new RegExp(BARE_URL);
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ text: text.slice(last, m.index) });
    segs.push({ text: m[0], href: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ text: text.slice(last) });
  return segs.length ? segs : (text ? [{ text }] : []);
}

// Precedence: inline code > [label](url) link > **bold** > *italic*. Underscore-italic is
// intentionally NOT supported — it false-fires on snake_case identifiers in technical text.
const INLINE = /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)/g;

export function parseInline(input: string): Seg[] {
  const segs: Seg[] = [];
  const re = new RegExp(INLINE);
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    if (m.index > last) segs.push(...linkifyBare(input.slice(last, m.index)));
    const tok = m[0];
    if (m[1]) segs.push({ text: tok.slice(1, -1), code: true });
    else if (m[2]) {
      const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (mm) segs.push({ text: mm[1], href: mm[2] }); else segs.push({ text: tok });
    } else if (m[3]) segs.push({ text: tok.slice(2, -2), bold: true });
    else if (m[4]) segs.push({ text: tok.slice(1, -1), italic: true });
    last = m.index + tok.length;
  }
  if (last < input.length) segs.push(...linkifyBare(input.slice(last)));
  return segs.length ? segs : [{ text: input }];
}

// ─── lightweight, language-agnostic code highlighting ────────────────────────
// NOT a full grammar-aware highlighter (that needs a per-language lexer / Highlight.js).
// A generic pass: string literals, line comments, numbers, and a common keyword set — enough
// to read as "highlighted code" across JS/TS/PY/RS/SH without claiming per-language accuracy.
const KEYWORDS = new Set(
  ('const let var function return if else for while do switch case break continue import from export ' +
   'default class new extends await async try catch finally throw typeof instanceof type interface enum ' +
   'public private protected static def fn pub use mod match struct impl trait where self super void int ' +
   'float double bool str string boolean true false null undefined nil None True False and or not in is ' +
   'lambda yield with as pass raise elif print echo func package go defer chan map range').split(' ')
);
const CODE_TOK = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|((?:\/\/|#|--).*$)|(\b\d[\d_.eExXabcdefABCDEF]*\b)|([A-Za-z_]\w*)/g;

function highlightCode(line: string): Seg[] {
  const segs: Seg[] = [];
  try {
    const re = new RegExp(CODE_TOK);
    let last = 0; let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      if (m.index > last) segs.push({ text: line.slice(last, m.index) });   // punctuation/space: default fg
      if (m[1]) segs.push({ text: m[0], color: 'green' });                  // string literal
      else if (m[2]) segs.push({ text: m[0], color: 'gray', italic: true });// line comment
      else if (m[3]) segs.push({ text: m[0], color: 'yellow' });            // number
      else if (m[4]) segs.push(KEYWORDS.has(m[0]) ? { text: m[0], color: 'magenta' } : { text: m[0] });
      last = m.index + m[0].length;
    }
    if (last < line.length) segs.push({ text: line.slice(last) });
  } catch {
    return [{ text: line, color: 'gray' }];   // never let highlighting throw
  }
  return segs.length ? segs : [{ text: line, color: 'gray' }];
}

// ─── line classification (threads code-fence state) ──────────────────────────
export function classifyLine(line: string, inFence: boolean): { md: MdLine; nextFence: boolean } {
  if (/^\s*```/.test(line)) return { md: { kind: 'fence', raw: line }, nextFence: !inFence };
  if (inFence) return { md: { kind: 'code', segs: highlightCode(line) }, nextFence: inFence };

  const h = line.match(/^(#{1,6})\s+(.*)$/);
  if (h) return { md: { kind: 'header', level: h[1].length, segs: parseInline(h[2]) }, nextFence: inFence };

  // bullets → •, then blockquote gutter
  const bulleted = line.replace(/^(\s*)[-*+]\s+/, '$1• ');
  const bq = bulleted.match(/^(\s*)>\s?(.*)$/);
  if (bq) {
    return {
      md: { kind: 'text', segs: [{ text: `${bq[1]}▏ `, color: 'gray' }, ...parseInline(bq[2]).map((s) => ({ color: 'gray', ...s }))] },
      nextFence: inFence,
    };
  }
  return { md: { kind: 'text', segs: parseInline(bulleted) }, nextFence: inFence };
}

// ─── rendering ───────────────────────────────────────────────────────────────
function SegView({ s }: { s: Seg }): React.ReactElement {
  if (s.href) {
    const label = s.text;
    if (supportsHyperlinks()) return <Text underline color="blue">{osc8(s.href, label)}</Text>;
    // Fallback keeps the URL visible + copyable where OSC 8 isn't supported.
    return <Text underline color="blue">{label === s.href ? label : `${label} (${s.href})`}</Text>;
  }
  const color = s.code ? 'cyan' : s.color;
  return <Text bold={s.bold} italic={s.italic} color={color}>{s.text}</Text>;
}

/** Render one classified markdown line as Ink elements. */
export function MdView({ md }: { md: MdLine }): React.ReactElement {
  if (md.kind === 'fence') return <Text color="gray">{md.raw}</Text>;
  if (md.kind === 'code') return <Text>{md.segs.map((s, i) => <SegView key={i} s={s} />)}</Text>;
  if (md.kind === 'header') {
    return <Text>{md.segs.map((s, i) => <SegView key={i} s={{ ...s, bold: true, color: s.href ? undefined : (s.color ?? 'cyan') }} />)}</Text>;
  }
  // plain text — preserve blank lines at full height (paragraph breaks)
  if (!md.segs.length || (md.segs.length === 1 && md.segs[0].text === '')) return <Text> </Text>;
  return <Text>{md.segs.map((s, i) => <SegView key={i} s={s} />)}</Text>;
}
