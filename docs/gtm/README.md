# GTM — strategy backbone

The spine for how Haven goes to market. Start here, then use the companion docs:

- [`sweden-target-list.md`](./sweden-target-list.md) — the design-partner target list.
- [`outreach-playbook.md`](./outreach-playbook.md) — qualification, messaging, demo, objections.
- [`metrics.md`](./metrics.md) — activation, north-star, and the funnel we instrument against.

All GTM copy must stay inside [`docs/regulatory/casp-risk-guardrails.md`](../regulatory/casp-risk-guardrails.md)
and [`docs/product/copy-guidelines.md`](../product/copy-guidelines.md). The short version
lives in **Positioning guardrails** at the bottom of this doc — read it before writing
any outbound copy.

## One-liner

**A budgeted wallet for machine spend — the API calls, data, compute, and traffic your
agents and automations already pay for, today stuck on shared cards and shared API keys.**

Give each agent or automation its own budget with on-chain guardrails, and let its spend
appear in your bookkeeping tool automatically. You keep custody the whole time — Haven is
non-custodial software, never a payment processor and never the party that holds your funds.

## The problem we wedge into

Companies already pay programmatically for services — per-call APIs, data, compute, ad
spend, SMS, infra. Today that spend runs on **shared corporate cards or shared API keys
with no per-system budget**. When an agent or script overspends, loops, or is compromised,
there is no native limit and no clean per-system record. Finance can't tell which
automation spent what.

Haven's wedge: give each agent/automation a **budgeted wallet with on-chain limits**
(amount + reset period per token, enforced on-chain, not just in a database), and a
**non-asserting feed** so that spend appears in the company's bookkeeping tool.

## ICP & wedge

**ICP:** a Swedish company that already pays programmatically/recurringly for services
today on shared cards or API keys, and would benefit from a per-agent budget with on-chain
guardrails plus automatic bookkeeping. (Full qualifying signals and the target list live in
[`sweden-target-list.md`](./sweden-target-list.md).)

**Wedge — lead with companies whose agents already spend.** Tier A (AI agent-builders
whose agents provision/call paid APIs and infra) is the sharpest entry point: the money is
already in their core loop, so the budgeted wallet is an immediate fit rather than a
behavior change. Tier B (payments/crypto-native) is the lowest-friction technical buy-in.
C–F broaden the wedge beyond AI to any programmatic-spend tech.

## Why Sweden first

This is a deliberate beachhead, not a limitation.

