/**
 * Google Chat REST — outbound from gateway (same credentials as Vodou-channels).
 */
import { chat } from '@googleapis/chat';
import { JWT } from 'google-auth-library';
export function decodeGoogleChatRecipient(recipient) {
    if (!recipient || typeof recipient !== 'string')
        return null;
    try {
        const buf = Buffer.from(recipient, 'base64url');
        const o = JSON.parse(buf.toString('utf8'));
        const space = (o.s || o.space || '').trim();
        if (!space)
            return null;
        const thread = (o.t || o.thread || '').trim();
        return { space, ...(thread ? { thread } : {}) };
    }
    catch {
        try {
            const buf = Buffer.from(recipient, 'base64');
            const o = JSON.parse(buf.toString('utf8'));
            const space = (o.s || o.space || '').trim();
            if (!space)
                return null;
            const thread = (o.t || o.thread || '').trim();
            return { space, ...(thread ? { thread } : {}) };
        }
        catch {
            return null;
        }
    }
}
async function chatClientFromCredentials(credsJson) {
    try {
        const creds = JSON.parse(credsJson);
        if (!creds.client_email || !creds.private_key)
            return null;
        const jwt = new JWT({
            email: String(creds.client_email),
            key: String(creds.private_key).replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/chat.bot'],
        });
        return chat({ version: 'v1', auth: jwt });
    }
    catch (e) {
        console.error('[Gateway] Google Chat auth parse failed:', e instanceof Error ? e.message : e);
        return null;
    }
}
export async function sendGoogleChatMessage(credsJson, recipient, text) {
    const routing = decodeGoogleChatRecipient(recipient);
    if (!routing || !credsJson.trim())
        return null;
    const client = await chatClientFromCredentials(credsJson);
    if (!client)
        return null;
    try {
        const requestBody = { text };
        if (routing.thread)
            requestBody.thread = { name: routing.thread };
        const res = await client.spaces.messages.create({
            parent: routing.space,
            requestBody,
        });
        return typeof res.data.name === 'string' ? res.data.name : null;
    }
    catch (e) {
        console.error('[Gateway] Google Chat send failed:', e instanceof Error ? e.message : e);
        return null;
    }
}
