/**
 * SkillScopeAdapter — stub. The Skills view refactor will wire this up.
 *
 * Shape is final; body is a placeholder that returns a minimal descriptor
 * so `workbench:skill:<id>` conversations can still render a chat surface
 * even before the full skill wiring exists.
 */
(() => {
  // Person emoji palette — every skill ("subagent") gets a deterministic
  // person icon from this set, hashed off the skill id. Same skill always
  // gets the same person; different skills get distinct ones.
  const PERSON_ICONS = [
    '🧑‍💼','👩‍💼','👨‍💼','🧑‍🔬','👩‍🔬','👨‍🔬','🧑‍🎨','👩‍🎨','👨‍🎨',
    '🧑‍💻','👩‍💻','👨‍💻','🧑‍🚀','👩‍🚀','👨‍🚀','🧑‍🏫','👩‍🏫','👨‍🏫',
    '🧑‍⚕️','👩‍⚕️','👨‍⚕️','🧑‍🍳','👩‍🍳','👨‍🍳','🧑‍🔧','🧑‍🌾','🧑‍🎤',
    '🦸','🦹','🧙','🧝','🧚','🧞','🥷','🕵️','👤',
  ];
  function personFor(skillId) {
    const id = String(skillId || '');
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return PERSON_ICONS[h % PERSON_ICONS.length];
  }

  const SkillScopeAdapter = {
    async describe(skillId) {
      if (!skillId) return null;
      const person = personFor(skillId);
      return {
        scopeType: 'skill',
        scopeId: skillId,
        raw: `workbench:skill:${skillId}`,
        displayName: skillId,
        iconHtml: `<span class="sw-icon-emoji sw-icon-person">${person}</span>`,
        toolRail: [],
        emptyStateHint: 'Skill workbench — scope exists but the skill runner UI is not yet wired here. Open #/skills to run this skill directly for now.',
      };
    },
  };

  if (typeof window.ScopeRegistry !== 'undefined') {
    window.ScopeRegistry.register('skill', SkillScopeAdapter);
  } else {
    console.error('[SkillScopeAdapter] ScopeRegistry not loaded — load scope-registry first');
  }
})();
