# templates/rules — the ONE source for every host's rules file

`CLAUDE.md`, `.cursorrules`, `.cursor/rules/vodou-policy.mdc`, `GEMINI.md`,
`.github/copilot-instructions.md` (and any host added later) are **generated** from here by `vodou-core rules render`. Edit these
files, run the renderer, commit both. `vodou-core rules render --check` exits 2
when a generated file has drifted from its source — CI and the pre-commit guard
use it.

Why (PLAN-SESSION-CONTRACT, blocks 3–5; PLAN-HOST-RULES-ONE-SOURCE): each host's
rules file was hand-maintained prose and they diverged. `.cursorrules` went three
months without the parallel-session commit rules while Cursor worked in this same
worktree. Policy that is host-agnostic lives here once.

Layout:
- `NN-*.md` — shared policy blocks, composed in numeric order.
- `hosts/<name>.md` — one adapter per generated file: a small header,
  `target:` / `blocks:` / optional `frontmatter:`, a `---` line, host-specific
  HEAD markdown, an optional `<!-- TAIL -->` marker, host-specific TAIL markdown.

`blocks: all` includes every shared block; `blocks: 50,70` picks by number
prefix. A host whose context budget cannot carry the full set (Cursor's
always-applied `.mdc`) selects the resident rules only — that selection is the
adapter's declared budget, and it is the only place such a choice is made.

## Spliced regions — AGENTS.md

`AGENTS.md` is the manual, hand-written, and NOT generated. But where it quotes a
policy block it does so through a region the renderer owns:

    <!-- rules:begin 70-lane-canon -->
    …replaced with templates/rules/70-lane-canon.md on every render…
    <!-- rules:end 70-lane-canon -->

`--check` flags a region that differs from its block; an unknown stem or a
missing end marker is an error, not an empty hole. The renderer then mirrors
the spliced `AGENTS.md` to `.vodou/workspace/AGENTS.md` (what the bootstrap
serves) so the pointer every session is handed names one manual, not three.

## Hosts with no file of their own

- **Codex** reads root `AGENTS.md` natively under a 32 KiB cap. Its adapter is
  *placement*: the `50-commits` and `70-lane-canon` regions sit at the top of
  AGENTS.md, inside the cap.
- **Global `~/.claude/CLAUDE.md`** — decided 2026-08-27: **project policy stays
  project-scoped.** No global adapter; nothing here reaches other repositories.
