/**
 * Brain summary API — the one LLM call the memory graph is allowed to make.
 *
 * The Map tab is read-only and model-free by design: retrieval is FTS5 + local
 * ONNX vectors + a local cross-encoder, no model in the loop. This route is the
 * deliberate exception, and it is **pull-only**: nothing here runs until a
 * person clicks "Summarize" in the reading pane. Nothing is cached, nothing is
 * written back to memory.db, and no summary is ever extracted as a fact (lane
 * canon rule 5 — an LLM's read of your memories is ephemeral output, not a
 * memory).
 *
 *   POST /api/brain/summarize { kind: 'chunk' | 'entity', id }
 *     → { summary, model, title, subtitle, sources[], ms }
 *
 * The context it summarizes is assembled HERE, from the same read-only queries
 * the graph draws with — the memory itself plus its largest connections
 * (embedding neighbours, co-mentioned names, backlinks, near-duplicate copies,
 * open conflicts). The model never queries; it only reads what we hand it.
 *
 * Mounted ahead of `brainRouter` in src/index.ts because that router is GET-only
 * by construction (`405` on anything else) and must stay that way.
 */

import { Router, Request, Response } from 'express';
import { dayKeyOfNaiveUtc } from '../user-time.js';
import * as Q from '../brain/queries.js';
import { rawLLMCall, getActiveModelLabel } from '../llm.js';
import { ensureConversation, saveMessage } from '../conversation-store.js';

export const brainSummaryRouter = Router();

/** How much memory text the model gets. Local models have small windows and a
 *  person is waiting on this click, so the budget is deliberately tight. */
const MAX_CONTEXT_CHARS = 18_000;
const MAX_NEIGHBOURS = 8;
const MAX_MENTIONS = 18;
const MAX_CONNECTIONS = 12;
const EXCERPT = 700;

type Source = { id: string; title: string; path: string; why: string };

const oneLine = (s: string, n = 120): string =>
  (s || '').replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim().slice(0, n);

