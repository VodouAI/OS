---
name: pr-review-pipeline
description: workflow template — automated pull request review with security audit + style check + summary; pre-installed, activates in Phase 2
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "apply pr-review-pipeline template"
  - "/board apply-template pr-review-pipeline"
stopping_points: none
actions: inline
metadata:
  vodou:
    persona_role: pull request review pipeline
    template_kind: pr_review
    phase_active: 2
---

# pr-review-pipeline

A 3-stage automated PR review: security audit, style/linting pass, then human-readable summary. Useful for open-source maintainers, ExecDesk CTO reviews, or compliance trails.

**Phase 1 status:** pre-installed but inactive.

## Inputs

Tasks bound to this template must have `metadata.pr_url` set at creation (e.g. via webhook from GitHub's `pull_request.opened` event, or manually via `./do board create … --metadata '{"pr_url": "https://github.com/...PR/123"}'`).

## Stages

### Stage 1 — Security audit

<!-- AGENT_ACTIONS_1: {
  "step_key": "security_audit",
  "assignee_default": "security-reviewer",
  "skills": ["board-worker", "security-pr-audit", "github-code-review"],
  "workspace": "scratch",
  "required_artifacts": {
    "metadata.security_findings_count": "^[0-9]+$",
    "metadata.security_blocking": "^(true|false)$"
  },
  "on_success": "style_check",
  "on_failure": "security_audit",
  "max_runtime_seconds": 1800,
  "max_retries": 1,
  "budget_usd_cap": 2.50
} -->

Pull the PR diff, scan for: secrets in code (API keys, tokens, .env contents), unsafe SQL, command injection, auth bypass, XSS surface, dependency CVEs. Output: a structured finding list with severity. Sets `metadata.security_blocking=true` if any high-severity finding requires resolution before merge.

### Stage 2 — Style check

<!-- AGENT_ACTIONS_2: {
  "step_key": "style_check",
  "assignee_default": "engineer",
  "skills": ["board-worker", "lint-runner"],
  "workspace": "worktree",
  "required_artifacts": {
    "metadata.lint_errors": "^[0-9]+$",
    "metadata.format_diff_lines": "^[0-9]+$",
    "metadata.tests_run": "^[0-9]+$"
  },
  "on_success": "summary",
  "on_failure": "style_check",
  "max_runtime_seconds": 1200,
  "max_retries": 1,
  "budget_usd_cap": 1.00
} -->

Run the repo's linter + formatter + test suite. Capture counts and diffs. No human judgment yet; just structured signals.

### Stage 3 — Human-readable summary

<!-- AGENT_ACTIONS_3: {
  "step_key": "summary",
  "assignee_default": "reviewer",
  "skills": ["board-worker", "pr-summary-writer"],
  "workspace": "scratch",
  "required_artifacts": {
    "metadata.summary_posted_to_pr": "^true$",
    "metadata.recommendation": "^(approve|request_changes|comment)$"
  },
  "on_success": null,
  "on_failure": "summary",
  "max_runtime_seconds": 900,
  "budget_usd_cap": 1.50,
  "requires_approval_on": ["running→done"]
} -->

The reviewer reads the previous two stages' output and writes a structured PR comment with: TL;DR, security findings, style findings, test coverage delta, and a final recommendation (approve / request_changes / comment). Posts the comment back to the PR. Approval gate before `done` so a human signs off on the recommendation before it goes live.

## Total budget cap

~$5 per PR. Tunable per-repo via task budgets.

## When to use vs not

✓ **Use it when** you maintain a repo with frequent contributions, want consistent review quality, and trust the security-reviewer's track record.

✗ **Skip it when**:
- Solo dev on personal projects (overhead > value)
- The PR is from a long-trusted maintainer (manual review is fine + faster)
- The repo has special context the pipeline doesn't know (use `ship-a-feature` for those)

## Auto-trigger (Phase 2+)

Wire to `Vodou-channels` webhook for `pull_request.opened` events. The webhook handler creates the task with `metadata.pr_url` set + `workflow_template_id="pr-review-pipeline"`. The board takes over from there.
