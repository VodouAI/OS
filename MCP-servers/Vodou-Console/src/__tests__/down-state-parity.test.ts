/**
 * COHERENCE F18 + F19 — "One command says it's fine, the next says it's down."
 *
 * One condition — the local Vodou app is not running — was answered three
 * different ways by the three surfaces a person might be standing in front of:
 *
 *   CLI          "is the daemon running? try ./start-vodou-services.sh"
 *   Console Two  "Start it from the menu bar."   ← a surface that has never existed
 *   panel        "Vodou isn't running"            ← no next step at all
 *
 * F18 fixed Console Two; F19 fixed the panel. What this file guards is that
 * they do not drift apart again, because nothing else can: the three live in
 * three codebases (Rust, the console's browser bundle, the extension), none of
 * which can import from the others, so the only thing holding them together is
 * an assertion that reads all three.
 *
 * A source test on purpose. The failure is a WORD, and no behavioural test has
 * ever failed because a sentence sent someone to a menu bar that isn't there.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../../..');

/**
 * What the product SAYS — the string literals, with comments skipped.
 *
 * Two drafts of this got it wrong in opposite directions, which is worth
 * recording because both mistakes are the finding's own shape. Grepping whole
 * files went red on the comment in `chat.js` explaining the F18 fix ("this used
 * to say 'Start it from the menu bar'"). Extracting quotes without skipping
 * comments went red on the same sentence for the same reason. And the reverse
 * is the dangerous one: a file passing "names the start command" on the
 * strength of a comment while the message a user reads says nothing of the kind.
 *
 * Language-aware because it has to read Rust as well as JavaScript: `'` opens a
 * string in JS and a LIFETIME in Rust (`&'static str`), so treating it as a
 * quote there swallows the rest of the line and can hide a real message.
 */
function stringsOf(file: string): string {
  const src = readFileSync(file, 'utf8');
  const quotes = file.endsWith('.rs') ? ['"'] : ["'", '"', '`'];
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (src[i] === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    const quote = src[i];
    if (quotes.includes(quote)) {
      let j = i + 1;
      let buf = '';
      while (j < src.length) {
        if (src[j] === '\\') { buf += src[j + 1] ?? ''; j += 2; continue; }
        if (src[j] === quote) break;
        // An unterminated single-line literal is not a literal; bail rather
        // than swallowing the file.
        if (quote !== '`' && src[j] === '\n') { buf = ''; break; }
        buf += src[j];
        j++;
      }
      if (buf) out.push(buf);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('\n');
}

/** Every surface that tells a person the app is not running. */
const SURFACES = [
  { name: 'CLI (mem search)', file: path.join(REPO, 'src/main.rs') },
  { name: 'Console Two', file: path.join(REPO, 'MCP-servers/Vodou-Console/public/two/chat.js') },
  { name: 'extension panel', file: path.join(REPO, 'extension/Store-vodou-bridge/gateway-errors.js') },
];

const present = SURFACES.filter((s) => existsSync(s.file));

describe('every surface answers "Vodou is not running" the same way', () => {
  it('names the one command that actually starts it', () => {
    for (const s of present) {
      const text = stringsOf(s.file);
      expect(
        text.includes('./start-vodou-services.sh'),
        `${s.name} tells a stuck user the app is down without naming the command that starts it`,
      ).toBe(true);
    }
  });

  it('never sends anyone to a menu bar', () => {
    // The literal F18 defect. There is no status-item app: every "menubar" in
    // the tree is the web console's own CSS shell variable.
    for (const s of present) {
      const text = stringsOf(s.file);
      expect(
        /from the menu ?bar/i.test(text),
        `${s.name} points at a menu bar Vodou has never had`,
      ).toBe(false);
    }
  });

  it('the two windowed surfaces promise the same self-recovery', () => {
    // Both reconnect without being asked, so both say so — and the claim has to
    // stay true in both places or one of them is lying to a waiting user.
    const two = stringsOf(path.join(REPO, 'MCP-servers/Vodou-Console/public/two/chat.js'));
    expect(two).toContain('reconnects on its own');

    const panelCopy = path.join(REPO, 'extension/Store-vodou-bridge/gateway-errors.js');
    if (existsSync(panelCopy)) {
      expect(stringsOf(panelCopy)).toContain('reconnects on its own');
    }
  });

  it('the panel reads its sentence from the shared copy, not from an inline string', () => {
    const panel = path.join(REPO, 'extension/Store-vodou-bridge/sidepanel.js');
    if (!existsSync(panel)) return;
    const text = readFileSync(panel, 'utf8');
    expect(
      text.includes("VodouGatewayError.notRunning('panel')"),
      'the panel status line must use the shared sentence — an inline copy is how the three surfaces drifted in the first place',
    ).toBe(true);
  });
});
