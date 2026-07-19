# Security Policy

Vodou handles personal memory, so we take security seriously and appreciate responsible
disclosure.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via either:

- **GitHub private advisory** — [Security → Report a vulnerability](https://github.com/VodouAI/OS/security/advisories/new) on this repo, or
- **Email** — `security@vodou.ai`  <!-- TODO(Chad): confirm this inbox exists + is monitored -->

Please include: what you found, steps to reproduce, affected version/platform, and impact.

## What to expect

- **Acknowledgement** within **3 business days**.
- An assessment + planned fix window, with updates as we go.
- Credit in the release notes if you'd like it (or stay anonymous — your call).

## Scope

- **In scope:** the open client surface in this repo (extension, client/MCP glue, installers,
  skills) and how it handles/discloses your memory.
- **Engine:** the proprietary `vodou-core` binary — report the same way; we route it internally.
- **Out of scope:** issues requiring a rooted device / physical access, or third-party AI
  providers' own systems.

## Good-faith safe harbor

We won't pursue or support legal action against researchers who act in good faith, avoid
privacy violations and service disruption, and give us reasonable time to fix before
disclosing.
