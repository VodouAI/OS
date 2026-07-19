import { jsx as _jsx } from "react/jsx-runtime";
import { Text } from 'ink';
// ─── OSC 8 hyperlinks ────────────────────────────────────────────────────────
const OSC = ']8;;';
const BEL = '';
function osc8(url, label) { return `${OSC}${url}${BEL}${label}${OSC}${BEL}`; }
/** Conservative capability check — emit clickable escapes only where they're known to work,
 *  otherwise fall back to visible `text (url)`. Terminal.app lacks OSC 8 (auto-links bare
 *  URLs for ⌘-click instead), so it falls through to the readable fallback. */
export function supportsHyperlinks() {
    if (process.env.VODOU_TUI_NO_LINKS === '1')
        return false;
    if (process.env.FORCE_HYPERLINK && process.env.FORCE_HYPERLINK !== '0')
        return true;
    const tp = process.env.TERM_PROGRAM;
    if (tp === 'iTerm.app' || tp === 'WezTerm' || tp === 'Hyper' || tp === 'vscode')
        return true;
    if (process.env.KITTY_WINDOW_ID)
        return true;
    if (process.env.VTE_VERSION && Number(process.env.VTE_VERSION) >= 5000)
        return true;
    return false;
}
// ─── inline parsing ──────────────────────────────────────────────────────────
// Trailing punctuation is excluded so "see https://x.io." doesn't swallow the period.
const BARE_URL = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g;
/** Split a plain-text run, turning bare http(s) URLs into href segments. */
function linkifyBare(text) {
    const segs = [];
    const re = new RegExp(BARE_URL);
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
        if (m.index > last)
            segs.push({ text: text.slice(last, m.index) });
        segs.push({ text: m[0], href: m[0] });
        last = m.index + m[0].length;
    }
    if (last < text.length)
        segs.push({ text: text.slice(last) });
    return segs.length ? segs : (text ? [{ text }] : []);
}
// Precedence: inline code > [label](url) link > **bold** > *italic*. Underscore-italic is
// intentionally NOT supported — it false-fires on snake_case identifiers in technical text.
const INLINE = /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)/g;
export function parseInline(input) {
    const segs = [];
    const re = new RegExp(INLINE);
    let last = 0;
    let m;
    while ((m = re.exec(input))) {
        if (m.index > last)
            segs.push(...linkifyBare(input.slice(last, m.index)));
        const tok = m[0];
        if (m[1])
            segs.push({ text: tok.slice(1, -1), code: true });
        else if (m[2]) {
            const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
            if (mm)
                segs.push({ text: mm[1], href: mm[2] });
            else
                segs.push({ text: tok });
        }
        else if (m[3])
            segs.push({ text: tok.slice(2, -2), bold: true });
        else if (m[4])
            segs.push({ text: tok.slice(1, -1), italic: true });
        last = m.index + tok.length;
    }
    if (last < input.length)
        segs.push(...linkifyBare(input.slice(last)));
    return segs.length ? segs : [{ text: input }];
}
// ─── lightweight, language-agnostic code highlighting ────────────────────────
// NOT a full grammar-aware highlighter (that needs a per-language lexer / Highlight.js).
// A generic pass: string literals, line comments, numbers, and a common keyword set — enough
// to read as "highlighted code" across JS/TS/PY/RS/SH without claiming per-language accuracy.
const KEYWORDS = new Set(('const let var function return if else for while do switch case break continue import from export ' +
    'default class new extends await async try catch finally throw typeof instanceof type interface enum ' +
    'public private protected static def fn pub use mod match struct impl trait where self super void int ' +
    'float double bool str string boolean true false null undefined nil None True False and or not in is ' +
    'lambda yield with as pass raise elif print echo func package go defer chan map range').split(' '));
const CODE_TOK = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|((?:\/\/|#|--).*$)|(\b\d[\d_.eExXabcdefABCDEF]*\b)|([A-Za-z_]\w*)/g;
function highlightCode(line) {
    const segs = [];
    try {
        const re = new RegExp(CODE_TOK);
        let last = 0;
        let m;
        while ((m = re.exec(line))) {
            if (m.index > last)
                segs.push({ text: line.slice(last, m.index) }); // punctuation/space: default fg
            if (m[1])
                segs.push({ text: m[0], color: 'green' }); // string literal
            else if (m[2])
                segs.push({ text: m[0], color: 'gray', italic: true }); // line comment
            else if (m[3])
                segs.push({ text: m[0], color: 'yellow' }); // number
            else if (m[4])
                segs.push(KEYWORDS.has(m[0]) ? { text: m[0], color: 'magenta' } : { text: m[0] });
            last = m.index + m[0].length;
        }
        if (last < line.length)
            segs.push({ text: line.slice(last) });
    }
    catch {
        return [{ text: line, color: 'gray' }]; // never let highlighting throw
    }
    return segs.length ? segs : [{ text: line, color: 'gray' }];
}
// ─── line classification (threads code-fence state) ──────────────────────────
export function classifyLine(line, inFence) {
    if (/^\s*```/.test(line))
        return { md: { kind: 'fence', raw: line }, nextFence: !inFence };
    if (inFence)
        return { md: { kind: 'code', segs: highlightCode(line) }, nextFence: inFence };
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h)
        return { md: { kind: 'header', level: h[1].length, segs: parseInline(h[2]) }, nextFence: inFence };
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
function SegView({ s }) {
    if (s.href) {
        const label = s.text;
        if (supportsHyperlinks())
            return _jsx(Text, { underline: true, color: "blue", children: osc8(s.href, label) });
        // Fallback keeps the URL visible + copyable where OSC 8 isn't supported.
        return _jsx(Text, { underline: true, color: "blue", children: label === s.href ? label : `${label} (${s.href})` });
    }
    const color = s.code ? 'cyan' : s.color;
    return _jsx(Text, { bold: s.bold, italic: s.italic, color: color, children: s.text });
}
/** Render one classified markdown line as Ink elements. */
export function MdView({ md }) {
    if (md.kind === 'fence')
        return _jsx(Text, { color: "gray", children: md.raw });
    if (md.kind === 'code')
        return _jsx(Text, { children: md.segs.map((s, i) => _jsx(SegView, { s: s }, i)) });
    if (md.kind === 'header') {
        return _jsx(Text, { children: md.segs.map((s, i) => _jsx(SegView, { s: { ...s, bold: true, color: s.href ? undefined : (s.color ?? 'cyan') } }, i)) });
    }
    // plain text — preserve blank lines at full height (paragraph breaks)
    if (!md.segs.length || (md.segs.length === 1 && md.segs[0].text === ''))
        return _jsx(Text, { children: " " });
    return _jsx(Text, { children: md.segs.map((s, i) => _jsx(SegView, { s: s }, i)) });
}
