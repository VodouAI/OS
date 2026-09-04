// Sidebar badge: count of skills awaiting human review (autonomous draft/candidate
// proposals from the skill-learning loop). Mirrors the execdesk approval-badge pattern.
// Drafts are inert until promoted — the badge tells the user something is waiting.
(function () {
  window.refreshSkillsReviewBadge = async function () {
    try {
      const r = await fetch('/api/skills/pending-count');
      if (!r.ok) return;
      const { count } = await r.json();
      document.querySelectorAll('.skills-review-pending').forEach((el) => {
        if (count > 0) {
          el.dataset.count = String(count);
          el.textContent = String(count);
          el.style.display = 'inline-block';
        } else {
          el.dataset.count = '';
          el.textContent = '';
          el.style.display = 'none';
        }
      });
    } catch {
      /* gateway not ready / offline — leave badge hidden */
    }
  };
  const run = () => window.refreshSkillsReviewBadge();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
  // Refresh on navigation (e.g. after promoting from the review panel) and
  // periodically so a freshly-proposed draft surfaces without a reload.
  window.addEventListener('hashchange', run);
  setInterval(run, 60000);
})();
