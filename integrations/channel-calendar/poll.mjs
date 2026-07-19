#!/usr/bin/env node
// poll.mjs — Calendar channel poller for Vodou.
//
// Polls Google Calendar (via the existing Google Calendar MCP server) for new
// or updated events since the last watermark, posts each as a turn to
// /api/v2/channels/turns with surface=calendar, persists the watermark.
//
// Pairs with channel-email/poll.mjs for meeting follow-up continuity:
// recall surfaces both the calendar event and any related email thread.
//
// Run via cron / launchd every ~5 min.
//
// State persisted at: integrations/channel-calendar/.watermark.json

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
const POLL_LIMIT = parseInt(process.env.CALENDAR_POLL_LIMIT || '50', 10);
const CALENDAR_ID = process.env.CALENDAR_ID || 'primary';

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
    if (!existsSync(WATERMARK_PATH)) return { last_updated: null, last_event_id: null };
    return JSON.parse(await readFile(WATERMARK_PATH, 'utf8'));
}
async function saveWatermark(wm) {
    await mkdir(dirname(WATERMARK_PATH), { recursive: true });
    await writeFile(WATERMARK_PATH, JSON.stringify(wm, null, 2));
}

async function listCalendarEvents({ updated_min, limit }) {
    // Verified live 2026-05-09 against running daemon: Google Calendar MCP
    // server is registered as `server="google-calendar"` with tool
    // `list-events` (kebab-case, not snake_case).
    const args = {
        calendar_id: CALENDAR_ID,
        max_results: limit,
        ...(updated_min ? { updated_min } : {}),
    };
    const res = await fetch(`${VODOU_HOST}/api/tools/call`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: 'google-calendar', tool: 'list-events', args }),
    });
    if (!res.ok) throw new Error(`google-calendar list-events failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return json?.data?.result?.events || json?.data?.result?.items || [];
}

async function recordTurn({ eventId, content, occurredAt, conversationId }) {
    const body = {
        principal_id: principalId,
        surface: 'calendar',
        role: 'system',
        content,
        conversation_id: conversationId,
        surface_external_id: eventId,
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

function formatEvent(ev) {
    const summary = ev.summary || '(no title)';
    const start = ev.start?.dateTime || ev.start?.date || 'unknown start';
    const end = ev.end?.dateTime || ev.end?.date || 'unknown end';
    const attendees = (ev.attendees || []).map(a => a.email || a.displayName).join(', ');
    const description = ev.description || '';
    const status = ev.status || '';
    return [
        `Event: ${summary}`,
        `When: ${start} → ${end}`,
        attendees ? `Attendees: ${attendees}` : '',
        status ? `Status: ${status}` : '',
        '',
        description,
    ].filter(Boolean).join('\n').slice(0, 8000);
}

async function main() {
    const wm = await loadWatermark();
    console.error(`[calendar-poll] starting; last_updated=${wm.last_updated || 'none'}`);

    let events;
    try {
        events = await listCalendarEvents({
            updated_min: wm.last_updated,
            limit: POLL_LIMIT,
        });
    } catch (err) {
        console.error(`[calendar-poll] failed to list events: ${err.message}`);
        process.exit(1);
    }

    if (events.length === 0) {
        console.error('[calendar-poll] no new/updated events');
        return;
    }

    let recorded = 0;
    let highestUpdated = wm.last_updated;
    let highestId = wm.last_event_id;

    for (const ev of events) {
        try {
            const conversationId = `workbench:surface:calendar:${ev.id}`;
            const occurredAt = ev.updated || ev.created
                ? new Date(ev.updated || ev.created).toISOString()
                : undefined;
            await recordTurn({
                eventId: ev.id,
                content: formatEvent(ev),
                occurredAt,
                conversationId,
            });
            recorded++;
            if (ev.updated && (!highestUpdated || ev.updated > highestUpdated)) {
                highestUpdated = ev.updated;
            }
            if (!highestId || ev.id > highestId) highestId = ev.id;
        } catch (err) {
            console.error(`[calendar-poll] failed to record ${ev.id}: ${err.message}`);
        }
    }

    if (recorded > 0) {
        await saveWatermark({ last_updated: highestUpdated, last_event_id: highestId });
        console.error(`[calendar-poll] recorded ${recorded} events; watermark advanced`);
    }
}

main().catch(err => {
    console.error(`[calendar-poll] fatal: ${err.message}`);
    process.exit(1);
});
