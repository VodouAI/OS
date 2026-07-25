# Contributing to Vodou

Thanks for wanting to help. This repo (`VodouAI/OS`) is the **open,
Apache-2.0-licensed client surface** of Vodou. A quick, honest map so your time
goes where it counts.

## What this repo is (and isn't)

Vodou is **open-core** — and the line is simple: **everything except the engine is open.**

- ✅ **Open (this repo, Apache-2.0):** the entire client + orchestration stack — the
  gateway, all first-party MCP servers, the browser extension, the skill format,
  installers, and docs. All of it is fair game for contributions. Preserve the
  `NOTICE` file on redistribution.
- 🔒 **Proprietary (not here):** the Vodou **engine** — its Rust source (`src/**`,
  `Cargo.*`) **and** its compiled binaries (`vodou-core`, `vodou-hook-bin`). The
  engine ships as a signed binary from [`VodouAI/vodou-core`](https://github.com/VodouAI/vodou-core)
  under its EULA. Its source isn't public, so **PRs to the engine aren't possible** —
  everything else is.

If you're unsure whether something is contributable, open an issue and ask first.

## Good places to contribute

- Browser-capture adapters for new AI surfaces
- Client / extension fixes and UX
- New or improved **skills**
- Docs, examples, quickstart improvements
- Bug reports with clear repro (see the issue templates)

Have a look at issues labeled **`good first issue`** to start.

## Development setup

```bash
git clone https://github.com/VodouAI/OS
cd OS
# follow the README quickstart — the installer fetches the engine binary
./install-vodou.sh        # or the platform installer
```

Run the relevant tests before opening a PR (each component documents its own).

## Pull requests

1. Fork, branch, make focused changes (one concern per PR).
2. Keep the diff minimal — match the surrounding code's style.
3. Update docs if you change behavior.
4. **Sign the CLA** — see below (required once per contributor).
5. Open the PR; fill in the template.

We aim to review within a few working days.

## Contributor License Agreement (CLA)

We use a **lightweight CLA** (not DCO). It lets you keep ownership of your work
while granting Vodou the rights needed to use, distribute, and — if needed later —
relicense the open surface. Full text: [CLA.md](CLA.md) (individuals) ·
[CLA-CORPORATE.md](CLA-CORPORATE.md) (companies).

**How to sign:** on your first PR, the CLA Assistant bot will comment. Reply with:

```text
I have read the CLA Document and I hereby sign the CLA
```

Entity-owned contributions: email **legal@vodou.ai** before merging (Corporate CLA).

## Code of Conduct

By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please **do not** file security issues publicly — see [SECURITY.md](SECURITY.md) for private
disclosure.
