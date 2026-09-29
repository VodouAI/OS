/**
 * Browser Hands (PLAN-BROWSER-HANDS §13.4): shrink a chrome-devtools-mcp
 * `take_snapshot` to what an errand needs, so the inner loop keeps ONE
 * snapshot in context and stays under its token budget.
 *
 * Measured 2026-09-28: OpenTable's homepage snapshot is 110,862 chars
 * (~28k tokens), 1,201 lines — 494 links and 493 StaticText, most of them
 * restaurant tiles. The errand needs the controls (the date button, the time
 * combobox, "Sign in", "search"), not 400 restaurant links.
 *
 * Input format (chrome-devtools-mcp 1.10): one node per line,
 *   `<indent>uid=<id> <role> "<name>" <attrs…>`
 * Rules, applied per line:
 *   - landmarks, headings and interactive controls are always kept;
 *   - everything inside a dialog/alertdialog is kept (a booking summary lives there);
 *   - StaticText is dropped when its text repeats the nearest kept ancestor's name;
 *   - images, `generic` wrappers and presentational nodes are dropped;
 *   - `url="…"` attributes are removed (clicks go by uid, and URLs are long and
 *     can carry identifiers — the model never needs them);
 *   - names are truncated to MAX_NAME chars;
 *   - within one parent, links beyond LINKS_PER_GROUP are summarised as one
 *     "+N more links" line, so a grid of tiles can't flood the context, and a
 *     hidden link takes its WHOLE subtree with it (its label text included —
 *     the first version leaked 477 StaticText lines / 30k chars that way);
 *   - outside dialogs, StaticText beyond TEXT_PER_GROUP per parent is summarised;
 *   - a CLOSED dropdown (combobox/listbox `expandable` without `expanded`) shows
 *     OPTIONS_WHEN_CLOSED options, then "+N more options": Resy's two closed pickers
 *     (guests, time) were 44 of the page's lines; the model still sees the value and
 *     can fill the box with an option's text;
 *   - text inside a live region (status/alert) keeps up to LIVE_NAME chars — sites
 *     announce what a control is showing there ("There are 5 results… Carbone")
 *     when the list itself isn't in the accessibility tree.
 * Indentation is re-derived from kept ancestors so the tree still reads as a tree.
 */

export const MAX_NAME = 80;
export const LINKS_PER_GROUP = 8;
export const TEXT_PER_GROUP = 3;
export const OPTIONS_WHEN_CLOSED = 3;
export const LIVE_NAME = 240;
const LIVE = new Set(['status', 'alert', 'log']);

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox',
  'radio', 'switch', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'treeitem', 'gridcell', 'columnheader', 'rowheader',
]);
const STRUCTURE = new Set([
  'RootWebArea', 'banner', 'main', 'navigation', 'contentinfo', 'complementary', 'form',
  'search', 'region', 'dialog', 'alertdialog', 'alert', 'status', 'heading', 'list', 'tablist',
  'menu', 'menubar', 'grid', 'table', 'row', 'group', 'radiogroup', 'tabpanel',
]);
const DIALOG = new Set(['dialog', 'alertdialog', 'alert']);
const DROP = new Set(['image', 'img', 'generic', 'none', 'presentation', 'LineBreak', 'InlineTextBox', 'separator']);

interface Node {
  depth: number;
  uid: string;
  role: string;
  name: string;
  attrs: string;
}

const LINE = /^(\s*)uid=(\S+)\s+(\S+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$/;

export function parseLine(line: string): Node | null {
  const m = LINE.exec(line);
  if (!m) return null;
  return { depth: m[1].length, uid: m[2], role: m[3], name: m[4] ?? '', attrs: (m[5] ?? '').trim() };
}

function cleanAttrs(attrs: string): string {
  return attrs
    .replace(/\s*url="(?:[^"\\]|\\.)*"/g, '')
    .replace(/\s*description="(?:[^"\\]|\\.)*"/g, (d) => (d.length > 90 ? '' : d))
    .trim();
}

function truncate(name: string, max = MAX_NAME): string {
  return name.length > max ? name.slice(0, max - 1) + '…' : name;
}

const isClosedDropdown = (role: string, attrs: string) =>
  (role === 'combobox' || role === 'listbox') && /\bexpandable\b/.test(attrs) && !/\bexpanded\b/.test(attrs);

export interface FilterResult {
  text: string;
  keptNodes: number;
  totalNodes: number;
  inChars: number;
  outChars: number;
}

