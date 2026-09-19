#!/usr/bin/env node
/**
 * gen-gateway-openapi.mjs — derive src/api/gateway-openapi.json from the routes
 * the gateway actually registers.
 *
 * The spec behind Docs & API → API Explorer was written by hand and nothing
 * compared it with the code. Measured 2026-09-15: 73 documented operations
 * against ~430 registered, and 9 of the 73 described a method or path that no
 * longer existed (PUT toggles that are POST, `/api/tools/schema` that is
 * `/api/tools/:toolName/schema`). `docs.ts` told people to run
 * `npm run gen:gateway-openapi`; no such script existed.
 *
 * What it reads:
 *   - every `app.use('/api/…', …, someRouter)` mount in src/index.ts, following
 *     the router into its file (and any nested `router.use('/x', subRouter)`)
 *   - every `app.<method>('/api/…')` in any src file (index.ts, library.ts, …)
 *
 * What it keeps: hand-written operations (summary, examples, parameters) are
 * never touched. Operations it adds carry `x-generated: true` and are rebuilt on
 * every run from the handler: path params, `req.query.*` names, `req.body` keys,
 * and the comment block above the route.
 *
 * Run (from MCP-servers/Vodou-Console):
 *   node scripts/gen-gateway-openapi.mjs          rewrite src/ + dist/ copies
 *   node scripts/gen-gateway-openapi.mjs --check  exit 1 on drift, write nothing
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const SRC = path.join(PKG, 'src');
const SPEC_SRC = path.join(SRC, 'api', 'gateway-openapi.json');
const SPEC_DIST = path.join(PKG, 'dist', 'api', 'gateway-openapi.json');
const CHECK = process.argv.includes('--check');

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const M = METHODS.join('|');
// The gateway's HTTP API: /api and /v1, plus the four root endpoints that
// predate the /api prefix and are still called.
const API_PATH = /^\/(api|v1)(\/|$)|^\/(chat|clear|health|stats)(\/|$)/;

// ─── Nav groups ──────────────────────────────────────────────────────────────
// Longest prefix wins. Existing tags keep their names so hand-written ops stay
// in the group they were written for; new tags are appended to the nav.
const TAG_PREFIXES = [
  ['/api/heartbeat', 'Briefing & Tasks'],
  ['/api/channels', 'Messaging'],
  ['/chat', 'Chat & Conversation'], ['/clear', 'Chat & Conversation'],
  ['/api/chat', 'Chat & Conversation'], ['/api/conversations', 'Chat & Conversation'],
  ['/api/gateway', 'Chat & Conversation'], ['/api/link-preview', 'Chat & Conversation'],
  ['/api/files', 'Files'],
  ['/api/intents', 'Intent Routing'], ['/api/route', 'Intent Routing'],
  ['/api/servers', 'MCP Servers'], ['/api/mcp', 'MCP Servers'], ['/api/mcp-registry', 'MCP Servers'],
  ['/api/memory', 'Memory'], ['/api/vaults', 'Memory'], ['/api/import', 'Memory'], ['/api/brain', 'Memory'],
  ['/v1', 'OpenAI-Compatible API'],
  ['/api/scheduler', 'Scheduler'],
  ['/api/scripts', 'Scripts'], ['/api/exec', 'Scripts'],
  ['/api/settings', 'Settings'], ['/api/appearance', 'Settings'], ['/api/profile', 'Settings'],
  ['/api/skills', 'Skills'], ['/api/skill-console', 'Skills'],
  ['/health', 'System'], ['/stats', 'System'], ['/api/system', 'System'], ['/api/health', 'System'],
  ['/api/providers', 'System'], ['/api/identity', 'System'], ['/api/usage', 'System'],
  ['/api/cascade', 'System'], ['/api/control-grammar', 'System'], ['/api/presence', 'System'],
  ['/api/loops', 'System'], ['/api/docs', 'System'],
  ['/api/thinking', 'Thinking Sessions'],
  ['/api/tools', 'Tools (MCP)'], ['/api/vbb', 'Tools (MCP)'],
  ['/api/webhooks', 'Webhooks'],
  ['/api/workflows', 'Workflows'], ['/api/graph', 'Workflows'], ['/api/automations', 'Workflows'],
  ['/api/board', 'Board'],
  ['/api/onboarding', 'Onboarding'], ['/api/interview', 'Onboarding'],
  ['/api/lenses', 'Lenses'],
  ['/api/projects', 'Projects & Scope'], ['/api/dock', 'Projects & Scope'],
  ['/api/library', 'Library'],
  ['/api/capture', 'Browser Capture'], ['/api/page-match', 'Browser Capture'],
  ['/api/oauth', 'OAuth & Accounts'], ['/api/claude-auth', 'OAuth & Accounts'],
  ['/api/feed', 'Activity & Feed'], ['/api/timeline', 'Activity & Feed'], ['/api/receipts', 'Activity & Feed'],
  ['/api/turn', 'Activity & Feed'], ['/api/logs', 'Activity & Feed'], ['/api/home', 'Activity & Feed'],
  ['/api/workbench', 'Workbench'],
];
const NEW_TAGS = {
  'Board': { id: 'board', icon: '🗂️', description: 'Kanban board — tasks, runs, assignees and the agents that pick work up.' },
  'Onboarding': { id: 'onboarding', icon: '🧭', description: 'First-run setup, the guided checklist, and the profile interview.' },
  'Lenses': { id: 'lenses', icon: '🔍', description: 'Lens cards — fetch, act on, and manage the lens manifests.' },
  'Projects & Scope': { id: 'projects', icon: '📂', description: 'Projects, their instructions and skills, and what each surface is scoped to.' },
  'Library': { id: 'library', icon: '📚', description: 'The saved-document library — add URLs and text, browse, match a page to what you saved.' },
  'Browser Capture': { id: 'capture', icon: '🌐', description: 'The browser extension capture lane — captured turns, per-site status, page matching.' },
  'OAuth & Accounts': { id: 'oauth', icon: '🔑', description: 'Connector OAuth flows and account authentication status.' },
  'Activity & Feed': { id: 'activity', icon: '📰', description: 'Activity feed, timeline, turn receipts and logs.' },
  'Workbench': { id: 'workbench', icon: '🧪', description: 'Workbench endpoints.' },
};

// ─── The nine that were wrong (2026-09-15) ──────────────────────────────────
// Keyed by normalized `METHOD /path/{}`. The hand-written op moves to where the
// route really is; `dropQuery` removes query params the move turned into path
// params, `summary` renames when one op becomes two.
const CORRECTIONS = {
  'GET /api/channels': [{ to: 'GET /api/channels/status' }],
  'PUT /api/settings': [{ to: 'POST /api/settings' }],
  'GET /api/settings/models': [{ to: 'GET /api/settings/models/{}', dropQuery: true }],
  'PUT /api/skills/{}/toggle': [{ to: 'POST /api/skills/{}/toggle' }],
  'PUT /api/scheduler/{}/toggle': [{ to: 'POST /api/scheduler/{}/toggle' }],
  'PUT /api/servers/{}/toggle': [
    { to: 'POST /api/servers/{}/enable', summary: 'Enable server', dropBody: true },
    { to: 'POST /api/servers/{}/disable', summary: 'Disable server', dropBody: true },
  ],
  'POST /api/scripts/run': [{ to: 'POST /api/scripts/{}/{}/run', dropQuery: true }],
  'GET /api/scripts/status/{}': [{ to: 'GET /api/scripts/jobs/{}' }],
  'GET /api/tools/schema': [{ to: 'GET /api/tools/{}/schema', dropQuery: true }],
};

// ─── Source parsing ─────────────────────────────────────────────────────────
const fileCache = new Map();
function read(file) {
  if (!fileCache.has(file)) fileCache.set(file, fs.readFileSync(file, 'utf8'));
  return fileCache.get(file);
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

function resolveImport(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/, ''));
  for (const cand of [base + '.ts', path.join(base, 'index.ts')]) if (fs.existsSync(cand)) return cand;
  return null;
}

/** local name → { file, name } where name is the exported identifier (or 'default'). */
function importsOf(file) {
  const out = new Map();
  const re = /import\s+(?:type\s+)?(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"](\.[^'"]+)['"]/g;
  for (const m of read(file).matchAll(re)) {
    const target = resolveImport(file, m[3]);
    if (!target) continue;
    if (m[1]) out.set(m[1], { file: target, name: 'default' });
    for (let part of (m[2] || '').split(',')) {
      part = part.trim().replace(/^type\s+/, '');
      if (!part) continue;
      const [orig, alias] = part.split(/\s+as\s+/).map((s) => s.trim());
      out.set(alias || orig, { file: target, name: orig });
    }
  }
  return out;
}

function tsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') out.push(...tsFiles(p)); }
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const routes = new Map(); // `METHOD expressPath` → route

function addRoute(method, expressPath, file, idx) {
  const key = `${method.toUpperCase()} ${expressPath}`;
  if (routes.has(key)) return; // Express dispatches to the first registration
  routes.set(key, { method, expressPath, file, idx });
}

const joinPath = (prefix, sub) => {
  const p = (prefix + (sub === '/' ? '' : sub)).replace(/\/+/g, '/');
  return p.length > 1 ? p.replace(/\/$/, '') : p;
};

function collectRouter(file, name, prefix, depth = 0) {
  if (depth > 4) return;
  const body = read(file);
  if (name === 'default') {
    const m = body.match(/export\s+default\s+(\w+)/);
    name = m ? m[1] : 'router';
  }
  const own = new RegExp(`\\b${esc(name)}\\.(${M})\\(\\s*['"\`]([^'"\`]*)['"\`]`, 'g');
  let hits = [...body.matchAll(own)];
  // Files that build `const router = Router()` and export it under another name.
  if (!hits.length) hits = [...body.matchAll(new RegExp(`\\b\\w*[Rr]outer\\.(${M})\\(\\s*['"\`]([^'"\`]*)['"\`]`, 'g'))];
  for (const h of hits) addRoute(h[1], joinPath(prefix, h[2]), file, h.index);

  const nested = new RegExp(`\\b${esc(name)}\\.use\\(\\s*['"\`](\\/[^'"\`]*)['"\`]\\s*,\\s*(\\w+)\\s*\\)`, 'g');
  for (const n of body.matchAll(nested)) {
    const imp = importsOf(file).get(n[2]);
    if (imp) collectRouter(imp.file, imp.name, joinPath(prefix, n[1]), depth + 1);
    else collectRouter(file, n[2], joinPath(prefix, n[1]), depth + 1);
  }
}

