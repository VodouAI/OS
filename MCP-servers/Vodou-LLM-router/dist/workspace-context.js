/**
 * Vodou Context Loader — direct DB access so the LLM has full Vodou state before answering.
 * Everything: intents, memory search, MCP servers & tools, scheduler, skills registry, scripts.
 */
import { open as openDb } from './db.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { loadCapabilities, getCapabilitiesSummary } from './capabilities.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const VODOU_ROOT = process.env.VODOU_PROJECT_PATH || join(__dirname, '..', '..', '..');
const BRAIN_DB = join(VODOU_ROOT, 'vodou-core.db');
const MEMORY_DB = join(VODOU_ROOT, 'memory.db');
const STOPWORDS = new Set('a an and are can do does for how is it of or the to what when where which who why'.split(' '));
function queryTerms(q) {
    return q
        .toLowerCase()
        .replace(/'s\b/g, ' ')
        .split(/\W+/)
        .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}
function textMatchesTerms(text, terms) {
    if (terms.length === 0)
        return true;
    const lower = text.toLowerCase();
    return terms.some((t) => lower.includes(t));
}
let brainDb = null;
let memoryDb = null;
let gatewayDb = null;
const GATEWAY_DB = join(VODOU_ROOT, 'MCP-servers', 'Vodou-Console', 'gateway.db');
function getGatewayDb() {
    if (!existsSync(GATEWAY_DB))
        return null;
    if (!gatewayDb) {
        gatewayDb = openDb(GATEWAY_DB, { readOnly: true, timeout: 5000 });
    }
    return gatewayDb;
}
/**
 * Read a setting from gateway_settings (same store the web UI writes to).
 */
export function getGatewaySetting(key) {
    const db = getGatewayDb();
    if (!db)
        return null;
    try {
        const row = db.prepare('SELECT value FROM gateway_settings WHERE key = ?').get(key);
        return row?.value ?? null;
    }
    catch {
        return null;
    }
}
function getBrainDb() {
    if (!existsSync(BRAIN_DB))
        return null;
    if (!brainDb) {
        brainDb = openDb(BRAIN_DB, { readOnly: true });
    }
    return brainDb;
}
function getMemoryDb() {
    if (!existsSync(MEMORY_DB))
        return null;
    if (!memoryDb) {
        memoryDb = openDb(MEMORY_DB, { readOnly: true });
    }
    return memoryDb;
}
function safeQuery(db, sql, params = []) {
    try {
        const stmt = db.prepare(sql);
        return stmt.all(...params);
    }
    catch {
        return [];
    }
}
export function getIntentMappings() {
    const db = getBrainDb();
    if (!db)
        return [];
    return safeQuery(db, 'SELECT keyword, server_name, tool_name, priority FROM intent_mappings ORDER BY priority DESC, keyword');
}
/** All MCP servers and their tools from the brain DB. */
export function getMcpServersAndTools() {
    const db = getBrainDb();
    if (!db)
        return [];
    return safeQuery(db, `SELECT s.name as server_name, t.name as tool_name, t.description
     FROM tools t JOIN mcp_servers s ON t.server_id = s.id
     ORDER BY s.name, t.name`);
}
/** Scheduled tasks (scheduler). */
export function getScheduledTasks() {
    const db = getBrainDb();
    if (!db)
        return [];
    return safeQuery(db, 'SELECT id, name, schedule, schedule_type, payload, enabled, one_shot, next_run_at, last_run_at FROM scheduled_tasks ORDER BY id');
}
/** Skills from brain's skills_registry (DB). */
export function getSkillsRegistry() {
    const db = getBrainDb();
    if (!db)
        return [];
    return safeQuery(db, 'SELECT name, description FROM skills_registry WHERE is_active = 1 ORDER BY name');
}
/** Registered scripts (Vodou-script-executor). */
export function getScriptRegistry() {
    const db = getBrainDb();
    if (!db)
        return [];
    return safeQuery(db, 'SELECT server_name, script_name, command, description FROM script_registry ORDER BY server_name, script_name');
}
export function searchMemoryFts(query, topK = 10) {
    const db = getMemoryDb();
    if (!db)
        return [];
    const terms = query.trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0)
        return [];
    const ftsQuery = terms.join(' OR ');
    try {
        const stmt = db.prepare(`
      SELECT mc.path, mc.text, bm25(memory_fts) as score
      FROM memory_fts JOIN memory_chunks mc ON memory_fts.rowid = mc.rowid
      WHERE memory_fts MATCH ? ORDER BY score LIMIT ?
    `);
        const rows = stmt.all(ftsQuery, topK);
        const maxScore = Math.max(...rows.map((r) => Math.abs(r.score)), 1);
        return rows.map((r) => ({
            path: r.path,
            text: r.text,
            score: 1 - Math.abs(r.score) / maxScore,
        }));
    }
    catch {
        return [];
    }
}
/** Query-scoped skills, MCP servers+tools, and scripts (for route output). */
export function getRelevantMatchesForQuery(query) {
    const terms = queryTerms(query);
    const hasTerms = terms.length > 0;
    const allIntents = getIntentMappings();
    const allServerTools = getMcpServersAndTools();
    const allSkills = getSkillsRegistry();
    const allScripts = getScriptRegistry();
    const relevantIntents = hasTerms
        ? allIntents.filter((m) => textMatchesTerms(m.keyword, terms))
        : [];
    const relevantServerNames = new Set();
    for (const m of relevantIntents)
        relevantServerNames.add(m.server_name);
    if (hasTerms) {
        for (const t of allServerTools) {
            if (textMatchesTerms(t.server_name, terms) || textMatchesTerms(t.tool_name, terms) || (t.description && textMatchesTerms(t.description, terms)))
                relevantServerNames.add(t.server_name);
        }
    }
    const serverTools = hasTerms && relevantServerNames.size > 0
        ? allServerTools.filter((t) => relevantServerNames.has(t.server_name))
        : [];
    const relevantSkills = hasTerms
        ? allSkills.filter((s) => textMatchesTerms(s.name, terms) || (s.description && textMatchesTerms(s.description, terms)))
        : [];
    const relevantScripts = hasTerms
        ? allScripts.filter((r) => textMatchesTerms(r.server_name, terms) ||
            textMatchesTerms(r.script_name, terms) ||
            textMatchesTerms(r.command, terms) ||
            (r.description && textMatchesTerms(r.description, terms)))
        : [];
    const byServer = new Map();
    for (const t of serverTools) {
        const list = byServer.get(t.server_name) ?? [];
        list.push(t.tool_name);
        byServer.set(t.server_name, list);
    }
    const mcpServers = Array.from(byServer.entries()).map(([server_name, tools]) => ({ server_name, tools }));
    return {
        skills: relevantSkills.map((s) => ({ name: s.name, description: s.description })),
        mcpServers,
        scripts: relevantScripts.map((r) => ({ server_name: r.server_name, script_name: r.script_name, command: r.command })),
    };
}
function formatToolsByServer(tools) {
    const byServer = new Map();
    for (const r of tools) {
        const list = byServer.get(r.server_name) ?? [];
        list.push(r.tool_name);
        byServer.set(r.server_name, list);
    }
    const lines = [];
    for (const [server, names] of byServer) {
        lines.push(`- **${server}**: ${names.join(', ')}`);
    }
    return lines.join('\n');
}
/** Assemble Vodou context relevant to the query only: filtered intents, memory, MCP+tools, scheduler, skills, scripts. */
export function getBrainContextForQuery(query) {
    const terms = queryTerms(query);
    const allIntents = getIntentMappings();
    const memoryHits = searchMemoryFts(query, 12);
    const allServerTools = getMcpServersAndTools();
    const scheduledTasks = getScheduledTasks();
    const allSkills = getSkillsRegistry();
    const allScripts = getScriptRegistry();
    loadCapabilities(true);
    const capabilitiesSummary = getCapabilitiesSummary();
    const hasTerms = terms.length > 0;
    const scheduleTerms = ['schedule', 'scheduled', 'task', 'tasks', 'cron', 'run', 'periodic', 'hourly', 'daily'];
    const queryAboutScheduling = hasTerms && terms.some((t) => scheduleTerms.some((s) => s.includes(t) || t.includes(s)));
    const relevantIntents = hasTerms
        ? allIntents.filter((m) => textMatchesTerms(m.keyword, terms)).slice(0, 35)
        : [];
    const relevantServerNames = new Set();
    for (const m of relevantIntents)
        relevantServerNames.add(m.server_name);
    if (hasTerms) {
        for (const t of allServerTools) {
            if (textMatchesTerms(t.server_name, terms) || textMatchesTerms(t.tool_name, terms) || (t.description && textMatchesTerms(t.description, terms)))
                relevantServerNames.add(t.server_name);
        }
    }
    const serverTools = hasTerms && relevantServerNames.size > 0
        ? allServerTools.filter((t) => relevantServerNames.has(t.server_name))
        : [];
    const showFullScheduler = scheduledTasks.length > 0 && (queryAboutScheduling || !hasTerms);
    const relevantSkills = hasTerms
        ? allSkills.filter((s) => textMatchesTerms(s.name, terms) || (s.description && textMatchesTerms(s.description, terms))).slice(0, 25)
        : [];
    const relevantScripts = hasTerms
        ? allScripts.filter((r) => textMatchesTerms(r.server_name, terms) ||
            textMatchesTerms(r.script_name, terms) ||
            textMatchesTerms(r.command, terms) ||
            (r.description && textMatchesTerms(r.description, terms))).slice(0, 20)
        : [];
    let section = '# Vodou state (query-relevant)\n\n';
    section += '## Intent mappings (keyword → server::tool)\n\n';
    if (relevantIntents.length > 0) {
        for (const m of relevantIntents) {
            section += `- **${m.keyword}** → ${m.server_name}::${m.tool_name}\n`;
        }
    }
    else if (allIntents.length > 0 && !hasTerms) {
        section += `(${allIntents.length} intents total — ask with specific keywords to see relevant ones)\n`;
    }
    else
        section += '(none match this query)\n';
    section += '\n## Relevant memories (memory.db FTS)\n\n';
    if (memoryHits.length > 0) {
        for (const h of memoryHits) {
            section += `- [${h.path}] ${h.text.slice(0, 300)}${h.text.length > 300 ? '...' : ''}\n`;
        }
    }
    else
        section += '(no matches)\n';
    section += '\n## MCP servers & tools (query-relevant)\n\n';
    if (serverTools.length > 0) {
        section += formatToolsByServer(serverTools);
        const nServers = new Set(serverTools.map((t) => t.server_name)).size;
        section += `\n(${serverTools.length} tools across ${nServers} servers)\n`;
    }
    else if (allServerTools.length > 0 && hasTerms) {
        section += '(no servers/tools match this query)\n';
    }
    else if (allServerTools.length > 0) {
        section += `(${allServerTools.length} tools across ${new Set(allServerTools.map((t) => t.server_name)).size} servers — ask with keywords to filter)\n`;
    }
    else
        section += '(none)\n';
    section += '\n## Scheduler (scheduled tasks)\n\n';
    if (scheduledTasks.length > 0) {
        if (showFullScheduler) {
            for (const t of scheduledTasks) {
                const en = t.enabled ? 'on' : 'off';
                section += `- **${t.name}** (${en}): ${t.schedule_type} ${t.schedule} → \`${t.payload.slice(0, 60)}${t.payload.length > 60 ? '...' : ''}\`\n`;
            }
        }
        else {
            section += `${scheduledTasks.length} task(s) scheduled. (User can ask "what's scheduled?" for the list.)\n`;
        }
    }
    else
        section += '(none)\n';
    section += '\n## Skills (registry, query-relevant)\n\n';
    if (relevantSkills.length > 0) {
        for (const s of relevantSkills) {
            section += `- **${s.name}**: ${s.description ?? '(no description)'}\n`;
        }
    }
    else if (allSkills.length > 0 && hasTerms) {
        section += '(none match this query)\n';
    }
    else if (allSkills.length > 0) {
        section += `(${allSkills.length} skills — ask with keywords to see relevant ones)\n`;
    }
    else
        section += '(none)\n';
    section += '\n## Script registry (query-relevant)\n\n';
    if (relevantScripts.length > 0) {
        for (const r of relevantScripts) {
            section += `- ${r.server_name} / **${r.script_name}**: \`${r.command}\`\n`;
        }
    }
    else if (allScripts.length > 0 && hasTerms) {
        section += '(none match this query)\n';
    }
    else if (allScripts.length > 0) {
        section += `(${allScripts.length} scripts — ask with keywords to filter)\n`;
    }
    else
        section += '(none)\n';
    section += '\n## Capabilities\n\n';
    section += hasTerms ? 'Relevant intents and tools are listed above.\n' : capabilitiesSummary;
    return {
        intents: hasTerms ? relevantIntents : allIntents,
        memoryHits,
        capabilitiesSummary,
        promptSection: section,
    };
}
//# sourceMappingURL=workspace-context.js.map