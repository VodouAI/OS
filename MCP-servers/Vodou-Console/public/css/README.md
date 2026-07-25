# Gateway stylesheets

Linked from `index.html` in this order (cascade matters):

| File | Contents |
|------|----------|
| `01-tokens.css` | Global reset, **theme + palette** colors (`data-theme` × `data-palette`), type/spacing/radius/shadow tokens |
| `02-primitives.css` | Layout utilities, `.card` / `.modal` / `.form-*`, typography utilities, `@keyframes`, `body` / headings |
| `03-layout-chat.css` | Sidebar, main shell, **chat thread + composer** (must follow design system **§14**), command palette, briefing strips, etc. |
| `04-views.css` | Non-chat routes: memory, skills, home, onboarding, settings (incl. Appearance), docs, API explorer, apps |

**Theme axes (orthogonal):**

| Attribute | Values | Default | Control |
|-----------|--------|---------|---------|
| `data-theme` | `light` \| `dark` | `dark` | Sidebar sun/moon + Settings → Appearance |
| `data-palette` | `brand` \| `ritual` | `brand` | Settings → Appearance |

- **brand** — IanDesignART guide primary `#2563EB` + gray `#6B7280`, cool slate surfaces (light + dark).
- **ritual** — classic Obsidian / Bone / Gold (`#c9a227`).

Persistence: `localStorage['vodou-theme']`, `localStorage['vodou-palette']`. Missing palette migrates once to `brand`. Boot script in `index.html` `<head>` sets both before CSS.

**Editing:** Prefer changing **`01-tokens.css`** for theme-wide color/spacing/type. Feature-specific rules stay in `03` or `04`. Use `var(--accent)` (no hardcoded teal/gold fallbacks). Scoped `<style>` blocks inside `js/views/*.js` are legacy — migrate toward these files when touching a view.

**New files:** If a sheet grows unwieldy, split along feature boundaries and add a new `<link>` after `04` (or subdivide `04` with a numbered prefix). Keep load order documented here.
