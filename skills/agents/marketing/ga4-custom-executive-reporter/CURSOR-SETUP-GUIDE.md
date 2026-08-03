# GA4 in Cursor: MCP → Skill → Frontend

**For:** Anyone building custom Google Analytics reports in Cursor with Auto — including if you’ve never set up Google Cloud, OAuth, or MCP before.  
**How to use:** Open this file in Cursor. Set the model to **Auto**. Tell the agent:

> Read `CURSOR-SETUP-GUIDE.md` and execute **Step 1** only. Fully complete and test it before asking me to move on. If I don’t know something, walk me through it one step at a time.

At each step, paste the prompt block for that step (or say “do Step N from the guide”). Finish and verify before the next step. Iterate the skill until the reports are worth reusing (or selling).

**Companion skill:** `SKILL.md` in this same folder (`ga4-custom-executive-reporter`).

---

## Agent rules (mandatory)

The Cursor agent **must** follow these while running this guide:

1. **Assume zero prior knowledge** of Google Cloud, OAuth, GA4 property IDs, MCP config, tokens, or Cursor settings unless the user says otherwise.
2. **One manual step at a time.** Never dump a 10-item wall. Format each human action like:
   - **Do this now:** (one action)
   - **Where:** (exact URL or Cursor path)
   - **Click/type:** (what to press or paste)
   - **What you should see:** (success signal)
   - **Then reply with:** (what to paste back — e.g. “done”, a property ID, a screenshot description, an error message)
3. **Wait for the user’s reply** after every browser/login/credential step before continuing.
4. **Explain jargon once**, in plain language (e.g. “OAuth = Google’s login permission so the MCP can read your Analytics”).
5. **Never ask the user to invent credentials.** Tell them exactly which console to open and what to create.
6. **Never fake GA4 numbers** or claim MCP works without a real successful tool call.
7. If the user says “I don’t know” / “I’m lost” / “what’s a ___?”, **pause the main plan**, teach that one concept, then resume from the same checklist item.
8. Prefer official links (Google Cloud Console, Analytics, GitHub README) and keep them clickable.

---

## Before you start

You only need:

1. Cursor IDE installed  
2. This folder open as the project (or a parent folder that contains it)  
3. Model set to **Auto**  
4. A Google account that can see at least one website/app in **Google Analytics 4** (if you’re not sure you have GA4, tell the agent — it will help you check)

You do **not** need to already know: API keys, OAuth clients, property IDs, `mcp.json`, or Python/Node setup. The agent will walk you through each.

---

## Step 1 — Fully set up Google Analytics MCP

