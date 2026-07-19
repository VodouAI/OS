/**
 * Channel (e.g. WhatsApp) local-file attachments → provider-specific content (Anthropic blocks, OpenAI parts).
 */

import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';

export interface ChannelAttachmentMeta {
  url: string;
  filename?: string;
  mimeType?: string;
  type?: string;
}

const DEFAULT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_DOCUMENT_MAX_BYTES = 15 * 1024 * 1024;
const DEFAULT_TEXT_DOC_MAX_BYTES = 1024 * 1024;

let _loggedStrictRootsWarning = false;

/** Trim whitespace and one pair of surrounding " or ' (per comma-separated segment or whole value). */
function stripEnvQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      return t.slice(1, -1).trim();
    }
  }
  return t;
}

function strictMediaRequired(): boolean {
  const v = process.env.CHANNEL_MEDIA_STRICT;
  return v === '1' || v === 'true' || v === 'yes';
}

function mediaRootsConfigured(): string[] {
  return (
    process.env.CHANNEL_MEDIA_ROOTS?.split(',').map((s) => stripEnvQuotes(s)).filter(Boolean) || []
  );
}

function maxBytesForKind(kind: 'image' | 'document' | 'plaintext'): number {
  if (kind === 'image') {
    return parseInt(process.env.CHANNEL_VISION_MAX_BYTES || String(DEFAULT_IMAGE_MAX_BYTES), 10);
  }
  if (kind === 'document') {
    return parseInt(process.env.CHANNEL_DOCUMENT_MAX_BYTES || String(DEFAULT_DOCUMENT_MAX_BYTES), 10);
  }
  return parseInt(process.env.CHANNEL_TEXT_ATTACHMENT_MAX_BYTES || String(DEFAULT_TEXT_DOC_MAX_BYTES), 10);
}

/**
 * Endpoints where we send OpenAI-style image_url / multimodal user content (trial; disable via env).
 */
export function openaiCompatVisionEnabled(endpoint: string): boolean {
  const extra =
    process.env.CHANNEL_VISION_COMPAT_ENDPOINTS?.split(',').map((s) => stripEnvQuotes(s)).filter(Boolean) ||
    [];
  for (const frag of extra) {
    if (frag && endpoint.includes(frag)) return true;
  }
  if (endpoint.includes('api.openai.com')) return true;
  if (endpoint.includes('generativelanguage.googleapis.com')) return true;
  if (endpoint.includes('openrouter.ai')) return true;
  if (endpoint.includes('api.fireworks.ai')) return true;
  if (endpoint.includes('api.together.ai')) return true;
  return false;
}

function underAllowedRoots(abs: string): boolean {
  const roots = mediaRootsConfigured();
  if (roots.length === 0) {
    if (strictMediaRequired()) {
      if (!_loggedStrictRootsWarning) {
        console.error(
          '[ChannelMedia] CHANNEL_MEDIA_STRICT is set but CHANNEL_MEDIA_ROOTS is empty — channel file reads disabled.'
        );
        _loggedStrictRootsWarning = true;
      }
      return false;
    }
    return true;
  }
  return roots.some((root) => {
    try {
      const r = fs.realpathSync(path.resolve(root));
      return abs === r || abs.startsWith(r + path.sep);
    } catch {
      return false;
    }
  });
}

/**
 * Hard denylist for secret/credential files. Channel attachment `url`s are
 * fully attacker-controlled (a remote sender relays whatever path they like),
 * and `underAllowedRoots` is fail-OPEN by default (empty CHANNEL_MEDIA_ROOTS +
 * no CHANNEL_MEDIA_STRICT ⇒ allow all), so a sender could point an attachment
 * at `.env`/`~/.ssh/id_rsa`/`*.db` and have the gateway base64 it into the LLM
 * context for exfiltration. This denylist blocks that class REGARDLESS of the
 * roots config — defense in depth that mirrors the fs-sandbox secret denylist.
 */
function isDeniedSecretPath(abs: string): boolean {
  const lower = abs.toLowerCase();
  const base = path.basename(lower);
  if (base === '.env' || base.startsWith('.env.') || base.endsWith('.env')) return true;
  if (/\.(key|pem|p12|pfx|crt|cer|der|db|sqlite|sqlite3|keychain|kdbx)$/.test(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(base)) return true;
  if (base === 'credentials' || base === '.netrc' || base === '.npmrc' || base === '.pgpass') return true;
  // Sensitive directories anywhere in the resolved path.
  if (/(^|[\\/])\.(ssh|aws|gnupg|config\/gcloud)([\\/]|$)/.test(lower)) return true;
  return false;
}

/** Path visible + allowed roots + strict policy; no size limit (use checkSize). */
export function resolveChannelMediaPath(raw: string): { abs: string; size: number } | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed)) return null;

  let abs = path.resolve(trimmed);
  try {
    abs = fs.realpathSync(abs);
  } catch {
    return null;
  }

  if (isDeniedSecretPath(abs)) {
    console.error(`[ChannelMedia] SECURITY: refused secret/credential path from channel attachment: ${abs}`);
    return null;
  }

  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;

  if (!underAllowedRoots(abs)) {
    if (mediaRootsConfigured().length > 0) {
      console.error(`[ChannelMedia] Path outside CHANNEL_MEDIA_ROOTS: ${abs}`);
    }
    return null;
  }

  return { abs, size: st.size };
}

