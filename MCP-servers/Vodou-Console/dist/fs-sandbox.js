/**
 * fs-sandbox.ts — atomic, confined filesystem operations for the managed/API web-chat
 * FS tools (write_file / read_file / list_dir / edit_file).
 *
 * Plan: PLANS/0.6.4/6-PLAN-MANAGED-CHAT-FS-TOOLS.md §4.2-A.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY MODEL (read before editing)
 * ─────────────────────────────────────────────────────────────────────────────
 * Confinement is a TWO-LAYER scheme. Do not conflate them:
 *
 *   Layer 1 — lexical resolve + `path.relative()` escape check + denylist.
 *             This is UX / fast-fail ONLY. It is NOT the security boundary.
 *             (`startsWith`-style prefix checks are exactly what failed in
 *              CVE-2025-53110; a naive `realpath` fallback is CVE-2025-53109.)
 *
 *   Layer 2 — THE BOUNDARY: the real (symlink-resolved) path of the deepest
 *             existing ancestor must stay under the canonicalised root, AND every
 *             open() uses O_NOFOLLOW so a pre-existing symlink at the final
 *             component is rejected (ELOOP) rather than followed. Together these
 *             defeat symlink-escape and the common TOCTOU swap for the
 *             single-owner, per-conversation threat model this plan targets.
 *
 * What this is NOT: kernel-atomic `openat2(RESOLVE_BENEATH)`. Node has no binding
 * for it. The remaining (tiny) TOCTOU window between the ancestor realpath check
 * and open requires an attacker who can swap a parent directory for a symlink
 * mid-call — out of scope for the local single-owner model. The dangerous case
 * (the `bash` tool) is NOT served here; it gets an OS-level sandbox in Phase 2+
 * (§4.2-B). Multi-tenant hosting graduates to a Rust openat2/Landlock helper (§10
 * Phase 4). The `tenantId` arg below is the (currently inert) seam for that.
 */
import { constants as FS, openSync, closeSync, readSync, writeSync, fstatSync, mkdirSync, renameSync, unlinkSync, realpathSync, readdirSync, statSync, lstatSync, readFileSync, existsSync, } from 'fs';
import os from 'os';
import path from 'path';
import { getProjectRoot } from './db.js';
import { projectContextRoot } from './project-context.js';
import { applyEdit, applyMultiEdit, EditError } from './edit-applier.js';
/** Typed error so the executor can map a clean `success:false` ToolResult. */
export class SandboxError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'SandboxError';
        this.code = code;
    }
}
const DEFAULT_MAX_BYTES = 2_000_000; // 2 MB
const DEFAULT_READ_LINES = 2000; // #1.6 — windowed read_file default window (Claude-Code parity)
/** Per-op byte cap (write content, read length, edit file size). */
export function maxBytes() {
    const v = parseInt(process.env.VODOU_FS_TOOLS_MAX_BYTES || '', 10);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_BYTES;
}
/** Base directory for all per-conversation workspaces. Overridable for tests/cloud. */
function rootBase() {
    return (process.env.VODOU_FS_TOOLS_ROOT ||
        path.join(getProjectRoot(), '.vodou', 'workspace', 'agent-files'));
}
function envOn(name) {
    const v = process.env[name];
    return v === '1' || v === 'true';
}
/**
 * Resolve the active mode for THIS call. The unsandboxed gate is fail-safe: it is
 * honored ONLY for a single-user context (tenantId absent or 'self' — today's model).
 * A real per-request tenant (cloud/multi-tenant) forces full confinement back on,
 * regardless of the env flag — confinement is restored, never silently dropped.
 */
function resolveSandboxMode(ctx) {
    const tenant = (ctx?.tenantId || 'self').trim();
    const singleUser = tenant === '' || tenant === 'self';
    if (singleUser && envOn('VODOU_FS_TOOLS_UNSANDBOXED')) {
        // PLAN-PROJECT-FS-JAIL — a non-Default project turn downgrades 'unsandboxed'
        // to project-confined. Explicit VODOU_FS_TOOLS_ROOT (tests/embedded CLI) and
        // the kill switch keep the historical unbounded behavior.
        if (process.env.VODOU_PROJECT_FS_JAIL !== '0' &&
            !process.env.VODOU_FS_TOOLS_ROOT &&
            projectContextRoot() &&
            path.resolve(projectContextRoot()) !== path.resolve(getProjectRoot())) {
            return 'project';
        }
        return 'unsandboxed';
    }
    if (envOn('VODOU_FS_TOOLS_FLAT_ROOT'))
        return 'flat';
    return 'sandboxed';
}
/** In unsandboxed mode, keep the denylist on unless the operator explicitly opts out. */
function unsandboxedAllowProtected() {
    return envOn('VODOU_FS_TOOLS_UNSANDBOXED_ALLOW_PROTECTED');
}
/** Base dir for resolving RELATIVE paths in unsandboxed mode (absolute paths bypass it).
 *  PLAN-GATEWAY-PROJECTS Phase 2 — precedence: explicit env root (embedded CLI launch dir),
 *  then the active gateway project's root (per-turn async context), then the install root.
 *  The denylist below still runs over the full absolute path, so secrets stay protected
 *  regardless of which project root is active. */
