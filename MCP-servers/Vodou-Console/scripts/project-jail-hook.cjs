#!/usr/bin/env node
/**
 * project-jail-hook.cjs — Claude Code PreToolUse hook enforcing per-project file isolation.
 *
 * PLAN-PROJECT-FS-JAIL (alpha bug 2026-07-09: prompting inside a gateway project could
 * read anywhere on disk; a broad "index" walk reached ~/Pictures and tripped macOS TCC).
 *
 * The gateway spawns claude-cli with cwd = the active project's root_path and
 * --dangerously-skip-permissions. Permission rules can't express "deny everything
 * outside <root>", but PreToolUse hooks fire in ALL permission modes — so this script
 * is the boundary. It receives the hook JSON on stdin and blocks (exit 2, reason on
 * stderr → fed back to the model) any file-tool call that resolves outside the jail.
 *
 * Jail root comes from env VODOU_PROJECT_JAIL_ROOT (set by llm.ts only for
 * non-Default project turns). No env → allow everything (exit 0) — fail-open by
 * design: this is a project-scoping boundary for the single-user local product,
 * not a security sandbox (see PLAN-SECURITY-AUDIT-FINDINGS for that track).
 *
 * Policy:
 *  - File tools (Read/Write/Edit/NotebookEdit/Glob/Grep): target path must resolve
 *    under the project root or the system temp dir. Symlinks are resolved via the
 *    deepest existing ancestor (same trick as fs-sandbox.ts) so a link can't escape.
 *  - Bash: the command STRING is scanned for home-directory references (~, $HOME,
 *    /Users/<name>/... or /home/<name>/...). Any home path outside the project root,
 *    temp dir, or the Vodou install root (needed for `vodou-core call` tool access)
 *    blocks the command. Non-home absolute paths (/usr, /opt, /etc...) pass — normal
 *    dev commands must keep working; the goal is "stop wandering through the user's
 *    personal files", not a syscall jail.
 *
 * Kill switch: VODOU_PROJECT_FS_JAIL=0 (checked by llm.ts before wiring the hook,
 * and honored here as a second layer for already-spawned sessions).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function realOfDeepestExisting(p) {
  // realpath the deepest EXISTING ancestor so symlinked intermediates can't
  // smuggle a path outside the jail (mirror of fs-sandbox assertRealAncestorUnderRoot).
  let cur = p;
  let suffix = [];
  while (true) {
    try {
      const real = fs.realpathSync(cur);
      return suffix.length ? path.join(real, ...suffix) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p; // hit fs root without anything existing
      suffix.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

function isUnder(target, root) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function main() {
  if (process.env.VODOU_PROJECT_FS_JAIL === '0') return allow();
  const jailRaw = process.env.VODOU_PROJECT_JAIL_ROOT;
  if (!jailRaw) return allow();

  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return allow(); // unparseable hook payload — never wedge the session
  }

  const toolName = String(input.tool_name || '');
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : jailRaw;

  const jail = realOfDeepestExisting(path.resolve(jailRaw));
  const tmp = fs.realpathSync(os.tmpdir());
  const home = os.homedir();
  const allowedRoots = [jail, tmp, '/tmp', '/private/tmp'];

  const deny = (target) => {
    process.stderr.write(
      `Blocked by Vodou project isolation: "${target}" is outside this project's folder (${jailRaw}). ` +
      `This conversation is scoped to the project. Work within the project folder, ` +
      `or ask the user to add the file to the project / switch to the Default workspace for machine-wide access.`,
    );
    process.exit(2);
  };

  const checkPath = (raw) => {
    if (typeof raw !== 'string' || !raw.length) return;
    let expanded = raw;
    if (expanded === '~' || expanded.startsWith('~/')) expanded = path.join(home, expanded.slice(1));
    const resolved = realOfDeepestExisting(path.resolve(cwd, expanded));
    if (!allowedRoots.some((r) => isUnder(resolved, r))) deny(raw);
  };

  const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']);
  if (FILE_TOOLS.has(toolName)) {
    checkPath(toolInput.file_path);
    checkPath(toolInput.notebook_path);
    checkPath(toolInput.path);
    // A Glob PATTERN that is itself absolute (or ~-rooted) escapes via `path`-less calls.
    const pat = toolInput.pattern;
    if (toolName === 'Glob' && typeof pat === 'string' && (pat.startsWith('/') || pat.startsWith('~'))) {
      // Strip glob magic so realpath sees a plain prefix ("/Users/x/**" -> "/Users/x").
      checkPath(pat.split(/[*?[{]/)[0] || pat);
    }
    return allow();
  }

  if (toolName === 'Bash') {
    const cmd = String(toolInput.command || '');
    // Home-path candidates: ~ | $HOME | the literal home dir. Quotes/word chars kept simple —
    // this is a wandering-guard heuristic, not an escape-proof parser.
    const candidates = [];
    const homeEsc = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:~(?=/|\\s|$|["'])|\\$HOME|\\$\\{HOME\\}|${homeEsc})(/[^\\s"'\`;|&)<>]*)?`, 'g');
    let m;
    while ((m = re.exec(cmd)) !== null) {
      candidates.push(path.join(home, m[1] || ''));
    }
    // The install root is allowed from Bash so `<install>/vodou-core call ...` (MCP tool
    // access, skills, AGENT_ACTIONS) keeps working from project conversations.
    const installRoot = process.env.VODOU_INSTALL_ROOT ? realOfDeepestExisting(path.resolve(process.env.VODOU_INSTALL_ROOT)) : null;
    for (const cand of candidates) {
      const resolved = realOfDeepestExisting(cand);
      const ok = allowedRoots.some((r) => isUnder(resolved, r)) || (installRoot && isUnder(resolved, installRoot));
      if (!ok) deny(cand);
    }
    return allow();
  }

  return allow();
}

function allow() {
  process.exit(0);
}

main();
