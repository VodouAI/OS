#!/usr/bin/env node
/**
 * cli-qa.mjs — end-to-end QA gate for the Vodou CLI (bin/vodou-cli).
 *
 * Drives the real launcher: one-shot mode (child_process) for fast assertions, and a
 * pseudo-terminal (node-pty) fed through a headless terminal emulator (@xterm/headless)
 * for the things that only matter on a real screen — output persistence, scrollback,
 * slash commands, and the Ink TUI. The emulator is essential: grepping the raw pty byte
 * stream gives FALSE PASSES because erased-on-screen text still appears in the bytes.
 *
 * Run: node scripts/cli-qa.mjs   (from MCP-servers/Vodou-Console, after `npm run build`)
 */

import { createRequire } from 'module';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../../..');
const CLI = path.join(PROJECT_ROOT, 'bin', 'vodou-cli');
const SCRATCH = '/tmp/vodou-qa-scratch';

const results = [];
const record = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`); };

function setupScratch() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.writeFileSync(path.join(SCRATCH, 'NOTES.txt'), 'hello from the scratch repo\nsecond line\n');
  for (const f of ['WRITE_TEST.txt']) { try { fs.unlinkSync(path.join(SCRATCH, f)); } catch {} }
}

/** Run a one-shot turn; resolve stdout (ANSI stripped). */
function oneShot(prompt, { cwd = SCRATCH, stdin } = {}) {
  return new Promise((resolve) => {
    const args = stdin == null ? ['-p', prompt] : [];
    const p = spawn(CLI, args, { cwd, env: process.env });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    if (stdin != null) { p.stdin.write(stdin); p.stdin.end(); }
    p.on('close', () => resolve(out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')));
    p.on('error', () => resolve(''));
  });
}

/** Run an interactive pty session through the emulator; resolve {screen, baseY}. */
function ptySession(steps, { cols = 100, rows = 40, cwd = SCRATCH, dumpAt, extraArgs = [] } = {}) {
  return new Promise((resolve) => {
    const term = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
    const cmd = [CLI, ...extraArgs].join(' ');
    const p = pty.spawn('/bin/bash', ['-lc', cmd], { name: 'xterm-color', cols, rows, cwd, env: process.env });
    p.onData((d) => term.write(d));
    for (const [t, s] of steps) setTimeout(() => { try { p.write(s); } catch {} }, t);
    setTimeout(() => {
      const b = term.buffer.active;
      let screen = '';
      for (let y = 0; y < b.length; y++) { const l = b.getLine(y); if (l) screen += l.translateToString(true).replace(/\s+$/, '') + '\n'; }
      try { p.kill(); } catch {}
      resolve({ screen, baseY: b.baseY });
    }, dumpAt);
    p.onExit(() => {});
  });
}

async function main() {
  if (!fs.existsSync(CLI)) { console.error(`CLI not found: ${CLI}`); process.exit(2); }
  setupScratch();
  console.log(`QA: ${CLI}\nscratch: ${SCRATCH}\n`);

  // 1. one-shot answer
  const r1 = await oneShot('what is 2+2? reply with just the number');
  record('one-shot output', /\b4\b/.test(r1), r1.match(/⏺.*/)?.[0]?.slice(0, 40) || '');

  // 2. cwd read
  const r2 = await oneShot('read NOTES.txt and quote its first line exactly');
  record('cwd read (launch dir)', /hello from the scratch repo/.test(r2));

  // 3. cwd write
  await oneShot('create a file named WRITE_TEST.txt containing the word VERIFIED');
  record('cwd write (launch dir)', fs.existsSync(path.join(SCRATCH, 'WRITE_TEST.txt')));

  // 4. model label = configured (sonnet) for substantive turn
  const r4 = await oneShot('summarize the files in this directory in one sentence');
  record('model = configured (sonnet) on substantive turn', /claude-sonnet/.test(r4), (r4.match(/claude-[a-z0-9-]+/) || [''])[0]);

  // 5. session continuity across two processes
  await oneShot('Remember this fact: the QA code is 8821. Acknowledge in 3 words.');
  const r5 = await oneShot('What QA code did I tell you? Reply with just the number.');
  record('session continuity (cross-launch)', /8821/.test(r5));

  // 6. piped stdin one-shot
  const r6 = await oneShot(null, { stdin: 'how many .txt files are here? just the number\n' });
  record('piped stdin one-shot', /\d/.test(r6.replace(/build [0-9-]+[a-z]/, '')));

  // 7. tool turn output PERSISTS on screen (emulator) — runs against the DEFAULT renderer
  // (now the TUI). Marker set is renderer-agnostic: TUI tool lines use ✓/✗, plain uses ⎿/⏺.
  const s7 = await ptySession([[7000, 'count the .txt files here using a tool, then say the number and DONE'], [8500, '\r']], { dumpAt: 45000 });
  record('tool-turn output persists (screen)', /DONE/.test(s7.screen) && /✓|✗|⎿|⏺/.test(s7.screen));

  // 8. scrollback present (small viewport + long output) — PLAIN renderer (now that TUI is
  // the default, pin --plain so both renderers' scrollback stay covered; TUI is check 12).
  // 50s window: 25 lines via a cold claude-cli turn can take >25s → short dumpAt false-fails.
  const s8 = await ptySession([[7000, 'list the numbers 1 to 25, each on its own line'], [8500, '\r']], { rows: 12, dumpAt: 50000, extraArgs: ['--plain'] });
  record('native scrollback (--plain)', s8.baseY > 0, `baseY=${s8.baseY}`);

  // 9. slash command /usage
  const s9 = await ptySession([[7000, 'hi'], [8500, '\r'], [20000, '/usage'], [21000, '\r']], { dumpAt: 24000 });
  record('slash /usage', /turn\(s\)/.test(s9.screen));

  // 10. startup banner (VODOU wordmark + tagline + build marker)
  const s10 = await ptySession([[6000, '/exit'], [6500, '\r']], { dumpAt: 8000 });
  record('startup banner + build marker',
    /[▀▄█]/.test(s10.screen) && /personalization OS/.test(s10.screen) && /build 20\d\d-\d\d-\d\d/.test(s10.screen),
    (s10.screen.match(/build 20[0-9-]+[a-z]?/) || [''])[0]);

  // 11. --tui launches and renders the banner (VODOU wordmark + cwd)
  const s11 = await ptySession([[7000, '/exit'], [8000, '\r']], { dumpAt: 10000, extraArgs: ['--tui'] });
  record('--tui launches', /[▀▄█]/.test(s11.screen) && /cwd:|\/tmp/.test(s11.screen));

  // 12. --tui SCROLLBACK: long answer in a short viewport must commit finished lines to
  // native scrollback (baseY>0) without losing them — early AND late lines both retained.
  // Regression guard for the "answer taller than the viewport corrupts/pins/vanishes" bug:
  // before the incremental-commit fix the whole stream sat in the live tail and this fails.
  const s12 = await ptySession(
    [[7000, 'list the numbers 1 to 25, each on its own line, nothing else'], [8500, '\r']],
    { rows: 12, dumpAt: 50000, extraArgs: ['--tui'] }
  );
  const early12 = /(^|\n)\s*1\s*($|\n)/.test(s12.screen);
  const late12 = /(^|\n)\s*25\s*($|\n)/.test(s12.screen);
  record('--tui native scrollback (no vanish)', s12.baseY > 0 && early12 && late12,
    `baseY=${s12.baseY} early=${early12} late=${late12}`);

  // 13. TUI markdown + hyperlink parsing — deterministic unit check (no LLM), guards the
  // dependency-free renderer: inline styling, markdown + bare links, and code-fence state.
  let ok13 = false, d13 = '';
  try {
    const md = await import(pathToFileURL(path.join(PROJECT_ROOT, 'MCP-servers/Vodou-Console/dist/cli/renderers/markdown.js')).href);
    const segs = md.parseInline('see **bold**, `code`, [Vodou](https://vodou.ai) and https://x.io done');
    const bold = segs.some((s) => s.bold && s.text === 'bold');
    const code = segs.some((s) => s.code && s.text === 'code');
    const mdlink = segs.some((s) => s.href === 'https://vodou.ai' && s.text === 'Vodou');
    const bare = segs.some((s) => s.href === 'https://x.io' && s.text === 'https://x.io');
    const fence = md.classifyLine('```js', false).nextFence === true && md.classifyLine('const x = 1', true).md.kind === 'code';
    ok13 = bold && code && mdlink && bare && fence;
    d13 = `bold=${bold} code=${code} mdlink=${mdlink} bare=${bare} fence=${fence}`;
  } catch (e) { d13 = 'import failed: ' + (e?.message || e); }
  record('TUI markdown + links parse', ok13, d13);

  // 14. slash-command data formatters — deterministic (reads vodou-core.db, no LLM). Guards
  // /server, /skills, /tools returning real rows rather than throwing into the input loop.
  let ok14 = false, d14 = '';
  try {
    const cmd = await import(pathToFileURL(path.join(PROJECT_ROOT, 'MCP-servers/Vodou-Console/dist/cli/commands.js')).href);
    const sv = /MCP servers \(\d+\/\d+ active\)/.test(cmd.listServersText());
    const sk = /skills \(\d+\)/.test(cmd.listSkillsText());
    const tl = /tools \(\d+/.test(cmd.listToolsText('gmail'));
    ok14 = sv && sk && tl;
    d14 = `server=${sv} skills=${sk} tools=${tl}`;
  } catch (e) { d14 = 'import failed: ' + (e?.message || e); }
  record('slash formatters (/server /skills /tools)', ok14, d14);

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error('QA harness error:', e); process.exit(2); });
