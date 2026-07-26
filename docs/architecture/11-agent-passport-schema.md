---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/lib/passport/**
  - packages/backend/src/routes/agent-passports.ts
  - packages/backend/src/routes/passport-verify.ts
  - packages/backend/scripts/register-passport-schema.ts
last-verified: "2026-07-26"
---

# L0 Agent Passport — EAS schema

The passport is a signed, on-chain-anchored, revocable credential attesting an
agent's **provenance, enforced controls, and live status**. This doc fixes the
schema's field semantics and the two encodings that are easy to get wrong.
Epic: [#970](https://github.com/d-hinders/Haven-AI/issues/970); this schema is
[#971](https://github.com/d-hinders/Haven-AI/issues/971).

## What L0 attests — and what it does not

This distinction is the product, not a caveat. Blurring it is the one failure
mode that would matter.

| L0 **does** attest | L0 does **NOT** attest |
|---|---|
| **Issued by Haven** — this agent was provisioned by a known operator | **Who is accountable** — no legal or natural person is identified |
| **Bound to a treasury** — the account whose funds it can spend | Anything KYC-derived |
| **Enforced policy** — a pointer to the on-chain controls that bound it | That the agent behaves well, or that its operator is reputable |
| **Live status** — revocable, with revocation authoritative off-chain | Regulatory compliance of any kind |

Naming discipline, from the epic: say **issued / governed / revocable**.
*Verified* is reserved for L2 (ZK-anchored KYC) and must not appear in copy,
API fields, or docs describing L0. L0 attests **governance, not identity**.

**No PII is in the schema.** Everything person-shaped stays off-chain behind
Haven's API. Note the graph is permanently public regardless: treasury → N
agents → issued-by-Haven is visible to anyone reading the chain, even with
policy detail API-gated. That is a conscious trade (epic §open questions), not
an oversight.

## Fields

Registered as one EAS schema, `revocable = true`, no resolver:

```text
address agentEoa,address smartAccount,address treasury,uint8 assuranceLevel,
string policyUri,uint64 issuedAt,uint64 expiresAt
```

| Field | Meaning |
|---|---|
| `agentEoa` | `agents.delegate_address`. **Required.** |
| `smartAccount` | The Hybrid delegator. **Optional** — zero address when absent. |
| `treasury` | The account the agent spends from — the "bound to" claim. |
| `assuranceLevel` | `uint8` ladder: `0` = L0 (issuable). `1`/`2` reserved. |
| `policyUri` | Pointer to the enforced controls; detail resolves via Haven's API. |
| `issuedAt` / `expiresAt` | Unix seconds. Expiry is a claim, not enforcement. |

> **The schema string is immutable once registered.** Field order, names and
> types all feed the UID; changing any of them mints a *different* schema and
> orphans every passport already attested. A change is a new schema plus a
> migration, never an edit.

## The two encodings that bite

### 1. Both addresses are bound, and either must verify

Owner decision 2026-07-24. [#946](https://github.com/d-hinders/Haven-AI/issues/946)
made settlement a **per-payment** choice, and a merchant sees a different
address on each path:

- **EIP-3009 leg** → the merchant sees the **agent EOA** as `from`.
- **erc7710 redemption** → the merchant sees the **smart account** as delegator.

Bind only one and verification breaks depending on which path the payment took.
So the verifier ([#974](https://github.com/d-hinders/Haven-AI/issues/974)) maps
*either* bound address to the same passport.

`agentEoa` is the **required** one because it is universal — every agent has a
delegate address, including legacy/import-only agents that have nothing else.
The smart account is derived from it and exists only on the delegation rail.
(This is reversed from the epic's initial suggestion; the data model decided it.)

### 2. The zero address means "absent", and must never resolve

EAS has no nullable field type, so an agent with no smart account is attested
with `smartAccount = 0x0`. Two rules follow, both enforced in
`lib/passport/binding.ts` rather than left to callers:

- **A lookup by the zero address never matches.** Otherwise every EOA-only
  agent collides on one "address", and a merchant querying a junk or zero
  address gets handed somebody else's passport.
- **A zero smart account decodes to `null`, never to a real value** — accepting
  it as real would make an EOA-only agent look like a delegation-rail one.

This mirrors the delegation rail's posture on the zero address
([security model](../security/delegation-rail-security-model.md) §7).

## Revocation — what merchants must check

**Haven's verifier is authoritative. The chain is an anchor, not the authority.**
This is the single most important thing for an integrator to get right.

| | Authority | Latency |
|---|---|---|
| **Haven's verifier** (`standing`) | ✅ **Decides.** `agents.status = 'revoked'` IS the revocation | Immediate |
| **The EAS attestation** | Anchor only — describes, never decides | Eventually consistent |

> **Check the verifier, not only the chain.** An EAS revoke is a transaction: it
> can lag, fail, or sit unmined. During that window the on-chain attestation
> still reads as valid while Haven has already revoked the agent. A merchant
> deciding on-chain alone would serve a revoked agent.

The standing response makes the divergence visible rather than leaving it to be
inferred — `chainLagging: true` means exactly "revoked here, chain hasn't caught
up yet".

| `standing` | Meaning |
|---|---|
| `active` | Authorized right now |
| `suspended` | Temporarily **not** authorized (paused). Reversible; the anchor is untouched |
| `revoked` | **Not** authorized — regardless of what the chain says. Terminal |
| `unknown` | No such agent. Never treat as authorized |

**`active` is an allow-list of one.** Only the literal agent status `active`
reads as authorized; every other status — `paused` today, anything a later
migration adds — reads as `suspended`. A deny-list (*"not revoked, therefore
active"*) would make each new status a permission by default, which is how a
paused agent came to read as `active` in the first draft.

`suspended` deliberately does **not** revoke the anchor: pausing is reversible
and an EAS revoke is one-way, so revoking on pause would make un-pausing require
re-issuing the passport. Issuance is likewise allowed for a paused agent and
**refused (409) for a revoked one** — minting an attestation for an agent Haven
has already revoked spends gas to create the very divergence described above.

`anchor` reports the chain's progress for transparency: `not_anchored`,
`anchored`, `revocation_pending`, `revoked_onchain`.

### Why a revoke cannot fail permanently

A failed anchor **retries with backoff** (30s doubling to a 1h cap) until the DB
and chain agree — owner decision 2026-07-24. There is deliberately **no terminal
`failed` revocation state**: a revoked agent whose on-chain flag never flipped is
precisely the divergence this design exists to prevent, so a struggling revoke
stays `pending` and due rather than being dropped.

A revocation left unreconciled past a threshold is an **operational incident**,
not a silent state — surfaced by `listStuckRevocations()` for alarming. While it
is stuck, the verifier still answers `revoked` correctly; the exposure is only to
merchants who ignored the rule above and checked the chain alone.

### What actually drives the retries

Both halves of the anchor are fire-and-forget — an EAS write must never block
agent creation or an owner's revoke — which only holds because something later
retries what the in-request attempt dropped. That something is the **passport
sweep** in `index.ts`: a leader-locked tick (every 5 minutes, not hourly, so it
does not flatten a schedule that starts at 30s) that runs
`retryPendingPassports()`, then `reconcilePendingRevocations()`, then logs
anything `listStuckRevocations()` returns as a warning.

**Every phase and every row is isolated**, which is not incidental. Neither
sweep's per-row call catches everything — `issuePassport` and
`reconcileRevocation` both make repository calls outside their own try blocks —
and both queues are ordered OLDEST FIRST. So a single poison row (or one
transient pool error) aborting a batch would put that same row first again on
the next tick, and every tick after: one bad row silently stopping every
revocation in the system, which is exactly the failure the sweep exists to
prevent. Each row is caught individually and counted (`{ attempted, failed }` —
a sweep reporting `attempted: 50` while failing all 50 reads as healthy), and
each of the three phases runs in its own try/catch so a failure in the issuance
retry cannot silence the revocation reconciliation or the alarm. The alarm
especially must run when everything above it is failing: that is when it
matters.

Two properties make that safe to run repeatedly and from more than one place:

- **The queue is defined by the invariant, not a flag.** "Agent revoked, anchor
  not confirmed" — *not* `revocation_status = 'pending'`. The difference is
  load-bearing: revoking an agent while its passport is still anchoring enqueues
  nothing (the enqueue guard requires an already-anchored row), so a flag-based
  queue would miss that agent forever and leave its attestation live. Issuance
  also re-checks on anchor completion, closing the same race immediately rather
  than at the next tick.
The sweep's queries are indexed for the invariant they actually use.
Migration 049's partial index was `WHERE revocation_status = 'pending'`, which
matched the flag-based queue; redefining the queue by invariant
(`revocation_status <> 'confirmed'`) silently orphaned it, because Postgres uses
a partial index only when the query's WHERE clause *implies* the index
predicate. Migration 050 replaces it. Note `db:schema-smoke` cannot catch this
class of problem — it `PREPARE`s each query, so it validates that a plan exists,
not which plan.

- **`claimRevocation` is the single gate**, and it checks the invariant *and*
  takes a lease in one atomic `UPDATE`. Checking `agents.status = 'revoked'`
  there rather than in the caller is what makes the unconditional
  anchor-completion hook safe — no caller can revoke a live agent's anchor. The
  lease matters because EAS reverts a second revoke with `AlreadyRevoked`: two
  concurrent attempts would burn gas and then fail on every backoff cycle
  forever instead of converging.

## Verifying a passport (merchant-facing)

Two public, unauthenticated endpoints. The caller is a merchant deciding
whether to serve an agent; it has no Haven account and cannot be asked to get
one.

| Endpoint | Returns |
|---|---|
| `GET /passport/issuer` | The address to pin, the payload version, and the receipt TTL |
| `GET /passport/verify?address=0x…` or `?uid=0x…` | A **signed receipt**, or `{ found: false, reason: "no_passport" }` |

Resolution works from **either** agent address — the delegate EOA a merchant
sees on an EIP-3009 header, or the Hybrid account it sees as the delegator in
erc7710 redemption. #971 binds both precisely because #946 made settlement a
per-payment choice, so a merchant can verify from whichever address it holds.

An agent with **no passport is a normal 200 answer**, not a 404. Issuance is
opt-in, so most agents have none — and an error status is what makes an
integration treat a lookup failure as a pass.

### The verifier speaks only about passports already public on-chain

Owner decision 2026-07-26. Lookups resolve **anchored passports only**. A
pending or failed passport returns the same `{ found: false, reason:
"no_passport" }` as an agent with none — reporting "pending" separately would
disclose exactly what this withholds, that the address belongs to a Haven
customer.

The line that gives: everything the endpoint reveals about an agent's
**existence** is already readable from the EAS attestation by anyone. Live
`standing` deliberately goes *further* than the chain — that is the product, and
the whole point of the revocation model above — but it now does so only for
agents whose attestation is already published.

The filter is written into the query explicitly rather than left to emerge.
`markAnchored` happens to write `agent_eoa`, `smart_account` and
`attestation_uid` in the same statement that sets `status = 'anchored'`, so a
pending row has NULLs in every lookup column and could not be found anyway —
but that is an accident of write ordering. The day someone records those
addresses at request time, an unauthenticated endpoint would quietly start
confirming Haven customers before anything about them is public. Four tests
assert the filter against rows whose lookup columns are populated, so they fail
if the clause is removed.

### Why a signed receipt and not a boolean

A bare `{ ok: true }` forces a live call to Haven for every merchant decision:
an availability coupling (Haven down means merchants cannot gate) and a privacy
one (Haven sees every merchant's traffic). The response is instead a
self-contained artifact whose authenticity a merchant checks **offline**:

```ts
import { verifyMessage } from 'ethers' // or viem's verifyMessage

// Sort keys at EVERY depth — see the warning below before "simplifying" this.
const canon = (v) =>
  Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
    : v

const { receipt, signature } = await fetch(`${HAVEN}/passport/verify?address=${agent}`).then((r) => r.json())
const ok = verifyMessage(JSON.stringify(canon(receipt)), signature).toLowerCase() === PINNED_ISSUER.toLowerCase()
if (!ok || receipt.standing !== 'active' || receipt.expiresAt < Date.now() / 1000) return deny()
```

Pin `PINNED_ISSUER` once from `GET /passport/issuer`. Do **not** take it from
the receipt's own `issuer` field — authenticating an artifact against a value it
carries is circular.

Key ordering does not matter: the signature is over a canonical serialization
(**every** key sorted, at every depth, no whitespace), so a merchant that parses
and re-serializes still verifies. That is deliberate — a digest that depended on
our wire ordering would make every such merchant conclude Haven was forging
receipts.

> **⚠️ Do NOT replace `canon` with `JSON.stringify(receipt, Object.keys(receipt).sort())`.**
> It looks like the same thing and is not: the array form of the replacer is a
> recursive property *allow-list*, so nested objects have their keys filtered
> against the top-level names. `controls` collapses to `{}` and drops out of the
> digest entirely — meaning `policyEnforcedOnchain`, the field the receipt is
> *about*, would verify as authentic no matter what it said. This was Haven's
> own first implementation and this snippet's first version; the check below
> passed happily against a forged control summary. If you shipped that version,
> re-verify anything you accepted with it.

`version` is part of the signed payload, so a receipt is only ever interpreted
under the rules it was minted with. It is at `haven-passport-receipt/2`; `/1`
was never released.

### Freshness, and the gap caching would otherwise reopen

A cacheable receipt is **by definition potentially stale on replay**: the agent
can be revoked a second after it was issued. Unbounded, that reintroduces
exactly the "anchor says authorized, issuer says revoked" gap above — only with
the merchant's cache playing the part of the lagging chain. Three things bound
it, and all three are in the artifact rather than in advice:

- **`expiresAt`, five minutes, and signed** — so a merchant cannot extend it and
  an expired receipt is objectively expired rather than a matter of local policy.
  The value is a deliberate choice: shorter and caching buys nothing over
  calling us; much longer and a revocation could go unnoticed for most of a
  payment session.
- **`standingEpoch`, monotonic** — two receipts for the same agent are strictly
  comparable, so a merchant can tell a newer one from an older one. `issuedAt`
  alone cannot do this: clocks skew.
- **Re-verify before anything irreversible.** Cached receipts are for routine
  gating and rate-limiting. The endpoint always answers from current state;
  caching is the merchant's choice, never ours.

A verification failure reports **`not_signed_by_issuer`** rather than
distinguishing "tampered" from "signed by someone else". Those are
cryptographically indistinguishable — recovery yields *some* address for any
payload — and an API that claimed to tell them apart would be asserting
something it cannot know. `expired` stays separate because it is the one
distinction that changes what a merchant should do: re-fetch, rather than treat
as an attack.

### Rate limiting is per SUBJECT, not per caller

The endpoint is unauthenticated and there is no `trustProxy`, so `request.ip`
collapses to the proxy address for all external traffic — a per-caller limit
would be one global bucket, and a single client sending 121 requests a minute
could 429 passport verification for **every merchant at once**. Raising the
ceiling makes the shared bucket bigger, not safer.

So the limiter keys on the **queried address or UID** (120/min each). Merchants
verifying different agents mostly do not collide, and an abusive caller mostly
exhausts only the bucket for the agent it is hammering. *Mostly*, precisely: the
key generator runs before the handler validates input, and the default store is
a 5000-entry LRU, so flooding more than that many junk subjects inside a window
can evict a real subject's counter and reset its ceiling. A large improvement on
one global bucket, not an absolute guarantee. That is also the right shape for
the real threat — hammering or enumerating a specific subject — rather than for
"who is calling", which behind an untrusted proxy is unknowable. Making
per-caller limits real needs `trustProxy`, which changes `request.ip` for every
rate-limited route including the money path; that is a separate decision.

### Minimal disclosure

The endpoint is unauthenticated, so the response shape *is* the protection. It
carries standing, assurance level, the bound addresses (already public
on-chain), and a boolean control summary — `rail`, `policyEnforcedOnchain`,
`treasuryBound`. It carries **no** owner identity, budget amounts, balances,
counterparties, or treasury address. A merchant needs to know an agent is
governed, not how much its owner lets it spend.

### Perimeter

This answers a question about an **agent's governance status**. It verifies no
payment, settles nothing, holds nothing, and takes no fee — none of the
merchant-acquiring surface [`casp-risk-guardrails.md`](../regulatory/casp-risk-guardrails.md)
puts out of scope. Do not grow it into payment verification or receipts for
settled merchant transactions; that is a different question with a different
perimeter.

## Registration and configuration

Registration is an **operator step** — an on-chain transaction needing a funded
key, whose UID does not exist until it lands:

```bash
npm run ops:register-passport-schema -w packages/backend            # dry run: verify pins
npm run ops:register-passport-schema -w packages/backend -- --send  # register
```

The script is **fail-closed on the pins**. The EAS addresses in
`lib/passport/schema.ts` are the standard OP-Stack predeploys Base inherits,
but they were pinned *without* an on-chain check (no RPC egress in the authoring
environment). Before sending anything the script proves both contracts have
bytecode **and** that SchemaRegistry answers `getSchema(bytes32)` — code at an
address is not proof it is the right contract. The dry run does exactly that
verification and stops, so anyone with an RPC URL can confirm the pins with no
key and no gas. Until it has run, treat the addresses as *proposed, not pinned*
— the posture `delegation-contracts.ts` takes.

Config is per chain and fail-closed: `AGENT_PASSPORT_SCHEMA_UID_<chainId>`.
Unset means "not registered here" and issuance **refuses** rather than
attesting against a schema nobody can verify. Base Sepolia (84532) is the only
chain served; Base mainnet rides with the
[#908](https://github.com/d-hinders/Haven-AI/issues/908) gate and its own
verification run — never by copying the block.

`PASSPORT_SCHEMA_REGISTRAR_KEY` is a throwaway testnet key for that one-off
registration. **Never reuse `RELAYER_PRIVATE_KEY`**: registration is public and
permissionless and has no business borrowing a key that moves value.

`PASSPORT_RECEIPT_SIGNING_KEY` signs the verification receipts above and follows
the same rule for the same reason — its address is *published* for merchants to
pin, so it signs public assertions and must be dedicated. It is a **message
signer only**: no provider, no transaction, and a non-custody invariant test
enforces that rather than trusting the convention. Unset means verification is
off and both endpoints return 503 rather than serving an unsigned receipt.

## Related

- [Module boundaries](10-module-boundaries.md) — `lib/passport/` is a module
  with a public `index.ts`; import through it, never a private file.
- [Delegation-rail security model](../security/delegation-rail-security-model.md)
  — the custody perimeter the passport describes, and the zero-address posture.
- [x402 payment sequence](04-x402-payment-sequence.md) — the two settlement
  paths that force the dual address binding.
