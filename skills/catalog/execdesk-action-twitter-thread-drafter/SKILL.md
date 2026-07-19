---
name: execdesk-action-twitter-thread-drafter
description: CMO drafts a 5–7 tweet thread in the founder's voice, cites brand specifics, queues to approval (default-ON). Runs on demand or weekly cron.
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - draft a thread
  - draft a twitter thread
  - twitter thread
  - tweet thread
  - thread about
stopping_points: optional
actions: actions.json
imported_from: {source: catalog}
metadata:
  vodou:
    category: execdesk
    execdesk_role: action
    execdesk_phase: 1
    execdesk_pack: exec-pack-default
    called_by: execdesk-cmo
    requires_company_brief: true
    schedule_default: "0 9 * * 1"
    approval_gate: on
    approval_gate_locked: false
    persistent_workbench: workbench:skill:execdesk-action-twitter-thread-drafter
---

# Twitter Thread Drafter — CMO weekly content (v1.0)

> **Wedge keystone.** Per `EXECDESK-WEDGE-VALIDATION-RESULT.md`:
> - Maya (F1): _"That's the whole job. That's what I'd pay for."_
> - Asha (F5): _"If a CMO drafted my weekly /r/soapmaking post and queued it for me to approve? That's exactly what I keep almost-doing-myself but never get around to."_
>
> This is THE skill the wedge wants. Voice fidelity is the line between "I'd publish this" and "canceling subscription."

CMO drafts a 5–7 tweet thread tied to the founder's brief (audience, voice, current product / launch / season). Output goes straight to the approval queue with `default-ON` gate per §0.7 #9 — never auto-publishes externally.

## When it runs

### On-demand (today)
User types _"draft a thread about [topic]"_ in `/#/execdesk` chat. Topic can be:
- A current product/launch ("the new card-holder line")
- A milestone or AMA ("our $50k MRR moment")
- A craft/build-in-public update ("the new vegetable-tan supplier")
- A community AMA prep ("/r/EDC AMA next week — draft the opener")

If no topic provided, the CMO infers one from the brief's "this quarter" goals + recent memory. If still ambiguous, asks ONE question: _"What's the thread about — a product launch, a milestone, a community AMA, or something else?"_