function collectAll() {
  const index = path.join(SRC, 'index.ts');
  const imports = importsOf(index);
  const mount = /\bapp\.use\(\s*['"`](\/[^'"`]*)['"`]\s*,\s*(?:[\w.]+(?:\([^()]*\))?\s*,\s*)*(\w+)\s*\)/g;
  for (const m of read(index).matchAll(mount)) {
    if (!API_PATH.test(m[1])) continue;
    const imp = imports.get(m[2]);
    if (imp) collectRouter(imp.file, imp.name, m[1]);
    else collectRouter(index, m[2], m[1]);
  }
  const direct = new RegExp(`\\bapp\\.(${M})\\(\\s*['"\`](\\/[^'"\`]*)['"\`]`, 'g');
  for (const file of tsFiles(SRC)) {
    for (const m of read(file).matchAll(direct)) if (API_PATH.test(m[2])) addRoute(m[1], m[2], file, m.index);
  }
}

// ─── Route → OpenAPI ────────────────────────────────────────────────────────
/** `/api/library/:id(\\d+)/raw` → { path: '/api/library/{id}/raw', params: ['id'] } */
function toOpenApiPath(expressPath) {
  const params = [];
  const p = expressPath.replace(/:(\w+)(\((?:\\.|[^)])*\))?\??/g, (_, name) => { params.push(name); return `{${name}}`; });
  return { path: p, params };
}
const norm = (method, p) => `${method.toUpperCase()} ${p.replace(/\{[^}]+\}/g, '{}')}`;

function handlerSlice(route) {
  const body = read(route.file);
  const starts = [...body.matchAll(new RegExp(`\\b\\w+\\.(${M})\\(\\s*['"\`]\\/`, 'g'))]
    .map((m) => m.index).filter((i) => i > route.idx).sort((a, b) => a - b);
  return body.slice(route.idx, Math.min(starts[0] ?? body.length, route.idx + 8000));
}

// Method names reached through an optional chain (`body.reason?.trim()`), never fields.
const NOT_FIELDS = new Set(['length', 'toString', 'constructor', 'hasOwnProperty', 'trim', 'map', 'filter',
  'includes', 'split', 'slice', 'some', 'every', 'forEach', 'keys', 'values', 'entries', 'toLowerCase',
  'toUpperCase', 'startsWith', 'endsWith', 'replace', 'match', 'join', 'push', 'find', 'reduce']);
function namesFrom(slice, source) {
  const names = new Set();
  const src = esc(source);
  // An alias holds the WHOLE object: `const b = req.body;`, `= (req.body ?? {}) as …`,
  // `= req.body || {}`. Not `const reason = (req.body?.reason …)`, which holds one field.
  const aliases = [...slice.matchAll(new RegExp(`const\\s+(\\w+)\\s*(?::[^=]+)?=\\s*\\(?\\s*${src}\\s*(?:;|\\)|\\?\\?|\\|\\||as\\b)`, 'g'))].map((m) => m[1]);
  for (const who of [src, ...aliases.map(esc)]) {
    for (const m of slice.matchAll(new RegExp(`\\b${who}\\??\\.(\\w+)`, 'g'))) names.add(m[1]);
    for (const m of slice.matchAll(new RegExp(`\\b${who}\\[['"](\\w+)['"]\\]`, 'g'))) names.add(m[1]);
  }
  for (const m of slice.matchAll(new RegExp(`\\{([^{}]*)\\}\\s*=\\s*\\(?\\s*${src}\\b`, 'g'))) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/[:=\s]/)[0];
      if (/^\w+$/.test(n)) names.add(n);
    }
  }
  // (req.body ?? {}) as { name?: unknown; rules?: RulesBody }
  for (const m of slice.matchAll(new RegExp(`${src}\\s*(?:\\?\\?|\\|\\|)\\s*\\{\\}\\s*\\)\\s*as\\s*\\{([^}]*)\\}`, 'g'))) {
    for (const k of m[1].matchAll(/(\w+)\??\s*:/g)) names.add(k[1]);
  }
  return [...names].filter((n) => !NOT_FIELDS.has(n));
}

