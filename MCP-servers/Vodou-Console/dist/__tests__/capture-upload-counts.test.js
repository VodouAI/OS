/**
 * POST /api/capture/upload — an upload that imported NOTHING must not report
 * success.
 *
 * The live bug: the endpoint passed the uploaded FILE to `mem import <source>
 * <file>`, and the OpenClaw/Hermes importer only ever walked DIRECTORIES. A
 * `.zip` therefore matched no files, the CLI exited 0, and this route answered
 * `{ ok: true }` over zero imported memories. The Rust side now accepts a zip
 * and fails loudly on an unrecognisable one; this side stops trusting exit 0 on
 * its own and reads the importer's real counts.
 *
 * `vodou-core` is faked through VODOU_CORE_BIN (the hook `resolveCoreBin()`
 * already honours) so what is under test is this route's contract, not the
 * importer underneath it — that has its own Rust tests.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vodou-upload-test-'));
vi.mock('../db.js', () => ({
    getMemoryDb: () => null,
    getGatewayDb: () => null,
    getDb: () => null,
    getSetting: () => null,
    setSetting: () => { },
    getProjectRoot: () => root,
}));
vi.mock('../vbb/bridge.js', () => ({
    persistCaptureTurn: async () => 1,
    bridgeStatus: () => ({ connected: false }),
    pushCaptureArmed: () => { },
    pushBackfill: () => { },
    disconnectBridge: () => { },
}));
const { memoryCaptureRouter, parseImportSummary } = await import('../api/memory-capture.js');
/** A stand-in `vodou-core` that prints `stdout` and exits `code`. */
function fakeCore(stdout, code = 0) {
    const bin = path.join(root, `fake-core-${Math.random().toString(36).slice(2)}.sh`);
    fs.writeFileSync(bin, `#!/bin/sh\ncat <<'EOF'\n${stdout}\nEOF\nexit ${code}\n`);
    fs.chmodSync(bin, 0o755);
    return bin;
}
async function upload(source, filename) {
    const app = express();
    app.use('/api/capture', memoryCaptureRouter);
    const server = app.listen(0);
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/capture/upload?source=${source}&filename=${encodeURIComponent(filename)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'PK-fake-archive-bytes' });
        const text = await res.text();
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            parsed = text;
        }
        return { status: res.status, body: parsed };
    }
    finally {
        await new Promise((r) => server.close(() => r()));
    }
}
const savedBin = process.env.VODOU_CORE_BIN;
beforeAll(() => { fs.mkdirSync(root, { recursive: true }); });
afterAll(() => {
    if (savedBin === undefined)
        delete process.env.VODOU_CORE_BIN;
    else
        process.env.VODOU_CORE_BIN = savedBin;
    fs.rmSync(root, { recursive: true, force: true });
});
describe('POST /api/capture/upload — success means files landed, not exit 0', () => {
    it('refuses to call a 0-file import a success, and says what the export should contain', async () => {
        process.env.VODOU_CORE_BIN = fakeCore('import openclaw: 0 file(s), 0 chunk(s) indexed, 0 skipped, 0 flagged [job openclaw-1a2b3c4d]');
        const r = await upload('openclaw', 'openclaw-export.zip');
        expect(r.status).toBe(422);
        expect(r.body.ok).toBeUndefined();
        expect(String(r.body.error)).toContain('imported 0 files');
        expect(String(r.body.error)).toContain('MEMORY.md');
        expect(r.body.imported).toMatchObject({ files: 0, conversations: 0 });
    });
    it('reports the importer’s real counts when files did land', async () => {
        process.env.VODOU_CORE_BIN = fakeCore('import openclaw: 3 file(s), 11 chunk(s) indexed, 1 skipped, 0 flagged [job openclaw-1a2b3c4d]');
        const r = await upload('openclaw', 'openclaw-export.zip');
        expect(r.status).toBe(200);
        expect(r.body.ok).toBe(true);
        expect(r.body.imported).toEqual({ files: 3, chunks: 11, conversations: 0, messages: 0, job: 'openclaw-1a2b3c4d' });
    });
    it('counts a conversation import that wrote no memory FILES as a success', async () => {
        // Lane A lands conversations in gateway.db and zero files under memory/;
        // a files-only check would have called the working path a failure.
        process.env.VODOU_CORE_BIN = fakeCore('import chatgpt: 128 conversation(s), 2941 message(s); 0 file(s), 0 chunk(s) indexed, 0 skipped, 0 flagged [job chatgpt-99]');
        const r = await upload('chatgpt', 'chatgpt-export.zip');
        expect(r.status).toBe(200);
        expect(r.body.imported).toMatchObject({ conversations: 128, messages: 2941, files: 0 });
    });
    it('treats a run that printed no report at all as unproven, not as success', async () => {
        process.env.VODOU_CORE_BIN = fakeCore('');
        const r = await upload('hermes', 'hermes.zip');
        expect(r.status).toBe(422);
        expect(r.body.imported).toBeNull();
    });
    it('still surfaces a non-zero exit with the CLI’s own message', async () => {
        process.env.VODOU_CORE_BIN = fakeCore('Error: holds no .md files', 1);
        const r = await upload('hermes', 'photos.zip');
        expect(r.status).toBe(422);
        expect(String(r.body.error)).toContain('no .md files');
    });
});
describe('parseImportSummary', () => {
    it('ignores the chatter around the summary line', () => {
        const out = [
            '[mem import] --digest only applies to obsidian; ignoring for openclaw',
            'import openclaw (dry-run): 2 file(s), 7 chunk(s) indexed, 0 skipped, 1 flagged [job openclaw-abc]',
            '  deduped: 2 new chunk(s) checked, 0 grouped as near-duplicates, 0 conflict(s) queued',
        ].join('\n');
        expect(parseImportSummary(out)).toEqual({ files: 2, chunks: 7, conversations: 0, messages: 0, job: 'openclaw-abc' });
    });
    it('returns null rather than zeroes when there is no summary line', () => {
        expect(parseImportSummary('something else entirely')).toBeNull();
    });
});
