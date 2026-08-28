/**
 * Conversation Persistence — SQLite-backed storage for chat history
 * Survives server restarts. Gateway owns its own DB (gateway.db).
 *
 * PLAN-CONTINUITY-PRIMITIVE Phase 1 — every gateway_messages INSERT carries
 * principal_id (the install-owner's principal). The id is read once from
 * vodou-core.db and cached in-process. External callers (npm channel
 * packages) use the HTTP endpoint POST /api/v2/channels/turns instead of
 * importing this module directly.
 */

import { getDb, getGatewayDb } from './db.js';
import { reportWriteCorruption } from './db-health.js';

/**
 * Lazy-cached install-owner principal id. Read once from vodou-core.db on
 * first access. Returns null if the principal isn't seeded yet (pre-
 * `vodou-core continuity init`); the caller falls back to NULL principal_id
 * which is recovered later by the gateway_extractor backfill.
 */
let cachedSelfPrincipalId: string | undefined;
function getSelfPrincipalId(): string | null {
  if (cachedSelfPrincipalId !== undefined) return cachedSelfPrincipalId;
  try {
    const row = getDb()
      .prepare(
        "SELECT id FROM principals WHERE is_self = 1 AND merged_into IS NULL LIMIT 1"
      )
      .get() as { id: string } | undefined;
    if (row?.id) {
      cachedSelfPrincipalId = row.id; // cache positive only — retry on miss
      return row.id;
    }
  } catch {
    // Table doesn't exist yet (pre-migration 068) or DB error — fall through
  }
  return null;
}

export interface StoredMessage {
  id: number;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
  /** COHERENCE D-6 — the turn this message belongs to, when the lane minted one. */
  turn_id?: string | null;
  /** Slack/Telegram display name for this user row (optional; null for web-only chats). */
  sender_label?: string | null;
}

export interface StoredConversation {
  id: string;
  title: string;
  source?: string;
  sender_name?: string;
  created_at: string;
  updated_at: string;
  /** PLAN-GATEWAY-PROJECTS — owning project; NULL/undefined = Default. */
  project_id?: string | null;
}

/**
 * Ensure a conversation exists in the DB
 */
