/**
 * item 12 — every surface must speak the whole graph vocabulary.
 *
 * The defect this pins is the one that has now happened twice: the web chat's
 * WS switch had no `default`, so every `graph_*` event was silently dropped and
 * the plan card could never draw where a person types. The side panel's switch
 * (`vbb/chat.ts`) had exactly the same hole, found 2026-08-26.
 *
 * A unit test cannot catch it — each surface's own tests pass, because the code
 * they test works. What fails is the ROUTING, so this compares the surfaces to
 * each other. When a new `graph_*` event is added, this fails until every
 * surface forwards it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const src = (p: string) => readFileSync(path.resolve(__dirname, '..', p), 'utf-8');
const repo = (p: string) => readFileSync(path.resolve(__dirname, '../../../..', p), 'utf-8');

/** The vocabulary the driver actually emits — the source of truth. */
function emittedByDriver(): string[] {
  const text = src('workflow-driver.ts');
  const found = new Set<string>();
  for (const m of text.matchAll(/type:\s*'(graph_[a-z_]+)'/g)) found.add(m[1]);
  return [...found].sort();
}

describe('graph event vocabulary', () => {
  const emitted = emittedByDriver();

  it('the driver emits a graph vocabulary at all (a parity test over nothing proves nothing)', () => {
    expect(emitted.length).toBeGreaterThanOrEqual(5);
    expect(emitted).toContain('graph_plan');
    expect(emitted).toContain('graph_ask');
  });

  it('the side panel lane forwards every event the driver emits', () => {
    const panel = src('vbb/chat.ts');
    const missing = emitted.filter((e) => !panel.includes(`case '${e}'`));
    expect(missing, `vbb/chat.ts drops: ${missing.join(', ')}`).toEqual([]);
  });

  it('the web chat forwards every event the driver emits', () => {
    const web = src('index.ts');
    const missing = emitted.filter((e) => !web.includes(`case '${e}'`));
    expect(missing, `index.ts drops: ${missing.join(', ')}`).toEqual([]);
  });

  it('the panel wire type names every event, so a new one cannot compile silently', () => {
    const panel = src('vbb/chat.ts');
    const iface = panel.slice(panel.indexOf('export interface ChatWireEvent'), panel.indexOf('export interface ChatDeps'));
    const missing = emitted.filter((e) => !iface.includes(`'${e}'`));
    expect(missing, `ChatWireEvent omits: ${missing.join(', ')}`).toEqual([]);
  });

  it('the side panel RENDERS every event it is sent — forwarding without drawing is the same bug', () => {
    const ui = repo('extension/Store-vodou-bridge/sidepanel.js');
    const missing = emitted.filter((e) => !ui.includes(`case '${e}'`));
    expect(missing, `sidepanel.js has no renderer for: ${missing.join(', ')}`).toEqual([]);
  });

  /**
   * §4b: the echo flag rides alongside the text and a surface that drew the
   * structure skips it. The panel forwarded neither and so drew every plan
   * TWICE — once as the card, once as prose. Both halves are asserted, because
   * either one alone silently restores the double render.
   */
  it('the panel lane forwards echoOf, and the panel honours it', () => {
    expect(src('vbb/chat.ts'), 'vbb/chat.ts drops echoOf, so the panel cannot know').toContain('echoOf');
    expect(repo('extension/Store-vodou-bridge/sidepanel.js'), 'sidepanel.js ignores echoOf').toContain("echoOf === 'graph'");
  });

  it('a plan the panel renders can be RUN from the panel', () => {
    // Rendering without an affordance is a dead end: no run, so no `graph_ask`,
    // so the ask renderer is unreachable from this surface. That is how it
    // shipped, and every other test here still passed.
    expect(repo('extension/Store-vodou-bridge/sidepanel.js')).toContain('/api/graph/run');
  });

  /**
   * The offer fires on a GUESS and then returns, so a wrong guess costs the user
   * their answer. Every surface that draws the card must offer the way out, and
   * the server must carry the sentence the button re-sends — either half missing
   * leaves a card with nothing underneath it.
   */
  it('every card surface offers "Just answer it", and the server carries the sentence', () => {
    expect(src('graph-offer.ts'), 'graph_plan does not carry the sentence to re-send').toContain('sentence: message.trim()');
    expect(src('llm.ts'), 'the heuristic offer ignores skipGraphOffer').toContain('!options?.skipGraphOffer');
    expect(src('index.ts'), 'REST /chat drops skipGraphOffer').toContain('req.body?.skipGraphOffer');
    expect(src('index.ts'), 'the WS message frame drops skipGraphOffer').toContain('parsed?.skipGraphOffer');
    expect(src('vbb/chat.ts'), 'the panel lane drops skipGraphOffer').toContain('msg?.skipGraphOffer');
    expect(repo('MCP-servers/Vodou-Console/public/js/views/chat.js')).toContain('Just answer it');
    expect(repo('extension/Store-vodou-bridge/sidepanel.js')).toContain('Just answer it');
  });

  it('the panel can SAVE a plan, and posts to the same endpoint the web form does', () => {
    const panel = repo('extension/Store-vodou-bridge/sidepanel.js');
    expect(panel).toContain('/api/graph/save');
    // The partial-success line. A schedule that fails while the skill saves
    // must be said, or a half-save reads as a full one.
    expect(panel).toContain('scheduleError');
  });

  /**
   * A run started FROM the panel streams through `streamToConversation`, which
   * knows only web WS clients. Without the panel fallback the ask it parks on
   * is announced to nobody — the exact failure seen live on 2026-08-26.
   */
  it('a run started from the panel can reach the panel', () => {
    expect(src('index.ts'), 'streamToConversation never tries the panel lane').toContain('vbbEmitToPanel(convId, stamped)');
    expect(src('vbb/bridge.ts'), 'the bridge never registers a panel emitter').toContain('registerPanelEmitter(this.chatDeps())');
    expect(src('vbb/chat.ts')).toContain("convId.startsWith('panel:')");
  });

  it('the panel answers an ask through the run endpoint, not by chatting a number', () => {
    // Sending "1" as a chat message reaches chat() as a fresh turn; the panel
    // lane has no ask-answer path, and a model improvised a reply. Seen live.
    expect(repo('extension/Store-vodou-bridge/sidepanel.js')).toContain("/api/graph/runs/' + encodeURIComponent(g.runId) + '/answer");
  });

  /**
   * The stopping-point MENU is the text echo of `graph_ask`, the way the plan
   * text is the echo of `graph_plan`. Every emitter of it must carry `echoOf`,
   * or a surface that drew the buttons prints the question a second time —
   * which is what the user saw. All three sites are asserted: one unflagged
   * emitter silently brings the duplicate back on whichever path hits it.
   */
  it('every stopping-point menu emit is flagged as an echo of the ask', () => {
    const idx = src('index.ts');
    // These match substrings with no escape sequences on purpose: the source
    // spells newlines as the two characters `\` `n`, and an assertion that
    // tried to spell them too was unescaped one layer too many and failed
    // against a correct fix. This got pushed red once (a27a9079).
    expect(idx).toContain("${menu}");
    expect(idx).toContain("`, echoOf: 'graph' });");
    const l = src('llm.ts');
    expect(l).toContain("content: intro + menuContent, echoOf: 'graph'");
    expect(l).toContain("+ menuPart, echoOf: 'graph'");
  });

  it('the recipe author is handed the human words, never the channel envelope', () => {
    // "channel" in the wrapper out-ranked "cpu" in the tool catalog; both
    // cpu and mem resolved to Vodou-channels·channel_status on Telegram.
    expect(src('llm.ts')).toContain('offerPlan(conversationId, channelQueryText(message)');
  });

  it('a text surface is told how to run the plan, and "run" starts it', () => {
    expect(src('graph-offer.ts')).toContain('Reply **run** to run it');
    expect(src('llm.ts')).toContain('isRunReply(channelQueryText(message))');
  });

  /**
   * On a channel the plan arrives ONCE, as the offer's `echoOf` text chunk. The
   * graph-event text renderer exists for events with no text of their own;
   * feeding `graph_plan` through it as well doubled every plan on Telegram —
   * with the second copy rendered from stale rows, so it also read wrong.
   */
  it('the channel lane does not render graph_plan or graph_ask as text — both already ARE text', () => {
    // The plan arrives as the offer's echoOf chunk; the ask arrives as the
    // driver's menu chunk. Rendering either structured event as well doubled
    // it on Telegram, live, twice in one evening.
    const idx = src('index.ts');
    expect(idx).toContain("event.type !== 'graph_plan'");
    expect(idx).toContain("event.type !== 'graph_ask'");
  });

  /**
   * A channel reply to a parked gate arrives wrapped in the channel envelope.
   * Handed raw to the matcher, "2" is ~680 chars that match nothing — and for
   * an ad-hoc graph that meant null → model. Telegram, live: the model then
   * narrated "Not posted — held it there" and invented a daily job. B16's
   * guards never saw a "2". The matcher must get the human's words.
   */
  it('a channel reply to a gate is unwrapped before it reaches the matcher', () => {
    expect(src('llm.ts')).toContain('handleWorkflowChoice(conversationId, channelQueryText(message), onEvent)');
  });

  it('a plan reaches DOM-less surfaces as canonical text, not as rows to re-render', () => {
    // §5.8: text is canonical. If the driver stops sending it, the panel draws
    // nothing rather than inventing a second renderer — so this must hold.
    expect(src('workflow-driver.ts')).toContain('text: renderPlanText(plan)');
    expect(repo('extension/Store-vodou-bridge/sidepanel.js')).toContain('g.plan && g.plan.text');
  });
});
