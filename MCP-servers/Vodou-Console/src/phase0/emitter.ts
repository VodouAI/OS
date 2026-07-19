/**
 * Phase 0 — Cascade-readiness instrumentation.
 *
 * Emits one JSONL line per chat prompt to .vodou/phase0/cascade-readiness-YYYY-MM-DD.jsonl.
 * Pure observation — no behavior change. See PLANS/0.5.46/PHASE-0-INSTRUMENTATION-SPEC.md.
 *
 * Privacy: prompt text is NEVER written. Only length, classification, latency.
 *
 * Off-switch: VODOU_PHASE0_DISABLED=1 env var disables all writes.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getProjectRoot } from '../db.js';
import { classifyPrompt } from './classifier.js';

const DISABLED = process.env.VODOU_PHASE0_DISABLED === '1';

interface Phase0Begin {
  ts: number;
  conv_id: string;
  user_hash: string;
  source: string;
  scope: string | null;
  prompt_len: number;
  prompt_token_estimate: number;
  prompt_lines: number;
  has_code_block: boolean;
  starts_with_punct: boolean;
  prompt_normalized_for_match: string;
}

export interface Phase0Record extends Phase0Begin {
  daemon_intent_matched: boolean;
  daemon_intent_keyword: string | null;
  daemon_intent_confidence: number | null;
  daemon_auto_routed: boolean;
  brainloader_fired: boolean;
  brainloader_skill: string | null;
  tool_calls_count: number;
  tool_calls_distinct: string[];
  ttft_ms: number | null;
  total_latency_ms: number;
  response_tokens_estimate: number;
  phase0_classification: string;
}

let writeFailures = 0;
let lastWriteFailureMinute = 0;
let emitterDisabledThisSession = false;

function phase0Dir(): string {
  return path.join(getProjectRoot(), '.vodou', 'phase0');
}

function todayFile(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return path.join(phase0Dir(), `cascade-readiness-${yyyy}-${mm}-${dd}.jsonl`);
}

function userHash(userId: string | undefined | null): string {
  const id = userId || 'anonymous';
  return crypto.createHash('sha256').update(id).digest('hex').slice(0, 12);
}

export function beginPrompt(args: {
  conversationId: string;
  prompt: string;
  source?: string;
  scope?: string | null;
  userId?: string | null;
}): Phase0Begin | null {
  if (DISABLED || emitterDisabledThisSession) return null;
  const trimmed = args.prompt.trim();
  return {
    ts: Math.floor(Date.now() / 1000),
    conv_id: args.conversationId,
    user_hash: userHash(args.userId),
    source: args.source || 'gateway',
    scope: args.scope ?? null,
    prompt_len: args.prompt.length,
    prompt_token_estimate: Math.ceil(args.prompt.length / 4),
    prompt_lines: args.prompt.split('\n').length,
    has_code_block: /```/.test(args.prompt),
    starts_with_punct: /^[\{\[<]/.test(trimmed),
    prompt_normalized_for_match: trimmed.toLowerCase().slice(0, 200),
  };
}

export function emitRecord(record: Phase0Record): void {
  if (DISABLED || emitterDisabledThisSession) return;

  // Strip the normalized prompt before writing — used only for in-process classification.
  const { prompt_normalized_for_match: _omit, ...toWrite } = record;
  const line = JSON.stringify(toWrite) + '\n';

  try {
    fs.mkdirSync(phase0Dir(), { recursive: true });
    fs.appendFileSync(todayFile(), line, 'utf-8');
    writeFailures = 0;
  } catch (err) {
    writeFailures++;
    const nowMin = Math.floor(Date.now() / 60_000);
    if (nowMin !== lastWriteFailureMinute) {
      lastWriteFailureMinute = nowMin;
      // log once per minute, not every failure
      console.error('[phase0] emit failed:', err);
    }
    if (writeFailures >= 5) {
      emitterDisabledThisSession = true;
      console.error('[phase0] disabled for the session after 5+ consecutive write failures');
    }
  }
}

export interface StreamCounters {
  ttft_ms: number | null;
  tool_calls_count: number;
  tool_calls_distinct: string[];
  response_chars: number;
}

export function makeCounters(): StreamCounters {
  return { ttft_ms: null, tool_calls_count: 0, tool_calls_distinct: [], response_chars: 0 };
}

/**
 * Wraps a StreamCallback to side-track stream events into counters.
 * Returns a new callback that the chat() function can pass downstream.
 *
 * We never modify the events — just observe.
 */
export function instrumentCallback<T extends { type: string; toolName?: string; content?: string }>(
  startMs: number,
  counters: StreamCounters,
  inner: (e: T) => void
): (e: T) => void {
  return (e: T) => {
    try {
      if (counters.ttft_ms === null && e.type === 'text' && e.content) {
        counters.ttft_ms = Date.now() - startMs;
      }
      if (e.type === 'tool_call_start' && e.toolName) {
        counters.tool_calls_count += 1;
        if (!counters.tool_calls_distinct.includes(e.toolName)) {
          counters.tool_calls_distinct.push(e.toolName);
        }
      }
      if (e.type === 'text' && e.content) {
        counters.response_chars += e.content.length;
      }
    } catch {
      // never break the chat path
    }
    inner(e);
  };
}

/**
 * Final emit — combines a beginPrompt() result + counters + stage info.
 */
export function finalize(args: {
  begin: Phase0Begin | null;
  startMs: number;
  counters: StreamCounters;
  daemon_intent_matched?: boolean;
  daemon_intent_keyword?: string | null;
  daemon_intent_confidence?: number | null;
  daemon_auto_routed?: boolean;
  brainloader_fired?: boolean;
  brainloader_skill?: string | null;
}): void {
  if (!args.begin) return;
  const total_latency_ms = Date.now() - args.startMs;
  const record: Phase0Record = {
    ...args.begin,
    daemon_intent_matched: args.daemon_intent_matched ?? false,
    daemon_intent_keyword: args.daemon_intent_keyword ?? null,
    daemon_intent_confidence: args.daemon_intent_confidence ?? null,
    daemon_auto_routed: args.daemon_auto_routed ?? false,
    brainloader_fired: args.brainloader_fired ?? false,
    brainloader_skill: args.brainloader_skill ?? null,
    tool_calls_count: args.counters.tool_calls_count,
    tool_calls_distinct: args.counters.tool_calls_distinct,
    ttft_ms: args.counters.ttft_ms,
    total_latency_ms,
    response_tokens_estimate: Math.ceil(args.counters.response_chars / 4),
    phase0_classification: classifyPrompt({
      prompt_normalized: args.begin.prompt_normalized_for_match,
      prompt_len: args.begin.prompt_len,
      prompt_lines: args.begin.prompt_lines,
      has_code_block: args.begin.has_code_block,
      starts_with_punct: args.begin.starts_with_punct,
      scope: args.begin.scope,
      daemon_intent_matched: args.daemon_intent_matched ?? false,
      tool_calls_count: args.counters.tool_calls_count,
    }),
  };
  emitRecord(record);
}
