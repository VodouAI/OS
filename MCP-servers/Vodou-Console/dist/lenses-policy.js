/**
 * Visual lenses run only in the primary gateway web chat (#/chat, source=web).
 * Messaging channels, workbench tabs, heartbeat, and external clients get
 * plain-text replies without lens instructions or ```lens fences.
 */
/** Closed ```lens ... ``` blocks and trailing unclosed fences. */
const LENS_FENCE_RE = /```lens\s*\n[\s\S]*?```/g;
const LENS_FENCE_OPEN_RE = /```lens\s*\n[\s\S]*$/;
/**
 * True when this conversation may use lens system-prompt instructions and
 * gateway lens fetch/render (primary web chat only).
 */
export function lensesAllowedForConversation(convId, source) {
    if (!convId || convId.startsWith('workbench:'))
        return false;
    const s = (source || '').trim().toLowerCase();
    if (s && s !== 'web')
        return false;
    return true;
}
/** Remove lens fenced blocks; keep prose that precedes them. */
export function stripLensBlocks(text) {
    if (!text || !text.includes('```lens'))
        return text;
    return text
        .replace(LENS_FENCE_RE, '')
        .replace(LENS_FENCE_OPEN_RE, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
/**
 * PLAN-SECURITY-AUDIT-FINDINGS #18 (2026-07-24) — outbound secret redaction.
 * Last-line defense against exfil over a channel: even if a hijacked or
 * injected turn coaxes the model into pasting a credential into its reply, the
 * secret never leaves the box. Patterns match well-known key shapes; matched
 * runs become `[redacted]`. Conservative — only high-confidence secret shapes,
 * so ordinary prose (and the user's own non-secret content) is untouched.
 */
// `sk-` must START a token (FU-26, 2026-09-14): without the lookbehind an ordinary
// "execdesk-agent-…" in a live note matched, and a reply naming it was blanked.
const OUTBOUND_SECRET_PATTERNS = [
    /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g, // OpenAI / Anthropic-style
    /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
    /ghp_[A-Za-z0-9]{30,}/g, // GitHub PAT
    /gho_[A-Za-z0-9]{30,}/g, // GitHub OAuth
    /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
    /AKIA[0-9A-Z]{16}/g, // AWS access key id
    /AIza[0-9A-Za-z_-]{30,}/g, // Google API key
    /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
    /\bBearer\s+[A-Za-z0-9._-]{20,}/g, // bearer tokens
];
export function redactOutboundSecrets(text) {
    let out = text;
    let redactions = 0;
    for (const re of OUTBOUND_SECRET_PATTERNS) {
        out = out.replace(re, () => {
            redactions++;
            return '[redacted]';
        });
    }
    return { text: out, redactions };
}
/** A private-key HEADER alone — a clipped note keeps only its first line. */
const SECRET_HEADER_RE = /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/;
/**
 * FU-26 (PLAN-MEMORIES-ARE-FACTS-NOT-WORK-LOGS P4) — does this text carry a
 * credential shape? The redaction patterns above, used to keep a note from
 * travelling to a third-party AI at all. The engine's twin is
 * `src/inject_select.rs` `secret_shaped`; both are held to
 * `tests/fixtures/secret-shapes.json`.
 */
export function hasSecretShape(text) {
    const t = String(text || '');
    return SECRET_HEADER_RE.test(t) || OUTBOUND_SECRET_PATTERNS.some((re) => new RegExp(re.source).test(t));
}
/** Plain text for Telegram/Slack/etc. delivery. */
export function channelOutboundText(text) {
    const stripped = stripLensBlocks(text);
    const { text: safe, redactions } = redactOutboundSecrets(stripped);
    if (redactions > 0) {
        console.warn(`[security] redacted ${redactions} secret-shaped token(s) from an outbound channel reply`);
    }
    return safe;
}
