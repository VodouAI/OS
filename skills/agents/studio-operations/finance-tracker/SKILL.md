---
name: finance-tracker
description: Builds project budgets, tracks expenses against budget, forecasts costs, analyzes unit economics, and prepares financial summaries for stakeholders
version: 1.0.0
kind: subagent
required_tools: []
imported_from:
  source: hand-written
---

# Finance Tracker Agent

## Overview

This agent manages financial tracking for projects and products: building budgets, monitoring spend against plan, forecasting future costs, analyzing unit economics (CAC, LTV, margins), and preparing financial summaries. Use it when you need to plan a budget for a new project, understand your burn rate, evaluate whether your unit economics work, or prepare a financial update for stakeholders.

The agent works at the project and product level, not full company accounting. It produces the financial clarity teams need to make informed decisions about spending, pricing, and investment.

**STOPPING POINT 1**: What financial work do you need?

1. **Build a project budget** - Create a detailed budget for a new project or initiative
2. **Track expenses against budget** - Monitor actual spend vs plan and flag variances
3. **Forecast costs** - Project future expenses based on current trajectory and planned changes
4. **Analyze unit economics** - Calculate CAC, LTV, margins, and payback period
5. **Prepare a financial summary** - Package financial data for stakeholder review

---

## Workflow 1: Build a Project Budget

### Step 1: Identify all cost categories

```
PROJECT BUDGET: [project name]
Period: [start date] to [end date]
Budget owner: [person]
Approval required from: [person/role]

COST CATEGORIES:

1. PEOPLE (typically 60-80% of project cost)
   Role              | Headcount | Monthly cost | Duration | Total
   ------------------|-----------|-------------|----------|-------
   [Engineer]        | [n]       | [cost]      | [months] | [total]
   [Designer]        | [n]       | [cost]      | [months] | [total]
   [Product Manager] | [n]       | [cost]      | [months] | [total]
   [QA]              | [n]       | [cost]      | [months] | [total]
   [Contractor]      | [n]       | [cost]      | [months] | [total]
   Subtotal: [amount]

2. INFRASTRUCTURE
   Service           | Monthly cost | Duration | Total
   ------------------|-------------|----------|-------
   [Cloud hosting]   | [cost]      | [months] | [total]
   [Database]        | [cost]      | [months] | [total]
   [CDN]             | [cost]      | [months] | [total]
   [Monitoring]      | [cost]      | [months] | [total]
   Subtotal: [amount]

3. SOFTWARE & TOOLS
   Tool              | Monthly cost | Duration | Total
   ------------------|-------------|----------|-------
   [Analytics tool]  | [cost]      | [months] | [total]
   [Design tool]     | [cost]      | [months] | [total]
   [Dev tools]       | [cost]      | [months] | [total]
   Subtotal: [amount]

4. THIRD-PARTY SERVICES
   Service           | Pricing model | Est. volume | Monthly cost | Total
   ------------------|--------------|-------------|-------------|-------
   [API provider]    | [per call]   | [volume]    | [cost]      | [total]
   [Payment proc.]   | [% of rev]  | [volume]    | [cost]      | [total]
   Subtotal: [amount]

5. OTHER
   Item              | Cost    | Notes
   ------------------|---------|------
   [Travel]          | [cost]  | [context]
   [Legal]           | [cost]  | [context]
   [Marketing]       | [cost]  | [context]
   Subtotal: [amount]

TOTAL BUDGET: [sum of all categories]
CONTINGENCY (10-15%): [amount]
TOTAL WITH CONTINGENCY: [final amount]
```

### Step 2: Phase the budget

Not all costs are uniform across the project timeline:

```
PHASED BUDGET:

Category    | Month 1 | Month 2 | Month 3 | Month 4 | Month 5 | Month 6 | Total
------------|---------|---------|---------|---------|---------|---------|------
People      | [cost]  | [cost]  | [cost]  | [cost]  | [cost]  | [cost]  | [total]
Infra       | [cost]  | [cost]  | [cost]  | [cost]  | [cost]  | [cost]  | [total]
Software    | [cost]  | [cost]  | [cost]  | [cost]  | [cost]  | [cost]  | [total]
3rd party   | [cost]  | [cost]  | [cost]  | [cost]  | [cost]  | [cost]  | [total]
Other       | [cost]  | [cost]  | [cost]  | [cost]  | [cost]  | [cost]  | [total]
------------|---------|---------|---------|---------|---------|---------|------
Monthly tot | [sum]   | [sum]   | [sum]   | [sum]   | [sum]   | [sum]   | [TOTAL]
Cumulative  | [cum]   | [cum]   | [cum]   | [cum]   | [cum]   | [cum]   |
```

Infrastructure costs often ramp: month 1 is dev environment, month 4+ is production scale. People costs may ramp if you are hiring during the project.

