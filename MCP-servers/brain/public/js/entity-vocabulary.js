// BUILD COPY of MCP-servers/Vodou-Console/public/js/entity-vocabulary.js — edit there, then `npm run build` in MCP-servers/brain.
// The words for what a NAME is and how two names RELATE — one spelling.
//
// PLAN-PEOPLE-PAGES P0. These maps lived inside the Brain map's closure
// (brain/app.js); the People tab shows the same kinds and predicates, and two
// spellings of "works at" would drift within a month. They are console-only
// words — the extension never renders an entity kind — so they live here and
// not in vocabulary.js, whose extension copy must stay byte-identical (see
// extension/Store-vodou-bridge/test/vocabulary-parity.test.mjs) and whose every
// change is a store release.
//
// Loaded as a plain script by both hosts of the Brain map: the console's
// index.html and the standalone brain console. A raw `kind` or `predicate`
// must never reach textContent (coherence-guard) — call the functions.
globalThis.VodouEntityVocabulary = {
  /** What a name IS, once the classifier has judged it (PLAN-BRAIN-WEB-OF-NAMES
   *  P3/P4). Plural, for a filter over many. `not_an_entity` is the classifier's
   *  negative memory — never listed, but when named it is named honestly. */
  KIND_LABEL: {
    person: 'People', org: 'Orgs', product: 'Products', project: 'Projects',
    place: 'Places', event: 'Events', handle: 'Handles', name: 'Unclassified',
    not_an_entity: 'Junk',
  },
  /** Singular, for the chip on one page. */
  KIND_LABEL_ONE: {
    person: 'Person', org: 'Org', product: 'Product', project: 'Project',
    place: 'Place', event: 'Event', handle: 'Handle', name: 'Unclassified',
    not_an_entity: 'Junk',
  },
  /** Kind → word. `one` picks the singular. An unknown kind comes back as words, never as the raw enum. */
  kindLabel(kind, one = false) {
    const k = String(kind || '');
    const map = one ? this.KIND_LABEL_ONE : this.KIND_LABEL;
    return map[k] || (k ? k.replace(/_/g, ' ') : 'Unclassified');
  },

  /** P5 predicates, rendered as English. A typed edge is the difference between
   *  "these two turn up together" and "she signed the thing he wrote". */
  PREDICATE_LABEL: {
    works_at: 'works at', works_with: 'works with', founded: 'founded', member_of: 'member of',
    reports_to: 'reports to', met_with: 'met with', introduced: 'introduced',
    signed: 'signed', invested_in: 'invested in', advises: 'advises',
    located_in: 'in', built: 'built', uses: 'uses', depends_on: 'depends on',
    blocked_by: 'blocked by', part_of: 'part of', related_to: 'related to',
  },
  predicateLabel(p) {
    const k = String(p || '');
    return this.PREDICATE_LABEL[k] || k.replace(/_/g, ' ');
  },
};
