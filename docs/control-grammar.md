# Telling Vodou how much rope it has

Vodou can work three different ways when you are not watching, and until now
they had no names. This is the vocabulary.

## The three modes

| | What it does | When you want it | How it ends |
|---|---|---|---|
| **Schedule** | Runs on the clock. Every tick is a fresh run. | "Do this at 9am whether or not I am here." | When you delete the job. |
| **Watch** | Keeps an eye on something in one conversation and tells you when it changes. | "Tell me when the build goes green, while we carry on talking." | At a cap, on evidence, or when you clear it. |
| **Keep going** | Works towards a goal, deciding after each turn whether it is done. | "I want this finished, not one step of it attempted." | Done, blocked, out of budget, parked, or you say stop. |

**The one people get wrong:** Watch lives in one conversation and stops on its
own; Schedule runs forever on a clock and starts fresh every time.

A scheduled run never reads the chat it lives next to — it reads a state object,
so it cannot drift by inheriting a transcript. A Watch is the opposite: it is
*about* the conversation it was started in.

Schedule lives under **Activity › Scheduled**. Keep going lives on a **Board**
card. Watch is coming.

## While something is running

These are the things you can do to a turn that has already started. Before
this, the only options were to wait or open another chat — so people opened
another chat, and the question that was about *this* thread got asked somewhere
that could not see it.

**Side ask** — ask about this conversation without interrupting it. The answer
comes back beside the thread, not in it.

> Nothing you ask this way enters the transcript. That is the point, not a
> detail: if it did, your next real message would arrive with a question in its
> history that you never sent, and the running turn would have been changed by
> something you meant only to ask about.

Version one has no tools. It reads the recent conversation and answers from it,
and says so plainly when the answer is not there.

**Background** — send independent work off on its own, with a fresh context.
This is the existing Board spawn; it is named here so it stops being the thing
people reach for when they actually wanted a side ask.

**Steer** — nudge the turn that is running. It lands after the next tool result,
without restarting anything. *Not wired yet.*

## What Enter does while Vodou is busy

A per-conversation setting, with a global default.

- **Queue** — your message waits its turn. This is the default and the current
  behaviour.
- **Interrupt** — stop what is running and take this instead.
- **Steer** — nudge the running turn. **Not wired yet**, so choosing it queues
  your message and tells you it queued. It will not silently do nothing.

## What this is not

This vocabulary does not own the daily briefing, the graph cycle, or the
background checks that watch your memory for problems. Those are separate and
have their own rules. Naming things is only useful if the names stop at the
edge of what they describe.