export function ensureConversation(conversationId: string, title?: string, source?: string, senderName?: string, projectId?: string | null): void {
  const db = getGatewayDb();
  const existing = db.prepare('SELECT id FROM gateway_conversations WHERE id = ?').get(conversationId);
  if (!existing) {
    const principalId = getSelfPrincipalId();
    // project_id set at creation only (NULL = Default project). An existing
    // conversation's project is never reassigned by a later message.
    db.prepare(
      'INSERT INTO gateway_conversations (id, title, source, sender_name, principal_id, project_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(conversationId, title || 'New Chat', source || 'web', senderName || null, principalId, projectId ?? null);
  } else if (source && source !== 'web') {
    // Update source/sender if not already set (first channel message tags it)
    db.prepare(
      'UPDATE gateway_conversations SET source = ?, sender_name = COALESCE(sender_name, ?) WHERE id = ? AND (source IS NULL OR source = \'web\')'
    ).run(source, senderName ?? null, conversationId);
  }
  // Unified Slack workbench: refresh tab title + last speaker on every inbound message.
  if (conversationId === 'workbench:channel:slack' && source === 'slack' && senderName?.trim()) {
    const sn = senderName.trim();
    const t = ('Slack · ' + sn).substring(0, 120);
    db.prepare(
      'UPDATE gateway_conversations SET title = ?, sender_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(t, sn, conversationId);
  }
}

/**
 * Save a message to the DB.
 *
 * PLAN-CONTINUITY-PRIMITIVE Phase 1 — every row gets principal_id populated
 * from the cached self-principal lookup. If the principal isn't seeded yet
 * (pre-`continuity init`), principal_id stays NULL and gets backfilled by
 * the gateway extractor's principal_id sync on the next extraction cycle
 * (no data loss; identical user-visible behavior).
 */
/**
 * PLAN-HISTORY-BACKFILL P0 — optional idempotency.
 *
 * Pass `dedupeKey` and the row becomes INSERT OR IGNORE against a partial UNIQUE
 * index, so re-delivering the same turn is a no-op. Callers that pass nothing
 * behave exactly as before — native gateway chat must stay able to store two
 * identical turns, because a user genuinely does say "yes" twice.
 *
 * Returns true when a row was actually written, false when it was suppressed as a
 * duplicate. The old signature returned void; every existing caller ignores the
 * return, so this is source-compatible.
 */
export function saveMessage(
  conversationId: string,
  role: string,
  content: string,
  senderLabel?: string | null,
  skillName?: string | null,
  dedupeKey?: string | null,
  sourceMsgId?: string | null,
  claimWindowSecs?: number | null,
  /** PLAN-CAPTURE-FEED P2 — model that produced an assistant turn, when known. */
  model?: string | null,
  /**
   * PLAN-HISTORY-BACKFILL — this turn came from a HISTORIC transcript, not a live
   * exchange. Widens adopt-in-place to reach rows that predate keyed capture and
   * lie outside the live claim window; see the note above the claim.
   */
  isBackfill?: boolean,
  /**
   * E12 (PLAN-MEMORY-EVENT-TIME) — the turn's REAL creation time, when the
   * provider's own API told us. Naive-UTC `YYYY-MM-DD HH:MM:SS`.
   *
   * Omitted/null keeps the existing `CURRENT_TIMESTAMP` default, i.e. arrival
   * time. That default is correct for a live turn (it arrives as it is sent) and
   * wrong for a BACKFILL, where a months-old transcript would otherwise be dated
   * to now. Never invent one: an absent time must stay absent so the recency
   * ranker can tell "known old" from "unknown".
   */
  createdAt?: string | null,
  /**
   * PLAN-MEMORY-ON-EVERY-PAGE P0 — the page that was open while this turn
   * happened, already normalized (`host/path`). Presence is an ATTRIBUTE of a
   * memory being created, not a browsing log — see the note in db.ts. Null
   * whenever the toggle is off, the extension is not connected, or the tab is
   * not an http(s) page, which is the overwhelming majority.
   */
  pageUrl?: string | null,
  /**
   * COHERENCE F8 / D-6 — the turn this message belongs to.
   *
   * An OPTIONS BAG rather than a 13th positional: this function already takes
   * twelve, and threading a thirteenth through eighteen assistant call sites by
   * position is how an argument ends up one slot off in the one lane nobody
   * re-reads. Only lanes that mint a turn id pass it; everything else keeps the
   * NULL it always had.
   *
   * This is the join key between `gateway_messages` (here) and `turn_receipts`
   * (vodou-core.db), which is what lets a reloaded conversation show what each
   * turn actually used instead of going silent.
   */
  opts?: { turnId?: string | null },
): boolean {
  try {
    const db = getGatewayDb();
    // PLAN-NUL-BYTE-EXTRACTION-STALL — a NUL byte in a TEXT column is never
    // meaningful and poisons every downstream consumer. One reached memory.db on
    // 2026-07-28 via a pasted Meta AI binary WebSocket frame dump, and the
    // extractor then failed the WHOLE conversation ("nul byte found in provided
    // data") 6-8 times over, silently costing every fact in two full sessions.
    //
    // Stripped rather than rejected: the surrounding turn is legitimate and the
    // user should not lose 8,740 bytes of real content because 1 byte was binary.
    // Done here, not in one capture lane, because this is the single write path
    // every TypeScript producer goes through.
    content = typeof content === 'string' ? content.replace(/\u0000/g, '') : content;
    ensureConversation(conversationId);
    const principalId = getSelfPrincipalId();
    const label = senderLabel && String(senderLabel).trim() ? String(senderLabel).trim().substring(0, 200) : null;
    // Phase 6: tag skill-emitted turns so the hydrator can strip them after uninstall.
    const skill = skillName && String(skillName).trim() ? String(skillName).trim().substring(0, 120) : null;
    const dk = dedupeKey && String(dedupeKey).trim() ? String(dedupeKey).trim().substring(0, 200) : null;
    const smid = sourceMsgId && String(sourceMsgId).trim() ? String(sourceMsgId).trim().substring(0, 200) : null;
    // PLAN-CAPTURE-FEED P2 — sniffed from the provider's own payload, so treat it
    // as untrusted text: bounded, and NULL rather than empty.
    const mdl = model && String(model).trim() ? String(model).trim().substring(0, 80) : null;
    // Bounded and NULL-rather-than-empty, same discipline as every other id here.
    const tid = opts?.turnId && String(opts.turnId).trim()
      ? String(opts.turnId).trim().substring(0, 200)
      : null;
    // ADOPT-IN-PLACE (PLAN-HISTORY-BACKFILL §2, mixed-key-scheme gap).
    //
    // The key is `id:<providerMsgId>` when an id is available and `h:<bucket>:<hash>`
    // when it is not. The SAME turn seen once each way yields two different keys and
    // stores twice. Observed live 2026-07-27 while rolling the extension, and it is
    // structural for backfill: the live STREAM often has no per-message id (the
    // user's prompt rides the request body), while the history TRANSCRIPT always
    // does. Every conversation both live-captured and later backfilled would
    // duplicate its no-id turns — precisely the workload backfill introduces.
    //
    // So when a turn arrives WITH an id, first try to claim an existing hash-keyed
    // row for the same conversation/role/content and upgrade its key in place.
    //
    // ASYMMETRIC ON PURPOSE: an id may supersede a hash; a hash may NEVER supersede
    // an id. A content hash is not evidence of identity.
    //
    // Bounded by the same window the hash fallback already uses, so this is exactly
    // as safe as that fallback and no safer: two genuinely identical turns inside
    // the window are already collapsed by the hash path, and outside it neither
    // path claims. Widening the window would start eating real repeats.
    // ── BACKFILL widens the claim, because both bounds above are wrong for it ──
    //
    // Measured live 2026-08-09, and it is the exact duplication this mechanism was
    // built to stop: a ChatGPT thread captured forward-only on 2026-07-25 was
    // backfilled today. All 6 history turns inserted; the 4 already present became
    // duplicates. Two independent reasons the claim could not fire:
    //
    //   1. `dedupe_key IS NOT NULL` — those rows predate keyed capture, so they
    //      carry NULL and were invisible to the claim.
    //   2. `created_at >= now - 600s` — they were 374 HOURS old. The live window is
    //      off by a factor of ~2000 for a feature whose whole purpose is old content.
    //
    // For a backfill batch, drop both. The safety argument the narrow window rests
    // on ("two identical turns inside the window are already collapsed") is a
    // LIVE-capture argument; a historic transcript is a different shape. Each
    // history turn carries a distinct provider id, and the claim requires
    // `source_msg_id IS NULL`, so two genuine repeats of "yes" in one conversation
    // claim two different unclaimed rows — one each — instead of collapsing.
    //
    // Still scoped to conversation + role + EXACT content, and still asymmetric: an
    // id may supersede a hash or an unkeyed row, never the reverse. It also cannot
    // touch native chat, because the claim only runs when a dedupe key AND a
    // provider id are both present — which happens on the capture path alone.
    if (dk !== null && smid !== null) {
      const win = Math.max(60, Number(claimWindowSecs || 600));
      try {
        const claimed = isBackfill
          ? db.prepare(
            `UPDATE gateway_messages
                SET dedupe_key = ?, source_msg_id = ?
              WHERE rowid = (
                SELECT rowid FROM gateway_messages
                 WHERE conversation_id = ? AND role = ? AND content = ?
                   AND (source_msg_id IS NULL OR source_msg_id = '')
                 ORDER BY id DESC LIMIT 1)`
          ).run(dk, smid, conversationId, role, content)
          : db.prepare(
          `UPDATE gateway_messages
              SET dedupe_key = ?, source_msg_id = ?
            WHERE rowid = (
              SELECT rowid FROM gateway_messages
               WHERE conversation_id = ? AND role = ? AND content = ?
                 AND dedupe_key IS NOT NULL
                 AND (source_msg_id IS NULL OR source_msg_id = '')
                 AND created_at >= datetime('now', ?)
               ORDER BY id DESC LIMIT 1)`
        ).run(dk, smid, conversationId, role, content, `-${win} seconds`);
        if (Number((claimed as any)?.changes || 0) > 0) {
          console.log(`[conversation-store] adopted a hash-keyed row into id ${smid} (${conversationId})`);
          return false;   // already stored — key upgraded, no new row
        }
      } catch (e) {
        // A unique collision here means an id-keyed row already exists for this
        // turn, i.e. it is a duplicate either way. Anything else is worth seeing.
        const ec = (e as any)?.errcode;
        if (ec !== 2067) {
          console.warn(`[conversation-store] adopt-in-place failed (non-fatal): ${(e as Error).message}`);
        } else {
          return false;
        }
      }
    }

    // PLAN-CAPTURE-TRUNCATION-RACE P2 — a longer version of the SAME message wins.
    //
    // A streaming reply can be snapshotted mid-generation. The dedupe key for an
    // id-keyed turn is the provider's message id and deliberately ignores content,
    // so the first version seen is the only one ever stored — and for a streaming
    // reply the first version is the worst one. On 2026-07-30 a long ChatGPT answer
    // was stored, permanently, as the three characters "Vod".
    //
    // So on collision: if this is demonstrably MORE OF THE SAME MESSAGE, replace the
    // content in place.
    //
    // Two guards, both load-bearing:
    //   • longer only — a late, shorter replay must never clobber a complete turn.
    //     Makes the operation idempotent and order-independent, which matters
    //     because reconnect replays arrive out of order.
    //   • prefix only — the stored text must be a prefix of the incoming text. That
    //     is what distinguishes "the same reply, more of it" from a REGENERATED
    //     answer that happens to reuse the id. Without it, regenerating would
    //     silently overwrite the original.
    if (dk !== null && typeof content === 'string') {
      try {
        const prev = db.prepare(
          'SELECT id, content FROM gateway_messages WHERE dedupe_key = ? LIMIT 1',
        ).get(dk) as { id?: number; content?: string } | undefined;
        const prevId = typeof prev?.id === 'number' ? prev.id : null;
        if (prev && prevId !== null && typeof prev.content === 'string') {
          const stored = prev.content;
          if (content.length > stored.length && content.startsWith(stored)) {
            db.prepare('UPDATE gateway_messages SET content = ? WHERE id = ?').run(content, prevId);
            console.log(
              `[conversation-store] upgraded a truncated turn ${stored.length}→${content.length} chars ` +
              `(${conversationId} msg ${prevId})`,
            );
            requeueExtractionFor(prevId);
          }
          // Same-or-shorter: an ordinary duplicate. Nothing to do either way.
          return false;
        }
      } catch (e) {
        // Never let the upgrade path block a legitimate insert.
        console.warn(`[conversation-store] truncation-upgrade check failed (non-fatal): ${(e as Error).message}`);
      }
    }

    // NOT `INSERT OR IGNORE`. OR IGNORE swallows EVERY constraint failure — a NULL
    // role, a NOT NULL violation, an FK miss — and returns changes=0 exactly like a
    // duplicate. That would silently reintroduce the class of failure the P1-5 work
    // below was written to eliminate, for all ~20 callers including native chat.
    // Verified 2026-07-27: `INSERT OR IGNORE … (conversation_id, role) VALUES ('x', NULL)`
    // drops the row and reports success.
    //
    // Instead: plain INSERT, and catch ONLY the unique-violation on our own dedupe
    // index. Everything else keeps throwing, gets logged, and re-raises unchanged.
    try {
      db.prepare(
        createdAt
          ? 'INSERT INTO gateway_messages (conversation_id, role, content, principal_id, sender_label, skill_name, dedupe_key, source_msg_id, model, page_url, turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          : 'INSERT INTO gateway_messages (conversation_id, role, content, principal_id, sender_label, skill_name, dedupe_key, source_msg_id, model, page_url, turn_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(...(createdAt
        ? [conversationId, role, content, principalId, label, skill, dk, smid, mdl, pageUrl ?? null, tid, createdAt]
        : [conversationId, role, content, principalId, label, skill, dk, smid, mdl, pageUrl ?? null, tid]));
    } catch (err) {
      // Discriminate on errcode, NOT on `code`.
      //
      // node:sqlite reports `code: 'ERR_SQLITE_ERROR'` for EVERY sqlite failure —
      // unique, NOT NULL, foreign key, all of them. A first cut of this checked
      // `code === 'SQLITE_CONSTRAINT_UNIQUE'` (the better-sqlite3 spelling); it
      // never matches, so every duplicate would have re-thrown and taken
      // handleCaptureTurn down with it the first time anyone re-opened a
      // conversation. Verified 2026-07-27 against node:sqlite:
      //
      //   UNIQUE      -> errcode 2067, "UNIQUE constraint failed: gateway_messages.dedupe_key"
      //   NOT NULL    -> errcode 1299
      //   FOREIGN KEY -> errcode  787   (FKs ARE enforced here)
      //
      // Match the errcode AND the column name, so a unique violation on some
      // future index cannot be mistaken for a capture duplicate.
      const e = err as any;
      const msg = String(e?.message || '');
      const SQLITE_CONSTRAINT_UNIQUE = 2067;
      const isDedupeCollision = dk !== null
        && (e?.errcode === SQLITE_CONSTRAINT_UNIQUE || e?.code === 'SQLITE_CONSTRAINT_UNIQUE')
        && /dedupe_key/.test(msg);
      if (!isDedupeCollision) throw err;     // real failure — stay loud
      return false;                          // duplicate — do not touch updated_at
    }
    db.prepare(
      'UPDATE gateway_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(conversationId);
    return true;
  } catch (e) {
    // P1-5: chat-history persistence failures were swallowed by ~20 empty
    // `catch {}` sites at the call sites (and un-wrapped calls could crash a
    // handler). Log centrally here so a gateway.db write error (locked, disk
    // full, schema drift) is never silent, then re-throw to preserve the
    // existing throw contract — callers that wrap keep swallowing, but the
    // failure is now visible in the log.
    console.error(`[conversation-store] saveMessage FAILED (conv=${conversationId} role=${role}): ${(e as Error).message}`);
    // A write that failed because the FILE is damaged is the signal that took
    // 46 hours and 92 silent failures to notice on 2026-08-15. Latch it so
    // /health reports it immediately instead of it living only in this log.
    reportWriteCorruption(e);
    throw e;
  }
}

/**
 * Phase 6: mark all turns emitted by a (just-uninstalled) skill as excluded
 * from future LLM context. The rows stay in the DB for audit/transcript but
 * the conversation hydrator skips them when building the message array for
 * the next LLM call — so the model doesn't pattern-match against menus from
 * a skill that no longer exists.
 *
 * Returns the number of rows marked.
 */
export function excludeSkillMessagesFromContext(skillName: string, opts?: { contentPattern?: string }): number {
  if (!skillName || !skillName.trim()) return 0;
  const db = getGatewayDb();
  // First: clean exact-tag matches (forward-looking, where saveMessage tagged the row)
  const tagRes = db.prepare(
    'UPDATE gateway_messages SET excluded_from_context = 1 WHERE skill_name = ? AND excluded_from_context = 0'
  ).run(skillName.trim());
  let total = Number(tagRes.changes ?? 0);
  // Optional retroactive cleanup: assistant turns whose content contains a
  // distinctive signature (e.g., the skill's stopping-point menu title).
  // This handles existing poisoned conversations where saveMessage didn't
  // tag the row because the schema hadn't shipped yet.
  if (opts?.contentPattern && opts.contentPattern.trim().length >= 4) {
    const pat = '%' + opts.contentPattern.trim().replace(/[%_]/g, (m) => '\\' + m) + '%';
    const sigRes = db.prepare(
      "UPDATE gateway_messages SET excluded_from_context = 1, skill_name = COALESCE(skill_name, ?) WHERE role = 'assistant' AND excluded_from_context = 0 AND content LIKE ? ESCAPE '\\'"
    ).run(skillName.trim(), pat);
    total += Number(sigRes.changes ?? 0);
  }
  return total;
}

/**
 * Load messages for a conversation. By default skips messages tagged with a
 * skill that has since been uninstalled (excluded_from_context = 1). Pass
 * `includeExcluded: true` for transcript/audit views that need everything.
 */
export function loadMessages(conversationId: string, options?: { includeExcluded?: boolean }): StoredMessage[] {
  const db = getGatewayDb();
  const where = options?.includeExcluded
    ? 'conversation_id = ?'
    : 'conversation_id = ? AND (excluded_from_context IS NULL OR excluded_from_context = 0)';
  return db.prepare(
    `SELECT id, conversation_id, role, content, created_at, sender_label FROM gateway_messages WHERE ${where} ORDER BY id ASC`
  ).all(conversationId) as unknown as StoredMessage[];
}

/**
 * Load all conversations (for listing/tabs).
 *
 * PLAN-UNIVERSAL-MEMORY Phase 0 — imported conversation corpora land in
 * gateway_conversations with `source = 'import:<src>'`. A multi-year ChatGPT
 * archive is thousands of conversations; surfacing them here would drown the
 * tab strip. Default-exclude them; the Imports UI (Phase 5) passes
 * `{ includeImports: true }` (or uses loadImportedConversations) when it wants them.
 */
export function loadConversations(opts?: { includeImports?: boolean; includeCaptures?: boolean }): StoredConversation[] {
  const db = getGatewayDb();
  // Imports AND captures (capture:web:*, capture:ide:*) are raw memory-source
  // buffers, not chats — they belong in the Sources panel + Brain constellation,
  // not the conversation dock. Excluded by default; messaging channels, board,
  // skills, and real chats keep their normal source and stay. Opt back in for
  // surfaces that genuinely list capture rows.
  const importFilter = opts?.includeImports ? '' : " AND source NOT LIKE 'import:%'";
  const captureFilter = opts?.includeCaptures ? '' : " AND source NOT LIKE 'capture:%'";
  return db.prepare(
    `SELECT id, title, source, sender_name, created_at, updated_at, project_id FROM gateway_conversations WHERE deleted_at IS NULL${importFilter}${captureFilter} ORDER BY updated_at DESC`
  ).all() as unknown as StoredConversation[];
}

/**
 * PLAN-GATEWAY-PROJECTS — conversations belonging to a project. 'proj_default'
 * (or a null/empty id) also includes legacy conversations with project_id IS NULL.
 * Imported conversations are excluded by default (see loadConversations).
 */
export function loadConversationsByProject(projectId: string, opts?: { includeImports?: boolean; includeCaptures?: boolean }): StoredConversation[] {
  const db = getGatewayDb();
  const isDefault = !projectId || projectId === 'proj_default';
  const importFilter = opts?.includeImports ? '' : " AND source NOT LIKE 'import:%'";
  // Captures are memory sources, not project chats — keep them out of every
  // project's conversation list (Sources/Brain own them). See loadConversations.
  const captureFilter = opts?.includeCaptures ? '' : " AND source NOT LIKE 'capture:%'";
  const where = (isDefault
    ? "deleted_at IS NULL AND (project_id IS NULL OR project_id = 'proj_default')"
    : 'deleted_at IS NULL AND project_id = ?') + importFilter + captureFilter;
  const stmt = db.prepare(
    `SELECT id, title, source, sender_name, created_at, updated_at, project_id FROM gateway_conversations WHERE ${where} ORDER BY updated_at DESC`
  );
  return (isDefault ? stmt.all() : stmt.all(projectId)) as unknown as StoredConversation[];
}

/**
 * PLAN-UNIVERSAL-MEMORY Phase 0 — list ONLY imported conversations, newest first,
 * for the Console "Imports" tab. `sourceFilter` narrows to one source
 * (e.g. 'chatgpt' → source = 'import:chatgpt'); omit for all imports.
 */
export function loadImportedConversations(sourceFilter?: string): StoredConversation[] {
  const db = getGatewayDb();
  if (sourceFilter && sourceFilter.trim()) {
    return db.prepare(
      'SELECT id, title, source, sender_name, created_at, updated_at, project_id FROM gateway_conversations WHERE deleted_at IS NULL AND source = ? ORDER BY updated_at DESC'
    ).all(`import:${sourceFilter.trim()}`) as unknown as StoredConversation[];
  }
  return db.prepare(
    "SELECT id, title, source, sender_name, created_at, updated_at, project_id FROM gateway_conversations WHERE deleted_at IS NULL AND source LIKE 'import:%' ORDER BY updated_at DESC"
  ).all() as unknown as StoredConversation[];
}

/**
 * Expert-persona skill workbenches (`workbench:skill:<name>`), newest first.
 *
 * Which skills are "surfaced" into the dock's Skills tier has always been
 * client-only state (localStorage `vodou-surfaced-workbenches`) — so clearing
 * site data or opening a different browser profile silently emptied that tier
 * with no way back, while the conversations themselves sat here untouched. This
 * is the recovery path: the client seeds its surface list from these rows on
 * first load. Deliberately NOT age-filtered — a persona you used in May is still
 * a persona you want in the dock today.
 */
export function loadSkillWorkbenches(): StoredConversation[] {
  const db = getGatewayDb();
  return db.prepare(
    "SELECT id, title, source, sender_name, created_at, updated_at, project_id FROM gateway_conversations WHERE deleted_at IS NULL AND id LIKE 'workbench:skill:%' ORDER BY updated_at DESC"
  ).all() as unknown as StoredConversation[];
}

/**
 * PLAN-UNIVERSAL-MEMORY — insert an imported message with an EXPLICIT created_at
 * (the imported turn's original timestamp), which the normal saveMessage() path
 * can't do because gateway_messages.created_at defaults to CURRENT_TIMESTAMP.
 * Used by the single-conversation capture lane (Phase 4); the bulk export lane
 * writes gateway.db directly from Rust. `conversationId` must already be an
 * `import:<source>:<orig-uuid>` id ensured via ensureImportedConversation().
 * FTS triggers fire on this INSERT automatically — no extra maintenance needed.
 */
export function saveImportedMessage(
  conversationId: string,
  role: string,
  content: string,
  createdAt: string,
  senderLabel?: string | null,
): void {
  const db = getGatewayDb();
  const principalId = getSelfPrincipalId();
  const label = senderLabel && String(senderLabel).trim() ? String(senderLabel).trim().substring(0, 200) : null;
  db.prepare(
    'INSERT INTO gateway_messages (conversation_id, role, content, created_at, principal_id, sender_label) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(conversationId, role, content, createdAt, principalId, label);
  db.prepare(
    'UPDATE gateway_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(conversationId);
}

/**
 * PLAN-UNIVERSAL-MEMORY — ensure an imported conversation row exists with its
 * `import:<source>` provenance intact. Unlike ensureConversation(), this never
 * runs the "first channel message overwrites a 'web' row" dance — imported ids
 * are deterministic (`import:<source>:<orig-uuid>`) and never collide with web
 * conversations, so the source must be written verbatim and left alone.
 */
export function ensureImportedConversation(
  conversationId: string,
  source: string,
  title?: string,
  projectId?: string | null,
): void {
  const db = getGatewayDb();
  const existing = db.prepare('SELECT id FROM gateway_conversations WHERE id = ?').get(conversationId);
  if (!existing) {
    const principalId = getSelfPrincipalId();
    db.prepare(
      'INSERT INTO gateway_conversations (id, title, source, principal_id, project_id) VALUES (?, ?, ?, ?, ?)'
    ).run(conversationId, title || 'Imported chat', source, principalId, projectId ?? null);
  }
}

/**
 * Get a single conversation by ID
 */
export function getConversation(conversationId: string): StoredConversation | undefined {
  const db = getGatewayDb();
  return db.prepare(
    'SELECT id, title, source, sender_name, created_at, updated_at, project_id FROM gateway_conversations WHERE id = ?'
  ).get(conversationId) as StoredConversation | undefined;
}

/**
 * Update conversation title
 */
export function updateConversationTitle(conversationId: string, title: string): void {
  const db = getGatewayDb();
  db.prepare(
    'UPDATE gateway_conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(title, conversationId);
}

/**
 * PLAN-CAPTURE-FEED P1 — remember where a captured conversation lives on the
 * provider's site, so the feed can link back to the real thread.
 *
 * Last write wins: a thread's URL legitimately changes (Duck.ai mints a new
 * conversation id on the first message of a new chat), and the most recent one is
 * the one that will still resolve.
 *
 * Only http(s) is stored. The value comes from a page we do not control, and it
 * ends up in an href — a `javascript:` URL here would be an XSS vector delivered
 * by whichever site we captured from.
 */
export function setConversationSourceUrl(conversationId: string, url: string): void {
  if (!url || !/^https?:\/\//i.test(url)) return;
  try {
    getGatewayDb()
      .prepare('UPDATE gateway_conversations SET source_url = ? WHERE id = ?')
      .run(String(url).substring(0, 2000), conversationId);
  } catch { /* non-fatal: the feed degrades to no link */ }
}

/** Re-home a conversation under a project (PLAN-PROJECT-SCOPED-DOCK Phase 2).
 *  Used when a scheduled skill-console is created while a project is active so
 *  its dock tab follows that project. proj_default → NULL (the Default home). */
export function setConversationProject(conversationId: string, projectId: string | null | undefined): void {
  const db = getGatewayDb();
  const pid = !projectId || projectId === 'proj_default' ? null : projectId;
  db.prepare('UPDATE gateway_conversations SET project_id = ? WHERE id = ?').run(pid, conversationId);
}

/**
 * Soft-delete a conversation (marks deleted_at, preserves data for recovery)
 */
export function deleteConversation(conversationId: string): void {
  const db = getGatewayDb();
  db.prepare(
    'UPDATE gateway_conversations SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(conversationId);
}

/**
 * Restore a soft-deleted conversation. Bumps updated_at so the conversation
 * passes the 7-day window the WS connect handler uses when hydrating tabs.
 */
export function restoreConversation(conversationId: string): void {
  const db = getGatewayDb();
  db.prepare(
    'UPDATE gateway_conversations SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(conversationId);
}

/**
 * Recently closed (soft-deleted) conversations, most recently closed first —
 * powers the tab strip's "Recently closed" restore menu.
 */
export function listRecentlyClosedConversations(limit = 20): Array<StoredConversation & { deleted_at: string }> {
  const db = getGatewayDb();
  return db.prepare(
    'SELECT id, title, source, sender_name, created_at, updated_at, deleted_at FROM gateway_conversations WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?'
  ).all(limit) as unknown as Array<StoredConversation & { deleted_at: string }>;
}

/**
 * Load the N most recent messages (paginated UI history only — NOT for LLM seeding).
 * LLM seeding: hydrateLlmConversationFromDb() calls loadMessages() when the in-memory manager is empty.
 */
export function loadRecentMessages(conversationId: string, limit: number): StoredMessage[] {
  const db = getGatewayDb();
  const rows = db.prepare(
    'SELECT id, conversation_id, role, content, created_at, sender_label, turn_id FROM gateway_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?'
  ).all(conversationId, limit) as unknown as StoredMessage[];
  return rows.reverse(); // Restore chronological order
}

/** Messages strictly older than `beforeId` (by row id), chronological order — for paginated UI history */
export function loadMessagesOlderThan(conversationId: string, beforeId: number, limit: number): StoredMessage[] {
  const db = getGatewayDb();
  const rows = db.prepare(
    `SELECT id, conversation_id, role, content, created_at, sender_label, turn_id FROM gateway_messages
     WHERE conversation_id = ? AND id < ?
     ORDER BY id DESC LIMIT ?`
  ).all(conversationId, beforeId, limit) as unknown as StoredMessage[];
  return rows.reverse();
}

export function hasMessagesOlderThan(conversationId: string, oldestLoadedId: number): boolean {
  const db = getGatewayDb();
  const row = db.prepare(
    'SELECT 1 as x FROM gateway_messages WHERE conversation_id = ? AND id < ? LIMIT 1'
  ).get(conversationId, oldestLoadedId) as { x: number } | undefined;
  return !!row;
}

/**
 * Get message count for a conversation
 */
export function getMessageCount(conversationId: string): number {
  const db = getGatewayDb();
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM gateway_messages WHERE conversation_id = ?'
  ).get(conversationId) as { count: number };
  return row?.count || 0;
}

// --- Conversation Recall (PLAN-LONG-CONVO-RECALL.md Phase 4) ---

export interface RecallHit {
  id: number;
  role: string;
  content: string;
  created_at: string;
  rank: number;
}

/**
 * FTS5 search over this conversation's messages, strictly scoped by
 * conversation_id. Returns hits ranked by bm25 (lower = more relevant).
 * Requires Node 24 — FTS5 lives in the Node-bundled SQLite there.
 *
 * `query` is passed through to FTS5; the caller should pre-sanitize obvious
 * problem chars (parens, double quotes) or wrap a phrase in `"..."`. Empty
 * result is a valid signal — let the LLM see "no matches" and move on.
 */
/**
 * Sanitize a free-form query string for FTS5 MATCH. FTS5 treats `-`, `:`,
 * `*`, `^`, parens, and double quotes as special — passing claude's raw
 * query "narwhal-quasar-7783" will yield `no such column: quasar`. We:
 *   1. strip FTS5 metacharacters
 *   2. split on whitespace+punctuation into tokens
 *   3. drop tokens <2 chars, lowercase, cap at 8
 *   4. quote each token to escape any residual oddness and AND them
 */
export function sanitizeFtsQuery(raw: string): string {
  const cleaned = raw
    .replace(/["()*^:]/g, ' ')
    .replace(/-/g, ' ')
    .toLowerCase();
  const tokens = cleaned.split(/[\s,;.!?]+/)
    .filter((t) => t.length >= 2)
    .slice(0, 8)
    .map((t) => `"${t}"`);
  return tokens.join(' ');
}

export function searchConversationMessages(
  conversationId: string,
  query: string,
  limit: number = 5,
): RecallHit[] {
  if (!query || !query.trim()) return [];
  const fts = sanitizeFtsQuery(query);
  if (!fts) return [];
  const db = getGatewayDb();
  const safeLimit = Math.min(Math.max(limit, 1), 25);
  try {
    const rows = db.prepare(`
      SELECT m.id, m.role, m.content, m.created_at, bm25(gateway_messages_fts) AS rank
        FROM gateway_messages_fts f
        JOIN gateway_messages m ON m.id = f.rowid
       WHERE f.content MATCH ?
         AND m.conversation_id = ?
       ORDER BY rank ASC
       LIMIT ?
    `).all(fts, conversationId, safeLimit) as unknown as RecallHit[];
    return rows;
  } catch (e) {
    console.error(`[convo-recall] FTS5 search failed (need Node 24): ${(e as Error).message}`);
    return [];
  }
}

// --- Skill State Persistence ---

const MAX_VODOU_CONTEXT_SIZE = 20_000; // 20KB cap for stored Vodou context

export interface StoredSkillState {
  skill_name: string;
  oi_context: string | null;
  loaded_at: number;
}

/**
 * Save active skill state for a conversation (upsert)
 */
export function saveSkillState(conversationId: string, skillName: string, oiContext: string | null, loadedAt: number): void {
  const db = getGatewayDb();
  const cappedContext = oiContext && oiContext.length > MAX_VODOU_CONTEXT_SIZE
    ? oiContext.substring(0, MAX_VODOU_CONTEXT_SIZE)
    : oiContext;
  db.prepare(
    `INSERT INTO gateway_skill_state (conversation_id, skill_name, oi_context, loaded_at, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(conversation_id) DO UPDATE SET
       skill_name = excluded.skill_name,
       oi_context = excluded.oi_context,
       loaded_at = excluded.loaded_at,
       updated_at = CURRENT_TIMESTAMP`
  ).run(conversationId, skillName, cappedContext, loadedAt);
}

/**
 * Load skill state for a conversation (returns null if none or expired)
 */
export function loadSkillState(conversationId: string): StoredSkillState | null {
  const db = getGatewayDb();
  const row = db.prepare(
    'SELECT skill_name, oi_context, loaded_at FROM gateway_skill_state WHERE conversation_id = ?'
  ).get(conversationId) as StoredSkillState | undefined;
  if (!row) return null;
  // Expire if older than 30 minutes
  if (Date.now() - row.loaded_at > 1_800_000) {
    clearSkillState(conversationId);
    return null;
  }
  return row;
}

/**
 * Clear skill state for a conversation
 */
export function clearSkillState(conversationId: string): void {
  const db = getGatewayDb();
  db.prepare('DELETE FROM gateway_skill_state WHERE conversation_id = ?').run(conversationId);
}

/**
 * PLAN-CAPTURE-TRUNCATION-RACE P2 — put an upgraded turn back in front of the extractor.
 *
 * Rewriting a row's content is not enough on its own. The extractor works in
 * message-id SPANS recorded in `extraction_queue` (vodou-core.db); once a span is
 * `done` its watermark has moved past, so an upgraded row is never re-read and
 * memory keeps the bullets it distilled from the stub. A correct transcript beside
 * a stale memory is worse than consistent truncation, because the two disagree and
 * neither looks wrong on its own.
 *
 * Resetting the covering span to `pending` is enough: the extractor re-runs it and
 * its own dedupe absorbs the facts it already wrote.
 *
 * Best-effort by design — a failure here must never fail the capture.
 */
function requeueExtractionFor(messageId: number): void {
  if (!Number.isFinite(messageId)) return;
  try {
    const core = getDb();
    const r = core.prepare(
      `UPDATE extraction_queue
          SET state = 'pending', attempts = 0, updated_at = datetime('now')
        WHERE state = 'done' AND ? BETWEEN span_start AND span_end`,
    ).run(messageId);
    const n = Number((r as any)?.changes || 0);
    if (n > 0) console.log(`[conversation-store] requeued ${n} extraction span(s) covering msg ${messageId}`);
  } catch (e) {
    console.warn(`[conversation-store] could not requeue extraction for msg ${messageId}: ${(e as Error).message}`);
  }
}
