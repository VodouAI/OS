/**
 * The plan offer on a TEXT surface — a channel has no button.
 *
 * Live, Telegram, 2026-08-26: the plan arrived; `cpu` and `mem` had both
 * resolved to `Vodou-channels·channel_status` (the recipe author was handed
 * the ~700-char <untrusted_channel_message channel="telegram"> envelope, and
 * "channel" out-ranked "cpu" in the catalog); and no run ever started, because
 * nothing on a channel could start one. Same shape as the panel before
 * [Run it]: built, unreachable.
 */
import { describe, it, expect } from 'vitest';
import { isRunReply, rememberOfferedRecipe, takeOfferedRecipe } from '../graph-offer.js';

describe('a plan offered on a text surface can be run from it', () => {
  it('recognises the replies a person would actually type', () => {
    for (const r of ['run', 'Run', 'run it', 'run it.', 'go', 'yes, run it', '  RUN IT!  ']) {
      expect(isRunReply(r), `"${r}" should start the plan`).toBe(true);
    }
  });

  it('does not fire on sentences that merely contain the word', () => {
    for (const r of ['run the numbers again', 'how do I run this', 'go to slack', 'run every morning', '']) {
      expect(isRunReply(r), `"${r}" is a sentence, not a reply`).toBe(false);
    }
  });

  it('remembers the last offered recipe per conversation and hands it over exactly once', () => {
    rememberOfferedRecipe('conv-a', 'together:\n  a: s.t\n');
    rememberOfferedRecipe('conv-b', 'together:\n  b: s.u\n');
    expect(takeOfferedRecipe('conv-a')).toBe('together:\n  a: s.t\n');
    expect(takeOfferedRecipe('conv-a'), 'a second "run" must not re-run a consumed offer').toBeNull();
    expect(takeOfferedRecipe('conv-b')).toBe('together:\n  b: s.u\n');
    expect(takeOfferedRecipe('never-offered')).toBeNull();
  });

  it('a newer offer replaces an older one', () => {
    rememberOfferedRecipe('conv-c', 'old');
    rememberOfferedRecipe('conv-c', 'new');
    expect(takeOfferedRecipe('conv-c')).toBe('new');
  });
});
