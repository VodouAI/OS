/**
 * `graph-offer` — turn "every morning, brief me" into a plan card.
 *
 * PLAN-GRAPH-SKILLS **D1**, gateway half. The router now HOLDS a keyword
 * auto-route when a sentence describes multi-step or scheduled work, and says so
 * in the daemon's context block (`### Vodou Workflow Offer`). Holding alone only
 * removes the wrong answer; this is what puts the right one in its place.
 *
 * Before this, a plan card could only appear inside `create-a-skill`, and only
 * when `required_tools != 'none'` — so the feature existed and was unreachable
 * unless you already knew to start a skill-creation wizard.
 *
 * Nothing here executes a step. `buildPlan` compiles and describes; the card's
 * buttons are what run anything. That is what makes it safe to offer on a guess:
 * the worst case is a card the user ignores.
 */
import { authorRecipe } from './skill-recipe-author.js';
import { getDb } from './db.js';
import { buildPlan, renderPlanText } from './graph-plan.js';
import type { StreamEvent } from './llm.js';

/** The marker the daemon renders. One string, matched in one place. */
export const OFFER_MARKER = '### Vodou Workflow Offer';

/**
 * The tools this sentence might plausibly need, as `server.tool — description`.
 *
 * Without this the author was told `SERVERS AVAILABLE: any`, which tells a model
 * nothing — so it invented `bash.run` for "check my cpu and memory" while
 * `mcp-monitor.get_cpu_info` sat in the catalog. A plan built from invented tool
 * names compiles (the compiler validates SHAPE, and `bash.run` is a real tool)
 * and does the wrong thing.
 *
 * 893 active tools is far too many for a prompt, so they are RANKED against the
 * user's own words and capped. Only active servers: offering a tool from a
 * disconnected server produces a plan that cannot run.
 */
export function toolCatalogFor(sentence: string, limit = 40): string[] {
  try {
    const rows = getDb()
      .prepare(
        `SELECT s.name AS server, t.name AS tool, COALESCE(t.description,'') AS description
           FROM tools t JOIN mcp_servers s ON s.id = t.server_id
          WHERE s.active = 1 AND t.enabled = 1`,
      )
      .all() as Array<{ server: string; tool: string; description: string }>;

    // Words worth matching on. The short ones are stripped because "my" and
    // "and" match everything and would rank the catalog by noise.
    const words = sentence
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w));
    if (!words.length) return [];

    const scored = rows.map((r) => {
      // Matched on TOKENS, never substrings. "check my cpu and memory and write
      // me a one line health note" ranked `ms365.create-onenote-page` top,
      // because "one" and "note" both appear INSIDE "onenote" — two spurious
      // name hits, beating `mcp-monitor.get_cpu_info`'s one real one. The model
      // then wrote a plan out of OneNote tools and said so.
      const nameTokens = tokens(`${r.server} ${r.tool}`);
      const descTokens = tokens(r.description);
      let score = 0;
      for (const w of words) {
        // A hit in the NAME is worth more than one in prose: a tool called
        // `get_cpu_info` is about cpu, a tool that merely mentions it may not be.
        if (nameTokens.has(w)) score += 3;
        else if (descTokens.has(w)) score += 1;
      }
      return { r, score };
    });

    return scored
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.r.tool.localeCompare(b.r.tool))
      .slice(0, limit)
      .map((x) => `${x.r.server}.${x.r.tool} — ${x.r.description.replace(/\s+/g, ' ').slice(0, 90)}`);
  } catch (err) {
    // No catalog is the old behaviour, not a broken turn.
    console.error('[GraphOffer] tool catalog unavailable:', err);
    return [];
  }
}

/** `get_cpu_info` / `create-onenote-page` → the words a person would say. */
function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

/** Active server names, for when no tool ranks against the sentence. */
function serverNames(): string {
  try {
    const rows = getDb()
      .prepare(`SELECT name FROM mcp_servers WHERE active = 1 ORDER BY name`)
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name).join(', ') || 'none';
  } catch {
    return 'none';
  }
}

/** Words that match everything and would rank the catalog by noise. */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'out', 'get',
  'give', 'show', 'tell', 'make', 'write', 'every', 'each', 'then', 'when',
  'whenever', 'morning', 'day', 'week', 'workflow', 'automation', 'about',
]);

export function messageCarriesWorkflowOffer(memoryContext: string | null | undefined): boolean {
  return !!memoryContext && memoryContext.includes(OFFER_MARKER);
}

