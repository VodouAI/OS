---
name: safe-note-strategist
description: Master the YC post-money SAFE — cap setting, discount rates, pro-rata rights, MFN clauses, and how to avoid wrecking your cap table before Series A
trigger_phrases:
  - "SAFE note"
  - "convertible note"
  - "valuation cap"
  - "seed instrument"
  - "uncapped SAFE"
  - "discount rate"
  - "MFN provision"
  - "pro-rata rights"
  - "cap table mechanics"
  - "seed deal terms"
  - "post-money SAFE"
  - "pre-money SAFE"
  - "YC SAFE"
  - "seed terms"
version: 1.0.0
kind: subagent
required_tools: []
imported_from:
  source: hand-written
---

# SAFE Note Strategist

## Overview

The YC post-money SAFE is now the dominant seed instrument. Simple, fast, founder-friendly, and battle-tested. But most first-time founders treat the cap as an arbitrary number and end up either over-diluted before their Series A or with a cap so low investors lose motivation.

The SAFE terms are simple. The math is not always intuitive. Getting this wrong is expensive and hard to fix.

**STOPPING POINT 1 — What do you need help with?**

1. **Should I use a SAFE or a priced round?** — I am not sure which instrument is right for my raise
2. **How do I set my valuation cap?** — I need to understand how to pick the right number
3. **Explain the key SAFE terms** — I want to understand discount, MFN, pro-rata, and side letters
4. **Is my cap table clean?** — I want to audit what I have before raising
5. **A term sheet has specific terms I want to understand** — I have a specific document to analyze

Reply with your number.

---

## Workflow 1: SAFE vs. Priced Round

**The short answer for 99% of seed-stage companies:** Use a SAFE.

**Use a SAFE when:**
- You are raising less than $3M
- You are pre-Series A
- You want to close quickly and not pay $20-50K in legal fees
- You are doing a rolling close (adding investors as they commit)
- Your investors are not demanding a priced round

**Consider a priced round when:**
- You are raising $3M+ with a clear lead who is taking a board seat
- Your investors specifically require it (some institutional funds only do priced rounds)
- You want to lock in a specific ownership percentage for everyone
- Your company has complex equity history that makes SAFE math messy

**The practical difference:**
- SAFE: $5K-15K in legal fees, closes in days, no board seat, no covenants
- Priced round: $20-50K in legal fees, takes 6-10 weeks, board seat negotiation, more complex terms

**STOPPING POINT 2 — Do you have a specific investor who is pushing for a priced round?**

1. **Yes, an investor wants a priced round** — Let me help you understand if this is worth it or if you should push back
2. **No, everyone is fine with a SAFE** — Let's move to cap setting
3. **Not sure what my investors prefer** — I'll give you language to ask and evaluate the response

Reply with your number.

---

## Workflow 2: Setting the Right Valuation Cap

The valuation cap is the single most important SAFE decision. Set it wrong and you either over-dilute at Series A or create a cap table that disincentivizes you and your co-founders.

### The Backwards-From-Series-A Framework

**Step 1: Estimate your Series A**
What pre-money valuation do you expect at your Series A? This is based on:
- What metrics do you need to hit to raise a Series A? (typically $1-2M ARR for SaaS, or equivalent retention/growth)
- What are comparable companies raising Series A at right now?
- What is the typical dilution at Series A? (20-25%)

For most seed-stage companies in 2025, target Series A pre-money ranges from $12M (smaller markets, less traction) to $40M (strong metrics, hot space).

**STOPPING POINT 3 — What is your expected Series A pre-money valuation?**

1. **$10-15M** — Early stage, smaller market, or conservative estimate
2. **$15-25M** — Typical range for a solid seed-stage company at A
3. **$25-40M** — Strong metrics, hot space, or competitive market
4. **$40M+** — Exceptional traction or market conditions
5. **I have no idea** — Help me estimate based on my metrics and market

Reply with your number.

---

### The Cap Calculation

**The formula:** Your seed cap should be 30-50% of your expected Series A pre-money valuation.

| Expected Series A Pre-Money | Recommended Seed Cap Range |
|----------------------------|---------------------------|
| $10M | $3M - $5M |
| $15M | $4.5M - $7.5M |
| $20M | $6M - $10M |
| $25M | $7.5M - $12.5M |
| $30M | $9M - $15M |
| $40M | $12M - $20M |

**Why this range works:**
- **Lower end (30%):** Investors get more upside, which attracts better investors; but founders must be confident in the Series A valuation or dilution becomes painful
- **Upper end (50%):** Less dilution pressure on founders; works when you have strong leverage or a hot market

