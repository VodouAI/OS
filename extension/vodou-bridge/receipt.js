// What the turn actually used, in words — the ONE implementation.
//
// COHERENCE F8: "The panel and the chat tell me different things about what my
// turn used." F30 closed the loud half of that — the server had always emitted
// a complete `turn_receipt` frame and neither client consumed it — and pinned
// the panel and Console Two to the same wording with a parity test. What it
// left behind was this: `content.js` built the same phrase a third time, from
// its own copy of the counting and pluralisation rules.
//
// Byte-identical today, and that is precisely the problem. Three copies of one
// sentence pass every test ever written, right up until someone improves the
// wording in one place — and then the same turn describes itself two ways
// depending on whether you read the panel or the toast on the page, which is
// the finding, restated.
//
// The panel and the content script live in different worlds but the same
// bundle, so they can share this the way `sites.js` and `gateway-errors.js` are
// shared: `<script src>` from sidepanel.html, a manifest content_scripts entry
// for the page. Console Two cannot import it (different codebase entirely) and
// stays honest by the parity test instead.

globalThis.VodouReceipt = {
  /**
   * The pieces: `["4 memories", "2 tools", "1 skill"]`.
   *
   * EMPTY when the turn used nothing, and every caller depends on that. A
   * "0 memories" badge reads as a failure at exactly the moment the feature is
   * meant to prove competence, so the silent case is a rule, not an accident —
   * the caller keeps its own wording instead of announcing a zero.
   *
   * Counts only. The NAMED items belong to the panel, which has room for them;
   * the in-page toast sits on top of somebody else's website.
   */
  parts(r) {
    if (!r) return [];
    const mem = (r.memories && r.memories.used) || 0;
    const tools = (Array.isArray(r.tools) && r.tools.length) || 0;
    const skills = (Array.isArray(r.skills) && r.skills.length) || 0;
    const out = [];
    if (mem) out.push(mem + ' ' + (mem === 1 ? 'memory' : 'memories'));
    if (tools) out.push(tools + ' ' + (tools === 1 ? 'tool' : 'tools'));
    if (skills) out.push(skills + ' ' + (skills === 1 ? 'skill' : 'skills'));
    return out;
  },

  /** The one-line form: `"4 memories · 2 tools"`, or `''` for a turn that used nothing. */
  label(r) {
    return this.parts(r).join(' · ');
  },
};
