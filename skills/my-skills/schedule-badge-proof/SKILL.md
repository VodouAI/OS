---
name: schedule-badge-proof
description: Temporary: proves the catalog schedule badge and the scheduled filter light up.
---

# schedule-badge-proof

Saved from a plan card. The **recipe below is the source** — edit the words,
not the JSON; `vodou-core recipe compile` regenerates the rest.

## Shape

    together:
      cpu: mcp-monitor.get_cpu_info
      mem: mcp-monitor.get_memory_info

<!-- AGENT_ACTIONS: {"initial_steps":[{"args":{},"id":"cpu","on_fail":"skip","parallel_group":"together","server":"mcp-monitor","side_effecting":false,"tool":"get_cpu_info"},{"args":{},"id":"mem","on_fail":"skip","parallel_group":"together","server":"mcp-monitor","side_effecting":false,"tool":"get_memory_info"},{"id":"join_together","in":["cpu","mem"],"kind":"join","min_success":2,"mode":"all_settled","on_partial":"continue_with_warning"}],"schema_version":"1.1","stopping_points":[{"id":1,"options":{"1":{"label":"Run again","steps":[{"args":{},"id":"cpu","on_fail":"skip","parallel_group":"together","server":"mcp-monitor","side_effecting":false,"tool":"get_cpu_info"},{"args":{},"id":"mem","on_fail":"skip","parallel_group":"together","server":"mcp-monitor","side_effecting":false,"tool":"get_memory_info"},{"id":"join_together","in":["cpu","mem"],"kind":"join","min_success":2,"mode":"all_settled","on_partial":"continue_with_warning"}],"vars":{}},"2":{"label":"Done","steps":[],"vars":{}}},"title":"Run complete","type":"menu"}]} -->
