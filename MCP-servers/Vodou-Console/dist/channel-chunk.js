/**
 * Outbound channel chunking.
 *
 * Lifted out of index.ts verbatim so it can be tested without starting the
 * gateway — importing index.ts boots the HTTP server, which is why this logic
 * went unverified long enough for `substring(0, 4000)` to silently truncate
 * 2,221 stored replies and for a 4,942-char morning-briefing to be rejected
 * outright by Telegram (HTTP 400) while the run reported success.
 */
/** WhatsApp text limit per message; longer replies are split into sequential sends. */
export const WHATSAPP_TEXT_CHUNK = 4096;
/**
 * Per-channel outbound limits. Telegram rejects >4096 with HTTP 400
 * "message is too long" — which is exactly how morning-briefing's 4,942-char
 * result failed to arrive on 2026-08-19 while the run itself succeeded. Values
 * sit under each provider's hard cap to leave room for the continuation marker.
 */
export function outboundLimitFor(source) {
    switch (source) {
        case 'telegram': return 3900; // hard cap 4096
        case 'slack': return 3900; // 4000 practical
        case 'discord': return 1900; // hard cap 2000
        case 'whatsapp': return WHATSAPP_TEXT_CHUNK;
        default: return 3900;
    }
}
/**
 * Split for a channel without cutting a sentence — or a code fence — in half.
 *
 * Generalised from `chunkTextForWhatsApp`, which was correct and used by exactly
 * one channel while every other outbound path did `substring(0, 4000)` and threw
 * the remainder away (2,221 stored replies exceed that). The name was the only
 * thing WhatsApp-specific about it.
 *
 * The fence rule is the addition: splitting inside a ``` block leaves the first
 * message with an unterminated fence and the second starting mid-code, which
 * renders as garbage on every client. When a cut would land inside a fence we
 * back up to the fence opening instead.
 */
export function chunkTextForOutbound(full, maxLen) {
    // Room for the fences this function may add when a code block spans a
    // boundary: a closing "\n```" on one chunk and a reopening "```lang\n" on
    // the next. Reserved up front so the additions cannot push a chunk over.
    const FENCE_RESERVE = 24;
    const body = Math.max(32, maxLen - FENCE_RESERVE);
    const parts = chunkTextForWhatsApp(full, body);
    if (parts.length < 2)
        return parts;
    // Close-and-reopen, not back-up-and-carry.
    //
    // The first attempt backed the split up to the last unmatched fence and
    // carried the remainder into the next chunk. That is wrong twice over: the
    // carry can push the following chunk back over the limit, and a block longer
    // than one whole chunk can't be backed out of at all, so a chunk still ships
    // with an odd fence count and every renderer downstream treats the rest of
    // the message as unstyled soup. Closing the block at the boundary and
    // reopening it with the same language keeps each chunk independently valid,
    // which is the only property a per-message renderer can act on.
    const out = [];
    let reopen = null; // non-null => this chunk starts inside a fence
    for (const raw of parts) {
        let chunk = reopen !== null ? '```' + reopen + '\n' + raw : raw;
        let inside = false;
        let lang = '';
        for (const f of chunk.match(/```[^\n`]*/g) || []) {
            if (inside) {
                inside = false;
                lang = '';
            }
            else {
                inside = true;
                lang = f.slice(3).trim();
            }
        }
        if (inside) {
            chunk += '\n```';
            reopen = lang;
        }
        else
            reopen = null;
        out.push(chunk);
    }
    // Invariant, not decoration: nothing leaves here over the limit. This is the
    // exact failure the function exists to prevent — Telegram HTTP 400 "message
    // is too long", morning-briefing, 4,942 chars, 2026-08-19. Text with no break
    // opportunity at all (a base64 blob, a single long line) reaches here, and a
    // mid-word break beats a rejected send. A hard split can reintroduce an odd
    // fence count, but only for input that had no line breaks to split on, where
    // there was no correct rendering available in the first place.
    const bounded = [];
    for (const part of out) {
        if (part.length <= maxLen) {
            bounded.push(part);
            continue;
        }
        for (let i = 0; i < part.length; i += maxLen)
            bounded.push(part.slice(i, i + maxLen));
    }
    return bounded.filter((p) => p.length > 0);
}
export function chunkTextForWhatsApp(full, maxLen) {
    const t = full.trimEnd();
    if (t.length <= maxLen)
        return [t.length ? t : ''];
    const parts = [];
    let rest = t;
    while (rest.length > 0) {
        if (rest.length <= maxLen) {
            parts.push(rest);
            break;
        }
        let cut = rest.lastIndexOf('\n\n', maxLen);
        if (cut < Math.floor(maxLen / 2))
            cut = rest.lastIndexOf('\n', maxLen);
        if (cut < Math.floor(maxLen / 2))
            cut = maxLen;
        parts.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut).trimStart();
    }
    return parts.length ? parts : [''];
}