/**
 * Author a recipe from the user's own sentence and show what it would do.
 *
 * Returns the plan's text form on success, or null if nothing usable came back —
 * in which case the caller carries on as if this had never run. A failed offer
 * must never cost the user their answer; that is the D2 lesson, where an empty
 * model response was read as "nothing to say" and the whole recipe path
 * disappeared without a trace.
 */
/**
 * The recipe last OFFERED per conversation, so a text surface can say "run"
 * and have it mean the plan it was just shown. Cleared when it is run or when
 * another plan replaces it. Never persisted: a restart forgets an offer, which
 * is correct — an offer nobody has acted on for that long is stale.
 */
const _offeredRecipe = new Map<string, string>();
export function rememberOfferedRecipe(conversationId: string, recipe: string): void { _offeredRecipe.set(conversationId, recipe); }
export function takeOfferedRecipe(conversationId: string): string | null {
  const r = _offeredRecipe.get(conversationId) ?? null;
  _offeredRecipe.delete(conversationId);
  return r;
}
/** A bare "run" / "run it" / "go" — the text-surface equivalent of the [Run it] button. */
export function isRunReply(message: string): boolean {
  return /^\s*(run(?:\s+it)?|go|yes,?\s+run\s+it)\s*[.!]?\s*$/i.test(message);
}

export async function offerPlan(
  conversationId: string,
  message: string,
  onEvent: (e: StreamEvent) => void,
  llm: (prompt: string) => Promise<string>,
  toolCatalog?: string[],
): Promise<string | null> {
  try {
    const catalog = toolCatalog?.length ? toolCatalog : toolCatalogFor(message);
    const authored = await authorRecipe(
      {
        // The user's sentence IS the description. Naming it here rather than
        // asking them for a skill name first is the entire point: the front door
        // is "say it", not "fill in a form".
        name: 'proposed-workflow',
        description: message.trim(),
        // The catalog is what stops the model inventing tool names. When nothing
        // ranks, fall back to naming the SERVERS rather than the useless "any".
        requiredTools: catalog.length ? 'see the tool list' : serverNames(),
        toolCatalog: catalog,
      },
      llm,
    );
    if (!authored) {
      console.error('[GraphOffer] no compilable recipe from the sentence — staying quiet');
      return null;
    }
    const plan = await buildPlan(authored.recipe);

    // A plan with no TOOL row is not a workflow, it is the question rephrased.
    // Free prose compiles legitimately — into a `prompt` step — so "do the thing"
    // produces a valid one-node graph, and offering a card for it would fire this
    // front door at every sentence containing the word "workflow". The offer is
    // only worth making when there is something to run.
    const toolRows = plan.rows.filter((r) => r.server && r.tool);
    if (toolRows.length === 0) {
      console.error('[GraphOffer] the sentence compiles to prose only, no tools — staying quiet');
      return null;
    }

    // The card and the text are the SAME plan rendered twice, and both must be
    // sent: the text event is the only thing `assistantFullText` accumulates, so
    // dropping it would erase the plan from the transcript and from memory
    // extraction.
    //
    // The text also rides INSIDE the card. Suppression no longer needs it — the
    // server marks its own echoes with `echoOf` — but a surface holding only the
    // structured event can still render the canonical words from it without
    // reimplementing the layout.
    // Text surfaces have no button. The plan text carries its own instruction
    // — a channel or CLI reader otherwise sees a plan and has no way to start
    // it, which is exactly how the panel shipped (built, unreachable). This is
    // an `echoOf: 'graph'` chunk, so a card surface skips it and its buttons
    // stand in.
    const text = renderPlanText(plan) + '\n\nReply **run** to run it, or just keep chatting.';
    onEvent({
      type: 'graph_plan',
      graph: {
        plan: {
          // The sentence this plan was guessed from, so a surface can offer
          // "Just answer it" — re-sending exactly what the user typed with the
          // offer suppressed. Without it the button has nothing to re-send.
          sentence: message.trim(),
          recipe: plan.recipe,
          rows: plan.rows,
          needed: plan.needed,
          notes: plan.notes,
          guard: plan.guard,
          text,
        },
      },
    });
    // The text form goes back to the caller so surfaces with no card renderer
    // (panel, channels, CLI) get the same content. §5.8: the text is canonical
    // and the DOM card is the progressive enhancement.
    rememberOfferedRecipe(conversationId, plan.recipe);
    return text;
  } catch (err) {
    console.error('[GraphOffer] offer failed, continuing without it:', err);
    return null;
  }
}
