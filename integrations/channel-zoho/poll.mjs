#!/usr/bin/env node
// poll.mjs — Zoho CRM channel poller for Vodou.
//
// Polls Zoho CRM for recent activity (notes, deals updates, contact changes)
// and records each as a Vodou turn with surface=zoho. Cross-surface recall
// surfaces CRM history when discussing customers in any other surface.
//
// Builds on v0.5.74 ExecDesk Zoho auth — reuses the OAuth tokens stored in
// vodou-core via the Vodou OAuth API.
//
// Run via cron / launchd every ~10 min (Zoho rate limits are tighter than
// Gmail/GCal).
//
// State persisted at: integrations/channel-zoho/.watermark.json

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.env.VODOU_PROJECT_PATH || process.cwd();
const VODOU_HOST = process.env.VODOU_HOST || 'http://127.0.0.1:8766';
const TOKEN_PATH = join(PROJECT_ROOT, '.vodou', 'console.token');
const WATERMARK_PATH = join(__dirname, '.watermark.json');
const VODOU_CORE_DB = join(PROJECT_ROOT, 'vodou-core.db');
const POLL_LIMIT = parseInt(process.env.ZOHO_POLL_LIMIT || '50', 10);

const token = (await readFile(TOKEN_PATH, 'utf8')).trim();

async function getSelfPrincipalId() {
    const { execSync } = await import('node:child_process');
    const out = execSync(
        `sqlite3 "${VODOU_CORE_DB}" "SELECT id FROM principals WHERE is_self=1 LIMIT 1;"`,
        { encoding: 'utf8' }
    ).trim();
    if (!out) throw new Error('no self-principal — run `vodou-core continuity init`');
    return out;
}
const principalId = await getSelfPrincipalId();

async function loadWatermark() {
    if (!existsSync(WATERMARK_PATH)) {
        return { last_modified_time: null, last_record_id: null };
    }
    return JSON.parse(await readFile(WATERMARK_PATH, 'utf8'));
}
async function saveWatermark(wm) {
    await mkdir(dirname(WATERMARK_PATH), { recursive: true });
    await writeFile(WATERMARK_PATH, JSON.stringify(wm, null, 2));
}

// Zoho activity types we poll. Verified live 2026-05-09 against running
// daemon: the registered Zoho MCP server is `server="zoho"` and it ONLY
// exposes ZohoMail_* tools — Zoho CRM (Notes/Deals/Contacts) tools are NOT
// available out of the box. To poll CRM modules, install a separate Zoho
// CRM MCP server and update ZOHO_SERVER + ZOHO_TOOL below.
//
// Default mode (`mail`): polls Zoho Mail via ZohoMail_SearchEmails.
// To switch to CRM mode: ZOHO_MODE=crm with ZOHO_SERVER + ZOHO_TOOL pointing
// at your installed CRM MCP server.
const ZOHO_MODE = process.env.ZOHO_MODE || 'mail';
const ZOHO_SERVER = process.env.ZOHO_SERVER || 'zoho';
const ZOHO_MAIL_TOOL = process.env.ZOHO_MAIL_TOOL || 'ZohoMail_SearchEmails';
const ZOHO_CRM_TOOL = process.env.ZOHO_CRM_TOOL || 'list_records';
const ZOHO_MODULES = (process.env.ZOHO_MODULES || 'Notes,Deals,Contacts,Activities').split(',');

async function listZohoMailMessages({ modified_since, limit }) {
    const args = {
        limit,
        ...(modified_since ? { modified_since } : {}),
    };
    const res = await fetch(`${VODOU_HOST}/api/tools/call`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: ZOHO_SERVER, tool: ZOHO_MAIL_TOOL, args }),
    });
    if (!res.ok) {
        console.error(`[zoho-poll] mail-mode failed: ${res.status} ${await res.text()}`);
        return [];
    }
    const json = await res.json();
    return json?.data?.result?.messages || json?.data?.result?.emails || json?.data?.result?.data || [];
}

async function listZohoRecords({ module_name, modified_since, limit }) {
    // CRM mode — requires a Zoho CRM MCP server installed (not available
    // in default Vodou setup). Set ZOHO_MODE=crm to use this path.
    const args = {
        module: module_name,
        per_page: limit,
        ...(modified_since ? { modified_since } : {}),
    };
    const res = await fetch(`${VODOU_HOST}/api/tools/call`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: ZOHO_SERVER, tool: ZOHO_CRM_TOOL, args }),
    });
    if (!res.ok) {
        console.error(`[zoho-poll] crm ${module_name} failed: ${res.status} ${await res.text()}`);
        return [];
    }
    const json = await res.json();
    return json?.data?.result?.records || json?.data?.result?.data || [];
}

async function recordTurn({ recordId, content, occurredAt, conversationId }) {
    const res = await fetch(`${VODOU_HOST}/api/v2/channels/turns`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            principal_id: principalId,
            surface: 'zoho',
            role: 'system',
            content,
            conversation_id: conversationId,
            surface_external_id: recordId,
            occurred_at: occurredAt,
        }),
    });
    if (!res.ok) throw new Error(`record_turn failed: ${res.status} ${await res.text()}`);
    return await res.json();
}

