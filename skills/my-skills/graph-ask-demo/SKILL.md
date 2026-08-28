---
name: graph-ask-demo
description: "TEST FIXTURE (not a user skill): reads CPU and memory in parallel, then asks before saving. It exists because it is the only thing that reproduces the graph_ask path end to end — a fan, a join, and a human node. Safe to run; safe to delete if the ask path ever gets a fixture home of its own."
trigger_phrases:
  - graph ask demo
  - machine reading demo
---

# Graph ask demo

> **This is a test fixture living in the skills tree.** It is a real, triggerable
> skill (`graph ask demo`), kept because it is the only thing that reproduces the
> `ask me:` path end to end against a real run record. It reads CPU and memory
> and writes nothing. If the ask path gets a proper fixture home, delete this.

Two harmless probes run **together**, a join needs 1 of 2, then it stops and asks.
This exists so the `ask me:` path can be tested against a real run record rather
than a synthetic event.

## Shape

    together probes:
      cpu: mcp-monitor.get_cpu_info {}
      mem: mcp-monitor.get_memory_info {}
    then:
      need: 1 of 2
      brief: write one short line about the machine from {cpu, mem}
    ask me:
      save this reading?


<!-- AGENT_ACTIONS: {"initial_steps":[{"args":{},"id":"cpu","on_fail":"skip","parallel_group":"probes","server":"mcp-monitor","tool":"get_cpu_info"},{"args":{},"id":"mem","on_fail":"skip","parallel_group":"probes","server":"mcp-monitor","tool":"get_memory_info"},{"id":"join_probes","in":["cpu","mem"],"kind":"join","min_success":1,"mode":"all_settled","on_partial":"continue_with_warning"},{"depends_on":["join_probes"],"id":"brief","prompt":"write one short line about the machine from {cpu, mem}"}],"schema_version":"1.1","stopping_points":[{"id":1,"options":{"1":{"label":"Yes","steps":[],"vars":{}},"2":{"label":"No","steps":[],"vars":{}}},"title":"save this reading?","type":"menu"}]} -->
