#!/usr/bin/env node
// poll.mjs — Email channel poller for Vodou.
//
// Polls Gmail (via the existing Gmail MCP server) for new messages since
// the last watermark, posts each as a turn to /api/v2/channels/turns with
// surface=email, and persists the watermark.
//
// Run via cron / launchd every ~5 min:
//   */5 * * * * cd /path/to/vodou && node integrations/channel-email/poll.mjs
//
// Requires:
//   - Vodou daemon running (.vodou/console.token + http://127.0.0.1:8766)
//   - Gmail MCP server registered with Vodou (via vodou-core servers add ...)
//   - VODOU_PROJECT_PATH env var pointing at the Vodou repo root
//
// State persisted at: integrations/channel-email/.watermark.json

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
const POLL_LIMIT = parseInt(process.env.EMAIL_POLL_LIMIT || '20', 10);

// ── Load auth ───────────────────────────────────────────────────────────────
const token = (await readFile(TOKEN_PATH, 'utf8')).trim();

// ── Load self-principal id from vodou-core.db ───────────────────────────────
async function getSelfPrincipalId() {
    const { execSync } = await import('node:child_process');
    const out = execSync(
        `sqlite3 "${VODOU_CORE_DB}" "SELECT id FROM principals WHERE is_self=1 LIMIT 1;"`,
        { encoding: 'utf8' }
    ).trim();
    if (!out) throw new Error('no self-principal in vodou-core.db — run `vodou-core continuity init` first');
    return out;
}
const principalId = await getSelfPrincipalId();

// ── Watermark helpers ───────────────────────────────────────────────────────
async function loadWatermark() {
    // Watermark stores ISO timestamp of newest message internalDate seen.
    // Used to build q="after:YYYY/MM/DD" on next poll.
    if (!existsSync(WATERMARK_PATH)) return { last_internal_date: null, seen_message_ids: [] };
    return JSON.parse(await readFile(WATERMARK_PATH, 'utf8'));
}
async function saveWatermark(wm) {
    await mkdir(dirname(WATERMARK_PATH), { recursive: true });
    await writeFile(WATERMARK_PATH, JSON.stringify(wm, null, 2));
}

// ── Call Vodou's MCP layer to invoke the Gmail server ───────────────────────
// MCP tools return results wrapped: data.result = { content: [{ text, type }], isError }
// where content[0].text is JSON-serialized actual output. This helper unwraps.
async function callMcpTool({ server, tool, args }) {
    const res = await fetch(`${VODOU_HOST}/api/tools/call`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ server, tool, args }),
    });
    if (!res.ok) throw new Error(`${server}::${tool} HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const result = json?.data?.result || {};
    if (result.isError) throw new Error(`${server}::${tool} tool error: ${JSON.stringify(result.content)}`);
    const text = result?.content?.[0]?.text || '';
    try {
        return JSON.parse(text);
    } catch {
        return text;  // fallback if not JSON
    }
}

async function listGmailMessages({ since_iso, limit }) {
    // Verified live 2026-05-09: Gmail MCP server is server="gmail" with tool
    // "messages_list". Args are camelCase: maxResults (not max_results), q
    // for Gmail search syntax. Watermarking via q="after:YYYY/MM/DD" since
    // history_id isn't a tool param. Response is MCP-wrapped JSON.
    const q = since_iso ? `after:${formatDateForGmailQuery(since_iso)}` : 'newer_than:7d';
    const result = await callMcpTool({
        server: 'gmail',
        tool: 'messages_list',
        args: { maxResults: limit, q },
    });
    return result?.messages || [];
}

function formatDateForGmailQuery(iso) {
    // Gmail q= "after:" expects YYYY/MM/DD
    const d = new Date(iso);
    return `${d.getUTCFullYear()}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')}`;
}

async function getGmailMessage(messageId) {
    // Verified live: tool is `message_get` (singular), arg is `id`.
    return await callMcpTool({
        server: 'gmail',
        tool: 'message_get',
        args: { id: messageId },
    });
}

// ── Post a turn to Vodou ────────────────────────────────────────────────────
async function recordTurn({ messageId, content, occurredAt, conversationId }) {
    const body = {
        principal_id: principalId,
        surface: 'email',
        role: 'user',  // inbound emails are 'user' role; sent emails would be 'assistant'
        content,
        conversation_id: conversationId,
        surface_external_id: messageId,
        occurred_at: occurredAt,
    };
    const res = await fetch(`${VODOU_HOST}/api/v2/channels/turns`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`record_turn failed: ${res.status} ${await res.text()}`);
    return await res.json();
}

// ── Format an email as a turn body ──────────────────────────────────────────
function formatEmail(msg) {
    // Gmail message_get returns { id, threadId, snippet, payload: { headers: [{name, value}] }, internalDate }
    const headers = msg?.payload?.headers || [];
    const headerVal = (name) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
    const from = headerVal('from') || 'unknown';
    const subject = headerVal('subject') || '(no subject)';
    const to = headerVal('to');
    const snippet = msg.snippet || '';
    return [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        '',
        snippet,
    ].filter(Boolean).join('\n').slice(0, 8000);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    const wm = await loadWatermark();
    console.error(`[email-poll] starting; last_internal_date=${wm.last_internal_date || 'none'}`);

    let stubs;
    try {
        stubs = await listGmailMessages({
            since_iso: wm.last_internal_date,
            limit: POLL_LIMIT,
        });
    } catch (err) {
        console.error(`[email-poll] failed to list messages: ${err.message}`);
        process.exit(1);
    }

    if (stubs.length === 0) {
        console.error('[email-poll] no new messages');
        return;
    }

    const seen = new Set(wm.seen_message_ids || []);
    const fresh = stubs.filter(s => !seen.has(s.id));
    if (fresh.length === 0) {
        console.error(`[email-poll] all ${stubs.length} messages already recorded`);
        return;
    }

    let recorded = 0;
    let highestInternalDate = wm.last_internal_date;
    const newSeen = [];

    for (const stub of fresh) {
        try {
            const full = await getGmailMessage(stub.id);
            const conversationId = `workbench:surface:email:${stub.threadId || stub.id}`;
            const internalDateMs = parseInt(full.internalDate || '0', 10);
            const occurredAt = internalDateMs ? new Date(internalDateMs).toISOString() : undefined;
            await recordTurn({
                messageId: stub.id,
                content: formatEmail(full),
                occurredAt,
                conversationId,
            });
            recorded++;
            newSeen.push(stub.id);
            if (occurredAt && (!highestInternalDate || occurredAt > highestInternalDate)) {
                highestInternalDate = occurredAt;
            }
        } catch (err) {
            console.error(`[email-poll] failed to record ${stub.id}: ${err.message}`);
        }
    }

    if (recorded > 0) {
        // Keep last 200 message IDs to dedupe across overlapping polls
        const keep = [...newSeen, ...(wm.seen_message_ids || [])].slice(0, 200);
        await saveWatermark({
            last_internal_date: highestInternalDate,
            seen_message_ids: keep,
        });
        console.error(`[email-poll] recorded ${recorded} messages; watermark advanced`);
    }
}

main().catch(err => {
    console.error(`[email-poll] fatal: ${err.message}`);
    process.exit(1);
});
