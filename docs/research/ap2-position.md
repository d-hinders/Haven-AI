---
owner: "@d-hinders"
status: research
covers: []  # narrative — no direct code mirror (this doc records a decision NOT to build)
last-verified: "2026-08-25"
---

# Haven's position on AP2 (Google's Agent Payments Protocol)

> **Decision: (c) monitor-only.** Haven will not build AP2 support now. Recorded
> by the owner in-session 2026-08-25 ([#2030](https://github.com/d-hinders/Haven-AI/issues/2030)).
> Revisit triggers in §6.

## 1. Why this doc exists

AP2 occupies the **authorization layer** of the agentic-commerce stack — the layer
Haven itself competes at. Until this doc, Haven had **no written position on it**:
a grep across `docs/` and `packages/*/src` on 2026-08-25, before this doc existed,
returned zero references to AP2 or A2A (the only hits were hex colour codes
containing `a2a`).

The point of the doc is not to build anything. It is so that "we looked at AP2 and
chose not to prioritise it" is a *recorded decision with reasoning*, rather than an
absence someone later mistakes for an oversight — in a partner conversation, a
diligence question, or a future planning session.

## 2. What AP2 is

> **Confidence:** the AP2-side detail in this section and the next is second-hand —
> the primary spec was unreachable when this was assessed. See [§10](#10-evidence-and-confidence)
> before relying on it. The Haven-side half of the §3 mapping is verified against code.

AP2 is Google's protocol for proving that an agent had a user's permission to
spend. Announced September 2025 with 60+ collaborators including Mastercard,
American Express, PayPal, Adyen and Coinbase.

**Three mandates**, all expressed as W3C Verifiable Credentials — tamper-evident,
portable, and non-repudiable:

| Mandate | Signed by | Carries |
|---|---|---|
| **Intent** | the **user**, up front | rules of engagement — price limits, timing, conditions |
| **Cart** | user (real-time) or agent (delegated, when Intent conditions are met) | exact items, quantities, final price |
| **Payment** | presented by the agent | signals to the payment ecosystem that an agent is involved |

**AP2 does not move money.** It is a trust and authorization layer over an existing
rail — cards, stablecoins, or real-time bank transfer. The **A2A x402 extension**
(built with Coinbase, the Ethereum Foundation and MetaMask) is its crypto rail.

Enforcement is **third-party refusal**: the Credential Provider, the card networks
and the Merchant Payment Processor each verify the mandate before the payment
proceeds, and a signed Payment Receipt returns either way.

## 3. The overlap with Haven

The structural correspondence is unusually clean — Haven arrived at AP2's two-tier
shape independently, in different vocabulary, because it is the natural shape of
the problem:

| AP2 | Haven equivalent |
|---|---|
| **Intent Mandate** — price limit, timing, conditions | **budget delegation** — period budget, expiry, optional recipient pin |
| **Cart Mandate** — exact items, exact price | **erc7710 settlement child** — exact amount, payee pin, ≤600s expiry |
| Signed VC, verified by counterparties | signed delegation, enforced by caveat enforcers at redemption |
| Non-repudiable Intent→Cart→Payment audit trail | intent rows, delegation hashes, receipts, accounting feed |

## 4. The difference that matters

**AP2 mandates are asserted. Haven delegations are enforced.**

A mandate is a document *about* a payment. It is not a *condition on* the payment.
The USDC contract has never heard of AP2.

That distinction is invisible in the card model and decisive on a self-custody
crypto rail:

- **Cards:** the agent never holds the money. It holds a token; the funds sit behind
  a processor. A party that is *not the agent* is in the path and refuses. AP2's
  enforcement works because a gatekeeper exists.
- **Self-custody stablecoins:** if the agent holds the key to a funded wallet, there
  is no gatekeeper. A hallucinating or compromised agent can pay a merchant that
  does not implement AP2 (nearly all of them), pay a spoofed merchant advertised by
  a prompt injection, or **simply sign a plain ERC-20 transfer with no mandate and no
  merchant at all**. AP2 has no answer to the last case: mandates constrain a
  *protocol flow*, never a *key*.

Note what Google states AP2's credentials establish: authorization, authenticity,
and **accountability — "who is responsible if something goes wrong?"** That is a
*dispute* question. **AP2 is an evidence and liability protocol, not a control
protocol.**

In the card world that is enormously valuable, because liability allocation *is* the
game — chargebacks, fraud rules, who absorbs the loss. Stablecoins have no
chargeback. An evidence layer over an irreversible rail tells you whose fault it was
*after the money is gone*. That gap is what on-chain enforced budgets fill, and it is
why AP2 adoption would not reduce the need for Haven's core mechanism.

## 5. Why we are not building it now

1. **It is not a usability blocker.** No user is unable to run an agent on Haven for
   want of AP2. It adds a credential format, not a capability.
2. **Nothing in the demand signal asks for it.** No prospect, customer or partner has
   made AP2 a condition.
3. **The interop cost is low and stays low.** §3 shows the mapping is close to
   mechanical, and §2's audit trail is close to what Haven already records. Deferring
   does not accumulate debt — the work is roughly as cheap later as now, and later it
   is informed by which parts of AP2 the market actually uses.
4. **Declaring intent is sufficient for the conversation it comes up in.** In an
   investor or partner discussion, "we've assessed AP2, here is the mapping, we will
   implement when it is asked for" is a stronger answer than a rushed implementation
   of a spec whose adoption is unproven.

## 6. Revisit triggers

Revisit this decision when **either** fires:

- **Capacity:** an investment round closes. This is the planned revisit point — the
  work is scheduled against having the capacity to do non-blocking work, not against
  AP2 becoming urgent.
- **Demand:** a prospect, customer or partner makes AP2 support a condition of
  proceeding.

The two are deliberately different in kind. The capacity trigger is when we *can*
afford it; the demand trigger is when we *must*, and it can fire first.

## 7. What to evaluate when it is revisited

- **Which option:** (a) emit AP2-shaped mandates as an interop surface over
  delegations — "AP2 semantics, on-chain enforcement" — or (b) decline permanently.
  This doc is (c), a deferral, and does not pre-commit to either.
- **Is Agent Passport the vehicle?** [#970](https://github.com/d-hinders/Haven-AI/issues/970)
  is already a signed, revocable EAS attestation of governed authority — structurally
  close to a mandate. See [`docs/product/agent-passport.md`](../product/agent-passport.md).
- **Should Haven be an AP2 Credential Provider?** In AP2's role model that party holds
  the user's payment credentials and verifies mandates. On a crypto rail that reads as
  "a wallet that enforces policy," which is Haven's product description. Worth
  examining deliberately rather than assuming Haven is only a rail participant.
- **Which mandates are actually load-bearing in practice**, as opposed to specified.

## 8. Relationship to x402 — do not conflate

**AP2 is authorization; x402 is settlement. They compose; they do not compete.** The
A2A x402 extension is AP2's crypto rail, so an AP2 transaction on stablecoins settles
*via* x402 — the protocol Haven already implements
([`docs/architecture/04-x402-payment-sequence.md`](../architecture/04-x402-payment-sequence.md)).
Adopting AP2 would add a credential layer above Haven's existing settlement path; it
would replace nothing.

## 9. Explicitly out of scope

- **A2A** (Google's agent-to-agent communication protocol) — a different layer
  (agent↔agent, versus MCP's agent↔tool). Relevant only when the counterparty is
  another agent rather than a merchant, at which point it is structurally cheap for
  Haven: a recipient pin points at another agent's account instead of a merchant's.
  Not assessed here.
- **The competitive question** of what defends Haven against a wallet vendor building
  on the same MetaMask Delegation Framework. That question is real and was raised
  alongside this one, but it is a *positioning* question, not an AP2 question — the
  framework is open and that competition exists with or without AP2. Deliberately not
  folded in here, so this doc does not carry an argument it cannot settle.

## 10. Evidence and confidence

Assessed 2026-08-25 from Google's announcement plus secondary sources. The primary
spec at `ap2-protocol.org` was **not reachable** from the assessing environment
(egress-blocked), so the role-level detail in §2 — particularly the exact division of
verification duties between Credential Provider, networks and Merchant Payment
Processor — is second-hand and should be re-derived from the spec before any
implementation decision under §7.

Ecosystem figures quoted in the surrounding analysis (transaction counts, seller
counts, Bazaar composition) came from search-engine summaries and are directional
only; at least one such summary was observed misreading its own cited numbers. None
of this doc's reasoning depends on them.

Primary sources:
[AP2 announcement (Google Cloud)](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol) ·
[AP2 specification](https://ap2-protocol.org/ap2/specification/) ·
[Coinbase — AP2 + x402](https://www.coinbase.com/developer-platform/discover/launches/google_x402)
