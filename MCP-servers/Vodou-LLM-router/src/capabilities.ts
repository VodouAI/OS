/**
 * Vodou Capabilities Loader
 * Loads and caches information about all available skills, MCP servers, and scripts
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { open } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Navigate up to Vodou root directory
const VODOU_ROOT = process.env.VODOU_PROJECT_PATH || join(__dirname, '..', '..', '..');

export interface Skill {
  name: string;
  description: string;
  triggers: string[];
  category: string;
  path: string;
}

export interface MCPServer {
  name: string;
  description: string;
  tools: MCPTool[];
}

export interface MCPTool {
  name: string;
  description: string;
  server: string;
}

export interface Script {
  name: string;
  description: string;
  command: string;
}

export interface OICapabilities {
  skills: Skill[];
  mcpServers: MCPServer[];
  scripts: Script[];
  lastUpdated: Date;
}

let cachedCapabilities: OICapabilities | null = null;

/**
 * Load all skills from the skills directory
 */
function loadSkills(): Skill[] {
  const skills: Skill[] = [];
  const skillsDir = join(VODOU_ROOT, 'skills');

  if (!existsSync(skillsDir)) {
    console.error(`Skills directory not found: ${skillsDir}`);
    return skills;
  }

  // Recursively find all SKILL.md files
  function findSkills(dir: string) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          findSkills(fullPath);
        } else if (entry.name === 'SKILL.md') {
          try {
            const content = readFileSync(fullPath, 'utf-8');
            const skill = parseSkillFile(content, fullPath);
            if (skill) {
              skills.push(skill);
            }
          } catch (e) {
            // Skip unreadable files
          }
        }
      }
    } catch (e) {
      // Skip unreadable directories
    }
  }

  findSkills(skillsDir);
  return skills;
}

/**
 * Parse a SKILL.md file to extract skill information
 */
function parseSkillFile(content: string, path: string): Skill | null {
  // Extract frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return null;

  const frontmatter = frontmatterMatch[1];

  // Parse name
  const nameMatch = frontmatter.match(/name:\s*(.+)/);
  const name = nameMatch ? nameMatch[1].trim() : '';

  // Parse description
  const descMatch = frontmatter.match(/description:\s*(.+)/);
  const description = descMatch ? descMatch[1].trim() : '';

  // Extract trigger phrases from content
  const triggersMatch = content.match(/## Trigger Phrases\n([\s\S]*?)(?=\n##|$)/);
  const triggers: string[] = [];
  if (triggersMatch) {
    const triggerLines = triggersMatch[1].match(/- "([^"]+)"/g);
    if (triggerLines) {
      triggers.push(...triggerLines.map(t => t.replace(/- "|"/g, '')));
    }
  }

  // Determine category from path
  const pathParts = path.split('/');
  const skillsIdx = pathParts.indexOf('skills');
  const category = skillsIdx >= 0 && pathParts[skillsIdx + 1]
    ? pathParts[skillsIdx + 1]
    : 'general';

  if (!name) return null;

  return {
    name,
    description,
    triggers,
    category,
    path,
  };
}

/**
 * Load MCP servers + tool counts straight from the brain DB (vodou-core.db),
 * the source of truth for installed servers. Previously parsed a generated
 * config.json, which could drift from what was actually registered.
 */
function loadMCPServers(): MCPServer[] {
  const servers: MCPServer[] = [];
  const dbPath = join(VODOU_ROOT, 'vodou-core.db');

  if (!existsSync(dbPath)) {
    console.error(`Brain DB not found: ${dbPath}`);
    return servers;
  }

  let db;
  try {
    db = open(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT s.name AS name, COUNT(t.id) AS tools_count
         FROM mcp_servers s
         LEFT JOIN tools t ON t.server_id = s.id
         GROUP BY s.id, s.name
         ORDER BY s.name`
      )
      .all() as { name: string; tools_count: number }[];

    for (const row of rows) {
      servers.push({
        name: row.name,
        description: `MCP server with ${row.tools_count} tools`,
        tools: [],
      });
    }
  } catch (e) {
    console.error('Error loading MCP servers from DB:', e);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }

  return servers;
}

/**
 * Load registered scripts
 */
function loadScripts(): Script[] {
  // Scripts are typically defined in a scripts directory or config
  // For now, return empty - can be extended later
  const scripts: Script[] = [];

  // Check for scripts directory
  const scriptsDir = join(VODOU_ROOT, 'scripts');
  if (existsSync(scriptsDir)) {
    try {
      const entries = readdirSync(scriptsDir);
      for (const entry of entries) {
        if (entry.endsWith('.sh') || entry.endsWith('.js') || entry.endsWith('.py')) {
          scripts.push({
            name: entry.replace(/\.(sh|js|py)$/, ''),
            description: `Script: ${entry}`,
            command: join(scriptsDir, entry),
          });
        }
      }
    } catch (e) {
      // Skip
    }
  }

  return scripts;
}

/**
 * Load all Vodou capabilities (skills, MCP servers, scripts). Intents come from workspace-context (direct DB).
 */
export function loadCapabilities(forceRefresh = false): OICapabilities {
  if (cachedCapabilities && !forceRefresh) {
    return cachedCapabilities;
  }

  const skills = loadSkills();
  const mcpServers = loadMCPServers();
  const scripts = loadScripts();

  cachedCapabilities = {
    skills,
    mcpServers,
    scripts,
    lastUpdated: new Date(),
  };

  console.error(`Loaded capabilities: ${skills.length} skills, ${mcpServers.length} MCP servers, ${scripts.length} scripts`);

  return cachedCapabilities;
}

/**
 * Get a formatted summary of capabilities for LLM context
 */
export function getCapabilitiesSummary(): string {
  const caps = loadCapabilities();

  let summary = '# Vodou Capabilities\n\n';

  // Skills
  summary += '## Skills (Expert Workflows)\n\n';
  for (const skill of caps.skills) {
    summary += `- **${skill.name}** (${skill.category}): ${skill.description}\n`;
    if (skill.triggers.length > 0) {
      summary += `  Triggers: ${skill.triggers.slice(0, 3).join(', ')}${skill.triggers.length > 3 ? '...' : ''}\n`;
    }
  }

  // MCP Servers
  summary += '\n## MCP Servers (Tools)\n\n';
  for (const server of caps.mcpServers) {
    summary += `- **${server.name}**: ${server.description}\n`;
  }

  // Scripts
  if (caps.scripts.length > 0) {
    summary += '\n## Scripts\n\n';
    for (const script of caps.scripts) {
      summary += `- **${script.name}**: ${script.description}\n`;
    }
  }

  return summary;
}

/**
 * Get capabilities as structured data for routing
 */
export function getCapabilitiesForRouting(): {
  skillNames: string[];
  skillTriggers: Map<string, string>;
  mcpServerNames: string[];
  scriptNames: string[];
} {
  const caps = loadCapabilities();

  const skillTriggers = new Map<string, string>();
  for (const skill of caps.skills) {
    for (const trigger of skill.triggers) {
      skillTriggers.set(trigger.toLowerCase(), skill.name);
    }
  }

  return {
    skillNames: caps.skills.map(s => s.name),
    skillTriggers,
    mcpServerNames: caps.mcpServers.map(s => s.name),
    scriptNames: caps.scripts.map(s => s.name),
  };
}
