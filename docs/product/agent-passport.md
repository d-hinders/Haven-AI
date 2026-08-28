---
owner: "@d-hinders"
status: current
covers: []  # narrative — the schema doc carries the code mapping
last-verified: "2026-08-27" # #2138: the three claims that a passport means "controls enforced on-chain" were unqualified — false for a legacy-rail agent, which could hold an issued passport because issuance was never gated by rail. The owner decided 2026-08-27 that it should be ("we should not support issuance on legacy rails"), so the code now refuses it and this page says so rather than describing a gate that did not exist. Existing legacy passports are NOT revoked — that was the same decision — so the caveat names them explicitly and points at the receipt's own policyEnforcedOnchain: false, which was always the honest answer. Deliberately does NOT restate the controls.rail value list: #2110 pinned that to migration 041 and the OpenAPI enum, and a hand-copied fourth source in product prose is the drift this epic keeps finding. Scope: the "What a passport is" intro, the Governed row, and the L0 ladder row; the revocation, verification and adoption sections were NOT re-verified in this pass.
---

# Agent Passport

**A passport says an agent is governed. It does not say who anyone is.**

That sentence is the whole design. Everything below elaborates it, and the
distinction is the product rather than a caveat — blurring it is the one failure
that would matter.

## The problem

An AI agent shows up to pay for something. The merchant has no way to tell it
apart from any other address. Is it accountable to anyone? Can its spending be
stopped? Is there an operator behind it, or is it a script someone wrote this
morning?

Today the honest answer is that you cannot tell. The agent presents an address,
and an address carries no history you can trust and no authority you can check.

## What a passport is

A signed, publicly readable attestation that a specific agent was **issued by
Haven**, is **bound to a treasury**, operates under **controls enforced
on-chain**, and can be **revoked**.

> **Passports are issued on the delegation rail only** (#2138, epic #1440).
> That is what makes the third claim true rather than aspirational: the
> delegation rail's caveat enforcers reject an out-of-policy redemption
> on-chain, so "enforced by the chain" is a description of the mechanism. The
> retired AllowanceModule and Smart Sessions rails cannot transact at all — every
> payment entry point answers 410 — so an agent there has no spending for a
> contract to govern, and Haven refuses to issue it a passport rather than
> attest a control that cannot be exercised.
>
> **A passport issued on a legacy account before that gate still exists**, and
> is deliberately left alone rather than revoked. Its own control summary
> reports `policyEnforcedOnchain: false`, which is the honest answer — so the
> receipt tells a merchant the truth even where this page's four claims read as
> universal. Read the claims below as describing what Haven **issues**; read the
> receipt for what a specific passport **asserts**.

Four claims, each independently checkable:

| Claim | What it means |
|---|---|
| **Issued** | A known operator provisioned this agent. It did not appear from nowhere. |
| **Bound to a treasury** | The account whose funds it may spend is named. Its reach is finite and stated. |
| **Governed** | The limits on it are enforced by the chain during the payment, not by a service that could be bypassed or misconfigured. True by construction: Haven issues only on the rail where that holds. |
| **Revocable** | Authority can be withdrawn, and the withdrawal takes effect immediately — not when a cache expires. |

**Revocable is the load-bearing one.** A credential that cannot be withdrawn is
a claim about the past. A merchant checking a passport is asking about *now*.

## What a passport is NOT

| Not this | Why it matters |
|---|---|
| **Identity** | No legal or natural person is named. It tells you an agent is governed, not who to hold responsible. |
| **KYC** | Nothing here derives from identity checks. |
| **A reputation score** | It says nothing about whether an agent behaves well, or whether its operator is trustworthy. |
| **A compliance attestation** | It asserts no regulatory status of any kind. |
| **A guarantee of payment** | It describes authority, not solvency or intent. |

Haven says **issued**, **governed**, **revocable** — never *verified*. That word
belongs to a tier that does not exist yet, and using it early would be the whole
failure mode: a merchant hearing "verified agent" reasonably concludes someone
checked an identity. Nobody did.

## The assurance ladder

Governance and identity are different questions, so they are different tiers.
The ladder exists so the boundary is structural rather than a matter of careful
wording.

| Tier | Claim | Status |
|---|---|---|
| **L0 — Governance** | Issued, treasury-bound, controls enforced on-chain, revocable | The tier Haven issues — on the delegation rail only |
| **L1 — Screened** | L0 plus sanctions screening | Defined, not issuable |
| **L2 — Verified** | L1 plus identity, anchored without disclosing it | Defined, not issuable |

L1 and L2 are defined in the schema from the start so later tiers need no
redesign — and they are **inactive by construction**, not by policy. The
database refuses to store a tier above L0, and the verifier refuses to report a
tier it cannot issue rather than quietly describing it as L0. A tier that is
merely *intended* to stay unreachable eventually gets reached.

## For merchants

You get a signed answer covering four things: the agent's current standing, its
assurance tier, the addresses it is bound to, and how long the answer is good
for.

- **Standing is live.** A revoked agent reads as revoked immediately, rather
  than when something expires.
- **Answers are short-lived and signed.** You cannot be handed a stale answer
  and told it is current, and you cannot extend one.
- **Re-check before anything irreversible.** Cached answers suit routine gating
  and rate-limiting. For a refund window or a large order, ask again.
- **An agent with no passport is a normal answer**, not an error. Issuance is
  opt-in, so most agents have none. Read it as "no claim made" and apply
  whatever policy you would apply to any unknown counterparty.

What a passport does not do is replace your own controls. It narrows uncertainty
about governance. It does not remove it, and it is silent on the other questions
you would normally ask.

## For investors

The interesting property is what it refuses to claim.

Agent-payment infrastructure has an obvious temptation: describe governance in
language that sounds like identity, because identity is what merchants actually
want. That works until the first incident, at which point the gap between what
was implied and what was attested becomes the entire story.

Haven's position is that **governance is the claim that can be made truthfully
today**, and that stating it precisely is worth more than stating something
larger and vaguer. The naming discipline is enforced in the schema, in the API
field names, in a copy lint, and in the tier gate above — not in a style guide
someone is expected to remember.

The bet is that a checkable, narrow claim beats an impressive one: merchants can
build on the first and cannot safely build on the second.

## How it works, briefly

The attestation lives on-chain, so anyone can read it without asking Haven. Live
standing — revoked or not — comes from Haven, because the chain lags and
revocation has to be immediate. An agent can carry a pointer to its own passport
alongside a payment, so a merchant **verifies** rather than **discovers**.

No personal data is in the attestation; everything person-shaped stays behind
the API. One trade-off is deliberate and worth stating plainly: the on-chain
record shows treasury → agents → issued-by-Haven to anyone reading the chain,
whether or not those agents ever transact.

## Read next

- [Agent Passport schema and verification](../architecture/11-agent-passport-schema.md)
  — the technical contract: fields, verification, revocation, delivery.
- [Copy guidelines](copy-guidelines.md) — the terminology rules this page follows.
- [CASP risk guardrails](../regulatory/casp-risk-guardrails.md) — the regulatory
  perimeter; a passport verifies no payment and settles nothing.