function unsandboxedBase() {
    const base = process.env.VODOU_FS_TOOLS_ROOT || projectContextRoot() || getProjectRoot();
    mkdirSync(base, { recursive: true });
    return realpathSync(base);
}
// ── Denylist (defense-in-depth ON TOP of the allowlist root — never the boundary) ──
const DENY_SEGMENTS = new Set(['.git', 'node_modules', '.ssh', '.aws', '.gnupg']);
function deniedByPolicy(rel) {
    const segs = rel.split(path.sep).filter(Boolean);
    for (const s of segs) {
        // case-fold the segment: macOS/Windows FS are case-insensitive, so ".GIT"
        // is the same dir as ".git". (Denylist is defense-in-depth; the allowlist
        // root is the real boundary — but don't let trivial casing slip it.)
        const lower = s.toLowerCase();
        if (DENY_SEGMENTS.has(lower))
            return `path contains a protected segment: "${s}"`;
        if (/^\.env(\..*)?$/i.test(s))
            return `.env files are off-limits`;
        if (/\.(db|sqlite|sqlite3|key|pem|p12|pfx)$/i.test(s))
            return `protected file type: "${s}"`;
        if (/^(vodou-core|vodou-hook-bin)$/i.test(lower))
            return `protected binary: "${s}"`;
    }
    return null;
}
/**
 * conversationId / tenantId may contain ':' (workbench convs like
 * `workbench:integration:asana`). Keep each as ONE filesystem segment: strip path
 * separators, NUL, and any `..` run so they can never widen the root.
 */
function sanitizeSegment(s) {
    let cleaned = String(s).replace(/[/\\\0]/g, '_').replace(/\.\.+/g, '_');
    // CRITICAL: a bare '.' (or any all-dots remainder the prior replaces left, since
    // `\.\.+` needs 2+ dots) survives unchanged and would COLLAPSE the path under
    // path.join — e.g. join(base,'self','.') === base — widening the per-conversation
    // root up to the shared tenant base (cross-conversation escape). Map any all-dots
    // segment to '_'. (Found by adversarial review 2026-06-04.)
    if (/^\.+$/.test(cleaned))
        cleaned = '_';
    return cleaned.length ? cleaned : '_';
}
/**
 * Ensure + canonicalise the per-conversation root. The returned path is
 * realpath-resolved (so e.g. macOS `/tmp -> /private/tmp` is already collapsed),
 * which is the canonical form every confinement check compares against.
 */
export function ensureRoot(ctx) {
    const mode = resolveSandboxMode(ctx);
    // Flat + unsandboxed + project don't need a conversation context (no per-conv nesting).
    // 'project' anchors at the same base — unsandboxedBase() already resolves to the
    // active project root via projectContextRoot(); confinement happens in confine().
    if (mode === 'unsandboxed' || mode === 'project')
        return unsandboxedBase();
    if (mode === 'flat') {
        const base = rootBase();
        mkdirSync(base, { recursive: true });
        return realpathSync(base);
    }
    const conversationId = (ctx?.conversationId || '').trim();
    if (!conversationId) {
        throw new SandboxError('no_conversation', 'file tools require a conversation context');
    }
    const tenantBase = path.join(rootBase(), sanitizeSegment(ctx.tenantId || 'self'));
    const dir = path.join(tenantBase, sanitizeSegment(conversationId));
    mkdirSync(dir, { recursive: true });
    const canon = realpathSync(dir);
    // Defense-in-depth: the per-conversation root MUST be a strict child of the
    // tenant base. Guards any future sanitizer gap that lets a segment collapse the
    // path back up to (or above) the tenant base.
    const canonBase = realpathSync(tenantBase);
    const rel = path.relative(canonBase, canon);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new SandboxError('bad_conversation', 'invalid conversation id (does not resolve to a per-conversation workspace)');
    }
    return canon;
}
/**
 * THE BOUNDARY check (Layer 2): the realpath of the deepest existing ancestor of
 * `abs` must be the root itself or strictly under it. realpathSync resolves the
 * ENTIRE symlink chain, so a symlinked intermediate that points outside the root
 * is caught here even if `abs` does not yet exist.
 */
