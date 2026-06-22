# GTM — outreach playbook

Operational messaging for the design-partner motion in [`README.md`](./README.md).
All copy here must pass the **Positioning guardrails** in
[`README.md`](./README.md#positioning-guardrails-read-before-writing-copy) and
[`docs/product/copy-guidelines.md`](../product/copy-guidelines.md).

## Qualification — the first call

Built on the three qualifying signals in [`sweden-target-list.md`](./sweden-target-list.md).
Sort prospects on these; a "yes" on all three is a strong fit.

1. **Do you pay programmatically for services today?** (per-call APIs, data, compute,
   traffic, SMS, infra) → yes = fit.
2. **Is that spend on shared cards / shared API keys with no per-system budget?** → that's
   the pain Haven removes.
3. **Do you use Fortnox / SIE bookkeeping and want that spend to show up there
   automatically?** → the reporting add-on hook.

Good discovery questions:
- "When an agent or script overspends or loops, what stops it today?"
- "If I asked which automation spent the most last month, how would you find out?"
- "Who owns reconciling that spend into the books — and how manual is it?"

### Screen-out (disqualification) — do this early

Operationalize the regulatory "do-not-target" line. **Ask directly:**

> "Is the money moving *your own* spend to *your own* suppliers and APIs — or are you
> trying to **pay out to third parties / disburse on someone else's behalf** (marketplace
> payouts, customer disbursements, PSP-style flows)?"

- **Own spend to own suppliers, within limits you set → in scope.** Haven is the company's
  own wallet paying its own APIs/suppliers within approved budgets.
- **Pay-out / disburse on others' behalf → out of scope.** That's transfer-service / CASP
  territory. Do not pitch Haven as the rail for it. See
  [`docs/regulatory/casp-risk-guardrails.md`](../regulatory/casp-risk-guardrails.md).

Also out of scope to pitch: swaps/ramps, fiat/card issuing, merchant acquiring/settlement,
yield, or treasury management.

## One-liner

> A budgeted wallet for machine spend — the APIs, data, and compute your agents already pay
> for, today stuck on shared cards. Each agent gets its own budget with on-chain limits, and
> the spend shows up in your bookkeeping tool. You keep custody the whole time.

## Cold email templates

Keep it short, name the pain, one clear ask. Swap the bracketed line per segment.

**Generic skeleton**

```text
Subject: per-agent budget for [Company]'s machine spend

Hi [Name],

[Segment-specific opener — what they pay for programmatically today.]

Most teams run that spend on shared cards or shared API keys with no per-system
budget — so when an automation overspends there's no native limit, and finance
can't tell which system spent what.

Haven gives each agent or automation its own budget with on-chain limits, and the
spend appears in your bookkeeping tool automatically. You keep custody throughout —
Haven is non-custodial software, not a payment processor.

Worth 20 minutes to see if it fits how [Company] runs machine spend? I can show an
agent pay for a live API under a budget you set, end to end.

[Name]
```

**Segment-specific openers**

- **A · AI agent-builders:** "Your agents provision and call third-party APIs and infra on
  your users' behalf — which means they're already spending."
- **B · payments/crypto-native:** "You already run on-chain rails, so on-chain spend caps
  per agent will feel native."
- **C · martech/data/comms:** "You push large volumes of ad/data/API spend programmatically
  every day."
- **D · iGaming:** "You consume dozens of supplier APIs — feeds, odds, KYC — at high volume."
- **E · fintech/spend-mgmt:** "You already think in spend controls; this is spend control
  for agents and machines."
- **F · ops automation:** "Your scripts pay for maps, data, SMS, and compute APIs around
  the clock."

## Live demo script

Goal: an agent pays for a real API **under a budget you set**, end to end, in a few minutes.
Uses the internal x402 demo merchant — [`packages/demo-merchant-mcp`](../../packages/demo-merchant-mcp/README.md).
The demo merchant is a **technical demo of a merchant-controlled wallet**, not a Haven
custody/facilitator/settlement product — say so if asked; funds don't flow through Haven.

1. **Set the budget.** In the Haven account, create an agent with a small Base USDC budget
   (e.g. a few thousandths of a USDC — demo prices are tiny). Point out: the limit is
   enforced on-chain, not just in a database.
2. **Connect the agent.** Wire it up via `npx @haven_ai/connect` or hosted MCP. No private
   keys are handed to Haven; the agent signs locally.
3. **Agent hits a paid resource.** Ask the agent to list the demo merchant's products,
   inspect a price, and buy one (`buy_vpn` / `buy_cloud_storage`). The merchant returns an
   x402 challenge.
4. **Payment happens within the budget.** The agent signs the merchant payment and retries;
   the purchase settles. Show that it executed *because it fit the budget*.
5. **Show the guardrail bite.** Try a purchase above the remaining budget → it's queued for
   your approval instead of auto-executing. This is the whole pitch in one moment.
6. **Show the bookkeeping feed.** The spend appears in the bookkeeping tool automatically.
   Say "appears in your bookkeeping tool" — **not** "audit-ready" or "your books are done."

Setup reference (internal): see "Test With Haven" in
[`packages/demo-merchant-mcp/README.md`](../../packages/demo-merchant-mcp/README.md). Keep
demo amounts tiny.

## Objection handling

**"Is this custody? Are you regulated as a payment provider?"**
No. Funds stay in your own wallet — Haven never holds them and can't move them outside the
limits you approve. Haven is non-custodial smart-account software that configures, validates,
and relays payments; it isn't a custodian, exchange, broker, or payment processor. Even a
fully compromised Haven can't spend beyond what you approved on-chain.

**"What if the agent is compromised or loops?"**
The budget is enforced on-chain — amount and reset period per token. Anything beyond the
remaining budget is queued for your approval, never auto-executed. You can pause, revoke, or
rotate an agent's access at any time.

**"We already use shared corporate cards — why change?"**
Cards give you one shared limit and no per-system attribution. Haven gives each agent its own
budget and a clean per-system record that appears in your bookkeeping tool — so finance can
see exactly which automation spent what.

**"Do you hold our keys?"**
No. Your wallet keys stay with you; the agent signs locally with its own key. Haven stores
only what it needs to authenticate and relay — never user or agent private keys.

**"Can we leave / are we locked in?"**
No lock-in. You can reach and revoke your wallet through any compatible UI, independent of
Haven.

**"We need to pay out to our customers / third parties."**
That's a different problem — paying out on others' behalf — and not what Haven does. Haven is
your own wallet paying your own suppliers and APIs within limits you set. (Screen this out
early; see disqualification above.)

## Copy review checklist (before sending anything external)

- [ ] Non-custodial language only — no "Haven holds / manages / transfers / pays."
- [ ] Bookkeeping feed = "appears in your bookkeeping tool," never "audit-ready / books done."
- [ ] No custody / PSP / merchant-settlement / swap / ramp / yield / advice claims.
- [ ] Payout/disbursement use cases screened out, not pitched.
- [ ] Word choices match [`docs/product/copy-guidelines.md`](../product/copy-guidelines.md).