function formatRecord(module, rec) {
    // Best-effort formatter; adjust per module shape.
    const id = rec.id || rec.Id || 'unknown';
    const name = rec.Name || rec.Subject || rec.Deal_Name || rec.Last_Name || '(unnamed)';
    const owner = rec.Owner?.name || rec.owner || '';
    const stage = rec.Stage || rec.Status || '';
    const value = rec.Amount || '';
    const note = rec.Note_Content || rec.Description || '';
    return [
        `[Zoho ${module}] ${name}`,
        `Id: ${id}`,
        owner ? `Owner: ${owner}` : '',
        stage ? `Stage: ${stage}` : '',
        value ? `Value: ${value}` : '',
        note ? `\n${note}` : '',
    ].filter(Boolean).join('\n').slice(0, 6000);
}

async function pollModule(module_name, watermark) {
    const records = await listZohoRecords({
        module_name,
        modified_since: watermark.last_modified_time,
        limit: POLL_LIMIT,
    });
    if (records.length === 0) return { recorded: 0, latest: watermark.last_modified_time };

    let recorded = 0;
    let latest = watermark.last_modified_time;

    for (const rec of records) {
        try {
            const recordId = `${module_name}:${rec.id || rec.Id}`;
            const conversationId = `workbench:surface:zoho:${module_name.toLowerCase()}:${rec.id || rec.Id}`;
            const occurredAt = rec.Modified_Time || rec.Created_Time;
            await recordTurn({
                recordId,
                content: formatRecord(module_name, rec),
                occurredAt,
                conversationId,
            });
            recorded++;
            if (occurredAt && (!latest || occurredAt > latest)) latest = occurredAt;
        } catch (err) {
            console.error(`[zoho-poll] ${module_name} ${rec.id} failed: ${err.message}`);
        }
    }
    console.error(`[zoho-poll] ${module_name}: recorded ${recorded}/${records.length}`);
    return { recorded, latest };
}

async function pollMail(watermark) {
    const messages = await listZohoMailMessages({
        modified_since: watermark.last_modified_time,
        limit: POLL_LIMIT,
    });
    if (messages.length === 0) return { recorded: 0, latest: watermark.last_modified_time };

    let recorded = 0;
    let latest = watermark.last_modified_time;
    for (const msg of messages) {
        try {
            const messageId = msg.id || msg.messageId || msg.uniqueId;
            const conversationId = `workbench:surface:zoho:mail:${msg.threadId || messageId}`;
            const occurredAt = msg.receivedTime || msg.sentDateInGMT || msg.modified;
            const content = [
                `[Zoho Mail]`,
                `From: ${msg.fromAddress || msg.from || 'unknown'}`,
                `Subject: ${msg.subject || '(no subject)'}`,
                '',
                msg.summary || msg.snippet || msg.body || '',
            ].join('\n').slice(0, 8000);
            await recordTurn({
                recordId: messageId,
                content,
                occurredAt,
                conversationId,
            });
            recorded++;
            if (occurredAt && (!latest || occurredAt > latest)) latest = occurredAt;
        } catch (err) {
            console.error(`[zoho-poll] mail ${msg.id || '?'} failed: ${err.message}`);
        }
    }
    console.error(`[zoho-poll] mail: recorded ${recorded}/${messages.length}`);
    return { recorded, latest };
}

async function main() {
    const wm = await loadWatermark();
    console.error(`[zoho-poll] starting; mode=${ZOHO_MODE} last_modified_time=${wm.last_modified_time || 'none'}`);

    let totalRecorded = 0;
    let highestLatest = wm.last_modified_time;

    if (ZOHO_MODE === 'mail') {
        const result = await pollMail(wm);
        totalRecorded += result.recorded;
        if (result.latest && (!highestLatest || result.latest > highestLatest)) {
            highestLatest = result.latest;
        }
    } else if (ZOHO_MODE === 'crm') {
        for (const module of ZOHO_MODULES) {
            const result = await pollModule(module, wm);
            totalRecorded += result.recorded;
            if (result.latest && (!highestLatest || result.latest > highestLatest)) {
                highestLatest = result.latest;
            }
        }
    } else {
        console.error(`[zoho-poll] unknown ZOHO_MODE=${ZOHO_MODE}; supported: mail, crm`);
        process.exit(2);
    }

    if (totalRecorded > 0) {
        await saveWatermark({
            last_modified_time: highestLatest,
            last_record_id: wm.last_record_id,
        });
        console.error(`[zoho-poll] total recorded ${totalRecorded}; watermark advanced`);
    } else {
        console.error('[zoho-poll] no new records');
    }
}

main().catch(err => {
    console.error(`[zoho-poll] fatal: ${err.message}`);
    process.exit(1);
});