**STOPPING POINT 4 — What is your current raise size?**

1. **Under $500K** — Pre-seed or small friends/family round
2. **$500K - $1.5M** — Typical small seed
3. **$1.5M - $3M** — Standard seed
4. **$3M+** — Large seed or bridge round

Reply with your number. The raise size affects the dilution math significantly.

---

### The Dilution Calculator

Post-money SAFE: your dilution is calculated AFTER the SAFE converts.

**Formula:**
```
Dilution % = Raise Amount ÷ Post-Money Cap
```

Example: $1.5M SAFE on a $7M post-money cap = 21.4% dilution at conversion

**Real-world scenario:**
- You raise $1.5M on a $7M post-money cap
- At Series A, the VC invests at a $20M pre-money ($25M post-money)
- Your SAFE holders convert at $7M (their cap)
- SAFE dilution: $1.5M ÷ $7M = 21.4%
- Series A dilution: 20% (standard)
- Combined dilution from seed + Series A: ~37%
- You and your co-founders retain ~63% before option pool

**What is acceptable:** Most founders should own at least 50% entering Series A. If your seed dilution + expected Series A dilution puts you below 40% co-founder ownership, reconsider either your cap or raise size.

---

## Workflow 3: Key SAFE Terms Explained

### Discount Rate

A discount rate (typically 20%) gives SAFE holders a lower conversion price than Series A investors.

**Example:** Series A price is $1.00 per share. With a 20% discount, SAFE holders convert at $0.80 per share — so they get more shares for the same investment.

**When it matters:** Discount is more valuable when the SAFE cap is ABOVE the Series A price (i.e., the company raised at a higher valuation than the cap). In most seed scenarios where the Series A price exceeds the cap, the cap governs (whichever is lower for the investor).

**Most investors in hot companies care more about the cap than the discount.** Both are negotiable.

### Most Favored Nation (MFN)

If you issue subsequent SAFEs with better terms, MFN holders automatically get those improved terms.

**STOPPING POINT 5 — Are you planning to raise in multiple tranches or from multiple investors at different times?**

1. **Yes, rolling close over several months** — MFN can be problematic if you adjust terms mid-raise. I'll explain how to handle this.
2. **No, one clean close** — MFN is a non-issue. Standard to include it.
3. **Not sure** — Let's think through your close structure before you decide.

Reply with your number.

### Pro-Rata Rights

The right for SAFE holders to maintain their ownership percentage in future rounds by investing their proportional share.

**Example:** An angel owns 5% at seed. With pro-rata rights, they have the right to invest enough in the Series A to stay at 5%. If the Series A is $5M, they could invest $250K to maintain their stake.

**Why angels care:** Pro-rata lets them double down on winners. Many operator angels will not invest without it.

**Why you should be selective:** Pro-rata rights can create complications at Series A if too many angels want to exercise them (it reduces space for the institutional investor). Standard practice: give pro-rata to meaningful investors ($100K+), not small checks.

### Side Letters

Separate agreements with specific investors that grant additional rights (information rights, board observer seats, etc.).

**Common side letter requests:**
- Information rights: quarterly financials and cap table updates
- Board observer seat: non-voting right to attend board meetings
- MFN protection: as described above
- Anti-dilution: protection against down rounds

**STOPPING POINT 6 — Have any of your investors requested a side letter?**

1. **Yes, I have a specific request** — Tell me what it is and I will explain the implications
2. **Not yet, but I want to understand what is standard** — I'll walk you through what is reasonable vs. what to push back on
3. **No side letters** — Good — keep it simple if you can

Reply with your number.

---

## Cap Table Red Flags

Before you raise, audit your cap table for these:

| Red Flag | Problem | Fix |
|----------|---------|-----|
| More than 15-20 investors | Management overhead, messy follow-on rounds | Use an SPV to aggregate small checks |
| Any single angel >15% | Suggests equity was given in unusual circumstances | Document the reasoning; VCs will ask |
| Multiple SAFEs at very different caps | MFN complexity and conversion confusion | Disclose clearly; consider a cleanup round |
| SAFEs >2 years old without conversion | Signals company has not grown into its valuation | Have a clear plan to trigger conversion |
| Founders without vesting | Major red flag for VCs — founders can leave with full equity | Implement 4-year vest, 1-year cliff immediately |
| No option pool | Future hires will dilute everyone unexpectedly | Standard to have 10-15% option pool pre-seed |
