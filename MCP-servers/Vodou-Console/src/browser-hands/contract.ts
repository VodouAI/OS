/**
 * Browser Hands (PLAN-BROWSER-HANDS §6.1, §13.5): the ONLY browser calls the
 * hands layer will make, and the decision for each one: run it, refuse it, or
 * stop for a fresh "yes" (a gate).
 *
 * This is code, not a setting: there is no install-side switch that turns a
 * gate off (§14.5), and the permissions profile (`full` auto-approves
 * everything, §13.2) does not apply here.
 *
 * chrome-devtools-mcp 1.10.1 is launched with --javascriptEvaluation=false and
 * the network/performance/memory/emulation/pwa categories off (backend.ts), which
 * leaves 21 tools. This allow-list narrows those further; anything not listed
 * is refused even if a future version of the server offers it.
 */

export type Decision =
  | { kind: 'allow'; args: Record<string, unknown> }
  | { kind: 'refuse'; reason: string }
  | { kind: 'gate'; category: GateCategory; target: string; args: Record<string, unknown> };

export type GateCategory = 'spend' | 'book' | 'send' | 'submit' | 'cancel' | 'delete' | 'account';

/** Tools the hands layer may call, with their argument checks below. */
export const ALLOWED_TOOLS = new Set([
  'new_page', 'list_pages', 'select_page', 'close_page', 'navigate_page',
  'take_snapshot', 'take_screenshot', 'wait_for',
  'click', 'fill', 'fill_form', 'hover', 'press_key', 'handle_dialog',
]);

/** Refused outright, with the reason recorded in the receipt. */
export const REFUSED_TOOLS: Record<string, string> = {
  evaluate_script: 'runs arbitrary JavaScript: can click without a click and read cookies',
  click_at: 'coordinate clicks have no accessible name to gate on',
  type_text: 'can submit a form via submitKey without a click; fill is used instead',
  upload_file: 'file uploads are out of scope in v1',
  drag: 'not needed for errands',
  lighthouse_audit: 'not needed for errands',
  get_console_message: 'console output can carry tokens and page internals',
  list_console_messages: 'console output can carry tokens and page internals',
  get_css_styles: 'not needed for errands',
  get_network_request: 'exposes response bodies and auth headers',
  list_network_requests: 'exposes response bodies and auth headers',
  emulate: 'not needed for errands',
};

/** Identity providers a login step may pass through (§13.10). */
export const IDENTITY_PROVIDERS = [
  'accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com', 'login.live.com',
  'www.facebook.com', 'auth0.com', 'okta.com',
];

/**
 * Consequential names. Buttons/menuitems/options matching these stop for a gate.
 * Links are navigation, so only the strongest verbs gate a link (a "Book now"
 * tile that opens a restaurant page shouldn't need a yes; "Place order" should).
 */
// ORDER MATTERS: the first match names the category, and the category words the
// "yes?" text. The more destructive meaning wins: "Cancel reservation" is a
// cancel, not a booking (a test caught exactly that).
const CONSEQUENTIAL: [GateCategory, RegExp][] = [
  ['cancel', /\b(cancel|unsubscribe|end (?:subscription|membership))\b/i],
  ['delete', /\b(delete|remove|erase|discard|clear (?:all|history))\b/i],
  ['account', /\b(change password|update (?:email|password|payment)|add (?:card|payment method)|transfer|withdraw|close account)\b/i],
  ['spend', /\b(pay|payment|buy|purchase|place (?:your |my )?order|check ?out|checkout|add to cart and pay|subscribe|upgrade|donate|tip|top up)\b/i],
  ['book', /\b(book|reserve|reservation|complete (?:reservation|booking)|confirm (?:reservation|booking)|rebook|change (?:flight|reservation))\b/i],
  ['send', /\b(send|post|publish|reply|share|invite)\b/i],
  ['submit', /\b(submit|confirm|agree and continue|i agree|accept and continue|finish|complete)\b/i],
];
const LINK_STRONG = /\b(pay|purchase|place (?:your |my )?order|checkout|delete|cancel|transfer|withdraw|confirm)\b/i;
const GATED_ROLES = new Set(['button', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'checkbox', 'radio']);

/** Fields the model may never fill (passwords come only from a password manager, §12.4). */
const SECRET_FIELD = /\b(password|passcode|passphrase|pin\b|cvv|cvc|security code|card number|credit card|debit card|account number|routing number|ssn|social security)\b/i;

export interface NodeInfo { uid: string; role: string; name: string; attrs: string }

export interface CallContext {
  /** uid → node, from the latest snapshot the loop saw. Clicks/fills must reference one. */
  nodes: Map<string, NodeInfo>;
  /** Hosts this task may visit (a recipe's site.domains, or the errand allow-list). Empty = any http(s). */
  allowedHosts: string[];
  /** True during a recipe `login` step: identity providers are allowed too. */
  inLoginStep?: boolean;
  /** The uid of the focused element, if the snapshot marked one. */
  focusedUid?: string;
}

export function classifyTarget(node: NodeInfo): GateCategory | null {
  const name = node.name || '';
  if (node.role === 'link') return LINK_STRONG.test(name) ? (CONSEQUENTIAL.find(([, r]) => r.test(name))?.[0] ?? 'submit') : null;
  if (!GATED_ROLES.has(node.role) && node.role !== 'link') return null;
  // A checkbox/switch gates only if its label is consequential (e.g. "I agree to be charged").
  for (const [cat, re] of CONSEQUENTIAL) if (re.test(name)) return cat;
  return null;
}

function hostAllowed(host: string, ctx: CallContext): boolean {
  const h = host.toLowerCase();
  const match = (d: string) => h === d || h.endsWith('.' + d);
  if (ctx.inLoginStep && IDENTITY_PROVIDERS.some(match)) return true;
  if (!ctx.allowedHosts.length) return true;
  return ctx.allowedHosts.some(match);
}

