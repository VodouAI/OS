/**
 * PLAN-JOB-FOLLOWUP — "I'll report back when it lands" has to actually land.
 *
 * The gateway answers a chat turn by spawning a `claude -p` subprocess. That
 * subprocess dies the moment the turn ends. So when the model starts a long
 * background job (`script-executor`, which detaches a wrapper and returns a
 * `job_<id>` immediately) and closes with "watcher armed on pid 3854; I'll read
 * the exit code when it lands", there is nothing left alive to read it. Live
 * evidence 2026-08-27: `job_PBaNzG47WZHL` (blog-morning) exited rc=0 at
 * 18:06:29, seven minutes after the turn that started it ended at 18:01 —
 * the conversation was never told.
 *
 * This module is the missing lane, and it lives entirely on the gateway (which
 * does outlive the turn):
 *
 *   1. `noteToolResult` sniffs job ids out of tool results as the turn streams.
 *   2. `noteAssistantText` accumulates the reply so `armWatches` can tell
 *      whether the model PROMISED a follow-up.
 *   3. `armWatches` (on `done`) records a watch for every job still running —
 *      and, when the reply promised a follow-up but started no registered job,
 *      for any still-alive pid the reply named (`nohup … &`, a detached build).
 *   4. `startJobWatcher` polls those watches and, when one finishes, posts a
 *      receipt into the conversation — plus, when a follow-up was promised, one
 *      LLM turn that delivers the report the model said it would deliver.
 *
 * Provider-agnostic on purpose: the hook sits in `dispatchToProvider`, which
 * every model (claude-cli, Anthropic SDK, OpenAI-compat, kimi) passes through.
 * A registered job is the only source that can report an exit CODE; a pid can
 * only report that it ended — which is still the signal the follow-up turn
 * needs in order to go read the log itself.
 *
 * Everything is injected (`setJobSurfaceImpl` / `setJobReportImpl`) the same way
 * `setBoardSurfaceImpl` is, so this file never imports index.ts or llm.ts.
 *
 * Time canon: `script_jobs.started_at`/`completed_at` are SQLite
 * `CURRENT_TIMESTAMP` — naive UTC — so they are parsed as UTC, never as local.
 */
import { readFileSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { getDb, getGatewayDb } from './db.js';
// P4 — "is this reply the work, or talk about the work?" is answered in ONE
// place now, shared with the browser panel lane's narration guard.
import { promisesFollowup, TAIL_SCAN_CHARS } from './reply-shape.js';
/** `job_PBaNzG47WZHL` — the id shape script-runner.ts generates. */
const JOB_ID_RE = /\bjob_[A-Za-z0-9_-]{8,}\b/g;
/** Only scan the head of a tool result — job ids are announced, not buried. */
const TOOL_RESULT_SCAN_CHARS = 20_000;
/** How much of the job's log to quote back. */
const LOG_TAIL_CHARS = 1_500;
/** `report` = receipt + one LLM turn when a follow-up was promised. */
export function jobFollowupMode() {
    const raw = (process.env.VODOU_JOB_FOLLOWUP || 'report').toLowerCase().trim();
    return raw === 'off' || raw === 'receipt' ? raw : 'report';
}
/** Poll cadence. A detached job's status is written by the wrapper on exit. */
const POLL_MS = parseInt(process.env.VODOU_JOB_WATCH_POLL_MS || '15000', 10);
/** Give up on a job that never reaches a terminal status (default 6h). */
const WATCH_CEILING_MS = parseInt(process.env.VODOU_JOB_WATCH_CEILING_MS || String(6 * 60 * 60 * 1000), 10);
const TERMINAL = new Set(['completed', 'failed', 'killed', 'cancelled', 'timeout']);
let _surface = null;
let _report = null;
export function setJobSurfaceImpl(fn) { _surface = fn; }
export function setJobReportImpl(fn) { _report = fn; }
const _turns = new Map();
function turnState(conversationId) {
    let s = _turns.get(conversationId);
    if (!s) {
        s = { jobIds: new Set(), tail: '', sawTools: false, bgShells: [] };
        _turns.set(conversationId, s);
    }
    return s;
}
/**
 * Called for every `tool_call_start`. The one thing worth knowing before the
 * result comes back: did the model reach for a BACKGROUND SHELL?
 *
 * `Bash(run_in_background: true)` inside the gateway's `claude -p` subprocess
 * has no exit code the gateway can read and no output that reaches gateway-side
 * state. Measured 2026-08-27: 18 of 676 recorded gateway turns did this. The
 * system prompt steers to the script executor instead. For the turns that do it
 * anyway, `armWatches` finds the shell in the process table and watches it like
 * a named pid, so the result still comes back to the chat.
 *
 * The FULL command is kept: it is what the process table is searched for.
 */
export function noteToolStart(conversationId, toolName, toolArgs) {
    if (jobFollowupMode() === 'off' || !toolArgs)
        return;
    if (toolArgs.run_in_background !== true)
        return;
    const cmd = typeof toolArgs.command === 'string' ? toolArgs.command : String(toolName ?? 'command');
    turnState(conversationId).bgShells.push(cmd.slice(0, 4000));
}
function defaultProcessList() {
    if (process.platform === 'win32')
        return [];
    try {
        const out = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,command='], {
            encoding: 'utf8', timeout: 3000, maxBuffer: 32 * 1024 * 1024,
        });
        const rows = [];
        for (const line of out.split('\n')) {
            const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
            if (m)
                rows.push({ pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10), command: m[3] });
        }
        return rows;
    }
    catch (e) {
        console.error('[job-watch] process table read failed:', e.message);
        return [];
    }
}
let _processList = defaultProcessList;
/** Tests inject a fixed table; `null` restores the real `ps`. */
export function setProcessListImpl(fn) {
    _processList = fn ?? defaultProcessList;
}
/** Quotes and backslashes out, whitespace collapsed. The Bash tool runs a
 *  command as `zsh -c … eval '<command>'`, re-quoting every `'` as `'\''`, so the
 *  raw command is only a substring of the process's command line once quoting is
 *  ignored on both sides. */
