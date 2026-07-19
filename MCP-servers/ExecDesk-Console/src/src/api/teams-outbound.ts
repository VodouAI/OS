/**
 * Microsoft Teams / Bot Framework REST — outbound messages from the gateway
 * (same credentials as Vodou-channels TeamsChannel; no botbuilder dependency here).
 */

const BF_SCOPE = 'https://api.botframework.com/.default';

export type TeamsRouting = { serviceUrl: string; conversationId: string };

export function decodeTeamsRecipient(recipient: string): TeamsRouting | null {
  if (!recipient || typeof recipient !== 'string') return null;
  try {
    const buf = Buffer.from(recipient, 'base64url');
    const o = JSON.parse(buf.toString('utf8')) as { s?: string; c?: string; serviceUrl?: string; conversationId?: string };
    const serviceUrl = (o.s || o.serviceUrl || '').trim();
    const conversationId = (o.c || o.conversationId || '').trim();
    if (!serviceUrl || !conversationId) return null;
    return { serviceUrl, conversationId };
  } catch {
    try {
      const buf = Buffer.from(recipient, 'base64');
      const o = JSON.parse(buf.toString('utf8')) as { s?: string; c?: string; serviceUrl?: string; conversationId?: string };
      const serviceUrl = (o.s || o.serviceUrl || '').trim();
      const conversationId = (o.c || o.conversationId || '').trim();
      if (!serviceUrl || !conversationId) return null;
      return { serviceUrl, conversationId };
    } catch {
      return null;
    }
  }
}

function tokenUrl(tenantId?: string): string {
  const t = tenantId?.trim();
  if (t) return `https://login.microsoftonline.com/${encodeURIComponent(t)}/oauth2/v2.0/token`;
  return 'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token';
}

export async function getBotFrameworkAccessToken(
  appId: string,
  appPassword: string,
  tenantId?: string,
): Promise<string | null> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: appId,
    client_secret: appPassword,
    scope: BF_SCOPE,
  });
  const r = await fetch(tokenUrl(tenantId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const d = (await r.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!r.ok || !d.access_token) {
    console.error('[Gateway] Bot Framework token failed:', r.status, d.error || d.error_description || d);
    return null;
  }
  return d.access_token;
}

function activitiesBase(serviceUrl: string, conversationId: string): string {
  const base = serviceUrl.replace(/\/+$/, '');
  return `${base}/v3/conversations/${encodeURIComponent(conversationId)}/activities`;
}

export async function sendTeamsActivity(params: {
  token: string;
  routing: TeamsRouting;
  text: string;
  botAppId: string;
}): Promise<string | null> {
  const { token, routing, text, botAppId } = params;
  const url = `${activitiesBase(routing.serviceUrl, routing.conversationId)}`;
  const body = {
    type: 'message',
    text,
    from: { id: botAppId, name: 'Vodou' },
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const d = (await r.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!r.ok) {
    console.error('[Gateway] Teams send failed:', r.status, d.error?.message || JSON.stringify(d).slice(0, 400));
    return null;
  }
  return d.id ? String(d.id) : null;
}

export async function updateTeamsActivity(params: {
  token: string;
  routing: TeamsRouting;
  activityId: string;
  text: string;
  botAppId: string;
}): Promise<boolean> {
  const { token, routing, activityId, text, botAppId } = params;
  const url = `${activitiesBase(routing.serviceUrl, routing.conversationId)}/${encodeURIComponent(activityId)}`;
  const body = {
    type: 'message',
    id: activityId,
    text,
    from: { id: botAppId, name: 'Vodou' },
  };
  const r = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
    console.error('[Gateway] Teams update failed:', r.status, d.error?.message || '');
    return false;
  }
  return true;
}
