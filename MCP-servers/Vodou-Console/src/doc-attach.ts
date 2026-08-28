/**
 * `@doc:` attach tokens (PLAN-DOCUMENT-LIBRARY §3.4.2, P2).
 *
 * Dragging a Library row into a chat composer drops the plain text `@doc:<slug>`.
 * Dropping plain text into a <textarea> is NATIVE browser behavior, so the drag
 * side needs no handler and no existing chat file is edited — which is what lets
 * this ship under the "no existing frontend file is edited" constraint.
 *
 * Resolution happens HERE, server-side, and that is the load-bearing choice:
 *
 *  1. Every surface gets it at once. Typing `@doc:msa` in Slack or Telegram
 *     attaches the document to that turn — ten channels, one implementation,
 *     zero frontend work.
 *  2. It is typeable, not only draggable.
 *  3. The token is copyable and pasteable anywhere Vodou listens, including a
 *     scheduled skill's prompt body.
 *
 * An unknown slug NEVER fails the turn: the message goes through with a visible
 * one-line notice and a suggestion. A silent drop would be worse than useless —
 * the user would believe the document was attached.
 *
 * Kept as its own module on purpose: `llm.ts` is ~390 KB and on the shared
 * hot-file list, so this costs it a single call site.
 */

import { runCore } from './api/memory-capture.js';

/** Chars of body pulled inline for a small document before we stop and rely on
 *  the model calling `vc_doc_read` for the rest. */
const INLINE_BUDGET = 12_000;

const TOKEN_RE = /@doc:([a-z0-9][a-z0-9._-]*)/gi;

export interface DocAttachResult {
  /** The message with tokens replaced by nothing (the attachment rides separately). */
  text: string;
  /** Attachment block to append to the turn's context, or '' when nothing resolved. */
  context: string;
  /** Human-facing notices — unknown slugs, truncation. Never silent. */
  notices: string[];
  /** True when at least one token was present, resolved or not. */
  sawToken: boolean;
}

interface LibrarySource {
  id: number;
  kind: string;
  name: string;
  chunks: number;
  card_state: string | null;
  broken_reason: string | null;
}

/**
 * Slug for a source name — **the only implementation** (COHERENCE F13).
 *
 * It used to be four: here, `public/library/index.html`, and twice inline in
 * the panel's `sidepanel.js`, held together by comments saying "MUST match".
 * They did match, which is exactly why nothing would have caught it when they
 * stopped: a token minted one way and resolved another is silently a different
 * document, and the failure surfaces as "Vodou says it attached my contract and
 * then answered about something else".
 *
 * So the surfaces no longer compute it. Every route that hands a document to a
 * client (`/api/library`, `/api/library/match`, `/api/page-match`) mints the
 * slug HERE and ships it on the row, and the clients paste what they were
 * given. The code that mints the token is the code that resolves it.
 */
export function slugOf(name: string, id: number): string {
  const s = String(name || '')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return s || String(id);
}

/**
 * Real edit distance, because the common typo is a DELETION
 * (`01-master-agreemnt`) and position-wise character comparison misaligns after
 * one — every later character reads as different, so the nearest match scores as
 * unrelated and the user gets no suggestion at all.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,                                  // deletion
        cur[j - 1] + 1,                               // insertion
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1) // substitution
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Close enough to suggest. Scales with length so short slugs stay strict. */
function close(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  const budget = Math.max(1, Math.floor(Math.max(a.length, b.length) / 6));
  return editDistance(a, b) <= budget;
}

async function listSources(): Promise<LibrarySource[]> {
  const r = await runCore(['mem', 'library', 'list', '--json'], { timeout: 20_000 });
  if (r.status !== 0) return [];
  try {
    const parsed = JSON.parse(r.stdout.trim() || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Resolve every `@doc:` token in a message.
 *
 * Small documents are inlined whole. Large ones contribute their CARD plus a
 * pointer to `vc_doc_read` — the tier-2 shape: the model is told what the
 * document is and how to open the part it needs, rather than being handed 55 KB
 * it mostly will not use.
 */
export async function resolveDocTokens(message: string): Promise<DocAttachResult> {
  const matches = [...String(message || '').matchAll(TOKEN_RE)];
  if (matches.length === 0) {
    return { text: message, context: '', notices: [], sawToken: false };
  }

  const sources = await listSources();
  const wanted = [...new Set(matches.map((m) => m[1].toLowerCase()))];
  const notices: string[] = [];
  const blocks: string[] = [];

  for (const slug of wanted) {
    const hit =
      sources.find((s) => slugOf(s.name, s.id) === slug) ??
      sources.find((s) => String(s.id) === slug);

    if (!hit) {
      const near = sources.map((s) => slugOf(s.name, s.id)).find((s) => close(s, slug));
      notices.push(
        `@doc:${slug} — no such document${near ? `; did you mean @doc:${near}?` : ''}`,
      );
      continue;
    }
    if (hit.broken_reason) {
      notices.push(`@doc:${slug} — this document is broken (${hit.broken_reason}) and was not attached`);
      continue;
    }

    const show = await runCore(
      ['mem', 'library', 'show', String(hit.id), '--json', '--max-chars', String(INLINE_BUDGET)],
      { timeout: 60_000 },
    );
    let card = '';
    let body = '';
    try {
      const d = JSON.parse(show.stdout.trim() || '{}');
      card = d.card || '';
      body = d.body || '';
    } catch {
      notices.push(`@doc:${slug} — could not be read and was not attached`);
      continue;
    }

    const truncated = body.includes('[… truncated');
    blocks.push(
      [
        `<document name="${hit.name}" id="${hit.id}">`,
        card ? card.trim() : '(no card — this document has not been summarized)',
        '',
        body.trim(),
        truncated
          ? `\n[Only part of this document is shown. Use vc_doc_read with id=${hit.id} and a \`section\` to read more.]`
          : '',
        '</document>',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    if (truncated) {
      notices.push(`@doc:${slug} — attached partially (${hit.chunks} chunks); ask for a section to see more`);
    }
  }

  return {
    // Strip the tokens: the attachment carries the content, and leaving the raw
    // token in the prompt just invites the model to echo it back.
    text: String(message).replace(TOKEN_RE, '').replace(/[ \t]{2,}/g, ' ').trim(),
    context: blocks.length ? `\n\n${blocks.join('\n\n')}\n` : '',
    notices,
    sawToken: true,
  };
}
