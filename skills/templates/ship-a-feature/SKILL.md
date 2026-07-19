---
name: ship-a-feature
description: workflow template — PM specs, engineer implements, reviewer approves, deployer ships; pre-installed with the board, activates in Phase 2 when the workflow_template kind enum lands
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "apply ship-a-feature template"
  - "/board apply-template ship-a-feature"
stopping_points: none
actions: inline
metadata:
  vodou:
    persona_role: feature delivery pipeline
    template_kind: feature_delivery
    phase_active: 2
---

# ship-a-feature

A 4-stage pipeline for shipping a feature end-to-end: spec → implement → review → deploy. The dispatcher auto-advances tasks through these stages when each stage's `required_artifacts` validate.

**Phase 1 status:** pre-installed but inactive. The kernel migration's `tasks.workflow_template_id` + `current_step_key` columns hold the binding; Phase 2 lands the loader that reads this file's `AGENT_ACTIONS_N` blocks into `board.db::board_templates`.

## Stages

### Stage 1 — Specify

<!-- AGENT_ACTIONS_1: {
  "step_key": "spec",
  "assignee_default": "pm",
  "skills": ["board-worker", "product-spec"],
  "workspace": "scratch",
  "required_artifacts": {
    "metadata.spec_doc_path": "\\.md$",
    "metadata.acceptance_criteria_count": "[1-9][0-9]*"
  },
  "on_success": "implement",
  "on_failure": "block",
  "max_runtime_seconds": 1800,
  "budget_usd_cap": 1.50
} -->

The PM (or PM-equivalent subagent) writes the spec: goal, approach, acceptance criteria, success metrics. Output is a markdown file. The dispatcher checks the file path matches `.md$` and the acceptance_criteria_count is ≥1 before advancing.

### Stage 2 — Implement

<!-- AGENT_ACTIONS_2: {
  "step_key": "implement",
  "assignee_default": "engineer",
  "skills": ["board-worker", "engineer-typescript", "engineer-rust"],
  "workspace": "worktree",
  "required_artifacts": {
    "metadata.pr_url": "^https://github\\.com/",
    "metadata.tests_run": "[1-9][0-9]*",
    "metadata.changed_files_count": "[1-9][0-9]*"
  },
  "on_success": "review",
  "on_failure": "implement",
  "max_runtime_seconds": 7200,
  "max_retries": 2,
  "budget_usd_cap": 8.00
} -->

The engineer (or engineer-equivalent subagent) writes the code in a git worktree, runs tests, opens a PR. Required artifacts: `metadata.pr_url` matching GitHub, `tests_run ≥ 1`, `changed_files_count ≥ 1`. On failure, retries once (back to implement); on second failure, falls to `block` for human review.

### Stage 3 — Review

<!-- AGENT_ACTIONS_3: {
  "step_key": "review",
  "assignee_default": "reviewer",
  "skills": ["board-worker", "security-pr-audit", "github-code-review"],
  "workspace": "scratch",
  "required_artifacts": {
    "metadata.approved": "true",
    "metadata.security_audit_passed": "true"
  },
  "on_success": "deploy",
  "on_failure": "implement",
  "max_runtime_seconds": 3600,
  "budget_usd_cap": 2.00,
  "requires_approval_on": ["running→done"]
} -->

The reviewer (or reviewer-equivalent subagent) does the editorial + security pass. Must explicitly set `metadata.approved=true` AND `metadata.security_audit_passed=true`. Approval gate fires before `done` so a human signs off. On rejection, kicks back to `implement` (engineer iterates).

### Stage 4 — Deploy

<!-- AGENT_ACTIONS_4: {
  "step_key": "deploy",
  "assignee_default": "deployer",
  "skills": ["board-worker", "deploy-prod"],
  "workspace": "scratch",
  "required_artifacts": {
    "metadata.deploy_status": "^success$",
    "metadata.deploy_url": "^https?://"
  },
  "on_success": null,
  "on_failure": "block",
  "max_runtime_seconds": 1800,
  "budget_usd_cap": 1.00
} -->

The deployer ships it. Requires `deploy_status=success` AND a `deploy_url`. On failure, blocks for human investigation.

## Pipeline total budget cap (recommendation)

Sum of stage caps: ~$12.50 per feature run. The board enforces per-stage caps; cumulative spend across stages rolls up via `SUM(task_runs.usd_spent)` for the parent task.

## When to use this template vs not

✓ **Use it when** the work follows the standard ship-a-feature shape: discrete spec, code change, review, deploy.

✗ **Skip it when**:
- It's research-only (no code change → use `daily-research-brief` instead)
- It's a documentation-only change (no review needed → just create a task with assignee=writer)
- It's a hotfix (the pipeline is too slow for incidents → create direct + auto-approve)
