#!/usr/bin/env node
/**
 * Regenerates repo-root .env.example from:
 * - MCP-servers/Vodou-Console/src/api/env-descriptions.json (canonical copy)
 * - scripts/env.example.manifest.json (section order, active vs commented, default values)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const descPath = path.join(root, 'MCP-servers/Vodou-Console/src/api/env-descriptions.json');
const manifestPath = path.join(root, 'scripts/env.example.manifest.json');
const outPath = path.join(root, '.env.example');

function stripForEnvComment(s) {
  return s
    .replace(/\*\*/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\u2019/g, "'")
    .replace(/\u2018/g, "'")
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2192/g, '->')
    .replace(/\s+/g, ' ')
    .trim();
}

function wrapKeyBlock(key, description, lineWidth) {
  const text = stripForEnvComment(description);
  const firstPrefix = `# ${key} -- `;
  const contPrefix = '# ';
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = firstPrefix;
  for (const word of words) {
    const sep = /\s$/.test(current) ? '' : ' ';
    const candidate = current + sep + word;
    if (candidate.length <= lineWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = contPrefix + word;
    }
  }
  if (current.length) lines.push(current);
  return lines.join('\n');
}

function descriptionForKey(descriptions, key) {
  if (descriptions[key]) return descriptions[key];
  // Manifest uses VODOU_* for many vars documented as OI_* in env-descriptions.json
  if (key.startsWith('VODOU_')) {
    const oi = `OI_${key.slice('VODOU_'.length)}`;
    if (descriptions[oi]) return descriptions[oi];
  }
  return null;
}

function main() {
  const descriptions = JSON.parse(fs.readFileSync(descPath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const lineWidth = 90;
  const blocks = [];

  blocks.push(
    '# =============================================================================',
    '# OI / Vodou -- environment template',
    '# Copy to .env and fill in values. Comment blocks are generated from',
    '# MCP-servers/Vodou-Console/src/api/env-descriptions.json (run: npm run sync-env-example).',
    '# https://app.vodou.ai for VODOU_TOKEN / VODOU_USER_ID',
    '# =============================================================================',
    '',
  );

  for (const section of manifest.sections) {
    blocks.push(
      '# =============================================================================',
      `# ${section.title}`,
      '# =============================================================================',
      '',
    );
    for (const entry of section.keys) {
      const { key, active, default: defVal } = entry;
      const desc = descriptionForKey(descriptions, key);
      if (!desc) {
        console.error(`sync-env-example: missing description for ${key} in env-descriptions.json`);
        process.exit(1);
      }
      blocks.push(wrapKeyBlock(key, desc, lineWidth));
      blocks.push(active ? `${key}=${defVal}` : `# ${key}=${defVal}`);
      blocks.push('');
    }
  }

  const out = blocks.join('\n').replace(/\n+$/, '\n');

  // GAMEPLAN B0-4 (PLANS/0.6.26) — REFUSE to silently delete documented keys.
  //
  // This script rebuilds .env.example from the manifest alone and overwrites the
  // file wholesale, so any key documented by hand — and 87 of the 214 keys in the
  // file were, including two entire sections (KANBAN BOARD, ROUTING/MEMORY TUNING)
  // and all four VODOU_ROUTER_* keys — vanishes on the next run with no warning.
  // Those keys are exactly the ones a person bothered to write help text for, and
  // the Settings -> Environment page files an undocumented key under "Other (in
  // your .env but not in .env.example)" with no help at all. So a silent
  // regeneration is a documentation regression that looks like a no-op diff.
  //
  // Fail closed: list what would be lost and write nothing. `--force` is the
  // deliberate escape hatch for when the removal IS the intent.
  const keysIn = (text) => new Set([...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
  if (fs.existsSync(outPath) && !process.argv.includes('--force')) {
    const existing = keysIn(fs.readFileSync(outPath, 'utf8'));
    const lost = [...existing].filter((k) => !keysIn(out).has(k)).sort();
    if (lost.length) {
      console.error(
        `sync-env-example: REFUSING to write — ${lost.length} documented key(s) are in ` +
          `.env.example but not in the manifest, and would be deleted:\n` +
          lost.map((k) => `  - ${k}`).join('\n') +
          `\n\nFix by adding each to scripts/env.example.manifest.json (+ a description in\n` +
          `MCP-servers/Vodou-Console/src/api/env-descriptions.json), or re-run with --force\n` +
          `if removing them is genuinely what you want.`
      );
      process.exit(1);
    }
  }

  fs.writeFileSync(outPath, out, 'utf8');
  console.log('wrote', path.relative(root, outPath));
}

main();
