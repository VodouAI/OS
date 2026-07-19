/**
 * OpenAI-Compatible API — /v1/chat/completions and /v1/models
 *
 * Thin adapter that maps OpenAI wire format to Vodou's chat() pipeline.
 * Same BrainLoader → memory → provider pipeline as the web UI.
 * Localhost-first, optional bearer auth via VODOU_OPENAI_COMPAT_TOKEN.
 */

import { Router, Request, Response } from 'express';
import { randomUUID, timingSafeEqual } from 'crypto';
import { chat, isConfigured, getActiveModelLabel, getLastMemoryUsed, getTotalMemoryCount } from '../llm.js';
import { ensureConversation, saveMessage } from '../conversation-store.js';
import { getSetting } from '../db.js';
import { hydrateLlmConversationFromDb } from '../conversation-hydrate.js';
import { recordChatFailure, clearChatFailure } from '../gateway-debug.js';

const router = Router();

// --- Bearer auth middleware (only enforced when VODOU_OPENAI_COMPAT_TOKEN is set) ---

router.use((req: Request, res: Response, next) => {
  const token = process.env.VODOU_OPENAI_COMPAT_TOKEN;
  if (!token) return next(); // no token configured = open (localhost use)

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({
      error: { message: 'Missing bearer token. Set Authorization: Bearer <token>', type: 'auth_error' },
    });
  }

  const provided = auth.slice(7);
  // Timing-safe compare to prevent timing attacks
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return res.status(401).json({
        error: { message: 'Invalid bearer token', type: 'auth_error' },
      });
    }
  } catch {
    return res.status(401).json({
      error: { message: 'Invalid bearer token', type: 'auth_error' },
    });
  }

  next();
});

// --- GET /v1/models ---

router.get('/models', (_req: Request, res: Response) => {
  const activeModel = getActiveModelLabel();
  res.json({
    object: 'list',
    data: [
      {
        id: 'vodou-default',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'vodou',
        metadata: { active_model: activeModel },
      },
    ],
  });
});

// --- POST /v1/chat/completions ---

router.post('/chat/completions', async (req: Request, res: Response) => {
  if (!isConfigured()) {
    return res.status(503).json({
      error: { message: 'Vodou gateway not configured. Set a provider in Settings.', type: 'server_error' },
    });
  }

  const { messages, stream } = req.body;

  // PLAN-UNIVERSAL-MEMORY-V2 Phase C (W1b) — BYOK capture identity. Tools
  // pointed at this endpoint (Cursor, Continue, Aider, custom scripts) name
  // themselves via `X-Vodou-App` (or OpenAI's `user` field); minted ids carry
  // `byok:<app>:` so the memory extractor scopes their chunks
  // `capture:byok:<app>` — the capture trust tier, visibly app-tagged, never
  // auto-promoted to MEMORY.md. Client-supplied conversation ids are honored
  // untouched (back-compat). Kill switch: VODOU_BYOK_SCOPED_IDS=0 (env wins),
  // else the UI toggle `capture.byok.enabled` in gateway_settings
  // (PLAN-MEMORY-EVERYWHERE-FRONTEND P0); default stays ON.
  const appRaw = (req.headers['x-vodou-app'] as string) || (typeof req.body.user === 'string' ? req.body.user : '') || 'app';
  const app = appRaw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'app';
  const scopedIdsEnv = process.env.VODOU_BYOK_SCOPED_IDS;
  const scopedIds = scopedIdsEnv !== undefined && scopedIdsEnv.trim() !== ''
    ? scopedIdsEnv !== '0'
    : getSetting('capture.byok.enabled') !== '0';

  // Extract conversation_id from body or header (accept legacy 'x-oi-' alias too)
  const convId: string = req.body.conversation_id
    || (req.headers['x-vodou-conversation-id'] as string)
    || (req.headers['x-oi-conversation-id'] as string)
    || (scopedIds ? `byok:${app}:${randomUUID()}` : randomUUID());

  // Extract last user message (standard pattern for OpenAI-compat proxies)
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: { message: 'messages array is required and must not be empty', type: 'invalid_request_error' },
    });
  }

  const lastUser = [...messages].reverse().find((m: any) => m.role === 'user');
  if (!lastUser?.content) {
    return res.status(400).json({
      error: { message: 'No user message found in messages array', type: 'invalid_request_error' },
    });
  }

  const userText = typeof lastUser.content === 'string'
    ? lastUser.content
    : Array.isArray(lastUser.content)
      ? lastUser.content.map((p: any) => p.text || '').join('')
      : JSON.stringify(lastUser.content);

  // Persist conversation + user message.
  // Source 'openai-compat' (NOT default 'web') so this open, machine-to-machine API
  // is excluded from web-chat-only capabilities like the FS tools (PLAN 0.6.4 §4.3 —
  // adversarial-review finding #2). Must be set on the FIRST ensureConversation
  // (saveMessage below won't overwrite an existing non-null source).
  const convTitle = convId.startsWith('byok:') ? `BYOK: ${app}` : 'OpenAI Compat';
  try { ensureConversation(convId, convTitle, 'openai-compat'); } catch {}
  try { saveMessage(convId, 'user', userText.substring(0, 10000)); } catch {}

  const completionId = 'chatcmpl-' + randomUUID().replace(/-/g, '').substring(0, 24);
  // Accept 'oi-default' as legacy alias for 'vodou-default' until v0.7.0 grace cleanup
  const requestedModel = req.body.model || 'vodou-default';
  const model = requestedModel === 'oi-default' ? 'vodou-default' : requestedModel;
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    return handleStreaming(req, res, convId, userText, completionId, model, created);
  } else {
    return handleNonStreaming(req, res, convId, userText, completionId, model, created);
  }
});

