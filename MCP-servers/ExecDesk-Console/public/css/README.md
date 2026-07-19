# Gateway stylesheets

Linked from `index.html` in this order (cascade matters):

| File | Contents |
|------|----------|
| `01-tokens.css` | Global reset, `:root` / `[data-theme]` colors, type/spacing/radius/shadow tokens |
| `02-primitives.css` | Layout utilities, `.card` / `.modal` / `.form-*`, typography utilities, `@keyframes`, `body` / headings |
| `03-layout-chat.css` | Sidebar, main shell, **chat thread + composer** (must follow design system **§14**), command palette, briefing strips, etc. |
| `04-views.css` | Non-chat routes: memory, skills, home, onboarding, settings, docs, API explorer, apps |

**Editing:** Prefer changing **`01-tokens.css`** for theme-wide color/spacing/type. Feature-specific rules stay in `03` or `04`. Scoped `<style>` blocks inside `js/views/*.js` are legacy — migrate toward these files when touching a view.

**New files:** If a sheet grows unwieldy, split along feature boundaries and add a new `<link>` after `04` (or subdivide `04` with a numbered prefix). Keep load order documented here.
