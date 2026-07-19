// Copies vendored browser assets out of node_modules into public/vendor/
// so the Brain console is fully offline (no CDN — the shipped Atlas's CDN
// lazy-load was flagged as offline-hostile; we don't inherit that).
import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vendorDir = path.join(root, 'public', 'vendor');
mkdirSync(vendorDir, { recursive: true });
copyFileSync(
  path.join(root, 'node_modules', 'd3', 'dist', 'd3.min.js'),
  path.join(vendorDir, 'd3.min.js')
);
console.log('[brain] vendored d3.min.js -> public/vendor/');
