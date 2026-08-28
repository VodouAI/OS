// Copies vendored browser assets into public/ so the Brain console is fully
// offline (no CDN — the shipped Atlas's CDN lazy-load was flagged as
// offline-hostile; we don't inherit that).
//
// PLAN-BRAIN-INTO-CONSOLE P1 / §4: the graph UI is now canonical in the
// Console (MCP-servers/Vodou-Console/public) and the standalone :8767 console
// is built FROM it. Every file listed in SHARED below is a build copy — edit the
// Console side, run `npm run build` here. The Console's drift test
// (src/__tests__/brain-queries-drift.test.ts) keeps the query layer honest;
// this script keeps the UI honest by stamping each copy with its origin.
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const consolePublic = path.resolve(root, '..', 'Vodou-Console', 'public');
const vendorDir = path.join(root, 'public', 'vendor');
mkdirSync(vendorDir, { recursive: true });
mkdirSync(path.join(root, 'public', 'js'), { recursive: true });
mkdirSync(path.join(root, 'public', 'css'), { recursive: true });

copyFileSync(
  path.join(root, 'node_modules', 'd3', 'dist', 'd3.min.js'),
  path.join(vendorDir, 'd3.min.js')
);
console.log('[brain] vendored d3.min.js -> public/vendor/');

// [console-relative source, brain-public-relative destination, comment style]
const SHARED = [
  ['js/brain/app.js',            'js/app.js',            'js'],
  ['js/brain/brain-template.js', 'js/brain-template.js', 'js'],
  ['js/vocabulary.js',           'js/vocabulary.js',     'js'],
  ['css/brain.css',              'css/brain.css',        'css'],
  ['css/01-tokens.css',          'css/tokens.css',       'css'],
];
for (const [from, to, kind] of SHARED) {
  const src = path.join(consolePublic, from);
  const dst = path.join(root, 'public', to);
  const body = readFileSync(src, 'utf8');
  const stamp = `BUILD COPY of MCP-servers/Vodou-Console/public/${from} — edit there, then \`npm run build\` in MCP-servers/brain.`;
  const banner = kind === 'js' ? `// ${stamp}\n` : `/* ${stamp} */\n`;
  writeFileSync(dst, banner + body);
  console.log(`[brain] copied ${from} -> public/${to}`);
}
