// The panel's pre-tick rule, run for real, in EVERY build.
//
// Why this file exists. Asking the panel "What do you know about <person>?"
// listed 13 well-ranked facts, ticked none of them, and left Insert disabled —
// which reads as "Vodou found nothing about this person". Ctrl+B answered the
// same question correctly from the same gateway response.
//
// The two lanes had drifted apart on which field they trust. content.js takes
// `resp.selected`: the facts the gateway decomposed the question into and
// chose. The panel ignored `selected` and pre-ticked on `item.in_vault`
// instead. In all-memory mode — the panel's DEFAULT scope — nothing outside the
// portable vault can ever have in_vault=true, and a vault admitting only
// PREF/IDENTITY holds no RESEARCH facts about people, so the gate was
// structurally unsatisfiable for exactly the queries a user asks a memory
// panel. Not a bug you can see by reading the rule; only by running it against
// a realistic response.
//
// So this loads the REAL sidepanel.js of each build into a VM with a small DOM,
// hands render() a response shaped like the live one (13 items, every one
// in_vault=false, 4 of them in `selected`), and asserts the server's picks come
// back ticked. Audits all three builds from one file for the reason
// sites.test.mjs does: they are separate lineages and a guard inside one cannot
// see the others drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILDS = ['vodou-bridge', 'sideload-only-vodou-bridge', 'Store-vodou-bridge'];

// Enough DOM to run render(): elements that hold children, text, classes and
// dataset, plus the handful of ids the function reaches for by name.
function makeDom() {
  const mk = (tag = 'div') => {
    const el = {
      tagName: tag,
      children: [],
      dataset: {},
      style: {},
      className: '',
      _text: '',
      type: '',
      checked: false,
      value: tag === 'select' ? 'relevance' : '',
      options: { length: 1 },
      title: '',
      get textContent() { return this._text; },
      set textContent(v) { this._text = String(v); this.children = []; },
      set innerHTML(v) { this._text = String(v); },
      classList: { add() {}, remove() {}, toggle() {} },
      appendChild(c) { this.children.push(c); return c; },
      append(...cs) { this.children.push(...cs); },
      addEventListener() {},
      setAttribute() {},
      querySelector() { return null; },
      querySelectorAll(sel) { return collect(this, sel); },
    };
    return el;
  };
  // Only selector the code uses: '#list input[type=checkbox]'.
  const byId = {};
  const collect = (root, sel) => {
    if (!sel.includes('input')) return [];
    const list = byId.list ? byId.list.children : [];
    const out = [];
    for (const row of list) for (const c of row.children || []) if (c.type === 'checkbox') out.push(c);
    return out;
  };
  for (const id of ['list', 'status', 'sort', 'scope', 'vault-select', 'insert', 'all', 'foot', 'q']) {
    byId[id] = mk(id === 'sort' || id === 'scope' || id === 'vault-select' ? 'select' : 'div');
  }
  const document = {
    // theme.js stamps data-theme on <html> before anything else runs.
    documentElement: mk('html'),
    body: mk('body'),
    head: mk('head'),
    createElement: mk,
    getElementById: (id) => byId[id] || mk(),
    querySelectorAll: (sel) => collect(null, sel),
    querySelector: () => null,
    addEventListener() {},
  };
  return { document, byId };
}