const RULE = /[─━═]{2,}|-{3,}|={3,}/g;
const ROUTE_REF = /^(GET|POST|PUT|PATCH|DELETE)\s+\/\S*\s*/i;
/** A banner line keeps its prose: `── POST /api/vaults  { name, rules } ──` → `{ name, rules }`. */
function unbanner(t) {
  const hadRule = RULE.test(t);
  RULE.lastIndex = 0;
  let s = t.replace(RULE, ' ').replace(/\s+/g, ' ').trim().replace(ROUTE_REF, '').trim();
  // `─── Endpoint ───`, `─── Health/inspect ───`: a section label, not a description.
  if (hadRule && s.split(/\s+/).length <= 2) s = '';
  return s;
}
function commentAbove(route) {
  const lines = read(route.file).slice(0, route.idx).split('\n');
  lines.pop(); // the partial line the route starts on
  const block = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) break;
    if (!/^(\/\/|\/\*\*?|\*)/.test(t)) break;
    block.unshift(t);
  }
  return block
    .map((t) => unbanner(t.replace(/^\/\*\*?|\*\/$|^\/\/+|^\*/g, '').trim()))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The comment's first sentence, when it reads as a summary. Route comments here
 * are written for the next engineer, not the explorer: many open with a plan tag
 * (`PLAN-GRAPH-SKILLS P0 (H3) —`), a body shape (`Body: { … }`), or a sentence
 * continued from the line above. Those fall back to the method + path summary,
 * and the comment still ships whole as the description.
 */