### Scheduled (Phase 2)
Default cron `0 9 * * 1` (Monday 9am, founder TZ — runs AFTER the weekly-brief at 8am so it can pick up the CEO's "this week's bet"). Output:
- Drafts a thread on the highest-priority topic from the weekly brief's Monday action
- Auto-queues to `/#/execdesk-approval` with default-ON gate
- Surfaces in home view's "What your team did this week" feed

## Output schema (locked v1.0)

```markdown
**[Thread topic — one line]**

1/ [Hook tweet — under 240 chars. Must stop the scroll. The first 7 words decide whether anyone reads tweet 2.]

2/ [Concrete specific. Numbers, names, places. NOT "we've grown a lot" — "we hit $42k MRR in 18 months from a basement workshop in Ohio."]

3/ [The story or insight. Founder voice. Not influencer voice.]

4/ [Continue the thread — 3–5 more tweets max. Each one self-contained but tied to the next.]

5/ [Optional: a tactical or contrarian angle. The thing your audience knows but Twitter writers don't.]

6/ [Optional: the lesson or what's next.]

7/ [CTA tweet — soft. Link in comments / DM me / etc. Never "BUY NOW".]

—
*[1-line rationale: why this angle, why this tone. Max 20 words.]*

**Auto-queued to `/#/execdesk-approval` for your review before posting.**
```

## Voice rules (locked — these are why founders stay)

**Required:**
- Founder-mirror voice. If brief says "shop" not "store," every tweet says "shop." If brief says "folks" not "customers," every tweet says "folks."
- Concrete specifics. Names, numbers, places. "Vegetable-tanned leather, made in Ohio, no hardware" beats "premium materials."
- Self-contained tweets. Each tweet should make sense on its own when retweeted.
- Under 280 chars per tweet.
- Numbered with `N/` prefix (the de facto Twitter thread convention).

**Banned:**
- "Are you ready to..." / "Imagine if..." / "Here's the thing..." / "Plot twist:" — viral-thread cliché openers
- 🧵 emoji as the opener (cliché). Use it ONLY if the brief signals the founder uses it naturally.
- "Game-changer", "10x", "leverage", "ecosystem", "drive engagement", "value prop" — LinkedIn-speak
- "I want to share..." / "I'd love to share..." / "Excited to announce..." — corporate filler
- Generic CTAs — "If you liked this thread, follow for more!" is a tell. Don't.
- More than 7 tweets unless the founder explicitly asks. Brevity > comprehensive.

## Brief grounding requirements

The thread MUST cite at least 2 of these from the brief, by name:
- A specific product, line, or SKU
- A specific number (revenue, customer count, AOV, % growth, time-in-business)
- A specific community or audience reference (subreddit, niche, geography)
- A specific competitor or comparison anchor

If you can't fit any of those, the thread is too generic — re-anchor and rewrite.

## Approval gate (default-ON, locked exception)

Per §0.7 #9, this skill ALWAYS routes through the approval queue. The approval gate is `default-ON` and CAN be turned off by the founder per-skill (it's not hard-locked like CFO outflows). But until they do, the gate is on.

The skill enqueues via `window.ExecDeskApproval.enqueue({...})` (browser-side) when run from the `/#/execdesk` UI, OR via `/api/exec/save-approval` (Phase 2 endpoint TBD when scheduled-cron path lands).

Queue payload:
```json
{
  "source": "execdesk-action-twitter-thread-drafter",
  "source_label": "CMO",
  "source_color": "#16a34a",
  "action": "twitter-thread",
  "title": "[Thread] {topic} — {N} tweets",
  "summary": "Auto-drafted by CMO. Review voice, specifics, CTA before posting.",
  "payload_preview": "{first 600 chars of thread}",
  "gate_reason": "External publish — default-ON per §0.7 #9"
}
```

## Failure modes to avoid

- **Generic motivational thread.** "Here are 5 lessons from building a $42k MRR business…" — no. That's LinkedIn slop. Concrete > generic; specific > universal.
- **Founder-impersonation drift.** If the brief says the founder is dry and self-deprecating, don't write earnest enthusiasm. Mirror their actual voice from quotes in the brief.
- **Over-engineered hook.** "Plot twist: I almost shut down my company last year. Here's what changed." → cliché. Skip the artificial cliffhanger; lead with the real thing.
- **Missing CTA or wrong CTA.** Soft, voice-aligned CTAs only. "Link in comments" / "DM if curious" / "Reply with your favorite color and we'll bump you up the list" — these match craft-community vibes. "BUY NOW WITH CODE LAUNCH20" doesn't.
- **Too many tweets.** Threads over 7 tweets lose readership fast. Default to 5–6. Earn the 7th.

## Output destination

1. **Render in chat** so the founder sees it immediately
2. **Enqueue to `/#/execdesk-approval`** with the payload above
3. **Persist to memory** at `workbench:skill:execdesk-cmo` so the CMO sees its own draft history

## Eval target

Two golden prompts in `evals/execdesk/golden-sets/cmo/`:
- `002-tweet-thread.md` (already exists) — covers basic thread shape
- New: `006-thread-no-topic.md` — verifies the CMO asks ONE clarifier when topic missing

Eval pass conditions: 5–7 numbered tweets, ≥2 brief citations, voice-banned-phrases absent, length per tweet ≤280, includes a soft CTA.

## What this skill does NOT do (out of scope)

- ❌ Doesn't post to Twitter directly. Approval queue gates external publish, always.
- ❌ Doesn't draft single tweets. Use a different skill or just chat with the CMO.
- ❌ Doesn't draft threads on topics outside the founder's brief without asking. If the user wants "draft a thread about AI ethics" and the founder sells leather goods, the CMO asks: _"That's outside your usual lane — sure you want it from me?"_
- ❌ Doesn't engage in viral-thread tropes (numbered list of life lessons, "I built a 7-figure business and here's what I learned" framing, etc.). Draft real content, not Twitter-formula content.