export function checkUrl(url: unknown, ctx: CallContext): string | null {
  if (typeof url !== 'string' || !url) return 'a URL is required';
  let u: URL;
  try { u = new URL(url); } catch { return 'not a valid URL'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return `${u.protocol} URLs are blocked (only http/https)`;
  if (!hostAllowed(u.hostname, ctx)) return `${u.hostname} is not one of this task's sites`;
  return null;
}

function nodeFor(uid: unknown, ctx: CallContext): NodeInfo | string {
  if (typeof uid !== 'string' || !uid) return 'an element uid from the latest snapshot is required';
  const n = ctx.nodes.get(uid);
  if (!n) return `uid ${uid} is not in the latest snapshot (take a new snapshot first)`;
  return n;
}

/** The decision for one call. Pure: no I/O. */
export function decide(tool: string, rawArgs: Record<string, unknown> | undefined, ctx: CallContext): Decision {
  const args = { ...(rawArgs || {}) };
  if (REFUSED_TOOLS[tool]) return { kind: 'refuse', reason: `${tool}: ${REFUSED_TOOLS[tool]}` };
  if (!ALLOWED_TOOLS.has(tool)) return { kind: 'refuse', reason: `${tool} is not on the Browser Hands allow-list` };

  switch (tool) {
    case 'new_page': {
      const bad = checkUrl(args.url, ctx);
      if (bad) return { kind: 'refuse', reason: bad };
      delete args.isolatedContext; // one profile per task; no hidden contexts
      return { kind: 'allow', args };
    }
    case 'navigate_page': {
      if (args.type === 'url' || args.url !== undefined) {
        const bad = checkUrl(args.url, ctx);
        if (bad) return { kind: 'refuse', reason: bad };
        args.type = 'url';
      }
      delete args.initScript; // runs JavaScript (also off server-side via --javascriptEvaluation=false)
      args.handleBeforeUnload = 'dismiss'; // never silently abandon a half-filled form
      return { kind: 'allow', args };
    }
    case 'handle_dialog': {
      // Accepting a dialog can be the consequential step ("Are you sure you want to cancel?").
      if (args.action === 'accept') return { kind: 'gate', category: 'submit', target: 'dialog: accept', args };
      return { kind: 'allow', args: { ...args, action: 'dismiss' } };
    }
    case 'click': {
      const n = nodeFor(args.uid, ctx);
      if (typeof n === 'string') return { kind: 'refuse', reason: n };
      if (args.dblClick) delete args.dblClick;
      const cat = classifyTarget(n);
      return cat ? { kind: 'gate', category: cat, target: `${n.role} "${n.name}"`, args } : { kind: 'allow', args };
    }
    case 'hover': {
      const n = nodeFor(args.uid, ctx);
      return typeof n === 'string' ? { kind: 'refuse', reason: n } : { kind: 'allow', args };
    }
    case 'fill': {
      const n = nodeFor(args.uid, ctx);
      if (typeof n === 'string') return { kind: 'refuse', reason: n };
      if (SECRET_FIELD.test(n.name)) return { kind: 'refuse', reason: `"${n.name}" is a secret field: the model never fills it (password manager path only)` };
      // Filling a consequential checkbox/switch ("true") is a click in disguise.
      if (['checkbox', 'switch', 'radio'].includes(n.role)) {
        const cat = classifyTarget(n);
        if (cat) return { kind: 'gate', category: cat, target: `${n.role} "${n.name}"`, args };
      }
      return { kind: 'allow', args };
    }
    case 'fill_form': {
      const els = Array.isArray(args.elements) ? args.elements : [];
      for (const e of els as { uid?: string }[]) {
        const n = nodeFor(e?.uid, ctx);
        if (typeof n === 'string') return { kind: 'refuse', reason: n };
        if (SECRET_FIELD.test(n.name)) return { kind: 'refuse', reason: `"${n.name}" is a secret field: the model never fills it` };
      }
      return { kind: 'allow', args };
    }
    case 'press_key': {
      const key = String(args.key || '');
      if (/\b(Enter|Return)\b/i.test(key)) {
        // Enter in a search box is navigation; anywhere else it can submit a form.
        const f = ctx.focusedUid ? ctx.nodes.get(ctx.focusedUid) : undefined;
        const isSearch = !!f && (f.role === 'searchbox' || (['combobox', 'textbox'].includes(f.role) && /search|where|location|restaurant|city/i.test(f.name)));
        if (!isSearch) return { kind: 'gate', category: 'submit', target: `key ${key}${f ? ` in ${f.role} "${f.name}"` : ''}`, args };
      }
      if (/(Control|Meta)\+(s|p|o|w|q|n|t)\b/i.test(key)) return { kind: 'refuse', reason: `${key}: browser shortcuts are blocked` };
      return { kind: 'allow', args };
    }
    default:
      return { kind: 'allow', args };
  }
}

/** Parse a (raw or filtered) snapshot into the uid → node map the contract checks against. */
export function nodesFromSnapshot(snapshot: string): { nodes: Map<string, NodeInfo>; focusedUid?: string } {
  const nodes = new Map<string, NodeInfo>();
  let focusedUid: string | undefined;
  const re = /^\s*uid=(\S+)\s+(\S+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$/;
  for (const line of snapshot.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const node = { uid: m[1], role: m[2], name: m[3] ?? '', attrs: (m[4] ?? '').trim() };
    nodes.set(node.uid, node);
    if (/\bfocused\b/.test(node.attrs)) focusedUid = node.uid;
  }
  return { nodes, focusedUid };
}
