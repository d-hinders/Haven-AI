# GTM — activation & metrics

How we measure whether the GTM motion in [`README.md`](./README.md) is working. Grounded in
the funnel already instrumented in the backend, so these definitions map to data we can
query today rather than aspirational events.

## North-star

**Recurring machine spend volume under guardrails** — total value of agent/automation
payments that execute *within on-chain budgets users set*, measured over a rolling window.
It captures the whole thesis in one number: real spend, by real agents, inside real limits.
Growth comes from more activated accounts × more agents per account × more recurring spend
per agent.

## Activation

**Activation = an account's first autonomous agent payment that settles within a budget.**

This maps directly to the `first_payment_settled` event in the onboarding funnel (see
[`packages/backend/src/lib/onboarding-funnel.ts`](../../packages/backend/src/lib/onboarding-funnel.ts)).
It's the moment the product proves itself: an agent paid for something on its own, and the
guardrail held. Both the self-serve and design-partner motions share this single activation
definition.

## The funnel we instrument

The backend already emits these onboarding events (`FunnelEvent` in
[`onboarding-funnel.ts`](../../packages/backend/src/lib/onboarding-funnel.ts)), in order:

| Step | Event | What it means |
|---|---|---|
| 1 | `signed_up` | Account created |
| 2 | `safe_deployed` / `safe_imported` | Haven wallet set up (new or imported) |
| 3 | `agent_created` | An agent exists |
| 4 | `allowance_granted` | A budget is set on-chain for that agent |
| 5 | `safe_funded` | The wallet has funds the agent can spend |
| 6 | `first_payment_settled` | **Activation** — first autonomous payment within budget |

`queryFunnel()` already returns per-step user counts and **median TTFP** (time-to-first-
payment: median interval from `signed_up` to `first_payment_settled`). Theme B funnel
instrumentation: [#354](https://github.com/d-hinders/Haven-AI/issues/354).

### Time-to-first-payment (TTFP) — the activation speed metric

TTFP is the headline funnel metric for both motions: how fast does a new account get an
agent paying autonomously? Shorten it by removing friction at the worst-converting step
(read the step-to-step conversion from `queryFunnel`, fix where users drop). For the
self-serve motion the path to watch is `connect → first payment → recurring`, anchored on
`npx @haven_ai/connect` and hosted MCP (see [`README.md`](./README.md#two-sided-motion)).

## Add-on attach

**Bookkeeping-feed attach rate** = share of activated accounts that have connected the
accounting-data feed (Fortnox/SIE), once it ships (epic
[#491](https://github.com/d-hinders/Haven-AI/issues/491)). It's the leading indicator for
the second revenue hook and for stickiness with finance-led buyers. Frame attach reporting
as "spend appears in the bookkeeping tool" — never "audit-ready" (per
[#501](https://github.com/d-hinders/Haven-AI/issues/501)).

## Design-partner motion metrics

Outbound is measured separately from product activation, but converges on the same
activation event:

- **Qualified accounts** — passed the three qualifying signals and the payout/PSP screen-out
  (see [`outreach-playbook.md`](./outreach-playbook.md)).
- **Design partners live** — named accounts whose agents have reached `first_payment_settled`
  with real (non-demo) budget. This is the headline outbound goal for the Sweden beachhead.
- **Reference logos** — design partners willing to be named (e.g. Tier A volume accounts).

## What "working" looks like for the Sweden beachhead

Before expanding beyond Sweden (see [`README.md`](./README.md#why-sweden-first)), we want:

1. A handful of **design partners live** with recurring machine spend under guardrails.
2. A **repeatable self-serve activation** — TTFP trending down, not one-off hand-holding.
3. Early **bookkeeping-feed attach** among finance-led accounts, validating the local moat.

Only then does Nordics/EU expansion earn priority over deepening the beachhead.