export function safeResolveMediaPath(
  raw: string,
  kind: 'image' | 'document' | 'plaintext'
): { abs: string } | null {
  const r = resolveChannelMediaPath(raw);
  if (!r) return null;
  const max = maxBytesForKind(kind);
  if (r.size > max) {
    console.error(`[ChannelMedia] Skip (too large for ${kind}): ${r.abs} (${r.size} > ${max})`);
    return null;
  }
  return { abs: r.abs };
}

function anthropicImageMediaType(mimeHint: string, filePath: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
  const m = (mimeHint || '').toLowerCase().split(';')[0].trim();
  if (m === 'image/jpeg' || m === 'image/jpg') return 'image/jpeg';
  if (m === 'image/png') return 'image/png';
  if (m === 'image/gif') return 'image/gif';
  if (m === 'image/webp') return 'image/webp';
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return null;
}

function isPdf(meta: ChannelAttachmentMeta, filePath: string): boolean {
  const m = (meta.mimeType || '').toLowerCase();
  if (m.includes('pdf')) return true;
  return path.extname(filePath).toLowerCase() === '.pdf';
}

function isPlainTextDocument(meta: ChannelAttachmentMeta, filePath: string): boolean {
  const m = (meta.mimeType || '').toLowerCase().split(';')[0].trim();
  if (m === 'text/plain' || m === 'text/markdown' || m === 'text/csv' || m === 'application/json') return true;
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.txt' || ext === '.md' || ext === '.csv' || ext === '.json' || ext === '.log';
}

/**
 * Build user content: text + image / document blocks per Anthropic Messages API.
 */
export function buildAnthropicUserContent(
  baseText: string,
  metas: ChannelAttachmentMeta[]
): Anthropic.Messages.ContentBlockParam[] {
  const textPart =
    baseText.trim() ||
    'The user sent the attached file(s). Use the image(s) or document(s) when relevant.';
  const blocks: Anthropic.Messages.ContentBlockParam[] = [{ type: 'text', text: textPart }];

  for (const meta of metas) {
    const base = resolveChannelMediaPath(meta.url);
    if (!base) {
      blocks.push({
        type: 'text',
        text: `[Attachment skipped or unreadable: ${meta.filename || meta.url}]`,
      });
      continue;
    }
    const { abs, size } = base;

    const pdf = isPdf(meta, abs);
    const ptxt = isPlainTextDocument(meta, abs);
    const imgMt = anthropicImageMediaType(meta.mimeType || '', abs);

    const over = (kind: 'image' | 'document' | 'plaintext') => size > maxBytesForKind(kind);

    if (pdf) {
      if (over('document')) {
        blocks.push({
          type: 'text',
          text: `[PDF too large (${size} bytes > ${maxBytesForKind('document')}): ${abs}]`,
        });
        continue;
      }
      try {
        const buf = fs.readFileSync(abs);
        const title = meta.filename || path.basename(abs);
        blocks.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') },
          title: title || undefined,
        });
        continue;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        blocks.push({ type: 'text', text: `[Failed to read PDF: ${abs} (${msg})]` });
        continue;
      }
    }

    if (ptxt) {
      if (over('plaintext')) {
        blocks.push({
          type: 'text',
          text: `[Text file too large (${size} bytes > ${maxBytesForKind('plaintext')}): ${abs}]`,
        });
        continue;
      }
      try {
        const buf = fs.readFileSync(abs);
        const text = buf.toString('utf8');
        const title = meta.filename || path.basename(abs);
        blocks.push({
          type: 'document',
          source: { type: 'text', media_type: 'text/plain', data: text },
          title: title || undefined,
        });
        continue;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        blocks.push({ type: 'text', text: `[Failed to read text file: ${abs} (${msg})]` });
        continue;
      }
    }

    if (imgMt) {
      if (over('image')) {
        blocks.push({
          type: 'text',
          text: `[Image too large (${size} bytes > ${maxBytesForKind('image')}): ${abs}]`,
        });
        continue;
      }
      try {
        const buf = fs.readFileSync(abs);
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: imgMt, data: buf.toString('base64') },
        });
        continue;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        blocks.push({ type: 'text', text: `[Failed to read image: ${abs} (${msg})]` });
        continue;
      }
    }

    blocks.push({
      type: 'text',
      text: `[Unsupported attachment type: ${abs} (${meta.mimeType || 'unknown'}) — not image, PDF, or plain text]`,
    });
  }

  return blocks;
}

export function appendChannelAttachmentHints(text: string, metas: ChannelAttachmentMeta[]): string {
  let out = text;
  for (const meta of metas) {
    if (!meta?.url) continue;
    const label = meta.filename || 'file';
    const mt = meta.mimeType || 'application/octet-stream';
    const tt = meta.type || 'file';
    out += '\n\n[Channel attachment: ' + label + ' local_path=' + meta.url + ' mime=' + mt + ' type=' + tt + ']';
  }
  return out;
}
