"""The topic pillars, defined once.

A small domain does not outrank anyone by being interesting. It outranks people
by TOPICAL AUTHORITY: a lot of material clustered on a few subjects, densely
interlinked, so a crawler can tell what the site is *about*. Scattered one-offs
read as a diary and rank like one.

These are chosen because they are simultaneously (a) what Vodou actually is
and (b) what most of the market is building right now and largely getting wrong.
Every post should land in one of them; a post that lands in none is a signal the
miner picked badly, not a reason to add another pillar. (Two have been added
since, each time from a measured share of `unsorted`, never from a hunch — see
the comments on the entries themselves.)

Imported by mine-topics.sh (to rotate coverage), mine-features.sh (same, for the
feature lane) and write-post.sh (to record which pillar a finished post landed
in). One table, several readers — if these ever disagree, rotation silently stops
working and nothing reports it.
"""
import re

PILLARS = {
    "agent-memory":      r"memor|chunk|recall|extract|inject|vault|forget|dedup|embedding",
    "retrieval-quality": r"retriev|fts5?|rerank|cross-encoder|search|rank|bm25|vector|semantic|hybrid",
    "mcp-orchestration": r"\bmcp\b|tool[- ]call|intent|rout|server|schema|agent|orchestrat|skill|scheduler",
    "llm-cost-latency":  r"cach|token|latency|throughput|prompt cache|cost|quantiz|batch|stream|timeout|spawn",
    # Added after measuring the miner: a large share of the best candidates were
    # about harnesses that lie — a green suite over code that never ran, a health
    # check that graded a different process, a benchmark that passed a worse model.
    # That is not a sub-topic of the other four, and it is one of the loudest open
    # problems in agent engineering right now, so it earns its own pillar.
    "agent-verification": r"eval|verif|assert|harness|fixture|regress|false.positive|flak|watchdog|health.?check|grader|smoke|coverage|broken-lab|silently",
    # Added 2026-08-26 when the FEATURE lane was built and needed somewhere to put
    # what Vodou actually ships. Measured, not guessed: pillar_of() over all 414
    # `feat(...)` commit subjects in the last 120 days returned `unsorted` for 210
    # of them (51%), and the scope census of those 210 is dominated by places a
    # human LOOKS at an agent — console 25, gateway 23, bridge 18, board 14, one 7,
    # onboarding 6, lenses 4, dock/panel/apps/feed/console-two/operator-surface 17.
    # That is ~57% of the unsorted mass in a single subject area that none of the
    # other five pillars' vocabularies describe, and `unsorted` carries a -20
    # rotation penalty, so half of every shipped feature was being ranked as
    # off-topic for a blog about building agents. The regex is deliberately narrow
    # (concrete UI nouns, not the word "console", which shows up in engineering
    # prose constantly) because pillar_of picks the highest count and a greedy
    # pattern here would quietly steal candidates from the other five.
    "agent-surface": r"side.?panel|onboard|\bdock\b|\bpopup\b|first.?run|\bmodal\b|\bbutton\b|\btooltip\b|approval|\bbanner\b|\bwizard\b|\bcard\b|side.?bar|browser extension|\bkeyboard shortcut",
}

LABELS = {
    "agent-memory":      "Agent memory",
    "retrieval-quality": "Retrieval quality",
    "mcp-orchestration": "MCP & orchestration",
    "llm-cost-latency":  "LLM cost & latency",
    "agent-verification": "Verifying agents",
    "agent-surface":     "The agent surface",
    "unsorted":          "Unsorted",
}


def pillar_of(text: str) -> str:
    """Whichever pillar's vocabulary appears most often. 'unsorted' if none does."""
    t = (text or "").lower()
    best, best_n = None, 0
    for name, pat in PILLARS.items():
        n = len(re.findall(pat, t))
        if n > best_n:
            best, best_n = name, n
    return best or "unsorted"


# --- feature-lane classification ---------------------------------------------
# A conventional-commit SCOPE is a far better pillar signal than the commit
# SUBJECT, and this is measured rather than assumed. Run pillar_of() over the
# seven `feat(graph):` subjects that make up the graph frontend and it returns
# "agent-memory" — on a single accidental hit of "memor" in *"memory fills the
# blanks"*, beating a tally of zero. The subjects are deliberately written as
# plain English headlines ("the plan card — see what will run before it runs"),
# which is exactly why they contain none of the jargon the regexes look for.
#
# So: the scope decides when we know it, and pillar_of() is the fallback for
# scopes we have never seen. The keys below are the real scopes measured from
# `git log --pretty=%s | grep '^feat('` over 120 days, not invented ones.
SCOPE_PILLARS = {
    # things a human looks at and steers
    "console": "agent-surface", "console-two": "agent-surface",
    "gateway": "agent-surface", "board": "agent-surface",
    "bridge": "agent-surface", "bridge-store": "agent-surface",
    "panel": "agent-surface", "dock": "agent-surface",
    "onboarding": "agent-surface", "lenses": "agent-surface",
    "one": "agent-surface", "vodou-one": "agent-surface",
    "apps": "agent-surface", "feed": "agent-surface",
    "operator-surface": "agent-surface", "picker": "agent-surface",
    "ui": "agent-surface", "ux": "agent-surface", "desktop": "agent-surface",
    "vbb": "agent-surface", "ext": "agent-surface", "chat-file-drop": "agent-surface",
    "presence": "agent-surface", "billing": "agent-surface", "usage": "agent-surface",

    # what the agent remembers
    "memory": "agent-memory", "page-memory": "agent-memory",
    "memory-render": "agent-memory", "memory-inject": "agent-memory",
    "inject": "agent-memory", "auto-inject": "agent-memory",
    "vaults": "agent-memory", "capture": "agent-memory",
    "backfill": "agent-memory", "entities": "agent-memory",
    "contradictions": "agent-memory", "brain": "agent-memory",
    "import": "agent-memory", "extractors": "agent-memory",
    "long-convo-recall": "agent-memory", "context": "agent-memory",

    # how it finds it again
    "library": "retrieval-quality", "sources": "retrieval-quality",
    "keygen": "retrieval-quality", "router-llm": "retrieval-quality",

    # how work gets planned and run
    "graph": "mcp-orchestration", "skills": "mcp-orchestration",
    "skill-console": "mcp-orchestration", "workflow": "mcp-orchestration",
    "board-planner": "mcp-orchestration", "router": "mcp-orchestration",
    "mcp": "mcp-orchestration", "mcp-egress": "mcp-orchestration",
    "channels": "mcp-orchestration", "scheduler": "mcp-orchestration",
    "hooks": "mcp-orchestration", "outcomes": "mcp-orchestration",
    "presets": "mcp-orchestration", "projects": "mcp-orchestration",

    # proving it works
    "coherence": "agent-verification", "flows": "agent-verification",
    "eval": "agent-verification", "qa": "agent-verification",
    "health": "agent-verification", "guard": "agent-verification",
    "receipt": "agent-verification",

    # what it costs to run
    "local-models": "llm-cost-latency", "llamacpp": "llm-cost-latency",
    "models": "llm-cost-latency", "deep-think": "llm-cost-latency",
    "ipc": "llm-cost-latency", "runtime": "llm-cost-latency",
}


def pillar_of_feature(scope: str, text: str = "") -> str:
    """Pillar for a shipped feature: scope first, prose second.

    Deliberately NOT a second classifier. When the scope is unknown this defers
    to pillar_of() verbatim, so there is still exactly one place that decides
    what a pillar's vocabulary is.
    """
    hit = SCOPE_PILLARS.get((scope or "").strip().lower())
    if hit:
        return hit
    return pillar_of(text)