function assertRealAncestorUnderRoot(canonRoot, abs) {
    let cur = abs;
    while (true) {
        if (existsSync(cur)) {
            const real = realpathSync(cur);
            if (real === canonRoot)
                return;
            const relReal = path.relative(canonRoot, real);
            if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
                throw new SandboxError('symlink_escape', 'path resolves (via symlink) outside the sandbox root');
            }
            return;
        }
        const parent = path.dirname(cur);
        if (parent === cur)
            break; // reached fs root without an existing ancestor
        cur = parent;
    }
    // canonRoot always exists (ensureRoot mkdir'd it), so we should never get here.
    throw new SandboxError('path_escape', 'no valid ancestor under sandbox root');
}
/**
 * Realpath-resolve `abs` via its deepest EXISTING ancestor (the not-yet-existing
 * suffix is re-appended). Same symlink-defeat trick as assertRealAncestorUnderRoot,
 * but returns the resolved path instead of asserting a root — used by the 'project'
 * boundary check, which allows two roots (project + tmp).
 */
function realOfDeepestExistingAncestor(abs) {
    let cur = abs;
    const suffix = [];
    while (true) {
        if (existsSync(cur)) {
            const real = realpathSync(cur);
            return suffix.length ? path.join(real, ...suffix) : real;
        }
        const parent = path.dirname(cur);
        if (parent === cur)
            return abs;
        suffix.unshift(path.basename(cur));
        cur = parent;
    }
}
/**
 * Resolve a user path to an absolute path guaranteed under `canonRoot`.
 * Returns the absolute path + the root-relative path (for clean result reporting).
 */
function confine(canonRoot, userPath, mode = 'sandboxed') {
    if (typeof userPath !== 'string' || !userPath.length) {
        throw new SandboxError('bad_path', 'path is required');
    }
    if (userPath.includes('\0'))
        throw new SandboxError('bad_path', 'path contains NUL');
    // An ABSOLUTE userPath makes path.resolve ignore canonRoot → the relative()
    // check below then rejects it (this is how "/etc/passwd" gets refused).
    const abs = path.resolve(canonRoot, userPath);
    const rel = path.relative(canonRoot, abs);
    // UNSANDBOXED (local-only, hard-gated in resolveSandboxMode): no boundary —
    // absolute paths and ..-escape are allowed (real filesystem). The denylist still
    // bites (cheap guard) unless the operator opted out. `rel` is reported only when
    // the target happens to fall under the base; otherwise the absolute path is shown
    // so the model sees the real file it touched.
    if (mode === 'unsandboxed' || mode === 'project') {
        if (!unsandboxedAllowProtected()) {
            // Run the segment denylist over the FULL absolute path (catches .ssh/.env/keys
            // anywhere, not just under the base).
            const policy = deniedByPolicy(abs.startsWith(path.sep) ? abs.slice(1) : abs);
            if (policy)
                throw new SandboxError('denied', policy);
        }
        const under = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        // PLAN-PROJECT-FS-JAIL — 'project' is unsandboxed WITH a boundary: the target
        // (symlink-resolved via the real-ancestor walk) must stay under the project root
        // or the system temp dir. This is what stops a project chat reading ~/Pictures.
        if (mode === 'project' && !under) {
            const tmpReal = realpathSync(os.tmpdir());
            const resolved = realOfDeepestExistingAncestor(abs);
            const inTmp = [tmpReal, '/tmp', '/private/tmp'].some((t) => {
                const r = path.relative(t, resolved);
                return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
            });
            if (!inTmp) {
                throw new SandboxError('project_escape', `path is outside this project's folder (${canonRoot}) — this conversation is scoped to the project; ask the user to add the file to the project or switch to the Default workspace`);
            }
        }
        if (mode === 'project' && under)
            assertRealAncestorUnderRoot(canonRoot, abs);
        return { abs, rel: under ? rel : abs };
    }
    // Layer 1 — fast-fail (NOT the boundary).
    if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
        throw new SandboxError('path_escape', 'path escapes the sandbox root');
    }
    const policy = deniedByPolicy(rel);
    if (policy)
        throw new SandboxError('denied', policy);
    // Layer 2 — the boundary.
    assertRealAncestorUnderRoot(canonRoot, abs);
    return { abs, rel };
}
/** Resolve root + mode together for an op. The sandboxed path is unchanged. */
function rootAndMode(ctx) {
    return { root: ensureRoot(ctx), mode: resolveSandboxMode(ctx) };
}
function readFdToString(fd, size, cap) {
    const len = Math.min(size, cap);
    const buf = Buffer.alloc(len);
    // read(2) may return a SHORT count (large reads, a signal, or the file shrinking
    // between fstat and read — a race). Buffer.alloc zero-fills, so stringifying past
    // the bytes actually read would inject phantom trailing NUL chars. Loop to fill,
    // then slice toString to `got`.
    let got = 0;
    while (got < len) {
        const n = readSync(fd, buf, got, len - got, got);
        if (n <= 0)
            break; // EOF / short read — stop; never stringify the zero-fill tail
        got += n;
    }
    return { content: buf.toString('utf8', 0, got), bytes: size, truncated: size > len };
}
/** Map a raw fs/openSync errno to a SandboxError (or rethrow ours). */
function mapFsError(e, rel) {
    if (e instanceof SandboxError)
        throw e;
    switch (e?.code) {
        case 'ENOENT': throw new SandboxError('not_found', `no such file: ${rel}`);
        case 'EEXIST': throw new SandboxError('exists', `file exists (use mode "overwrite" or "append"): ${rel}`);
        case 'ELOOP': throw new SandboxError('symlink_escape', `refusing to follow symlink: ${rel}`);
        case 'EISDIR': throw new SandboxError('is_dir', `${rel} is a directory`);
        case 'EACCES': throw new SandboxError('denied', `permission denied: ${rel}`);
        default: throw new SandboxError('io', e?.message || String(e));
    }
}
export function sandboxWrite(ctx, userPath, content, mode = 'create') {
    const { root, mode: sbMode } = rootAndMode(ctx);
    const { abs, rel } = confine(root, userPath, sbMode);
    const buf = Buffer.from(typeof content === 'string' ? content : '', 'utf8');
    if (buf.length > maxBytes()) {
        throw new SandboxError('too_large', `content ${buf.length}B exceeds cap ${maxBytes()}B`);
    }
    // Create any missing parent dirs (only ever UNDER the validated ancestor — a
    // pre-existing symlinked intermediate was already rejected by confine()).
    mkdirSync(path.dirname(abs), { recursive: true });
    let flags = FS.O_WRONLY | FS.O_NOFOLLOW;
    if (mode === 'append')
        flags |= FS.O_CREAT | FS.O_APPEND;
    else if (mode === 'overwrite')
        flags |= FS.O_CREAT | FS.O_TRUNC;
    else
        flags |= FS.O_CREAT | FS.O_EXCL; // 'create' — fail if it already exists
    const existedBefore = existsSync(abs);
    let fd;
    try {
        fd = openSync(abs, flags, 0o600);
    }
    catch (e) {
        mapFsError(e, rel);
    }
    try {
        writeSync(fd, buf, 0, buf.length, mode === 'append' ? null : 0);
    }
    finally {
        closeSync(fd);
    }
    return { path: rel, bytes: buf.length, mode, created: !existedBefore };
}
export function sandboxRead(ctx, userPath, maxReadBytes) {
    const { root, mode } = rootAndMode(ctx);
    const { abs, rel } = confine(root, userPath, mode);
    let fd;
    try {
        fd = openSync(abs, FS.O_RDONLY | FS.O_NOFOLLOW);
    }
    catch (e) {
        mapFsError(e, rel);
    }
    try {
        const st = fstatSync(fd);
        if (st.isDirectory())
            throw new SandboxError('is_dir', `${rel} is a directory (use list_dir)`);
        const cap = Math.min(maxReadBytes && maxReadBytes > 0 ? maxReadBytes : maxBytes(), maxBytes());
        const r = readFdToString(fd, st.size, cap);
        return { path: rel, content: r.content, bytes: r.bytes, truncated: r.truncated };
    }
    finally {
        closeSync(fd);
    }
}
/**
 * #1.6 (SWE-agent ACI) — windowed, line-numbered file read. The model reads a
 * BIG file in pages (`offset`/`limit`) instead of dumping the whole thing into
 * context. Output is `cat -n`-style (`<num>\t<text>`); that gutter format is
 * exactly what `edit-applier.ts::stripLineNumberPrefixes` strips, so an
 * old_string copied verbatim from this output still matches on edit. `truncated`
 * + `endLine`/`totalLines` tell the model how to paginate (next: offset endLine+1).
 */
