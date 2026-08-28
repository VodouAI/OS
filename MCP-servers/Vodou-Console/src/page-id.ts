/**
 * page-id — the TypeScript mirror of `src/memory/page_id.rs`.
 *
 * PLAN-MEMORY-ON-EVERY-PAGE P0. Two implementations exist because both sides need
 * the key: Rust writes it (extractor, library, sync) and the gateway reads it
 * (presence at insert time, the page-match endpoint, the panel).
 *
 * TWO IMPLEMENTATIONS OF ONE IDENTITY IS A LIABILITY, and it is accepted here for
 * one reason only: the alternative is a process spawn per keystroke on the typing
 * lane. The mitigation is that `page-id.parity.test.ts` runs the SAME table
 * through both and fails if they ever disagree — because a page key computed two
 * ways is two pages, and the whole feature silently stops matching.
 *
 * Keep the rules in step with the Rust doc comment, not with intuition:
 *   - fragment dropped (a scroll position is not a document)
 *   - tracking params dropped, survivors sorted
 *   - host lowercased, `www.` and port removed; path case PRESERVED
 *   - trailing `/` trimmed
 *   - on a chat host, truncated to the conversation id
 */

/** Query parameters that identify a CAMPAIGN, not a document. */
const TRACKING_PARAMS = new Set([
  'gclid', 'fbclid', 'msclkid', 'dclid', 'gbraid', 'wbraid', 'yclid',
  'mc_cid', 'mc_eid', 'igshid', 'si', 'ref', 'ref_src', 'referrer',
  '_hsenc', '_hsmi', 'vero_id', 'oly_enc_id', 'oly_anon_id', 'spm',
]);

/** Hosts where the conversation id in the path IS the page identity. */
const CHAT_HOSTS: Array<[string, string]> = [
  ['chatgpt.com', '/c/'],
  ['chat.openai.com', '/c/'],
  ['claude.ai', '/chat/'],
  ['gemini.google.com', '/app/'],
  ['copilot.microsoft.com', '/chats/'],
  ['perplexity.ai', '/search/'],
  ['www.perplexity.ai', '/search/'],
  ['grok.com', '/chat/'],
  ['chat.deepseek.com', '/a/chat/s/'],
];

export interface PageId {
  pageKey: string;
  host: string;
}

function stripScheme(url: string): string | null {
  const u = url.trim();
  const lower = u.toLowerCase();
  if (lower.startsWith('https://')) return u.slice(8);
  if (lower.startsWith('http://')) return u.slice(7);
  return null;
}

/** Lowercased host with `www.` removed, or null for a non-http(s) URL. */
export function hostOf(url: string): string | null {
  const rest = stripScheme(url);
  if (rest === null) return null;
  const authority = rest.split(/[/?#]/)[0] ?? '';
  // Drop userinfo and port: neither is part of a page's identity.
  const noUser = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  const host = (noUser.split(':')[0] ?? '').trim().toLowerCase();
  if (!host) return null;
  return host.startsWith('www.') ? host.slice(4) : host;
}

/** Canonicalize a URL into a stable page identity, or null if not http(s). */
export function normalizeUrl(url: string): PageId | null {
  const host = hostOf(url);
  if (!host) return null;
  const rest = stripScheme(url);
  if (rest === null) return null;

  const cut = rest.search(/[/?#]/);
  const afterAuthority = cut >= 0 ? rest.slice(cut) : '';
  const noFrag = afterAuthority.split('#')[0] ?? '';
  const qIdx = noFrag.indexOf('?');
  let path = qIdx >= 0 ? noFrag.slice(0, qIdx) : noFrag;
  const query = qIdx >= 0 ? noFrag.slice(qIdx + 1) : null;

  if (!path) path = '/';

  const chat = CHAT_HOSTS.find(([h]) => h === host);
  if (chat) {
    const prefix = chat[1];
    const idx = path.indexOf(prefix);
    if (idx >= 0) {
      const conv = (path.slice(idx + prefix.length).split('/')[0] ?? '');
      if (conv) return { pageKey: `${host}${prefix}${conv}`, host };
    }
  }

  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  const kept = (query ?? '')
    .split('&')
    .filter(Boolean)
    .filter((kv) => {
      const key = (kv.split('=')[0] ?? '').toLowerCase();
      return !(key.startsWith('utm_') || TRACKING_PARAMS.has(key));
    })
    .sort();

  return { pageKey: kept.length ? `${host}${path}?${kept.join('&')}` : `${host}${path}`, host };
}
