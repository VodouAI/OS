// MCP-servers/_shared/db.ts
//
// Thin adapter around `node:sqlite` (built into Node 22.13+/24+/all current LTS).
// Replaces `better-sqlite3` with zero native bindings.
//
// API surface kept near-identical to better-sqlite3 so call-sites barely change:
//   - new Database(path[, opts])           -> open(path[, opts])
//   - db.prepare(sql).run/get/all/iterate  -> identical
//   - db.transaction(fn)                   -> identical (native support)
//   - db.exec(sql)                         -> identical
//   - db.close()                           -> identical
//
// BLOB I/O: better-sqlite3 used Buffer; node:sqlite uses Uint8Array. Use
// toBlob() / fromBlob() at the boundary if you store/retrieve binary columns.
//
// Copy this file into each MCP server (no shared workspace package — servers
// must remain standalone).

import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

export interface OpenOptions {
  readOnly?: boolean;
  // better-sqlite3 compat alias (lowercase). We translate to node:sqlite's readOnly.
  readonly?: boolean;
  timeout?: number;
}

export function open(path: string, opts: OpenOptions = {}): DB {
  const readOnly = opts.readOnly ?? opts.readonly ?? false;
  return new DatabaseSync(path, {
    readOnly,
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
  });
}

// BLOB boundary helpers — only needed where binary columns cross the wire.
// (Buffer extends Uint8Array, so a plain Uint8Array view of the same memory works.)
export const toBlob = (b: Buffer | Uint8Array): Uint8Array =>
  new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

export const fromBlob = (u: Uint8Array): Buffer =>
  Buffer.from(u.buffer, u.byteOffset, u.byteLength);

// Boot-guard helper — call at server entrypoint to fail loud if Node version
// or node:sqlite is wrong/missing. Use:
//   import { assertNodeRuntime } from './db';
//   assertNodeRuntime();
//
// Default requires Node 24.x (the bundled Vodou runtime). Override with
// `assertNodeRuntime({ exactMajor: 22 })` only for development tooling that
// can't bump yet.
export function assertNodeRuntime(opts: { exactMajor?: number } = {}): void {
  const required = opts.exactMajor ?? 24;
  const [major] = process.versions.node.split('.').map(Number);
  if (major !== required) {
    console.error(
      `[fatal] Node ${required}.x required (Vodou bundled runtime); got ${process.versions.node}. Refusing to start.`
    );
    process.exit(1);
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:sqlite');
  } catch {
    console.error('[fatal] node:sqlite unavailable in this Node build');
    process.exit(1);
  }
}