export function sandboxReadLines(ctx, userPath, opts) {
    const { root, mode } = rootAndMode(ctx);
    const { abs, rel } = confine(root, userPath, mode);
    let fd;
    try {
        fd = openSync(abs, FS.O_RDONLY | FS.O_NOFOLLOW);
    }
    catch (e) {
        mapFsError(e, rel);
    }
    try {
        const st = fstatSync(fd);
        if (st.isDirectory())
            throw new SandboxError('is_dir', `${rel} is a directory (use list_dir)`);
        // Read up to the hard byte cap (windowing a huge file still can't exceed it).
        const cap = Math.min(opts?.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : maxBytes(), maxBytes());
        const r = readFdToString(fd, st.size, cap);
        const lines = r.content.split('\n');
        // A trailing newline yields a final empty element; drop it so totalLines is honest.
        if (lines.length > 1 && lines[lines.length - 1] === '')
            lines.pop();
        const totalLines = lines.length;
        const start = Math.max(1, Math.floor(opts?.offset ?? 1));
        const limit = Math.max(1, Math.floor(opts?.limit ?? DEFAULT_READ_LINES));
        const end = Math.min(totalLines, start + limit - 1);
        const window = start <= totalLines ? lines.slice(start - 1, end) : [];
        const numbered = window
            .map((t, i) => `${String(start + i).padStart(6, ' ')}\t${t}`)
            .join('\n');
        const truncated = r.truncated || end < totalLines;
        return { path: rel, content: numbered, startLine: start, endLine: Math.max(start - 1, end), totalLines, truncated };
    }
    finally {
        closeSync(fd);
    }
}
const SEARCH_MAX_FILES = 4000; // scan ceiling (walk bound)
const SEARCH_MAX_RESULTS = 100; // files-with-a-match returned
const SEARCH_MAX_FILE_BYTES = 1_000_000; // skip files larger than this
/**
 * #1.6 (SWE-agent ACI) — summarized search. Returns the FILES that contain a
 * match (path + first-match line + line number), NOT their full content — so the
 * model locates code without dumping whole files into context, then `read_file`s
 * the window it wants. Confined to the workspace; skips hidden/denied dirs
 * (`.git`/`node_modules`/…), symlinks (no escape), binaries, and oversized files.
 */