// --- Streaming (SSE) ---

async function handleStreaming(
  _req: Request, res: Response,
  convId: string, userText: string,
  completionId: string, model: string, created: number
) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  let fullText = '';
  let closed = false;

  // Handle client disconnect
  res.on('close', () => { closed = true; });

  const writeSSE = (data: string) => {
    if (!closed) res.write(`data: ${data}\n\n`);
  };

  const oaTurnId = randomUUID();
  try {
    hydrateLlmConversationFromDb(convId, userText.trim());
    await chat(convId, userText, (event) => {
      if (closed) return;

      switch (event.type) {
        case 'text':
          if (event.content) {
            fullText += event.content;
            writeSSE(JSON.stringify({
              id: completionId, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { content: event.content }, finish_reason: null }],
            }));
          }
          break;

        case 'done': {
          const usage = event.usage
            ? {
                prompt_tokens: event.usage.inputTokens || 0,
                completion_tokens: event.usage.outputTokens || 0,
                total_tokens: (event.usage.inputTokens || 0) + (event.usage.outputTokens || 0),
              }
            : undefined;
          writeSSE(JSON.stringify({
            id: completionId, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            ...(usage ? { usage } : {}),
          }));
          writeSSE('[DONE]');
          break;
        }

        case 'error':
          writeSSE(JSON.stringify({
            error: { message: event.error || 'Unknown error', type: 'server_error' },
          }));
          writeSSE('[DONE]');
          break;

        // Suppress tool events, status, mid-stream usage — not part of OpenAI chat format
        default:
          break;
      }
    }, { turnId: oaTurnId });
    clearChatFailure();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    recordChatFailure({
      convId,
      turnId: oaTurnId,
      error: msg,
      at: new Date().toISOString(),
    });
    writeSSE(JSON.stringify({ error: { message: msg, type: 'server_error' } }));
    writeSSE('[DONE]');
  }

  // Save assistant response
  if (fullText) {
    try { saveMessage(convId, 'assistant', fullText); } catch {}
  }

  if (!closed) res.end();
}

// --- Non-streaming ---

async function handleNonStreaming(
  _req: Request, res: Response,
  convId: string, userText: string,
  completionId: string, model: string, created: number
) {
  let fullText = '';
  let finalUsage: any = {};

  const oaTurnIdNs = randomUUID();
  try {
    hydrateLlmConversationFromDb(convId, userText.trim());
    await chat(convId, userText, (event) => {
      if (event.type === 'text') fullText += event.content || '';
      if (event.type === 'usage') finalUsage = event.usage || {};
      if (event.type === 'done' && event.usage) finalUsage = event.usage;
    }, { turnId: oaTurnIdNs });
    clearChatFailure();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    recordChatFailure({
      convId,
      turnId: oaTurnIdNs,
      error: msg,
      at: new Date().toISOString(),
    });
    return res.status(500).json({
      error: { message: msg, type: 'server_error' },
    });
  }

  // Save assistant response
  if (fullText) {
    try { saveMessage(convId, 'assistant', fullText); } catch {}
  }

  res.json({
    id: completionId,
    object: 'chat.completion',
    created,
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: fullText },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: finalUsage.inputTokens || 0,
      completion_tokens: finalUsage.outputTokens || 0,
      total_tokens: (finalUsage.inputTokens || 0) + (finalUsage.outputTokens || 0),
    },
  });
}

export { router as openaiCompatRouter };
