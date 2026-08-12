/**
 * `@doc:` attach tokens — PLAN-DOCUMENT-LIBRARY §3.4.2.
 *
 * The slug function is tested directly because it exists in TWO places that must
 * agree: here, and `slugOf()` in public/library/index.html (the drag payload).
 * If they drift, dragging a row produces a token the server cannot resolve — and
 * the failure looks like "the document wasn't attached", not like a bug.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const runCore = vi.fn();
vi.mock('../api/memory-capture.js', () => ({ runCore: (...a: unknown[]) => runCore(...a) }));

const { slugOf, resolveDocTokens } = await import('../doc-attach.js');

const SOURCES = [
  { id: 6, kind: 'md', name: '01-MASTER-AGREEMENT.md', chunks: 126, card_state: 'carded', broken_reason: null },
  { id: 7, kind: 'pdf', name: 'Investor Deck v5.pdf', chunks: 34, card_state: 'carded', broken_reason: null },
  { id: 8, kind: 'pdf', name: 'scanned.pdf', chunks: 0, card_state: null, broken_reason: 'no extractable text' },
];

function coreReturns(list = SOURCES, show: Record<string, unknown> = { card: 'CARD', body: 'BODY' }) {
  runCore.mockImplementation((args: string[]) => {
    if (args.includes('list')) return Promise.resolve({ status: 0, stdout: JSON.stringify(list), stderr: '' });
    if (args.includes('show')) return Promise.resolve({ status: 0, stdout: JSON.stringify(show), stderr: '' });
    return Promise.resolve({ status: 1, stdout: '', stderr: 'unexpected' });
  });
}

beforeEach(() => { runCore.mockReset(); coreReturns(); });

describe('slugOf', () => {
  it('drops the extension and normalizes to a typeable token', () => {
    expect(slugOf('01-MASTER-AGREEMENT.md', 6)).toBe('01-master-agreement');
    expect(slugOf('Investor Deck v5.pdf', 7)).toBe('investor-deck-v5');
  });

  it('falls back to the id when a name has nothing sluggable', () => {
    expect(slugOf('***.pdf', 9)).toBe('9');
    expect(slugOf('', 9)).toBe('9');
  });
});

describe('resolveDocTokens', () => {
  it('leaves a message with no token completely untouched', async () => {
    const r = await resolveDocTokens('what are our termination rights?');
    expect(r.sawToken).toBe(false);
    expect(r.text).toBe('what are our termination rights?');
    expect(r.context).toBe('');
    expect(runCore).not.toHaveBeenCalled();   // no token ⇒ no work at all
  });

  it('attaches the document and strips the token from the prompt', async () => {
    const r = await resolveDocTokens('summarize @doc:01-master-agreement for me');
    expect(r.sawToken).toBe(true);
    expect(r.text).toBe('summarize for me');
    expect(r.context).toContain('<document name="01-MASTER-AGREEMENT.md" id="6">');
    expect(r.context).toContain('CARD');
    expect(r.context).toContain('BODY');
    expect(r.notices).toHaveLength(0);
  });

  it('resolves by numeric id as well as slug', async () => {
    const r = await resolveDocTokens('@doc:7');
    expect(r.context).toContain('Investor Deck v5.pdf');
  });

  it('an unknown slug degrades to a visible notice, never a failed turn', async () => {
    // A silent drop is worse than useless: the user believes it was attached.
    const r = await resolveDocTokens('check @doc:01-master-agreemnt please');
    expect(r.context).toBe('');
    expect(r.notices[0]).toContain('no such document');
    expect(r.notices[0]).toContain('did you mean @doc:01-master-agreement');
    expect(r.text).toBe('check please');
  });

  it('refuses to attach a broken document, and says why', async () => {
    const r = await resolveDocTokens('@doc:scanned');
    expect(r.context).toBe('');
    expect(r.notices[0]).toContain('broken');
    expect(r.notices[0]).toContain('no extractable text');
  });

  it('deduplicates repeated tokens so one document is attached once', async () => {
    const r = await resolveDocTokens('@doc:7 versus @doc:7');
    expect(r.context.match(/<document /g) ?? []).toHaveLength(1);
  });

  it('attaches several distinct documents in one turn', async () => {
    const r = await resolveDocTokens('compare @doc:01-master-agreement with @doc:investor-deck-v5');
    expect(r.context.match(/<document /g) ?? []).toHaveLength(2);
  });

  it('announces truncation and points at the tier-2 tool', async () => {
    coreReturns(SOURCES, { card: 'CARD', body: 'head…\n\n[… truncated; call again with a narrower `section`]' });
    const r = await resolveDocTokens('@doc:01-master-agreement');
    expect(r.context).toContain('vc_doc_read');
    expect(r.notices[0]).toContain('attached partially');
  });

  it('survives a core failure without dropping the turn', async () => {
    runCore.mockResolvedValue({ status: 1, stdout: '', stderr: 'boom' });
    const r = await resolveDocTokens('@doc:anything');
    expect(r.notices[0]).toContain('no such document');
    expect(r.text).toBe('');
  });
});
