// COHERENCE F9 — "Is a 'briefing' a 'note'? Is a 'chat' a 'conversation'?
// Are 'docs' 'documents'?"
//
// Four objects, eight nouns. The harm is not inelegance: a reader who meets two
// words for one thing reasonably concludes there are two things, goes looking
// for the difference, and finds none. That is internal vocabulary escaping —
// the words the code uses leaking into the words the product speaks.
//
// The worst instance was one paragraph in the panel's settings that called the
// same object a CONVERSATION, a THREAD and a CHAT inside five sentences, under
// a heading that named it a fourth way. And a section header offering "Your
// docs about this" beside copy that says "document" everywhere else.
//
// The canon, one noun per object:
//
//   chat       the thing you had with an AI and Vodou saved
//   memory     anything Vodou knows, however it got there
//   document   a file in your Library
//   briefing   what a scheduled skill produced
//
// DELIBERATE EXCEPTION — "notes and memories".
//
// That pair phrase survives in the page-memory consent copy, and it is not an
// oversight. A note and a memory ARE the same object (a typed note is stored as
// a memory chunk), so by the rule above the phrase should collapse to
// "memories". But this is PERMISSION copy: it tells someone what Vodou will
// read before they grant it. Narrowing the words there narrows the apparent
// scope of the disclosure, and a privacy ask should err toward describing more
// than it does, not less — the principle F31 settled when it widened the same
// card rather than softening it. Consistency loses to disclosure here, on
// purpose, and this comment is the record of that trade.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What a person reads in the panel: no comments, no script, no style, no tags. */
function visibleHtml(file) {
  let h = fs.readFileSync(path.join(ROOT, file), 'utf8');
  h = h.replace(/<!--[\s\S]*?-->/g, ' ');
  h = h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ');
  return h.replace(/<[^>]+>/g, ' ');
}

/**
 * Prose written by the scripts. Class names, selectors and style fragments are
 * not copy, and counting them is how a first pass at this concluded the panel
 * said "doc" 22 times when a reader sees it once.
 */
function visibleJs(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const out = [];
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (src.startsWith('/*', i)) { i += 2; while (i < src.length && !src.startsWith('*/', i)) i++; i += 2; continue; }
    const q = src[i];
    if (q === "'" || q === '"' || q === '`') {
      let j = i + 1, buf = '';
      while (j < src.length) {
        if (src[j] === '\\') { buf += src[j + 1] ?? ''; j += 2; continue; }
        if (src[j] === q) break;
        if (q !== '`' && src[j] === '\n') { buf = ''; break; }
        buf += src[j]; j++;
      }
      // Prose = at least three words, and nothing that smells like CSS or a route.
      if (buf.split(/\s+/).length >= 3 && !/[{};]|px\b|flex|margin|padding|font-size|border|^\.|^#|\/api\//.test(buf)) {
        out.push(buf);
      }
      i = j + 1; continue;
    }
    i++;
  }
  return out.join('\n');
}

const COPY = [
  visibleHtml('sidepanel.html'),
  visibleJs('sidepanel.js'),
  visibleJs('controls.js'),
].join('\n');

// COHERENCE Phase 2 — the canon has a HOME now, so this test reads it from
// there rather than keeping a second copy. A rule enforced from a duplicate of
// itself is the drift it is meant to catch, one level up.
await import('../vocabulary.js');
const RETIRED = Object.entries(globalThis.VodouVocabulary.RETIRED)
  .map(([word, use]) => ({ word, use }));

test('one object, one noun — no retired synonym reaches the reader', () => {
  for (const { word, use } of RETIRED) {
    const hits = COPY.match(new RegExp(`\\b${word}\\b`, 'gi')) || [];
    assert.equal(
      hits.length, 0,
      `panel copy says "${word}" — the canon is "${use}". Two words for one object ` +
      'sends a reader looking for a difference that does not exist.',
    );
  }
});

test('the words the canon KEEPS are actually the ones in use', () => {
  // A guard that only bans is satisfied by saying nothing at all. The kept
  // words come from the module, so adding a noun to the canon automatically
  // requires the panel to actually say it.
  for (const noun of Object.keys(globalThis.VodouVocabulary.NOUNS)) {
    if (noun === 'briefing') continue; // produced by a scheduled skill; not panel chrome
    const rx = new RegExp(`\\b${noun}(s|ies)?\\b`, 'i');
    assert.ok(rx.test(COPY), `the panel no longer says "${noun}" — did the canon move?`);
  }
});

test('the disclosure exception is still deliberate, not forgotten', () => {
  // "notes and memories" stays in the permission copy on purpose (see the header
  // of this file). If it ever disappears, that should be a decision someone made
  // rather than a tidy-up, so the exception is asserted rather than assumed.
  assert.ok(
    /notes and memories/i.test(COPY),
    'the page-memory consent copy no longer says "notes and memories" — if that was ' +
    'deliberate, update this test and the note explaining why the phrase existed.',
  );
});