const excerpt = (s: string, n = EXCERPT): string => {
  const t = (s || '').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

const baseName = (p: string): string => (p || '').split('/').pop() || p || '';

/**
 * Time canon rule 3 — display parses naive-as-UTC and renders LOCAL. The model
 * is a display path here: whatever stamp we hand it is the date it writes into
 * the summary. Passing `created_at` raw made an evening memory read as tomorrow,
 * the exact bug the canon exists to stop (PLANS/PLAN-TIME-CANON.md). Mirrors the
 * brain UI's own whenMs/fmtDate pair.
 */
// The person's day, not the process's — `user-time.ts` is the one arbiter
// (its engine twin is `src/user_time.rs`). This used to build the key from
// `getFullYear()`, which is the machine's zone.
const localDay = dayKeyOfNaiveUtc;

/** Fetch full rows for a set of chunk ids, in the order given. */
function chunkRows(ids: string[]): Map<string, { id: string; path: string; text: string; chunk_tag: string; scope: string; created_at: string }> {
  const out = new Map<string, any>();
  if (!ids.length) return out;
  const d = Q.db();
  const stmt = d.prepare(
    `SELECT id, path, text, chunk_tag, COALESCE(scope,'') scope, created_at
     FROM memory_chunks WHERE id = ?`,
  );
  for (const id of ids) {
    const r = stmt.get(id) as any;
    if (r) out.set(id, r);
  }
  return out;
}

/** The memory, and the memories that are most plausibly ABOUT the same thing. */
function chunkContext(id: string): { title: string; subtitle: string; context: string; sources: Source[] } | null {
  const node: any = Q.nodeDetail(id);
  if (!node) return null;

  const sources: Source[] = [];
  const parts: string[] = [];
  const title = oneLine(node.text, 140) || id;

  parts.push('## The memory');
  parts.push(
    `- file: ${node.path}:${node.start_line ?? ''}\n` +
    `- kind: ${node.chunk_tag || 'UNTAGGED'}\n` +
    `- saved: ${localDay(node.created_at)}\n` +
    `- provenance: ${node.cls || 'yours'}${node.pinned ? ' (pinned)' : ''}`,
  );
  parts.push('```\n' + excerpt(node.text, 3_000) + '\n```');
  sources.push({ id: node.id, title, path: node.path, why: 'the memory itself' });

  const names: any[] = node.entities || [];
  if (names.length) {
    parts.push('## Names it mentions');
    parts.push(names.slice(0, 20).map((e) => `- ${e.canonical} (${e.kind})`).join('\n'));
  }

  // The "largest relatable connected memories": embedding neighbours first —
  // that is the axis the graph itself calls similarity, and it crosses files
  // and imports that the citation graph never links.
  let neighbours: Q.SimNeighbor[] = [];
  try {
    neighbours = Q.similarChunks(id, { topK: MAX_NEIGHBOURS, minCos: 0.45 });
  } catch { neighbours = []; }
  const nRows = chunkRows(neighbours.map((n) => n.chunk_id));
  const nLines: string[] = [];
  for (const n of neighbours) {
    const r = nRows.get(n.chunk_id);
    if (!r) continue;
    nLines.push(`### ${baseName(r.path)} · ${r.chunk_tag || 'UNTAGGED'} · ${localDay(r.created_at)} · closeness ${n.cos.toFixed(2)}\n${excerpt(r.text)}`);
    sources.push({ id: r.id, title: oneLine(r.text), path: r.path, why: `similar (${n.cos.toFixed(2)})` });
  }
  if (nLines.length) {
    parts.push('## Closest related memories (by meaning)');
    parts.push(nLines.join('\n\n'));
  }

  const backlinks: any[] = node.backlinks || [];
  if (backlinks.length) {
    parts.push('## Memories that cite this one');
    parts.push(backlinks.slice(0, 8).map((b) =>
      `- ${oneLine(b.preview)} — ${baseName(b.path)} · ${localDay(b.created_at)}`).join('\n'));
    for (const b of backlinks.slice(0, 8)) {
      sources.push({ id: b.id, title: oneLine(b.preview), path: b.path, why: 'cites this memory' });
    }
  }

  const siblings: any[] = node.siblings || [];
  if (siblings.length) {
    parts.push('## Near-duplicate copies of the same fact');
    parts.push(siblings.slice(0, 6).map((s) =>
      `- ${oneLine(s.preview)} — ${s.is_canonical ? 'canonical' : s.superseded_by ? 'superseded' : 'copy'}`).join('\n'));
  }

  const open = (node.conflicts || []).filter((c: any) => c.status === 'open');
  if (open.length) {
    parts.push('## Open contradictions');
    parts.push(open.map((c: any) =>
      `- "${c.slot}": imported says «${c.import_value}», you said «${c.native_value}» — UNRESOLVED`).join('\n'));
  }

  return {
    title,
    subtitle: `${node.chunk_tag || 'UNTAGGED'} · ${baseName(node.path)}`,
    context: parts.join('\n\n'),
    sources,
  };
}

/** A name, its strongest ties, and the memories that name it. */
function entityContext(eid: number): { title: string; subtitle: string; context: string; sources: Source[] } | null {
  const ent: any = Q.entityDetail(eid, MAX_MENTIONS);
  if (!ent) return null;

  const sources: Source[] = [];
  const parts: string[] = [];

  parts.push('## The name');
  const aliases = (ent.aliases || []).map((a: any) => a.display).filter((a: string) => a && a !== ent.canonical);
  parts.push(
    `- ${ent.canonical} (${ent.kind})\n` +
    (aliases.length ? `- also written as: ${aliases.join(', ')}\n` : '') +
    `- named in ${ent.mentions.length} memor${ent.mentions.length === 1 ? 'y' : 'ies'} (most recent first)`,
  );

  let ego: any = null;
  try { ego = Q.entityEgo(eid, {}, 1, MAX_CONNECTIONS, 1, 'chunk'); } catch { ego = null; }
  const conns: any[] = (ego?.connections || []).slice(0, MAX_CONNECTIONS);
  if (conns.length) {
    parts.push('## Who and what it turns up with (strongest first)');
    parts.push(conns.map((c) =>
      `- ${c.canonical} (${c.kind}) — ${c.w} shared memor${c.w === 1 ? 'y' : 'ies'}` +
      (c.predicate ? ` · stated relation: ${String(c.predicate).replace(/_/g, ' ')}` : '')).join('\n'));
  }

  const mentions: any[] = ent.mentions || [];
  if (mentions.length) {
    const rows = chunkRows(mentions.map((m) => m.id));
    parts.push('## The memories that name it');
    const lines: string[] = [];
    for (const m of mentions) {
      const r = rows.get(m.id);
      const text = r ? r.text : m.preview;
      lines.push(`### ${baseName(m.path)} · ${m.chunk_tag || 'UNTAGGED'} · ${localDay(m.created_at)}\n${excerpt(text, 500)}`);
      sources.push({ id: m.id, title: oneLine(text), path: m.path, why: `names ${ent.canonical}` });
    }
    parts.push(lines.join('\n\n'));
  }

  return {
    title: ent.canonical,
    subtitle: `${ent.kind} · ${ent.mentions.length} mention${ent.mentions.length === 1 ? '' : 's'}`,
    context: parts.join('\n\n'),
    sources,
  };
}

const SYSTEM = [
  "You are reading a slice of one person's personal memory store — facts their AI assistant",
  'saved for them over months. You are summarizing it back to that same person, so write in',
  'plain second person ("you"), never in the third person and never as a report about a user.',
  '',
  'Rules:',
  '- Ground every claim in the supplied memories. If they do not say something, do not say it.',
  '- Prefer the specific over the general: dates, names, numbers, decisions, the thing that changed.',
  '- Where two memories disagree, or one supersedes another, SAY SO plainly — that is the most',
  '  useful thing you can surface.',
  '- Be brief. This is read in a narrow side panel.',
].join('\n');

function promptFor(kind: 'chunk' | 'entity', title: string, context: string): string {
  const ask = kind === 'entity'
    ? [
      `Summarize what your memory holds about **${title}**.`,
      '',
      'Write, using markdown, and nothing else:',
      '',
      '**In short** — two or three sentences: who or what this is, and why it keeps coming up.',
      '',
      '**The threads** — 3 to 6 bullets, each one a distinct storyline or topic this name runs through.',
      '',
      '**Strongest connections** — 2 to 4 bullets naming the other people/orgs/projects it is most tied to, and what the tie actually is.',
      '',
      '**Worth a second look** — 1 to 3 bullets: contradictions, stale facts, or gaps. Write "Nothing stands out." if there are none.',
    ].join('\n')
    : [
      'Summarize this one memory and the memories nearest to it.',
      '',
      'Write, using markdown, and nothing else:',
      '',
      '**In short** — two or three sentences saying what this memory actually records.',
      '',
      '**What it connects to** — 3 to 6 bullets. Each bullet names a related memory and says what the RELATIONSHIP is (it repeats this, it contradicts it, it is the later decision, it is the same fact from another source). Do not just restate the related memory.',
      '',
      '**The bigger picture** — two or three sentences: what this cluster of memories adds up to.',
      '',
      '**Worth a second look** — 1 to 3 bullets: contradictions, stale facts, or gaps. Write "Nothing stands out." if there are none.',
    ].join('\n');

  return `${ask}\n\n---\n\n${context}`;
}

brainSummaryRouter.post('/', async (req: Request, res: Response) => {
  const started = Date.now();
  const kind = String(req.body?.kind || '').trim();
  const rawId = req.body?.id;

  if (kind !== 'chunk' && kind !== 'entity') {
    return res.status(400).json({ error: "kind must be 'chunk' or 'entity'" });
  }
  if (rawId === undefined || rawId === null || rawId === '') {
    return res.status(400).json({ error: 'id required' });
  }

  let built: { title: string; subtitle: string; context: string; sources: Source[] } | null;
  try {
    if (kind === 'entity') {
      const eid = parseInt(String(rawId).replace(/^entity:/, ''), 10);
      if (!Number.isFinite(eid)) return res.status(400).json({ error: 'entity id must be a number' });
      built = entityContext(eid);
    } else {
      built = chunkContext(String(rawId));
    }
  } catch (err) {
    console.error('[brain-summary] context build failed:', err);
    return res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
  }
  if (!built) return res.status(404).json({ error: 'not found' });

  let context = built.context;
  let truncated = false;
  if (context.length > MAX_CONTEXT_CHARS) {
    context = context.slice(0, MAX_CONTEXT_CHARS) + '\n\n…(older memories trimmed to fit)';
    truncated = true;
  }

  // Read the provider BEFORE the call, not just for the label: getActiveModelLabel
  // runs syncProviderFromDb(), so a model switched in Settings since boot is the
  // one that answers. Without it a stale provider answers and the label lies.
  const model = getActiveModelLabel();

  let summary: string;
  try {
    // TURNLESS: this runs from the memory graph's reading pane, which belongs to
    // no conversation — there is no turn to log it under. It becomes a turn only
    // if the person clicks "Continue in chat", which sends a normal message.
    summary = await rawLLMCall(promptFor(kind as 'chunk' | 'entity', built.title, context), SYSTEM, {
      maxTokens: 900,
      timeoutMs: 120_000,
      agent: 'memory-summary',
    });
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    console.error('[brain-summary] llm call failed:', msg);
    return res.status(502).json({ error: `The model didn't answer: ${msg}`, model });
  }

  // rawLLMCall does not throw — every provider failure (no endpoint configured,
  // HTTP 5xx, a timeout) comes back as the empty string. Returning 200 with an
  // empty summary would render as a blank panel that looks like the model had
  // nothing to say, which is a different and much worse claim than "it failed".
  if (!summary || !summary.trim()) {
    console.error(`[brain-summary] empty completion from ${model}`);
    return res.status(502).json({
      error: `${model} returned nothing. Check that the model is configured and reachable in Settings → Models, then try again.`,
      model,
    });
  }

  return res.status(200).set('cache-control', 'no-store').json({
    kind,
    id: String(rawId),
    title: built.title,
    subtitle: built.subtitle,
    summary: summary.trim(),
    model,
    sources: built.sources.slice(0, 24),
    context_chars: context.length,
    truncated,
    ms: Date.now() - started,
  });
});

/**
 * POST /api/brain/summarize/to-chat — carry a summary into a real conversation.
 *
 * The summary is seeded as the ASSISTANT's opening message, not as a user turn
 * quoting itself. That distinction is the whole point: a chat that opens with
 * "I'm carrying this over from my memory map: <summary>" in the user's own voice
 * reads as the user pasting their own notes at Vodou, and the first thing the
 * model does is summarize the summary. Seeded as an assistant message, the tab
 * simply IS the summary, and the user's first message is their real question.
 *
 * Written through `conversation-store` rather than rendered client-side only, so
 * the text is in `loadMessages` history when the next turn assembles context —
 * a DOM-only seed would leave the model with no idea what the thread is about.
 */
brainSummaryRouter.post('/to-chat', (req: Request, res: Response) => {
  const conversationId = String(req.body?.conversationId || '').trim();
  const summary = String(req.body?.summary || '').trim();
  const title = String(req.body?.title || '').trim();
  const subtitle = String(req.body?.subtitle || '').trim();
  const model = String(req.body?.model || '').trim();
  const sourceCount = Number(req.body?.sourceCount);
  const projectId = req.body?.projectId ? String(req.body.projectId) : null;

  if (!/^[A-Za-z0-9:_.-]{4,120}$/.test(conversationId)) {
    return res.status(400).json({ error: 'conversationId required' });
  }
  if (!summary) return res.status(400).json({ error: 'summary required' });
  if (summary.length > 60_000) return res.status(400).json({ error: 'summary too large' });

  // One line of provenance, then the summary verbatim. A model's read of your
  // memories is not itself a memory (lane canon rule 5) — the thread has to say
  // which model wrote it and how much it actually read.
  const head = title ? `✧ **${title}**${subtitle ? ` — ${subtitle}` : ''}\n\n` : '';
  // Plain text, no emphasis marks: the chat renderer implements `**bold**` and
  // NOTHING else — `*x*` and `_x_` both render as literal asterisks/underscores.
  const foot = (model || Number.isFinite(sourceCount))
    ? `\n\n— ${[model, Number.isFinite(sourceCount)
      ? `read from ${sourceCount} memor${sourceCount === 1 ? 'y' : 'ies'} in your memory map`
      : ''].filter(Boolean).join(' · ')}`
    : '';

  const seeded = head + summary + foot;
  try {
    ensureConversation(conversationId, title ? title.slice(0, 120) : 'Memory summary', 'web', undefined, projectId);
    saveMessage(conversationId, 'assistant', seeded, null, null, null, null, null, model || null);

    // The DB row is the whole seed. The in-memory transcript the provider is
    // actually prompted from is filled by `hydrateLlmConversationFromDb` on the
    // first switch or turn — which is also where the assistant-first case is
    // handled, so this route does not (and must not) write the manager itself:
    // `addAssistantMessage` on an empty conversation is a no-op, because
    // trimHistory drops a leading assistant message. Measured before the fix:
    // `manager_now=0` immediately after the call.
  } catch (err) {
    console.error('[brain-summary] to-chat seed failed:', err);
    return res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
  }

  return res.status(200).set('cache-control', 'no-store').json({ ok: true, conversationId });
});