export function filterSnapshot(snapshot: string): FilterResult {
  const lines = snapshot.split('\n');
  const out: string[] = [];
  // Stack of ancestors: { depth, kept (did we emit it), keptDepth (its output depth), name, inDialog }
  const stack: { depth: number; kept: boolean; outDepth: number; name: string; inDialog: boolean; links: number; texts: number; opts: number; hidden: number; key: string; suppressed: boolean; closed: boolean; live: boolean }[] = [];
  let total = 0;
  let kept = 0;
  const pendingMore = new Map<string, { outDepth: number; count: number; at: number; kind: string }>();

  const flushMore = (key: string) => {
    const p = pendingMore.get(key);
    if (p && p.count > 0) {
      out.splice(p.at, 0, `${'  '.repeat(p.outDepth)}… +${p.count} more ${p.kind}`);
      // shift later insertion points
      for (const [k, v] of pendingMore) if (k !== key && v.at >= p.at) v.at += 1;
    }
    pendingMore.delete(key);
  };

  for (const raw of lines) {
    const n = parseLine(raw);
    if (!n) {
      if (raw.startsWith('#')) out.push(raw);
      continue;
    }
    total++;
    while (stack.length && stack[stack.length - 1].depth >= n.depth) {
      const popped = stack.pop()!;
      for (const k of [...pendingMore.keys()]) if (k.startsWith(popped.key + '#')) flushMore(k);
    }
    const parent = stack[stack.length - 1];
    const inDialog = !!parent?.inDialog || DIALOG.has(n.role);
    const keptAncestor = [...stack].reverse().find((s) => s.kept);
    const outDepth = keptAncestor ? keptAncestor.outDepth + 1 : 0;

    const suppressed = !!parent?.suppressed; // inside a link the cap hid
    let keep: boolean;
    if (suppressed) {
      keep = false;
    } else if (inDialog) {
      keep = true; // a booking summary lives in a dialog: keep it all
    } else if (n.role === 'StaticText') {
      const dup = keptAncestor && keptAncestor.name && n.name && keptAncestor.name.includes(n.name.slice(0, 40));
      keep = !dup && n.name.length > 0 && !!parent && parent.kept && (STRUCTURE.has(parent.key.split('|')[1]) || INTERACTIVE.has(parent.key.split('|')[1]));
    } else if (DROP.has(n.role)) {
      keep = false;
    } else {
      keep = INTERACTIVE.has(n.role) || STRUCTURE.has(n.role);
    }
    let hideSubtree = false;

    // Cap links per kept parent (tile grids).
    const cap = (kind: string, limit: number, counter: 'links' | 'texts' | 'opts', owner = keptAncestor) => {
      if (!owner) return;
      owner[counter] += 1;
      if (owner[counter] > limit) {
        owner.hidden += 1;
        const k = owner.key + '#' + kind;
        const cur = pendingMore.get(k) ?? { outDepth, count: 0, at: out.length, kind };
        cur.count += 1;
        cur.at = out.length;
        pendingMore.set(k, cur);
        keep = false;
        hideSubtree = true;
      }
    };
    if (keep && !inDialog && n.role === 'link') cap('links', LINKS_PER_GROUP, 'links');
    if (keep && !inDialog && n.role === 'StaticText') cap('text', TEXT_PER_GROUP, 'texts');
    const closedOwner = [...stack].reverse().find((s) => s.closed);
    if (keep && n.role === 'option' && closedOwner) cap('options', OPTIONS_WHEN_CLOSED, 'opts', closedOwner);
    const live = !!parent?.live || LIVE.has(n.role);

    const key = `${n.uid}|${n.role}`;
    stack.push({ depth: n.depth, kept: keep, outDepth, name: n.name, inDialog, links: 0, texts: 0, opts: 0, hidden: 0, key, suppressed: suppressed || hideSubtree || (!keep && n.role === 'link'), closed: isClosedDropdown(n.role, n.attrs), live });
    if (!keep) continue;
    kept++;
    const attrs = cleanAttrs(n.attrs);
    out.push(`${'  '.repeat(outDepth)}uid=${n.uid} ${n.role}${n.name ? ` "${truncate(n.name, live ? LIVE_NAME : MAX_NAME)}"` : ''}${attrs ? ' ' + attrs : ''}`);
  }
  for (const k of [...pendingMore.keys()]) flushMore(k);
  const text = out.join('\n');
  return { text, keptNodes: kept, totalNodes: total, inChars: snapshot.length, outChars: text.length };
}