export function sandboxSearch(ctx, query, opts) {
    const { root, mode } = rootAndMode(ctx);
    const { abs: startAbs } = confine(root, opts?.path && opts.path !== '.' ? opts.path : '.', mode);
    if (!query)
        throw new SandboxError('bad_arg', 'search query must not be empty');
    let test;
    if (opts?.regex) {
        let re;
        try {
            re = new RegExp(query, 'i');
        }
        catch {
            throw new SandboxError('bad_arg', `invalid regex: ${query}`);
        }
        test = (l) => re.test(l);
    }
    else {
        const q = query.toLowerCase();
        test = (l) => l.toLowerCase().includes(q);
    }
    const maxResults = Math.min(Math.max(1, Math.floor(opts?.maxResults ?? SEARCH_MAX_RESULTS)), SEARCH_MAX_RESULTS);
    const allowProtected = mode === 'unsandboxed' && unsandboxedAllowProtected();
    const matches = [];
    let filesScanned = 0;
    let truncated = false;
    const stack = [startAbs];
    outer: while (stack.length) {
        const dir = stack.pop();
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const d of entries) {
            if (d.isSymbolicLink())
                continue; // no symlink escape (matches sandbox posture)
            const full = path.join(dir, d.name);
            if (d.isDirectory()) {
                if (DENY_SEGMENTS.has(d.name.toLowerCase()) || d.name.startsWith('.'))
                    continue;
                stack.push(full);
            }
            else if (d.isFile()) {
                // Don't surface a protected file's contents (parity with read_file's denylist).
                if (!allowProtected && deniedByPolicy(d.name))
                    continue;
                if (filesScanned >= SEARCH_MAX_FILES) {
                    truncated = true;
                    break outer;
                }
                let st;
                try {
                    st = statSync(full);
                }
                catch {
                    continue;
                }
                if (st.size > SEARCH_MAX_FILE_BYTES)
                    continue;
                filesScanned++;
                let content;
                try {
                    content = readFileSync(full, 'utf8');
                }
                catch {
                    continue;
                }
                if (content.includes('\u0000'))
                    continue; // binary guard
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (test(lines[i])) {
                        matches.push({ file: path.relative(root, full), line: i + 1, text: lines[i].trim().slice(0, 200) });
                        break; // first match per file (summarized)
                    }
                }
                if (matches.length >= maxResults) {
                    truncated = true;
                    break outer;
                }
            }
        }
    }
    return { query, matches, fileCount: matches.length, filesScanned, truncated };
}
export function sandboxList(ctx, userPath = '.') {
    const { root, mode } = rootAndMode(ctx);
    const { abs, rel } = confine(root, userPath || '.', mode);
    let st;
    try {
        st = lstatSync(abs);
    }
    catch (e) {
        mapFsError(e, rel || '.');
    }
    if (st.isSymbolicLink())
        throw new SandboxError('symlink_escape', `refusing to list a symlink: ${rel || '.'}`);
    if (!st.isDirectory())
        throw new SandboxError('not_dir', `${rel || '.'} is not a directory`);
    const entries = readdirSync(abs, { withFileTypes: true }).map((d) => {
        const type = d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : d.isFile() ? 'file' : 'other';
        const e = { name: d.name, type };
        if (type === 'file') {
            try {
                e.size = statSync(path.join(abs, d.name)).size;
            }
            catch { /* ignore */ }
        }
        return e;
    });
    return { path: rel || '.', entries };
}
/**
 * Forgiving exact-match edit (Claude Code public contract): `old_string` must
 * exist; unless `replace_all`, it must be UNIQUE. No-match / ambiguous throw a
 * SandboxError → the executor returns `success:false` so detectFileChanges does
 * NOT falsely record the file as modified (§4.1). Replacement is LITERAL
 * (split/join, not String.replace) so `$&`/`$1` in new_string are never expanded.
 */