**STOPPING POINT 2**: Budget is drafted. What refinement is needed?

1. **Stress-test assumptions** - Challenge the estimates with best-case and worst-case scenarios
2. **Compare to similar projects** - Benchmark against previous project budgets
3. **Identify cost reduction opportunities** - Find places to reduce spend without impacting outcomes
4. **Get approval** - Format the budget for the approver with justification narrative
5. **Set up tracking** - Create the tracking system to monitor actual vs budget

---

## Workflow 2: Track Expenses Against Budget

### Monthly tracking template

```
BUDGET VARIANCE REPORT: [project name]
Month: [month/year]

Category       | Budget  | Actual  | Variance | Var %  | Status | Notes
---------------|---------|---------|----------|--------|--------|------
People         | [amt]   | [amt]   | [+/- $]  | [%]    | [flag] | [explanation]
Infrastructure | [amt]   | [amt]   | [+/- $]  | [%]    | [flag] | [explanation]
Software       | [amt]   | [amt]   | [+/- $]  | [%]    | [flag] | [explanation]
3rd party      | [amt]   | [amt]   | [+/- $]  | [%]    | [flag] | [explanation]
Other          | [amt]   | [amt]   | [+/- $]  | [%]    | [flag] | [explanation]
---------------|---------|---------|----------|--------|--------|
TOTAL          | [amt]   | [amt]   | [+/- $]  | [%]    | [flag] |

YTD CUMULATIVE:
Budget: [amount]
Actual: [amount]
Variance: [amount] ([%])
Remaining budget: [amount]
Months remaining: [number]
Required monthly run rate to stay on budget: [amount]
Current monthly run rate: [amount]
```

### Variance analysis rules

| Variance | Status | Action |
|----------|--------|--------|
| Within 5% | Green | No action needed |
| 5-15% over | Yellow | Investigate. Determine if one-time or recurring. Adjust forecast. |
| 15%+ over | Red | Escalate. Identify cause. Present options: cut elsewhere, request additional budget, reduce scope. |
| Under budget | Blue | Good news, but investigate -- is work delayed rather than saved? |

### Burn rate calculation

```
BURN RATE ANALYSIS:

Monthly burn rate (last 3 months avg): [amount]
Total budget remaining: [amount]
Months of budget remaining at current rate: [remaining / burn rate]
Project months remaining: [number]

Runway vs plan:
- If months remaining > project months remaining: On track or under budget
- If months remaining < project months remaining: Will exceed budget by approx [amount]
  Action needed: [reduce burn by $X/month OR request additional $Y]
```

---

## Workflow 3: Forecast Costs

### Forecasting method

```
COST FORECAST: [project name]
Forecast date: [today]
Forecast period: [start] to [end]

ASSUMPTIONS:
- Team size: [current headcount, planned changes]
- Infrastructure: [current usage trends, planned scaling events]
- Third-party: [volume projections]
- One-time costs: [any known upcoming expenses]

FORECAST SCENARIOS:

                  | Optimistic | Base case | Pessimistic
People            | [amt]      | [amt]     | [amt]
Infrastructure    | [amt]      | [amt]     | [amt]
Third-party       | [amt]      | [amt]     | [amt]
Other             | [amt]      | [amt]     | [amt]
TOTAL             | [amt]      | [amt]     | [amt]

OPTIMISTIC assumptions: [what would make costs lower -- e.g., ship early, lower infra usage]
PESSIMISTIC assumptions: [what would make costs higher -- e.g., scope expansion, hiring delay, scaling issues]
```

### Cost drivers to track

Identify the 2-3 cost drivers that matter most and track them closely:

```
COST DRIVER TRACKING:

Driver               | Current  | Trend     | Impact on monthly cost | Watch for
---------------------|----------|-----------|------------------------|----------
[Team size]          | [N ppl]  | [stable]  | +$[X]K per person      | Hiring timeline
[Server instances]   | [N]      | [growing] | +$[X] per instance     | Traffic growth
[API call volume]    | [N/mo]   | [growing] | +$[X] per 1M calls     | Feature adoption rate
[Storage]            | [N TB]   | [growing] | +$[X] per TB           | User growth
```

**STOPPING POINT 3**: Forecast is prepared. What action is needed?

1. **Identify cost optimization opportunities** - Find places to reduce spend without impacting the project
2. **Model a specific scenario** - What happens to costs if we add 2 engineers? Double traffic? Launch in a new region?
3. **Update the budget** - Revise the budget based on forecast data
4. **Prepare a cost review presentation** - Package forecast for leadership discussion
5. **Set up cost alerts** - Define thresholds for automated warnings when costs exceed targets

---

## Workflow 4: Analyze Unit Economics

### Core unit economics framework

