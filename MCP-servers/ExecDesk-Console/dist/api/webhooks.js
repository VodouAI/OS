/**
 * Webhooks API — CRUD for webhooks table + inbound receiver
 */
import { Router } from 'express';
import { getDb } from '../db.js';
import { chat, isConfigured } from '../llm.js';
import { ensureConversation, saveMessage } from '../conversation-store.js';
import crypto from 'crypto';
export const webhooksRouter = Router();
// GET /api/webhooks — list all webhooks
webhooksRouter.get('/', (req, res) => {
    try {
        const db = getDb();
        const webhooks = db.prepare('SELECT id, name, url, method, headers_json, body_template, secret, expected_status, conversation_id, enabled, created_at FROM webhooks ORDER BY name ASC').all();
        // Don't expose full secret — mask it
        res.json(webhooks.map(w => ({
            ...w,
            secret: w.secret ? '***' + w.secret.slice(-4) : null,
        })));
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// POST /api/webhooks — create webhook
webhooksRouter.post('/', (req, res) => {
    try {
        const db = getDb();
        const { name, url, method, headers_json, body_template, secret, expected_status, conversation_id, enabled } = req.body;
        if (!name || !url) {
            res.status(400).json({ error: 'name and url are required' });
            return;
        }
        const result = db.prepare(`INSERT INTO webhooks (name, url, method, headers_json, body_template, secret, expected_status, conversation_id, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(name, url, method || 'POST', headers_json || '{}', body_template || null, secret || null, expected_status || 200, conversation_id || 'vodou-heartbeat', enabled !== undefined ? (enabled ? 1 : 0) : 1);
        const webhook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(result.lastInsertRowid);
        res.json(webhook);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// PUT /api/webhooks/:id — update webhook
webhooksRouter.put('/:id', (req, res) => {
    try {
        const db = getDb();
        const { id } = req.params;
        const { name, url, method, headers_json, body_template, secret, expected_status, conversation_id, enabled } = req.body;
        const existing = db.prepare('SELECT id FROM webhooks WHERE id = ?').get(id);
        if (!existing) {
            res.status(404).json({ error: `Webhook ${id} not found` });
            return;
        }
        const fields = [];
        const values = [];
        if (name !== undefined) {
            fields.push('name = ?');
            values.push(name);
        }
        if (url !== undefined) {
            fields.push('url = ?');
            values.push(url);
        }
        if (method !== undefined) {
            fields.push('method = ?');
            values.push(method);
        }
        if (headers_json !== undefined) {
            fields.push('headers_json = ?');
            values.push(headers_json);
        }
        if (body_template !== undefined) {
            fields.push('body_template = ?');
            values.push(body_template);
        }
        if (secret !== undefined) {
            fields.push('secret = ?');
            values.push(secret);
        }
        if (expected_status !== undefined) {
            fields.push('expected_status = ?');
            values.push(expected_status);
        }
        if (conversation_id !== undefined) {
            fields.push('conversation_id = ?');
            values.push(conversation_id);
        }
        if (enabled !== undefined) {
            fields.push('enabled = ?');
            values.push(enabled ? 1 : 0);
        }
        if (fields.length > 0) {
            values.push(id);
            db.prepare(`UPDATE webhooks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
        }
        const updated = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
        res.json(updated);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// DELETE /api/webhooks/:id — delete webhook
webhooksRouter.delete('/:id', (req, res) => {
    try {
        const db = getDb();
        const { id } = req.params;
        const result = db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
        if (result.changes === 0) {
            res.status(404).json({ error: `Webhook ${id} not found` });
            return;
        }
        res.json({ success: true, deleted: parseInt(id) });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// POST /api/webhooks/:id/toggle — flip enabled
webhooksRouter.post('/:id/toggle', (req, res) => {
    try {
        const db = getDb();
        const { id } = req.params;
        const webhook = db.prepare('SELECT id, enabled FROM webhooks WHERE id = ?').get(id);
        if (!webhook) {
            res.status(404).json({ error: `Webhook ${id} not found` });
            return;
        }
        const newEnabled = webhook.enabled ? 0 : 1;
        db.prepare('UPDATE webhooks SET enabled = ? WHERE id = ?').run(newEnabled, id);
        res.json({ id: webhook.id, enabled: newEnabled });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// POST /api/webhooks/receive/:name — inbound webhook receiver
// External systems (GitHub, CI/CD, monitoring) POST here to inject events into conversations
webhooksRouter.post('/receive/:name', async (req, res) => {
    try {
        const db = getDb();
        const { name } = req.params;
        const webhook = db.prepare('SELECT * FROM webhooks WHERE name = ? AND enabled = 1').get(name);
        if (!webhook) {
            res.status(404).json({ error: `Webhook "${name}" not found or disabled` });
            return;
        }
        // Validate HMAC signature if secret is configured
        if (webhook.secret) {
            const signature = req.headers['x-webhook-signature']
                || req.headers['x-hub-signature-256'];
            if (!signature) {
                res.status(401).json({ error: 'Missing signature header' });
                return;
            }
            const rawBody = JSON.stringify(req.body);
            const expected = 'sha256=' + crypto.createHmac('sha256', webhook.secret).update(rawBody).digest('hex');
            if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
                res.status(403).json({ error: 'Invalid signature' });
                return;
            }
        }
        // Format the inbound payload as a message
        const payload = req.body;
        const eventType = req.headers['x-github-event'] || 'webhook';
        const summary = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
        const message = `[Webhook: ${name}] ${eventType}\n\n\`\`\`json\n${summary.substring(0, 3000)}\n\`\`\``;
        const convId = webhook.conversation_id || 'vodou-heartbeat';
        ensureConversation(convId, `Webhook: ${name}`, 'webhook', name);
        try {
            saveMessage(convId, 'user', message);
        }
        catch { }
        // If LLM is configured, get a response
        if (isConfigured()) {
            const chunks = [];
            await chat(convId, message, (event) => {
                if (event.type === 'text' && event.content)
                    chunks.push(event.content);
                if (event.type === 'done') {
                    const full = chunks.join('');
                    if (full.trim()) {
                        try {
                            saveMessage(convId, 'assistant', full.trim());
                        }
                        catch { }
                    }
                }
            });
            res.json({ received: true, conversationId: convId, response: chunks.join('').substring(0, 500) });
        }
        else {
            res.json({ received: true, conversationId: convId, response: null });
        }
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