/** Read an existing text file for editing (O_NOFOLLOW; size cap; binary guard). */
function readTextForEdit(abs, rel) {
    let rfd;
    try {
        rfd = openSync(abs, FS.O_RDONLY | FS.O_NOFOLLOW);
    }
    catch (e) {
        mapFsError(e, rel);
    }
    let orig;
    try {
        const st = fstatSync(rfd);
        if (st.isDirectory())
            throw new SandboxError('is_dir', `${rel} is a directory`);
        if (st.size > maxBytes())
            throw new SandboxError('too_large', `file ${st.size}B exceeds cap ${maxBytes()}B`);
        orig = readFdToString(rfd, st.size, maxBytes()).content;
    }
    finally {
        closeSync(rfd);
    }
    // edit_file is a TEXT tool; a NUL byte means a utf8 round-trip would corrupt it.
    if (orig.includes('\0'))
        throw new SandboxError('binary', `${rel} looks binary (NUL byte) — refusing to edit a non-text file`);
    return orig;
}
/**
 * Atomic write: full content → sibling temp → rename over the target. A crash/short
 * write NEVER leaves a zero-length or partial file (the old truncate-then-write did);
 * rename(2) is atomic on one fs and replaces a symlinked target rather than following it.
 */
function atomicWriteText(abs, rel, updated) {
    const outBuf = Buffer.from(updated, 'utf8');
    if (outBuf.length > maxBytes())
        throw new SandboxError('too_large', `result ${outBuf.length}B exceeds cap ${maxBytes()}B`);
    const tmpAbs = path.join(path.dirname(abs), `.${path.basename(abs)}.vodou-tmp.${process.pid}.${_editTmpSeq++}`);
    let wfd;
    try {
        wfd = openSync(tmpAbs, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
    }
    catch (e) {
        mapFsError(e, rel);
    }
    try {
        writeSync(wfd, outBuf, 0, outBuf.length, 0);
    }
    finally {
        closeSync(wfd);
    }
    try {
        renameSync(tmpAbs, abs);
    }
    catch (e) {
        try {
            unlinkSync(tmpAbs);
        }
        catch { /* best-effort cleanup */ }
        mapFsError(e, rel);
    }
    return outBuf.length;
}
/**
 * Forgiving single edit (#8 Bet-1.1): exact → line-number-stripped → trailing-ws →
 * indent-flexible → fuzzy, ambiguity = hard error. No-match/ambiguous throw a
 * SandboxError → executor returns success:false so detectFileChanges does NOT record.
 */
export function sandboxEdit(ctx, userPath, oldString, newString, replaceAll = false) {
    if (typeof oldString !== 'string' || oldString.length === 0) {
        throw new SandboxError('bad_arg', 'old_string is required and must be non-empty');
    }
    const { root, mode } = rootAndMode(ctx);
    const { abs, rel } = confine(root, userPath, mode);
    const orig = readTextForEdit(abs, rel);
    let updated, replacements, strategy;
    try {
        const r = applyEdit(orig, oldString, typeof newString === 'string' ? newString : '', { replaceAll });
        ({ updated, replacements, strategy } = r);
    }
    catch (e) {
        if (e instanceof EditError)
            throw new SandboxError(e.code, e.message);
        throw e;
    }
    const bytes = atomicWriteText(abs, rel, updated);
    return { path: rel, replacements, bytes, strategy };
}
/**
 * Order-invariant, ATOMIC multi-hunk edit (#8 Bet-1.2): all edits resolved against the
 * ORIGINAL file via the same ladder, overlaps rejected, no-match/ambiguous in ANY edit
 * fails the whole call before a byte is written. One atomic write.
 */
export function sandboxMultiEdit(ctx, userPath, edits) {
    if (!Array.isArray(edits) || edits.length === 0) {
        throw new SandboxError('bad_arg', 'edits must be a non-empty array');
    }
    const { root, mode } = rootAndMode(ctx);
    const { abs, rel } = confine(root, userPath, mode);
    const orig = readTextForEdit(abs, rel);
    let result;
    try {
        result = applyMultiEdit(orig, edits);
    }
    catch (e) {
        if (e instanceof EditError)
            throw new SandboxError(e.code, e.message);
        throw e;
    }
    const bytes = atomicWriteText(abs, rel, result.updated);
    return { path: rel, edits: result.edits, totalReplacements: result.totalReplacements, bytes };
}
// monotonic temp-name suffix for atomic edits (avoids collisions across concurrent edits)
let _editTmpSeq = 0;
// ── Read tools: grep / glob / stat / tree (PLAN-FS-TOOLS-EXPANSION §3.1) ──────
// All reuse the SAME confined walk posture as sandboxSearch (symlink-skip,
// DENY_SEGMENTS + hidden-dir skip, size cap, binary guard). All ungated reads.
/**
 * Confined DFS over the workspace under `startAbs`. Calls `visit(full, dirent, depth)`
 * for every NON-symlink entry (files AND dirs). Skips symlinks (no escape), hidden
 * dirs, DENY_SEGMENTS dirs, and — unless `allowProtected` — denied FILES (.env / keys /
 * *.db, etc.). The file-level skip mirrors the per-file denylist read_file enforces:
 * without it, grep/glob/tree pointed at a real tree (flat/unsandboxed) would surface a
 * secret's name/contents that a direct read_file refuses. A visitor returning `false`
 * aborts the walk. `maxDepth` bounds recursion (0 = entries directly under startAbs);
 * `maxEntries` bounds entries visited. Returns `{ truncated }` (true iff maxEntries hit).
 */
function walkWorkspace(startAbs, visit, opts) {
    const maxDepth = opts?.maxDepth ?? Infinity;
    const maxEntries = opts?.maxEntries ?? Infinity;
    const allowProtected = opts?.allowProtected === true;
    let visited = 0;
    const stack = [{ dir: startAbs, depth: 0 }];
    while (stack.length) {
        const { dir, depth } = stack.pop();
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const d of entries) {
            if (d.isSymbolicLink())
                continue; // no symlink escape (sandbox posture)
            // Never surface a protected FILE through a read tool (parity with read_file's
            // denylist). DIRS keep the DENY_SEGMENTS/hidden skip below (recursion guard).
            if (!d.isDirectory() && !allowProtected && deniedByPolicy(d.name))
                continue;
            const full = path.join(dir, d.name);
            if (visit(full, d, depth) === false)
                return { truncated: false };
            if (++visited >= maxEntries)
                return { truncated: true };
            if (d.isDirectory()) {
                if (DENY_SEGMENTS.has(d.name.toLowerCase()) || d.name.startsWith('.'))
                    continue;
                if (depth + 1 <= maxDepth)
                    stack.push({ dir: full, depth: depth + 1 });
            }
        }
    }
    return { truncated: false };
}
/**
 * Convert a glob (`**`, `*`, `?`, `{a,b}`) to a case-insensitive RegExp anchored to
 * the WHOLE path. `**` crosses `/`; `*`/`?` do not. No new dependency.
 */