// The panel is not one file: sidepanel.html loads companions first (the Store
// build reads globalThis.VodouVocabulary from vocabulary.js). Load exactly what
// the page loads, in page order, so the harness cannot drift from the product.
function companionScripts(dir) {
  const html = readFileSync(join(EXT, dir, 'sidepanel.html'), 'utf8');
  return [...html.matchAll(/<script\s+src="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((f) => !f.endsWith('sidepanel.js') && existsSync(join(EXT, dir, f)));
}

function loadPanel(dir) {
  const src = readFileSync(join(EXT, dir, 'sidepanel.js'), 'utf8');
  const { document, byId } = makeDom();
  const never = () => new Promise(() => {}); // top-level main() must not resolve into the DOM
  const ctx = {
    document,
    console,
    location: { search: '' },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    navigator: { clipboard: { writeText: never } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    requestAnimationFrame: (fn) => { void fn; return 0; },
    URL, URLSearchParams, Promise, JSON, Set, Map, Array, Object, String, Number, Date, Math, RegExp, Error,
    chrome: {
      runtime: { sendMessage: never, lastError: null, getURL: (p) => p, onMessage: { addListener() {} } },
      tabs: { query: never, sendMessage: never, onUpdated: { addListener() {} }, onActivated: { addListener() {} } },
      storage: { local: { get: never, set: never }, onChanged: { addListener() {} } },
      sidePanel: { setOptions: never },
      windows: { getCurrent: never },
    },
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of companionScripts(dir)) {
    new vm.Script(readFileSync(join(EXT, dir, f), 'utf8'), { filename: `${dir}/${f}` }).runInContext(ctx);
  }
  // `const picker` is a lexical binding: it never becomes a property of the VM
  // global, so it can only be captured from inside the script's own scope.
  // Appending the capture keeps that scope — no export shim in shipped code.
  const capture = '\n;globalThis.__panel = { render, picker };';
  new vm.Script(src + capture, { filename: `${dir}/sidepanel.js` }).runInContext(ctx);
  return { panel: ctx.__panel, byId };
}

// The live response for "What do you know about Ab Emam?", trimmed: every item
// outside the vault, four of them chosen by the server.
const SELECTED = [
  'Ab Emam has about 19,000 LinkedIn followers; Vodou links him to Good Wolf Marketing',
  "Ab Emam's public themes: vendor lock-in, platform bets, build-vs-buy, automation",
  'Ab Emam is a founder, operator, M&A exec and AI/business advisor',
  "Ab Emam went to Virginia Tech's Pamplin College of Business",
];
const ITEMS = [
  ...SELECTED.map((text, i) => ({
    text, in_vault: false, relevance: 0.9 - i * 0.01,
    created_at: '2026-09-21 04:00:00', scope: 'capture:web:chatgpt', tag: 'RESEARCH',
  })),
  ...Array.from({ length: 9 }, (_, i) => ({
    text: `unrelated-but-ranked fact ${i}`, in_vault: false, relevance: 0.8 - i * 0.05,
    created_at: '2026-09-20 04:00:00', scope: 'web', tag: 'RESEARCH',
  })),
];

for (const dir of BUILDS) {
  test(`${dir}: all-memory results pre-tick the server's picks`, () => {
    const { panel, byId } = loadPanel(dir);
    assert.equal(typeof panel.render, 'function', 'render() must be reachable');
    assert.ok(panel.picker, 'picker state must be reachable');

    panel.picker.scope = 'all';
    panel.picker.selected = SELECTED;
    panel.picker.checked = new Set();
    panel.render(ITEMS);

    const boxes = [];
    for (const row of byId.list.children) for (const c of row.children || []) if (c.type === 'checkbox') boxes.push(c);
    assert.equal(boxes.length, ITEMS.length, 'every item renders a checkbox');

    const ticked = boxes.filter((b) => b.checked).map((b) => b.dataset.text);
    for (const s of SELECTED) {
      assert.ok(ticked.includes(s), `server-selected fact must arrive ticked: ${s.slice(0, 40)}…`);
    }
    // The regression in one line: before the fix this was 0 and Insert was dead.
    assert.ok(ticked.length >= SELECTED.length, 'Insert must have something to insert');
  });

  test(`${dir}: with no server picks, out-of-vault items stay unticked`, () => {
    const { panel, byId } = loadPanel(dir);
    panel.picker.scope = 'all';
    panel.picker.selected = [];        // gateway chose nothing
    panel.picker.checked = new Set();
    panel.render(ITEMS);               // every item in_vault=false

    const boxes = [];
    for (const row of byId.list.children) for (const c of row.children || []) if (c.type === 'checkbox') boxes.push(c);
    const ticked = boxes.filter((b) => b.checked);
    // The must-not-fire control: the fix adds the server's pick as a REASON to
    // tick, it does not make everything tick. Without it, the vault rule still
    // governs, and nothing here is in the vault.
    assert.equal(ticked.length, 0, 'nothing should be pre-ticked when the server picked nothing');
  });
}