function normCommand(s) {
    return s.replace(/['"\\]/g, '').replace(/\s+/g, ' ').trim();
}
/**
 * The pid of the shell running `command`, or null. Among processes whose command
 * line contains it, the OUTERMOST (its parent does not also match) is the one
 * whose exit means the whole command finished — the shell wrapper, not the
 * `node` it spawned. Newest wins, so a command re-run in a later turn binds to
 * that turn's copy. Refuses a very short command: `ls` matches half the table.
 */
export function findBackgroundShellPid(command, rows = _processList()) {
    const needle = normCommand(command);
    if (needle.length < 12)
        return null;
    const matches = rows.filter((r) => r.pid !== process.pid && normCommand(r.command).includes(needle));
    if (matches.length === 0)
        return null;
    const matchIds = new Set(matches.map((r) => r.pid));
    const outer = matches.filter((r) => !matchIds.has(r.ppid)).sort((a, b) => b.pid - a.pid);
    return outer[0]?.pid ?? null;
}
/** Called for every `tool_call_end` — collects job ids the turn started. */
export function noteToolResult(conversationId, toolResult) {
    if (jobFollowupMode() === 'off')
        return;
    turnState(conversationId).sawTools = true;
    if (!toolResult)
        return;
    const head = toolResult.length > TOOL_RESULT_SCAN_CHARS ? toolResult.slice(0, TOOL_RESULT_SCAN_CHARS) : toolResult;
    const found = head.match(JOB_ID_RE);
    if (!found)
        return;
    const s = turnState(conversationId);
    for (const id of found)
        s.jobIds.add(id);
}
/** Called for every `text` event — keeps only the tail, which is where a
 *  sign-off promise lives. */
export function noteAssistantText(conversationId, content) {
    if (jobFollowupMode() === 'off' || !content)
        return;
    const s = turnState(conversationId);
    s.tail = (s.tail + content).slice(-TAIL_SCAN_CHARS);
}
function readJob(jobId) {
    try {
        const row = getDb().prepare(`SELECT job_id, script_name, status, exit_code, pid, started_at, completed_at, output_file, error_file
         FROM script_jobs WHERE job_id = ?`).get(jobId);
        return row ?? null;
    }
    catch (e) {
        console.error('[job-watch] script_jobs read failed:', e.message);
        return null;
    }
}
/**
 * Lanes that speak without being asked — the Face's per-page context turns.
 * They are commentary on what the user is doing, not answers owed to them.
 */
export function isAmbientLane(conversationId) {
    return conversationId.startsWith('brainctx:');
}
function insertWatch(w) {
    try {
        getGatewayDb().prepare(`INSERT OR IGNORE INTO job_watches
         (watch_key, kind, job_id, pid, conversation_id, script_name, promised, armed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(w.watch_key, w.kind, w.job_id, w.pid, w.conversation_id, w.script_name, w.promised ? 1 : 0, w.armed_at);
        return true;
    }
    catch (e) {
        console.error('[job-watch] arm failed:', e.message);
        return false;
    }
}
/**
 * End of turn: arm a watch for every job this turn started that is STILL
 * running. A job that already finished mid-turn needs no watch — the model saw
 * its result and answered with it.
 *
 * Also the honest half: a turn that promised a follow-up but started nothing
 * watchable gets one visible line saying so, instead of a promise that quietly
 * never arrives.
 */
export function armWatches(conversationId) {
    const s = _turns.get(conversationId);
    _turns.delete(conversationId);
    if (!s || jobFollowupMode() === 'off')
        return;
    const promised = promisesFollowup(s.tail);
    const now = Date.now();
    let armed = 0;
    for (const jobId of s.jobIds) {
        const job = readJob(jobId);
        if (!job || TERMINAL.has(job.status))
            continue;
        if (insertWatch({
            watch_key: jobId, kind: 'job', job_id: jobId, pid: null,
            conversation_id: conversationId, script_name: job.script_name ?? '',
            promised, armed_at: now,
        }))
            armed++;
    }
    // Background shells. The shell is a child of the pooled `claude -p` that
    // answered, and it keeps running after the reply: measured 2026-09-15, a
    // Reddit scan started this way was still alive 8 minutes later while this
    // module told the user its output "cannot reach this chat". So find it in the
    // process table and watch it like a named pid. When it exits, the receipt and
    // one follow-up turn (always: a background shell is work the user is waiting
    // on) land in this conversation.
    const watchedShells = [];
    const lostShells = [];
    for (const cmd of s.bgShells) {
        const pid = findBackgroundShellPid(cmd);
        if (pid !== null && pidAlive(pid) && insertWatch({
            watch_key: `pid:${pid}:${now}`, kind: 'pid', job_id: null, pid,
            conversation_id: conversationId, script_name: cmd.slice(0, 500), promised: true, armed_at: now,
        })) {
            watchedShells.push({ cmd, pid });
            armed++;
        }
        else {
            lostShells.push(cmd);
        }
    }
    if (watchedShells.length > 0 && _surface) {
        const list = watchedShells.map((w) => `\`${w.cmd.slice(0, 120)}\` (pid ${w.pid})`).join(', ');
        console.error(`[job-watch] ${conversationId} watching ${watchedShells.length} background shell(s): ${watchedShells.map((w) => w.pid).join(', ')}`);
        _surface(conversationId, `_⏳ Still running in the background: ${list}. Vodou is watching it and will report the result here when it finishes._`);
    }
    // No registered job, but the reply promised a report and named a process that
    // is still alive — the `nohup … &` / detached-build case, which is most of
    // what "running it in the background" actually means. We can't know its exit
    // code, but we can know when it ENDS, and that is the trigger the follow-up
    // turn needs. Gated on `promised` so quoting a pid from `ps` arms nothing.
    if (armed === 0 && promised) {
        for (const pid of pidsIn(s.tail)) {
            if (!pidAlive(pid))
                continue;
            if (insertWatch({
                watch_key: `pid:${pid}:${now}`, kind: 'pid', job_id: null, pid,
                conversation_id: conversationId, script_name: '', promised: true, armed_at: now,
            }))
                armed++;
        }
    }
    // A background shell that could not be found running when the turn ended —
    // finished already, or not visible to `ps` (Windows). Nothing is left to watch
    // and its output did not reach the chat. Say so, and name the lane that
    // reports with an exit code.
    if (lostShells.length > 0 && _surface) {
        const list = lostShells.map((c) => `\`${c.slice(0, 120)}\``).join(', ');
        console.error(`[job-watch] ${conversationId} left ${lostShells.length} background shell(s) that could not be watched`);
        _surface(conversationId, `_⚠️ ${lostShells.length === 1 ? 'A background shell was' : `${lostShells.length} background shells were`} `
            + `started in this turn (${list}), but it was not running when the reply ended, so there was nothing to watch `
            + `and its output did not reach this chat. For long work, use the script executor; those jobs are watched and `
            + `post their exit code here._`);
    }
    if (armed > 0) {
        console.error(`[job-watch] armed ${armed} watch(es) for ${conversationId} (promised=${promised})`);
        return;
    }
    if (lostShells.length > 0)
        return;
    // A promise with nothing behind it. Say so in the conversation — the whole
    // failure mode this module exists for is a follow-up nobody is coming back
    // for, and silence is what made it invisible.
    // Gated on `sawTools`: "I'll let you know" in an ordinary conversation is
    // small talk, not an unkept promise. The failure this notice is for only
    // happens in a turn that actually RAN something.
    //
    // And never in the ambient lane. Measured against 3000 real gateway turns:
    // 1.37% match the promise heuristic, and the largest block of would-be FALSE
    // positives is `brainctx:` — the Face reacting to a half-typed message, where
    // "when it lands" means the USER finishing their sentence, not a job
    // ("When it lands complete, I'll respond to the whole thing at once"). Nobody
    // asked those turns for anything, so a warning there is pure noise. A job
    // genuinely started from that lane still gets its receipt; only the
    // nothing-is-coming notice is suppressed.
    if (promised && s.sawTools && !isAmbientLane(conversationId) && _surface) {
        console.error(`[job-watch] ${conversationId} promised a follow-up with no watchable job`);
        _surface(conversationId, '_⏳ Nothing was armed to report back on this turn — the assistant process ends with the reply, '
            + 'so no follow-up will arrive on its own. Ask when you want it checked._');
    }
}
/** Pids the reply named: "Watcher armed on pid 3854", "pid 39096". */
const PID_RE = /\bpid[:# ]\s*(\d{2,7})\b/gi;
/** Is this process still running? EPERM = alive but not ours. */
export function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === 'EPERM';
    }
}
export function pidsIn(text) {
    const out = [];
    PID_RE.lastIndex = 0;
    let m;
    while ((m = PID_RE.exec(text)) !== null)
        out.push(parseInt(m[1], 10));
    return out;
}
// ── Receipt formatting ─────────────────────────────────────────────────────
/** Naive-UTC (`YYYY-MM-DD HH:MM:SS`) → epoch ms. Per PLAN-TIME-CANON, these
 *  instants are UTC; `new Date(s)` would read them as LOCAL (the `-240m` bug
 *  in script-runner's own `elapsed`). */
export function parseNaiveUtc(s) {
    if (!s)
        return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s.trim());
    if (!m)
        return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}
function humanDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}
function tailOf(file, chars = LOG_TAIL_CHARS) {
    if (!file)
        return '';
    try {
        if (statSync(file).size === 0)
            return '';
        const text = readFileSync(file, 'utf8');
        return text.length > chars ? text.slice(-chars) : text;
    }
    catch {
        return '';
    }
}
/**
 * `run-background-job.sh` writes its own `--- Job … Started/Finished ---`
 * banners into BOTH the stdout and the stderr file, and the command header on
 * top of stdout. So "the error file is non-empty" is true of every job ever
 * run, and a receipt that trusted it showed two banners and hid the actual
 * output. Strip the wrapper's own noise before asking whether anything is there
 * — the receipt line already says the status, the code and the duration.
 */
function stripWrapperNoise(text) {
    return text
        .split('\n')
        .filter((l) => !/^--- Job \S+ (?:Started|Finished)/.test(l)
        && !/^Command: /.test(l)
        && !/^Working Directory: /.test(l))
        .join('\n')
        .trim();
}
export function formatReceipt(job) {
    const ok = job.status === 'completed' && (job.exit_code ?? 0) === 0;
    const icon = ok ? '✅' : '⛔';
    const started = parseNaiveUtc(job.started_at);
    const ended = parseNaiveUtc(job.completed_at) ?? Date.now();
    const elapsed = started !== null ? ` after ${humanDuration(ended - started)}` : '';
    const rc = job.exit_code === null || job.exit_code === undefined ? '?' : String(job.exit_code);
    const head = `${icon} **${job.script_name || 'job'}** \`${job.job_id}\` — ${job.status}, **rc=${rc}**${elapsed}.`;
    const err = stripWrapperNoise(tailOf(job.error_file, 800));
    const out = stripWrapperNoise(tailOf(job.output_file));
    // Both, when both have something: a job can fail with a useful stdout, and a
    // job can succeed while warning on stderr. Showing one and silently dropping
    // the other is how the first version of this hid every job's actual output.
    const body = (err ? `\n\nstderr:\n\`\`\`\n${err}\n\`\`\`` : '')
        + (out ? `\n\n\`\`\`\n${out}\n\`\`\`` : '');
    return head + body;
}
/** The prompt the follow-up turn runs on. Deliberately closes the loop AND
 *  forbids opening a new one — a report that ends in another promise is the
 *  same bug one turn later. */