function globToRegExp(glob) {
    let re = '';
    let braceDepth = 0;
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                re += '.*';
                i++;
                if (glob[i + 1] === '/')
                    i++;
            }
            else
                re += '[^/]*';
        }
        else if (c === '?') {
            re += '[^/]';
        }
        else if (c === '{') {
            re += '(?:';
            braceDepth++;
        }
        else if (c === '}') {
            re += ')';
            if (braceDepth > 0)
                braceDepth--;
        }
        else if (c === ',' && braceDepth > 0) {
            re += '|';
        }
        else if (/[.+^$()|[\]\\]/.test(c)) {
            re += '\\' + c;
        }
        else {
            re += c;
        }
    }
    return new RegExp('^' + re + '$', 'i');
}
/** Normalize a path to forward slashes (for glob matching + stable output). */
function toPosix(p) { return p.split(path.sep).join('/'); }
const GREP_MAX_RESULTS = 200; // total matching lines returned
const GREP_MAX_PER_FILE = 20; // matching lines per file
const GREP_MAX_CONTEXT = 10;
/**
 * Content search returning EVERY matching line (vs sandboxSearch's first-per-file
 * summary), with optional N context lines and an optional filename `glob` filter.
 * Use to INSPECT matches; use search_files to LOCATE files cheaply first.
 */
export function sandboxGrep(ctx, query, opts) {
    const { root, mode } = rootAndMode(ctx);
    const { abs: startAbs } = confine(root, opts?.path && opts.path !== '.' ? opts.path : '.', mode);
    if (!query)
        throw new SandboxError('bad_arg', 'grep query must not be empty');
    let test;
    if (opts?.regex) {
        let re;
        try {
            re = new RegExp(query, 'i');
        }
        catch {
            throw new SandboxError('bad_arg', `invalid regex: ${query}`);
        }
        test = (l) => re.test(l);
    }
    else {
        const q = query.toLowerCase();
        test = (l) => l.toLowerCase().includes(q);
    }
    const includeRe = opts?.glob ? globToRegExp(opts.glob) : null;
    const ctxN = Math.min(GREP_MAX_CONTEXT, Math.max(0, Math.floor(opts?.context ?? 0)));
    const maxResults = Math.min(Math.max(1, Math.floor(opts?.maxResults ?? GREP_MAX_RESULTS)), GREP_MAX_RESULTS);
    const maxPerFile = Math.min(Math.max(1, Math.floor(opts?.maxPerFile ?? GREP_MAX_PER_FILE)), GREP_MAX_PER_FILE);
    const allowProtected = mode === 'unsandboxed' && unsandboxedAllowProtected();
    const matches = [];
    let filesScanned = 0;
    let truncated = false;
    walkWorkspace(startAbs, (full, dirent) => {
        if (!dirent.isFile())
            return;
        const relToStart = toPosix(path.relative(startAbs, full));
        if (includeRe && !includeRe.test(relToStart))
            return;
        let st;
        try {
            st = statSync(full);
        }
        catch {
            return;
        }
        if (st.size > SEARCH_MAX_FILE_BYTES)
            return;
        if (filesScanned >= SEARCH_MAX_FILES) {
            truncated = true;
            return false;
        }
        filesScanned++;
        let content;
        try {
            content = readFileSync(full, 'utf8');
        }
        catch {
            return;
        }
        if (content.includes('\u0000'))
            return; // binary guard
        const lines = content.split('\n');
        const fileRel = toPosix(path.relative(root, full));
        let perFile = 0;
        for (let i = 0; i < lines.length; i++) {
            if (!test(lines[i]))
                continue;
            const m = { file: fileRel, line: i + 1, text: lines[i].slice(0, 300) };
            if (ctxN > 0) {
                m.before = lines.slice(Math.max(0, i - ctxN), i).map((s) => s.slice(0, 300));
                m.after = lines.slice(i + 1, Math.min(lines.length, i + 1 + ctxN)).map((s) => s.slice(0, 300));
            }
            matches.push(m);
            if (matches.length >= maxResults) {
                truncated = true;
                return false;
            }
            if (++perFile >= maxPerFile)
                break;
        }
    }, { allowProtected });
    return { query, matches, matchCount: matches.length, filesScanned, truncated };
}
const GLOB_MAX_RESULTS = 500;
/**
 * Find files whose path matches a glob (`**`/`*`/`?`/`{a,b}`). Pattern is matched
 * against the path RELATIVE to `path` (default workspace root); results report the
 * workspace-relative path so the model can read_file them directly. Reads no file
 * bodies — cheaper than search.
 */
