/**
 * item 12 — what a DOM-less surface actually reads.
 *
 * A channel gets text and nothing else. If `graph_ask` renders badly there, the
 * approval gate silently stops working for every phone in the product: the run
 * parks, and the only person who can release it never sees the question.
 */
import { describe, it, expect } from 'vitest';
import { renderGraphEventText } from '../graph-plan.js';

describe('renderGraphEventText', () => {
  it('shows the ask, its numbered options, and how to answer', () => {
    const out = renderGraphEventText('graph_ask', {
      ask: { askId: 'a1', title: 'Send the summary to #general?', type: 'menu',
             options: [{ n: '1', label: 'Yes, send it' }, { n: '2', label: 'Cancel' }] },
    })!;
    expect(out).toContain('Send the summary to #general?');
    expect(out).toContain('1. Yes, send it');
    expect(out).toContain('2. Cancel');
    expect(out).toContain('reply with the number');
  });

  it('every option number shown is one a person can actually type back', () => {
    const options = [{ n: '2', label: 'B' }, { n: '3', label: 'C' }]; // not 1-based
    const out = renderGraphEventText('graph_ask', { ask: { title: 'Pick', type: 'menu', options } })!;
    for (const o of options) expect(out).toContain(`${o.n}. ${o.label}`);
    expect(out).not.toContain('1.');
  });

  it('a free-text ask asks for an answer, not a number', () => {
    const out = renderGraphEventText('graph_ask', { ask: { title: 'Which repo?', type: 'text_input', options: [] } })!;
    expect(out).toContain('reply with your answer');
    expect(out).not.toContain('reply with the number');
  });

  it('an ask with no options never tells someone to reply with a number that does not exist', () => {
    const out = renderGraphEventText('graph_ask', { ask: { title: 'Proceed?', type: 'menu', options: [] } })!;
    expect(out).not.toContain('reply with the number');
  });

  it('renders a plan as the canonical text, never re-derived from rows', () => {
    const out = renderGraphEventText('graph_plan', { skill: 'brief', plan: { text: 'together — …\n  • a  s·t' } })!;
    expect(out).toContain('plan for brief');
    expect(out).toContain('together —');
  });

  it('returns null when there is nothing honest to say, so no blank lines are sent', () => {
    expect(renderGraphEventText('graph_plan', { skill: 'x', plan: {} })).toBeNull();
    expect(renderGraphEventText('graph_join', {})).toBeNull();
    expect(renderGraphEventText('graph_check', {})).toBeNull();
    expect(renderGraphEventText('graph_branch', { width: 0 })).toBeNull();
    expect(renderGraphEventText('graph_done', {})).toBeNull();
    expect(renderGraphEventText('something_else', { a: 1 })).toBeNull();
  });

  it('marks a refused check — a silent rejection reads as success', () => {
    const out = renderGraphEventText('graph_check', { line: 'cites a source', met: false })!;
    expect(out).toContain('REFUSED');
  });

  it('reports a fan before and after it runs', () => {
    expect(renderGraphEventText('graph_branch', { group: 'g', width: 3 })).toContain('running 3 at once');
    expect(renderGraphEventText('graph_branch', { group: 'g', branches: [1, 2, 3], elapsedMs: 2500 })).toContain('3 finished in 2.5s');
  });

  it('never throws on a missing or malformed payload', () => {
    for (const t of ['graph_plan', 'graph_ask', 'graph_join', 'graph_check', 'graph_branch', 'graph_done']) {
      expect(() => renderGraphEventText(t, undefined)).not.toThrow();
      expect(() => renderGraphEventText(t, { ask: null, plan: null } as never)).not.toThrow();
    }
  });
});