**Goal:** [google-analytics-mcp](https://github.com/googleanalytics/google-analytics-mcp) works in Cursor; tools verified with live data.

### Walkthrough checklist (agent leads; you confirm each line)

Work **one item at a time**. After each, user replies “done” or pastes the requested value/error.

1. **Confirm GA4 access** — Open Analytics → find a GA4 property (not Universal Analytics). Agent explains how to tell the difference and where the **Property ID** is (Admin → Property settings).
2. **Google Cloud project** — Create or pick a project. Agent gives exact console URL and clicks.
3. **Enable APIs** — Enable **Google Analytics Data API** (and **Admin API** if the MCP README requires it). Agent confirms how to verify “API enabled”.
4. **Credentials** — Whatever the MCP README requires (typically OAuth desktop/client or application default credentials). Agent:
   - Reads the current GitHub README first  
   - Chooses the simplest path for Cursor on the user’s OS  
   - Walks through creating the OAuth client / service account / ADC **step by step**  
   - Explains what to download, where to save it, and what **never** to commit to git  
5. **Install / register MCP in Cursor** — Agent edits or creates the Cursor MCP config (`mcp.json` / Settings → MCP), shows the exact JSON, and explains each field.
6. **Restart / reload MCP** — Agent tells user when to reload Cursor or toggle the server.
7. **Test with a live tool call** — List tools, then call one that returns real property/report data. Paste proof in chat.
8. **Credential map** — Agent writes a short “where everything lives” note for the user (paths, env vars, which Google account, which property ID). No secret values repeated in full if avoidable.

### If something fails

Agent must: diagnose → give **one** fix action → wait → retry the same checklist item. Common cases: wrong Google account, API not enabled, OAuth consent screen in “Testing” with user not added, missing redirect URI, MCP server not visible in Cursor, expired token.

### Prompt (copy into Cursor chat)

```
Read CURSOR-SETUP-GUIDE.md in this project. Execute Step 1 only.

Fully set up https://github.com/googleanalytics/google-analytics-mcp in this Cursor IDE.

I may not know Google Cloud, OAuth, API keys, property IDs, or MCP config. Follow the Agent rules in this guide:
- Teach me anything I don’t know
- One manual step at a time (Do this now / Where / Click-type / What I should see / Then reply with)
- Wait for my reply before the next step
- Read the official MCP README and follow its current auth method
- Never fake success — prove tools with a real live call

Walk me through every token, key, OAuth client, API enablement, and GA4 property step I need. When setup is done:
- Test and verify MCP tools from Cursor
- Show me exactly how the MCP is connected (mcp.json / settings)
- Give me a simple map of what I created and where it lives (without dumping full secrets)
- Confirm a live tool call returns real GA4 data

Start with checklist item 1 only.
```

### Done when

- [ ] MCP appears in Cursor MCP settings and is connected  
- [ ] At least one live tool call returns real GA4 data  
- [ ] You understand (in plain language) what credentials you created and where they live  
- [ ] You know which GA4 property ID you’re using  

**Then say:** “Step 1 done. Do Step 2.”

---

## Step 2 — Skill → custom reports

**Goal:** `ga4-custom-executive-reporter` runs against your live GA4 MCP, produces a stable custom report shape a frontend can consume.

If anything in Step 2 assumes knowledge you don’t have (what a “skill” is, where `SKILL.md` lives, how to invoke it), the agent must explain first, then continue one step at a time.

### Prompt (copy into Cursor chat)

```
Read CURSOR-SETUP-GUIDE.md. Execute Step 2 only.

Take a look at SKILL.md in this folder (ga4-custom-executive-reporter).

Fully set it up to run against my Google Analytics MCP.
I may not know how Cursor skills, tool wiring, or report JSON contracts work — explain briefly when needed, and walk me through any manual steps one at a time (same Agent rules as Step 1).

Walk me through making it production-usable:
- Wire required tools to the live GA4 MCP
- Keep/customize the CMO persona + XYZ objectives (Acquisition / Conversion / ROI-Action)
- Define a clear custom report output shape the skill always produces (JSON contract preferred)
- Create a runnable path/script so I can generate custom reports on demand

We want this skill to create custom reports that a front-end can render.
Once the skill base is setup, tested with live GA4 data, and the report contract is solid — stop and tell me we’re ready for Step 3 (frontend charts/views).

Iterate and refine the skill with me until the reports are sharp enough that I’d pay for / reuse them.
If auth or MCP breaks again, drop back into Step 1 style hand-holding until it works.
```

### Skill contract reminder (XYZ)

| Lens | Pull | Output |
|------|------|--------|
| **X Acquisition** | Organic vs paid channels | Impact → recommendation |
| **Y Conversion** | Event completion / conversion rates | Impact → recommendation |
| **Z ROI / Action** | Cost-efficiency or drop-offs | Impact → recommendation |

Persona: direct CMO advisor — concise, punchy, no metric tutorials.

### Done when

- [ ] Skill runs end-to-end on live GA4  
- [ ] Report shape is documented (fields the UI will chart)  
- [ ] You’ve refined persona/output at least once with real numbers  

**Then say:** “Step 2 done. Do Step 3.”

---

## Step 3 — Frontend from those reports

**Goal:** Openable UI with charts for X/Y/Z, refresh from live MCP data, same impact→recommendation voice.

Prefer a **Cursor Canvas** (`.canvas.tsx`) for the first shippable view. Only build a separate local web app if the agent justifies why Canvas isn’t enough — **one** primary deliverable, not both.

If you don’t know what a Canvas is, where files go, or how to open the preview, the agent must show you click-by-click.

### Prompt (copy into Cursor chat)

```
Read CURSOR-SETUP-GUIDE.md. Execute Step 3 only.

We finished:
1) Google Analytics MCP connected + tools verified
2) The ga4-custom-executive-reporter skill runs and produces custom XYZ reports

Now build the frontend for those reports.

I may not know Cursor Canvas, chart components, or how refresh/auth wiring works — explain briefly and walk me through any manual steps one at a time (same Agent rules).

Goal:
Turn the skill’s custom report output into a working front-end with charts I can open and refresh. Prefer a Cursor Canvas (.canvas.tsx) beside chat for the first shippable view. If a small local web app is clearly better, say why — then build that instead. One primary deliverable, not both.

Requirements:
1. Real data only — from the GA4 MCP via the skill (or a small runnable script the skill owns). No fake numbers.
2. Charts for X / Y / Z:
   - X Acquisition: organic vs paid
   - Y Conversion: event completion / conversion rates
   - Z ROI/Action: cost-efficiency OR drop-offs needing action
3. Every insight: impact first, then a direct recommendation (same CMO persona — no fluff).
4. Controls: property/site, date range, conversion event(s). Persist last settings if easy.
5. Refresh re-pulls live MCP data and re-renders. Loading + clear errors if auth/MCP fails.
6. Label every chart (title, axes/units, legend, source + date range).

Process:
- Inspect skill report shape + MCP tools; propose a minimal JSON contract the UI consumes
- Ship the thinnest vertical slice with all three XYZ panels on live data
- Test end-to-end with me: run skill → data lands → UI updates — tell me exactly what to click/open
- Iterate skill + UI together until I’d open this weekly; ask what “profit” means for me and optimize for that

Done when:
- I can open the UI, hit refresh, and see live GA4 XYZ charts + impact→recommendation insights
- One full refresh path is verified
- You’ve listed the next 3 highest-leverage refinements

Start now. Plan in 5 bullets max, then build and test. If I’m stuck, one step at a time.
```

### Done when

- [ ] UI opens and shows live XYZ charts  
- [ ] Refresh works against real MCP data  
- [ ] Next 3 refinements listed  

---

## After Step 3 — iterate for profit

Keep looping in one chat (or a new chat that reads this guide + `SKILL.md`):

1. Tighten skill prompts / report JSON for clearer charts  
2. Improve defaults (date range, conversion events, property)  
3. Add only charts that change a decision  

Tell the agent what “profit” means for you (time saved, client PDF, paid weekly report) and optimize for that. If something breaks (token expired, wrong property), say “I’m lost — walk me through fixing auth” and the agent must use Step 1 hand-holding again.

---

## Quick agent kickoff (all steps, still sequential)

If you want one opener:

```
Read CURSOR-SETUP-GUIDE.md and SKILL.md in this folder.
Work Step 1 → Step 2 → Step 3 in order.
Fully complete and test each step before starting the next.
Stop after each step’s “Done when” checklist and wait for me to say continue.

Follow the Agent rules: assume I may not know Google Cloud, OAuth, tokens, keys, property IDs, MCP, or Canvas. Teach me. One manual step at a time. Wait for my reply. Never fake GA4 numbers.
Start with Step 1 checklist item 1 only.
```