export function reportPrompt(job) {
    const out = stripWrapperNoise(tailOf(job.output_file));
    const err = stripWrapperNoise(tailOf(job.error_file, 800));
    return [
        `[job-watch] The background job you started has finished. You promised to report on it, and this is that follow-up turn.`,
        ``,
        `job_id: ${job.job_id}`,
        `script: ${job.script_name}`,
        `status: ${job.status}`,
        `exit_code: ${job.exit_code ?? '?'}`,
        `started_at (UTC): ${job.started_at ?? '?'}`,
        `completed_at (UTC): ${job.completed_at ?? '?'}`,
        out ? `\nstdout tail:\n${out}` : '',
        err ? `\nstderr tail:\n${err}` : '',
        ``,
        `Deliver the report now, in the terms you said you would use. Check whatever the job was supposed to produce.`,
        `Do NOT promise another follow-up: this turn ends and nothing of yours stays running.`,
    ].filter((l) => l !== '').join('\n');
}
/** Same job, no exit code: the process the reply was watching has ended.
 *  `command` is set for a background shell, which the reply may never have
 *  promised to report on — the user is waiting on it all the same. */
export function pidReportPrompt(pid, ran, command) {
    const lines = command
        ? [
            `[job-watch] The background command you started (pid ${pid}) has exited — it ran about ${ran} after your turn ended. This is the follow-up turn; the user is waiting for its result.`,
            `command: ${command}`,
        ]
        : [`[job-watch] The background process you said you would report on (pid ${pid}) has exited — it ran about ${ran} after your turn ended. This is that follow-up turn.`];
    return [
        ...lines,
        ``,
        `There is no exit code: the process was not started through the script executor, so check its output yourself — the log file you redirected to, the artifact it was supposed to produce, or the state it was supposed to change.`,
        command
            ? `Then answer the user with what it produced, as the reply the earlier turn could not give.`
            : `Then deliver the report, in the terms you said you would use.`,
        `Do NOT promise another follow-up: this turn ends and nothing of yours stays running.`,
    ].join('\n');
}
let _timer = null;
/** Watches whose follow-up turn is in flight — never fire two. */
const _reporting = new Set();
function openWatches() {
    try {
        return getGatewayDb().prepare(`SELECT watch_key, kind, job_id, pid, conversation_id, script_name, promised, armed_at
         FROM job_watches WHERE notified_at IS NULL ORDER BY armed_at`).all();
    }
    catch (e) {
        console.error('[job-watch] watch read failed:', e.message);
        return [];
    }
}
function closeWatch(key) {
    try {
        getGatewayDb().prepare('UPDATE job_watches SET notified_at = ? WHERE watch_key = ?').run(Date.now(), key);
    }
    catch (e) {
        console.error('[job-watch] watch close failed:', e.message);
    }
}
/** One pass. Exported so a test can drive it without a timer. */
export async function pollJobWatches(now = Date.now()) {
    if (jobFollowupMode() === 'off')
        return 0;
    let delivered = 0;
    for (const w of openWatches()) {
        if (_reporting.has(w.watch_key))
            continue;
        // What "finished" means differs by kind; everything after this block does not.
        let finished;
        let receipt;
        let prompt;
        let stillLabel;
        if (w.kind === 'pid') {
            finished = !pidAlive(w.pid ?? 0);
            const ran = humanDuration(now - w.armed_at);
            // A background shell's watch carries its command in script_name.
            const cmd = w.script_name ? w.script_name : '';
            const what = cmd
                ? `The background command \`${cmd.slice(0, 120)}\` (pid ${w.pid})`
                : `The background process \`pid ${w.pid}\``;
            receipt = `⏹ ${what} has exited (ran ~${ran} since the turn ended). `
                + `No exit code — it was not started through the script executor, so only its own log knows how it went.`;
            prompt = pidReportPrompt(w.pid ?? 0, ran, cmd || undefined);
            stillLabel = cmd ? `\`${cmd.slice(0, 120)}\` (pid ${w.pid}) is still running` : `\`pid ${w.pid}\` is still running`;
        }
        else {
            const job = readJob(w.job_id ?? '');
            if (!job) {
                // The row vanished (db reset / pruned). Close the watch rather than
                // re-reading it forever.
                closeWatch(w.watch_key);
                continue;
            }
            finished = TERMINAL.has(job.status);
            receipt = finished ? formatReceipt(job) : '';
            prompt = finished ? reportPrompt(job) : '';
            stillLabel = `\`${job.job_id}\` (${job.script_name || 'job'}) is still \`${job.status}\``;
        }
        if (!finished) {
            if (now - w.armed_at > WATCH_CEILING_MS) {
                closeWatch(w.watch_key);
                _surface?.(w.conversation_id, `_⏳ ${stillLabel} after ${humanDuration(now - w.armed_at)} — no longer watching it._`);
            }
            continue;
        }
        closeWatch(w.watch_key);
        delivered++;
        try {
            _surface?.(w.conversation_id, receipt);
        }
        catch (e) {
            console.error('[job-watch] receipt surface failed:', e.message);
        }
        if (w.promised === 1 && jobFollowupMode() === 'report' && _report) {
            _reporting.add(w.watch_key);
            void (async () => {
                try {
                    await _report(w.conversation_id, prompt);
                }
                catch (e) {
                    console.error(`[job-watch] follow-up turn for ${w.watch_key} failed:`, e.message);
                }
                finally {
                    _reporting.delete(w.watch_key);
                }
            })();
        }
    }
    return delivered;
}
export function startJobWatcher() {
    if (_timer || jobFollowupMode() === 'off')
        return;
    _timer = setInterval(() => { void pollJobWatches(); }, POLL_MS);
    _timer.unref?.();
    console.error(`[job-watch] watching background jobs every ${Math.round(POLL_MS / 1000)}s (mode=${jobFollowupMode()})`);
}
export function stopJobWatcher() {
    if (_timer) {
        clearInterval(_timer);
        _timer = null;
    }
}