- **The bookkeeping feed is a local moat.** The hosted accounting-data add-on targets
  **Fortnox / SIE** (epic [#491](https://github.com/d-hinders/Haven-AI/issues/491)) — the
  dominant Swedish bookkeeping stack. Agent spend that lands in the tool a Swedish finance
  team already uses is a wedge a global competitor doesn't have locally.
- **Density of fit.** Sweden has an unusually high concentration of AI agent-builders,
  payments/crypto-native companies, and programmatic-spend tech (see the target list) —
  enough qualified accounts to run a focused design-partner motion without spreading thin.
- **Founder reach.** Warm intros and a tight ecosystem make founder-led sales tractable here.

Nordics/EU is a **later phase**. Don't expand the target list or messaging beyond Sweden
until the beachhead has reference customers and a repeatable activation funnel
(see [`metrics.md`](./metrics.md)).

## Two-sided motion

Run both motions in parallel — they feed each other.

### A. Design-partner sales (outbound)
Founder-led outbound against [`sweden-target-list.md`](./sweden-target-list.md). Goal:
a handful of named design partners whose agents/automations spend real budget through
Haven, producing reference logos and product feedback. Sequencing Tier A → B → C–F.
Use [`outreach-playbook.md`](./outreach-playbook.md) for qualification and messaging.

### B. Developer self-serve (bottoms-up)
Haven is already self-serve-ready for developers:

- **`npx @haven_ai/connect`** — the connector the dashboard hands out to wire an agent in.
- **Hosted MCP quickstart** — keyless hosted MCP + local signer; an agent any runtime can
  discover and invoke without managing keys (see [`docs/operations/hosted-mcp.md`](../operations/hosted-mcp.md)).
- **x402 Bazaar listing** — discoverability for agents finding paid resources
  ([#473](https://github.com/d-hinders/Haven-AI/issues/473)).

A developer can connect an agent and reach a first autonomous payment without talking to
sales. Self-serve activations surface the design partners worth a founder conversation;
design-partner deployments harden the self-serve path and docs. The shared activation
metric across both is **time-to-first-payment** (see [`metrics.md`](./metrics.md)).

## Revenue map — ICP → hook → revenue

Three hooks, sequenced by what each segment values first.

| Hook | What it is | Leads for | Status |
|---|---|---|---|
| **Budgeted machine-spend wallet** | Per-agent on-chain budget + guardrails; the core value | Everyone — always the opening | Live |
| **Bookkeeping feed (add-on)** | Hosted, non-asserting feed; agent spend appears in Fortnox/SIE | Finance-led buyers (Tier A finance agents, E fintech, F ops) | In build — epic [#491](https://github.com/d-hinders/Haven-AI/issues/491) |
| **Per-transaction fee module** | Rail-agnostic fee across x402/MPP and future rails | Monetizes high-volume machine spend (Tier A high-volume, C, D) | [#386](https://github.com/d-hinders/Haven-AI/issues/386) |

**Leading hook by tier:**
- **Tier A (agent-builders):** lead with the budgeted wallet (money in their core loop);
  attach the bookkeeping feed for finance-flavored agents (e.g. AR/collections).
- **Tier B (payments/crypto-native):** lead with on-chain caps for stablecoin machine
  spend — fastest technical buy-in.
- **Tier C–D (programmatic-spend tech, iGaming):** lead with "swap shared cards for a
  per-automation budget," with the feed as the second hook; high volume makes the fee
  module relevant.
- **Tier E–F (fintech/spend-mgmt, ops automation):** lead with spend control + the
  bookkeeping feed together; finance teams value both.

## Regulatory positioning as a sales asset

Haven's non-custodial design is a **competitive advantage**, not just a compliance
constraint. Against custodial agent-wallets, the talking points are:

- **You keep custody.** Funds stay in your own wallet; Haven never holds them and can't
  move them outside the limits you approve.
- **We don't become a CASP or PSP.** Haven is smart-account software — it configures,
  validates, and relays payments, but isn't a custodian, exchange, broker, or payment
  processor. (See [`docs/regulatory/casp-risk-guardrails.md`](../regulatory/casp-risk-guardrails.md).)
- **On-chain limits, not a database promise.** Budgets are enforced on-chain; even a fully
  compromised Haven can't spend beyond what you approved.
- **No lock-in.** You can reach and revoke your wallet through any compatible UI.

This is also a **qualification line, not just a pitch**: companies whose actual need is to
**pay out to third parties / disburse on others' behalf** (marketplace payouts, PSP flows)
are transfer-service / CASP territory and are **out of scope** — see the "Do NOT target"
section in [`sweden-target-list.md`](./sweden-target-list.md) and the screen-out question
in [`outreach-playbook.md`](./outreach-playbook.md).

## Positioning guardrails (read before writing copy)

Every GTM surface — emails, decks, landing copy, demo scripts — must pass these:

- **Non-custodial language only.** Haven *helps configure / relays / records* payments
  within user-approved on-chain limits. Never "Haven holds / manages / transfers / pays."
- **The bookkeeping feed "appears in your bookkeeping tool" — never "audit-ready" or
  "your books are done."** It is a non-asserting feed, not an assurance or accounting
  service (per [#501](https://github.com/d-hinders/Haven-AI/issues/501)).
- **No claims of:** custody, payment processing, merchant settlement/acquiring, fiat/card
  rails, swaps/ramps, yield, treasury management, or financial advice.
- **Keep the "do-not-target" line.** Payout/PSP/disbursement-on-others'-behalf use cases
  are out of scope.
- Follow the do/don't word lists in [`docs/product/copy-guidelines.md`](../product/copy-guidelines.md)
  (e.g. "Haven account," "Haven wallet," "agent rules," "agent budgets," "connect your
  agent"; avoid "Safe," "relayer," "signer," "policy engine," "allowance module" in
  primary external copy).