function commentSummary(comment) {
  let s = comment.split(/(?<!\b(?:e\.g|i\.e|etc|vs))(?<=[.!?])\s/)[0] || '';
  s = s.replace(/^(?:PLAN-[\w-]+|§[\d.]+|[A-Z]+-\d+|item [\d/]+)[^—]*—\s*/, '').replace(/[.:]$/, '').trim();
  if (!s || s.length > 80 || s.length < 8) return '';
  if (!/^[A-Z]/.test(s)) return '';
  if (/^(Body|Returns?|Query|Params?)\b\s*[:{]/.test(s)) return '';
  if (/[`{}→]|\.\.$|\(e\.g$/.test(s)) return '';
  if ((s.match(/\(/g) || []).length !== (s.match(/\)/g) || []).length) return '';
  return s;
}

const VERB = { get: 'Get', post: 'Post', put: 'Update', patch: 'Update', delete: 'Delete' };
function autoSummary(method, p) {
  const segs = p.split('/').filter(Boolean);
  const rest = segs[0] === 'api' ? segs.slice(1) : segs;
  const words = rest.map((s) => (s.startsWith('{') ? `by ${s.slice(1, -1)}` : s.replace(/[-_]/g, ' ')));
  return `${VERB[method]} ${words.join(' ')}`.trim();
}

function tagFor(p) {
  let best = null;
  for (const [prefix, tag] of TAG_PREFIXES) {
    if ((p === prefix || p.startsWith(prefix + '/')) && (!best || prefix.length > best[0].length)) best = [prefix, tag];
  }
  return best ? best[1] : 'System';
}

function generatedOp(route, oaPath, params) {
  const slice = handlerSlice(route);
  const comment = commentAbove(route);
  const summary = commentSummary(comment) || autoSummary(route.method, oaPath);
  const rel = path.relative(PKG, route.file);
  let description = comment.length > 700 ? comment.slice(0, 700).replace(/\s\S*$/, '') + '…' : comment;
  description = (description ? description + '\n\n' : '') + `Defined in ${rel}.`;

  const op = { tags: [tagFor(oaPath)], summary, description, 'x-generated': true };
  const parameters = params.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } }));
  for (const name of namesFrom(slice, 'req.query')) {
    if (!params.includes(name)) parameters.push({ name, in: 'query', required: false, schema: { type: 'string' }, example: '' });
  }
  if (parameters.length) op.parameters = parameters;
  if (route.method !== 'get') {
    const keys = namesFrom(slice, 'req.body');
    if (keys.length) {
      op.requestBody = { content: { 'application/json': { schema: { type: 'object' }, example: Object.fromEntries(keys.map((k) => [k, ''])) } } };
    }
  }
  op.responses = { 200: { description: 'Success' } };
  return op;
}

// ─── Merge ──────────────────────────────────────────────────────────────────
function build() {
  collectAll();
  const spec = JSON.parse(fs.readFileSync(SPEC_SRC, 'utf8'));

  // Hand-written ops, keyed by normalized method+path, with the corrections applied.
  const curated = new Map();
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op || op['x-generated']) continue;
      const key = norm(method, p);
      const moves = CORRECTIONS[key];
      if (!moves) { curated.set(key, op); continue; }
      for (const mv of moves) {
        const moved = structuredClone(op);
        if (mv.summary) moved.summary = mv.summary;
        if (mv.dropQuery && moved.parameters) {
          moved.parameters = moved.parameters.filter((x) => x.in !== 'query');
          if (!moved.parameters.length) delete moved.parameters;
        }
        if (mv.dropBody) delete moved.requestBody;
        curated.set(mv.to, moved);
      }
    }
  }

  const codeOps = new Map(); // normalized key → { oaPath, method, route, params }
  for (const route of routes.values()) {
    const { path: oaPath, params } = toOpenApiPath(route.expressPath);
    const key = norm(route.method, oaPath);
    if (!codeOps.has(key)) codeOps.set(key, { oaPath, method: route.method, route, params });
  }

  const paths = {};
  const put = (p, method, op) => { (paths[p] ||= {})[method] = op; };
  let kept = 0, added = 0;
  // Existing path order first, so the nav doesn't reshuffle; new routes after, sorted.
  const ordered = [...codeOps.entries()].sort((a, b) => {
    const ia = Object.keys(spec.paths).findIndex((p) => norm('get', p).slice(4) === a[0].split(' ')[1]);
    const ib = Object.keys(spec.paths).findIndex((p) => norm('get', p).slice(4) === b[0].split(' ')[1]);
    if (ia !== ib) return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
    return a[1].oaPath.localeCompare(b[1].oaPath) || METHODS.indexOf(a[1].method) - METHODS.indexOf(b[1].method);
  });
  for (const [key, c] of ordered) {
    if (curated.has(key)) { put(c.oaPath, c.method, curated.get(key)); kept++; }
    else { put(c.oaPath, c.method, generatedOp(c.route, c.oaPath, c.params)); added++; }
  }
  const stale = [...curated.keys()].filter((k) => !codeOps.has(k));

  const tagNames = new Set(spec.tags.map((t) => t.name));
  const used = new Set(Object.values(paths).flatMap((item) => Object.values(item).flatMap((op) => op.tags || [])));
  const tags = spec.tags.filter((t) => used.has(t.name));
  for (const name of used) {
    if (tagNames.has(name)) continue;
    const t = NEW_TAGS[name] || { id: name.toLowerCase().replace(/\W+/g, '-'), icon: '📎', description: '' };
    tags.push({ name, description: t.description, 'x-explorer-id': t.id, 'x-explorer-icon': t.icon });
  }

  const total = kept + added;
  const out = {
    ...spec,
    info: { ...spec.info, description: `Complete REST API surface for the Vodou Console — ${total} operations, generated from the gateway's route registrations by scripts/gen-gateway-openapi.mjs.` },
    tags,
    paths,
  };
  return { out, kept, added, stale, codeOps };
}

// ─── Drift check (no writes) ────────────────────────────────────────────────
function check() {
  collectAll();
  const fail = [];
  const onDisk = JSON.parse(fs.readFileSync(SPEC_SRC, 'utf8'));
  const documented = new Set();
  for (const [p, item] of Object.entries(onDisk.paths)) for (const m of METHODS) if (item[m]) documented.add(norm(m, p));
  const inCode = new Map();
  for (const r of routes.values()) inCode.set(norm(r.method, toOpenApiPath(r.expressPath).path), r);
  for (const [k, r] of inCode) if (!documented.has(k)) fail.push(`+ ${k}   (registered in ${path.relative(PKG, r.file)}:${lineOf(read(r.file), r.idx)}, not in the spec)`);
  for (const k of documented) if (!inCode.has(k)) fail.push(`- ${k}   (in the spec, no route registers it)`);
  if (fs.existsSync(SPEC_DIST) && fs.readFileSync(SPEC_DIST, 'utf8') !== fs.readFileSync(SPEC_SRC, 'utf8')) {
    fail.push('dist/api/gateway-openapi.json differs from src/api/gateway-openapi.json (docs.ts serves the dist copy first)');
  }
  if (fail.length) {
    console.error(`gateway-openapi drift — ${fail.length} problem(s). Fix: node scripts/gen-gateway-openapi.mjs\n` + fail.join('\n'));
    process.exit(1);
  }
  console.log(`gateway-openapi: in step — ${inCode.size} operations registered, all documented.`);
}

if (process.argv.includes('--routes')) {
  // Where each operation is registered, for whoever writes its examples by hand.
  collectAll();
  const list = [...routes.values()].map((r) => ({
    key: norm(r.method, toOpenApiPath(r.expressPath).path),
    method: r.method.toUpperCase(),
    path: toOpenApiPath(r.expressPath).path,
    file: path.relative(PKG, r.file),
    line: lineOf(read(r.file), r.idx),
  }));
  console.log(JSON.stringify(list, null, 2));
} else if (CHECK) {
  check();
} else {
  const { out, kept, added, stale } = build();
  const text = JSON.stringify(out, null, 2) + '\n';
  fs.writeFileSync(SPEC_SRC, text);
  if (fs.existsSync(path.dirname(SPEC_DIST))) fs.writeFileSync(SPEC_DIST, text);
  console.log(`gateway-openapi: ${kept + added} operations (${kept} hand-written kept, ${added} generated), ${out.tags.length} nav groups.`);
  if (stale.length) console.log(`dropped ${stale.length} hand-written op(s) no route registers:\n  ${stale.join('\n  ')}`);
}
