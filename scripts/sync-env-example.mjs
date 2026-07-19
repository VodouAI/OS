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
  fs.writeFileSync(outPath, out, 'utf8');
  console.log('wrote', path.relative(root, outPath));
}

main();
