/**
 * PLAN-GRAPH-SKILLS P1 — ask the model for a RECIPE, not for JSON.
 *
 * `_gateway::create_skill` has asked the LLM to hand-write an
 * `<!-- AGENT_ACTIONS: {...} -->` block since 2026-03-22. That is a lot to ask:
 * the model has to emit valid nested JSON, correct step shapes and matching
 * option labels, all first try. When it gets it wrong you get a broken skill —
 * and, worse, when it gets it *structurally* right you can still get a fan with
 * no join, a join that omits a branch, or an unguarded `slack_post_message`,
 * because none of those are JSON errors.
 *
 * Asking for four lines of plain words instead moves every one of those from
 * "hope the model got it right" to "impossible by construction": the compiler
 * emits the join, counts every branch, and the plan card gates side effects.
 *
 * JSON has not gone anywhere. The recipe is SOURCE; `actions.json` is what the
 * engines run, exactly as before. This changes who writes the JSON, not whether
 * there is any.
 *
 * ## Why the retry is worth its cost
 *
 * The compiler's errors were written to name the fix —
 * `` `x` reads `{ghost}`, which no earlier step produces — check the name ``.
 * Handing that straight back to the model is a far better repair prompt than
 * anything this file could compose, so one retry carries the exact compiler
 * text. Two would be diminishing; a model that cannot fix a named error on the
 * second look is not going to on the third, and the caller has a working
 * fallback.
 */
import { compileRecipe } from './executor.js';
/** The format description handed to the model. Kept in one place so the prompt
 *  and the compiler cannot drift apart in what they claim the syntax is. */
export const RECIPE_SYNTAX = `A recipe has up to three blocks:

together <label>:
  <name>: <server>.<tool> {"arg":"value"}
then:
  need: 2 of 3
  <name>: <server>.<tool> {"arg":"value"}
  <name>: a sentence describing what to write from {name1, name2}
ask me:
  - a yes/no question

RULES:
- \`together:\` holds steps that DO NOT need each other's results. They run at once.
- \`then:\` holds steps that DO read earlier results. Reference them as {name}.
- Arguments must be literal JSON on the same line. Free-text arguments are rejected.
- \`need: N of M\` means the workflow continues if at least N of the M branches succeed. Omit it to require all.
- \`ask me:\` questions become approval stops. Add one before anything that sends, posts or deletes.
- Names are short, lowercase, no spaces.
- Do NOT write JSON, AGENT_ACTIONS, or markdown fences. Only the blocks above.`;
function buildPrompt(input) {
    const tools = input.toolCatalog?.length
        ? `\nTOOLS AVAILABLE (use these exact names):\n${input.toolCatalog.map((t) => `- ${t}`).join('\n')}`
        : input.requiredTools && input.requiredTools !== 'none'
            ? `\nSERVERS AVAILABLE: ${input.requiredTools}`
            : '';
    return `Write a Vodou RECIPE for this skill.

NAME: ${input.name}
WHAT IT SHOULD DO: ${input.description}
${tools}

${RECIPE_SYNTAX}

EXAMPLE — a morning briefing from three independent sources:

together sources:
  calendar: google-calendar.list-events {"calendarId":"primary"}
  mail: gmail.messages_list {"labelIds":["UNREAD"],"maxResults":15}
  slack: slack.slack_search_messages {"query":"mentions:me","count":10}
then:
  need: 2 of 3
  briefing: write one short briefing from {calendar, mail, slack}
ask me:
  - post it to #daily?

Think about which steps genuinely need each other's output. Steps that do not
belong under \`together:\`. Output ONLY the recipe.`;
}
/** Models wrap things in fences and preamble no matter what the prompt says. */
export function extractRecipe(raw) {
    let text = (raw || '').trim();
    const fence = text.match(/```(?:ya?ml|recipe|text)?\s*\n([\s\S]*?)```/);
    if (fence)
        text = fence[1];
    const lines = text.split('\n');
    // Drop any preamble before the first block header.
    const start = lines.findIndex((l) => /^(together|then|check|ask me)\b.*:\s*$/.test(l.trim()));
    if (start > 0)
        lines.splice(0, start);
    return lines.join('\n').trim() + '\n';
}
/**
 * Ask the model for a recipe and compile it. Returns null when the model cannot
 * produce something that compiles even once repaired — the caller then falls
 * back to the pre-existing JSON path rather than shipping a broken skill.
 */
export async function authorRecipe(input, llm) {
    const first = extractRecipe(await llm(buildPrompt(input)));
    if (!first.trim()) {
        console.error('[SkillRecipe] model returned nothing usable');
        return null;
    }
    try {
        const compiled = await compileRecipe(first);
        return { recipe: first, actions: compiled.actions, notes: compiled.notes, repaired: false };
    }
    catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        console.error(`[SkillRecipe] first attempt did not compile: ${why}`);
        // Hand back the compiler's exact words — they name the fix.
        const repairPrompt = `This recipe does not compile.

RECIPE:
${first}

COMPILER ERROR:
${why}

${RECIPE_SYNTAX}

Fix exactly that error and output ONLY the corrected recipe.`;
        try {
            const second = extractRecipe(await llm(repairPrompt));
            if (!second.trim())
                return null;
            const compiled = await compileRecipe(second);
            console.error('[SkillRecipe] repaired on the second attempt');
            return { recipe: second, actions: compiled.actions, notes: compiled.notes, repaired: true };
        }
        catch (err2) {
            const why2 = err2 instanceof Error ? err2.message : String(err2);
            console.error(`[SkillRecipe] repair also failed (${why2}); caller should fall back`);
            return null;
        }
    }
}
/**
 * The recipe block as it is stored in SKILL.md — the canonical source, with
 * `actions.json` as the generated artifact beside it. Same split PLAN-SKILLS-V2
 * already made for inline AGENT_ACTIONS, one layer up.
 */
export function recipeBlock(recipe) {
    return `<!-- GRAPH\n${recipe.trimEnd()}\n-->`;
}
/** Read a recipe back out of a SKILL.md, if it has one. */
export function extractRecipeBlock(md) {
    const m = md.match(/<!--\s*GRAPH\s*\n([\s\S]*?)\n\s*-->/);
    return m ? m[1].trim() + '\n' : null;
}
