#!/usr/bin/env node
/**
 * sync-skill-servers.js
 * Scans SKILL.md files, extracts MCP server references, populates skills_registry.required_tools
 * Uses VODOU_PROJECT_PATH from project root .env when available.
 */

import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
const PROJECT_ROOT = process.env.VODOU_PROJECT_PATH || path.resolve(__dirname, '../../..');
const DB_PATH = path.join(PROJECT_ROOT, 'vodou-core.db');

// Get all known server names from the DB
const db = new Database(DB_PATH, { readonly: false });
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

const serverRows = db.prepare('SELECT name FROM mcp_servers').all();
const knownServers = new Set(serverRows.map(r => r.name));

console.log(`Found ${knownServers.size} servers in DB: ${[...knownServers].join(', ')}`);

// Find all SKILL.md files
const skillsDir = path.join(PROJECT_ROOT, 'skills');
const skillMdFiles = [];

function walkDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full);
    } else if (entry.name === 'SKILL.md') {
      skillMdFiles.push(full);
    }
  }
}

walkDir(skillsDir);
console.log(`Found ${skillMdFiles.length} SKILL.md files`);

// Extract server references from a SKILL.md file
function extractServers(content) {
  const found = new Set();

  // Pattern 1: vodou-core call <server-name>
  const callRegex =./vodou-core\s+call\s+(\S+)/g;
  let m;
  while ((m = callRegex.exec(content)) !== null) {
    if (knownServers.has(m[1])) found.add(m[1]);
  }

  // Pattern 2: oi "call <server-name>
  const oiCallRegex = /oi\s+["']call\s+(\S+)/g;
  while ((m = oiCallRegex.exec(content)) !== null) {
    if (knownServers.has(m[1])) found.add(m[1]);
  }

  // Pattern 3: Direct server name mentions (only if a known server name appears as a whole word)
  for (const server of knownServers) {
    // Escape special regex chars in server name
    const escaped = server.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameRegex = new RegExp(`\\b${escaped}\\b`, 'g');
    if (nameRegex.test(content)) {
      found.add(server);
    }
  }

  return [...found].sort();
}

// Update skills_registry
const updateStmt = db.prepare('UPDATE skills_registry SET required_tools = ? WHERE name = ?');
const selectSkills = db.prepare('SELECT name, file_path FROM skills_registry');
const skills = selectSkills.all();

let updated = 0;
let skipped = 0;

for (const skill of skills) {
  // Find the SKILL.md for this skill
  const skillMd = skillMdFiles.find(f => {
    // Match by directory name containing the skill name, or file_path matching
    const dir = path.dirname(f);
    return dir.endsWith(skill.name) || (skill.file_path && f.startsWith(path.dirname(skill.file_path)));
  });

  if (!skillMd) {
    skipped++;
    continue;
  }

  const content = fs.readFileSync(skillMd, 'utf-8');
  const servers = extractServers(content);

  const json = JSON.stringify(servers);
  updateStmt.run(json, skill.name);
  if (servers.length > 0) {
    console.log(`  ${skill.name}: ${servers.join(', ')}`);
    updated++;
  }
}

console.log(`\nDone: ${updated} skills updated with server refs, ${skipped} skipped (no SKILL.md found)`);
db.close();