export function sandboxGlob(ctx, pattern, opts) {
    const { root, mode } = rootAndMode(ctx);
    const { abs: startAbs } = confine(root, opts?.path && opts.path !== '.' ? opts.path : '.', mode);
    if (!pattern)
        throw new SandboxError('bad_arg', 'glob pattern must not be empty');
    const re = globToRegExp(pattern);
    const maxResults = Math.min(Math.max(1, Math.floor(opts?.maxResults ?? GLOB_MAX_RESULTS)), GLOB_MAX_RESULTS);
    const allowProtected = mode === 'unsandboxed' && unsandboxedAllowProtected();
    const files = [];
    let filesScanned = 0;
    let truncated = false;
    walkWorkspace(startAbs, (full, dirent) => {
        if (!dirent.isFile())
            return;
        filesScanned++;
        if (!re.test(toPosix(path.relative(startAbs, full))))
            return;
        let st;
        try {
            st = statSync(full);
        }
        catch {
            return;
        }
        files.push({ path: toPosix(path.relative(root, full)), size: st.size, mtimeMs: Math.round(st.mtimeMs) });
        if (files.length >= maxResults) {
            truncated = true;
            return false;
        }
    }, { maxEntries: SEARCH_MAX_FILES, allowProtected });
    return { pattern, files, fileCount: files.length, filesScanned, truncated };
}
/** Stat one path: exists / type / size / mtime, plus lineCount for a text file. */
export function sandboxStat(ctx, userPath) {
    const { root, mode } = rootAndMode(ctx);
    const { abs, rel } = confine(root, userPath, mode);
    let st;
    try {
        st = lstatSync(abs);
    }
    catch (e) {
        if (e?.code === 'ENOENT')
            return { path: rel, exists: false };
        mapFsError(e, rel);
    }
    const type = st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : 'other';
    const out = { path: rel, exists: true, type, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
    if (type === 'file' && st.size <= maxBytes()) {
        try {
            const content = readFileSync(abs, 'utf8');
            if (!content.includes('\u0000')) {
                const lines = content.split('\n');
                if (lines.length > 1 && lines[lines.length - 1] === '')
                    lines.pop();
                out.lineCount = lines.length;
            }
        }
        catch { /* ignore — stat still useful without lineCount */ }
    }
    return out;
}
const TREE_DEFAULT_DEPTH = 3;
const TREE_MAX_DEPTH = 10;
const TREE_MAX_ENTRIES = 500;
/** Recursive directory structure to depth N (orientation), workspace-relative paths. */
export function sandboxTree(ctx, opts) {
    const { root, mode } = rootAndMode(ctx);
    const { abs: startAbs, rel } = confine(root, opts?.path && opts.path !== '.' ? opts.path : '.', mode);
    const depth = Math.min(TREE_MAX_DEPTH, Math.max(1, Math.floor(opts?.depth ?? TREE_DEFAULT_DEPTH)));
    const maxEntries = Math.min(TREE_MAX_ENTRIES, Math.max(1, Math.floor(opts?.maxEntries ?? TREE_MAX_ENTRIES)));
    const allowProtected = mode === 'unsandboxed' && unsandboxedAllowProtected();
    const entries = [];
    const { truncated } = walkWorkspace(startAbs, (full, dirent, d) => {
        const type = dirent.isDirectory() ? 'dir' : dirent.isFile() ? 'file' : null;
        if (!type)
            return; // skip sockets/fifos/etc.
        entries.push({ path: toPosix(path.relative(root, full)), type, depth: d });
    }, { maxDepth: depth - 1, maxEntries, allowProtected });
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { path: rel || '.', depth, entries, entryCount: entries.length, truncated };
}
