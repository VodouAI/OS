# CWS listing screenshots (not packed into the store ZIP)

All four are **1280×800**, one of the two sizes Chrome Web Store accepts (the other is 640×400).
Verified with `sips -g pixelWidth -g pixelHeight *.png`. Each has a **baked-in caption band** —
the caption is part of the PNG, so it survives however the store crops or scales the thumbnail,
and it does not depend on anyone reading the listing text next to it.

| File | What it shows | Role |
|------|----------------|------|
| `01-hero-remembers.png` | ChatGPT answering using the user's own conventions, with the Vodou panel visible alongside — the model already knows, without being told again | **Primary — the payoff** |
| `02-lands-in-your-draft.png` | The inserted memory sitting in the composer, **unsent** — the user reads and edits before anything goes anywhere | **Primary — consent** |
| `03-works-everywhere.png` | The panel's Settings tab: the 22-site grid, the localhost gateway, paired | **Primary — reach + trust** |
| `04-see-what-happened.png` | The panel's Activity feed, both directions — what was saved and what was inserted | **Supporting — accountability** |

**Upload in numeric order.** 01 leads because it shows the outcome rather than the mechanism;
02 immediately answers "so it types things for me?" with *no, it drafts and you decide*. 03 and
04 are the reviewer's questions rather than the user's — where does this run, and can the user
see what it did.

**If only two slots are used:** 01 + 02. The payoff, then the proof that nothing is sent on the
user's behalf.

## Keep these honest

Every shot is of the **side panel**. There is no popup — the toolbar icon opens the panel
(`manifest.json` has `side_panel.default_path` and an `action` block with no `default_popup`).
A screenshot of a UI the extension does not have is a listing mismatch, and it is the kind a
reviewer notices immediately because they have the extension loaded while they look.

The previous version of this file described `01-pick-what-to-share.png`, `02-ALT-popup-hero.png`
and `03-lands-in-your-chat.png` — none of which still exist, and one of which was a shot of the
retired popup. The reshoot happened 2026-07-30; the README did not follow until later the same
day. If the shots are ever redone again, rewrite this table in the same commit: a screenshot
manifest that names missing files is worse than none, because it sends whoever is submitting
looking for them.

## old-unusable/

Superseded shots, kept only as reference. Deliberately untracked; nothing references it.

Two different generations live in there, retired for two different reasons:

- **Off-spec sizes** — `01-bridge-popup-connected.png` (543×1024), `02-console-memory-insert.png`
  (1024×628), `03-console-context-in-draft.png` (1024×655), plus a stray `.jpg`. CWS takes
  1280×800 or 640×400 and nothing else.
- **Correctly sized but showing a product that no longer exists** — `01-pick-what-to-share.png`,
  `02-ALT-popup-hero.png`, `02-save-and-sync.png` and `03-lands-in-your-chat.png` are all
  1280×800. They were replaced because they show the **retired popup** and the old flow, not
  because of their dimensions.

That second category is the dangerous one: they pass an "is it 1280×800?" check and would sail
into a listing. This file used to claim *every* shot in here was off-spec, which would have made
someone re-checking sizes conclude they were safe to reuse.