```
UNIT ECONOMICS ANALYSIS: [product/business]
Analysis date: [date]
Period: [time range for data]

CUSTOMER ACQUISITION COST (CAC):
Total sales & marketing spend: [amount]
New customers acquired: [number]
CAC = Spend / New customers = [amount]

Break down by channel:
Channel           | Spend    | Customers | CAC     | % of total customers
------------------|----------|-----------|---------|---------------------
[Organic]         | [amt]    | [n]       | [cac]   | [%]
[Paid search]     | [amt]    | [n]       | [cac]   | [%]
[Content]         | [amt]    | [n]       | [cac]   | [%]
[Referral]        | [amt]    | [n]       | [cac]   | [%]
[Sales]           | [amt]    | [n]       | [cac]   | [%]

LIFETIME VALUE (LTV):
Average revenue per user per month (ARPU): [amount]
Gross margin: [%]
Monthly churn rate: [%]
Average customer lifetime: 1 / churn rate = [months]
LTV = ARPU x Gross margin x Lifetime = [amount]

LTV:CAC RATIO: [LTV / CAC] = [ratio]
Target: > 3:1 for healthy SaaS business
Current status: [healthy / needs improvement / unsustainable]

CAC PAYBACK PERIOD:
CAC / (ARPU x Gross margin) = [months]
Target: < 12 months for SaaS
Current status: [healthy / needs improvement / unsustainable]
```

### Margin analysis

```
MARGIN ANALYSIS:

Revenue breakdown:
- Gross revenue: [amount]
- Discounts/credits: [amount]
- Net revenue: [amount]

Cost of goods sold (COGS):
- Hosting/infrastructure: [amount]
- Third-party services (per-user costs): [amount]
- Support (per-user costs): [amount]
- Payment processing: [amount]
- Total COGS: [amount]

Gross margin: (Net revenue - COGS) / Net revenue = [%]
Target: > 70% for software, > 50% for services

Contribution margin (per customer per month):
ARPU - (COGS per customer) = [amount]
```

### Unit economics health check

| Metric | Healthy | Warning | Critical |
|--------|---------|---------|----------|
| LTV:CAC | > 3:1 | 1:1 to 3:1 | < 1:1 |
| CAC Payback | < 12 months | 12-18 months | > 18 months |
| Gross Margin | > 70% | 50-70% | < 50% |
| Net Revenue Retention | > 100% | 90-100% | < 90% |
| Monthly Churn | < 3% | 3-7% | > 7% |

**STOPPING POINT 4**: Unit economics analysis is complete. What next?

1. **Improve CAC** - Identify strategies to reduce customer acquisition cost by channel
2. **Improve LTV** - Identify strategies to increase lifetime value (reduce churn, increase ARPU)
3. **Optimize margins** - Find cost reduction opportunities in COGS
4. **Model pricing changes** - Simulate how pricing changes would affect unit economics
5. **Build into the financial summary** - Include unit economics in the stakeholder report

---

## Workflow 5: Prepare a Financial Summary

### Financial summary template

```
FINANCIAL SUMMARY: [project/product name]
Period: [date range]
Prepared: [date]

EXECUTIVE OVERVIEW
[2-3 sentences: Are we on track financially? What is the most important financial development?]

BUDGET PERFORMANCE
Total budget: [amount]
Spent to date: [amount] ([%] of budget)
Remaining: [amount]
Burn rate: [amount/month]
Budget status: [on track / at risk / over budget]

REVENUE (if applicable)
MRR/ARR: [amount]
Growth: [% month-over-month or year-over-year]
Revenue vs forecast: [amount vs plan]

UNIT ECONOMICS SNAPSHOT
CAC: [amount] ([trend: improving / stable / worsening])
LTV: [amount] ([trend])
LTV:CAC: [ratio]
Gross margin: [%]
CAC payback: [months]

KEY FINANCIAL RISKS
1. [Risk]: [potential impact] - [mitigation]
2. [Risk]: [potential impact] - [mitigation]

UPCOMING FINANCIAL EVENTS
- [Date]: [event, e.g., contract renewal, hiring, infrastructure scaling]
- [Date]: [event]

RECOMMENDATIONS
1. [Action] - Expected impact: [amount or outcome]
2. [Action] - Expected impact: [amount or outcome]
```

### Presentation tips for financial data

- **Always show trend, not just snapshot.** A $50K monthly burn means different things if it was $40K last month vs $60K.
- **Use simple visuals.** A budget vs actual bar chart communicates faster than a table.
- **Context over precision.** Round to the nearest thousand. "$47K" is better than "$47,283.51" in a summary.
- **Flag the asks.** If you need budget approval, additional resources, or a pricing change, make it explicit. Do not bury requests in data.
- **Separate confirmed from projected.** Make it clear which numbers are actual and which are forecasts. Use different colors or clearly label them.
