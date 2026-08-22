---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/modules/passport/**
  - packages/backend/src/infra/repositories/agent-passports.ts
  - packages/backend/src/routes/agent-passports.ts
  - packages/backend/src/routes/passport-verify.ts
  - packages/backend/scripts/register-passport-schema.ts
  - packages/backend/src/db/migrations/048_agent_passports.ts
  - packages/backend/src/db/migrations/049_agent_passport_revocation.ts
  - packages/backend/src/db/migrations/050_agent_passport_revocation_index.ts
  - packages/backend/src/db/migrations/051_agent_passport_addresses.ts
last-verified: "2026-08-22" # #1758: "no terminal failed revocation state" needed something able to observe agreement, and the only observer was unreachable — a revoke that mines after its bounded wait leaves `revocation_status` permanently `pending`. A new section records what CLOSES a revocation: the attestation's revoked bit read at a settled block, its evidence pointer from the durable outbound record, and the #1743 time question left open. Prior: #1745: the SECOND limit on "recovered, never re-minted" is closed — a null receipt no longer presumes dropped; a re-mint needs positive evidence the prior tx can never mine (its nonce consumed by something else). The bounded-stall argument and the still-open time question (#1743) are recorded rather than implied. The first limit (hash-keyed recovery) stands. Prior: #1742: the sweep's phase isolation protects against a THROW, not a hang — `revokeOnChain`'s bare `tx.wait()` could park the revocation phase and the stuck-revoke alarm downstream of it indefinitely. The wait is now bounded; the retry/backoff model, the no-terminal-failed-state rule and the verifier precedence are unchanged. Prior: #1735: the "recovered, never re-minted" claim is qualified — recovery is keyed off the persisted tx hash (hence the bump-worker exclusion) and presumes a null receipt means dropped, so a fee-stuck anchor can still re-mint (#1745). Anchor wait disposition on expiry recorded. Rest of the anchoring/revocation prose re-read against the code and unchanged.
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

**Field minimization is the only bound on that graph.** It limits what each
attestation says; it does not limit which agents appear in it. Every opted-in
agent is anchored whether or not it ever transacts — see
[anchoring happens at opt-in](#anchoring-happens-at-opt-in-and-that-is-a-revised-decision)
for why that exposure was accepted.

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
| `assuranceLevel` | `uint8` ladder: `0` = L0 (issuable). `1`/`2` reserved. The verifier **reads** this from the row and refuses to issue a receipt for any level it cannot issue, rather than clamping to L0 — understating a tier is a wrong answer presented as a right one ([#975](https://github.com/d-hinders/Haven-AI/issues/975)). |
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
`modules/passport/binding.ts` rather than left to callers:

- **A lookup by the zero address never matches.** Otherwise every EOA-only
  agent collides on one "address", and a merchant querying a junk or zero
  address gets handed somebody else's passport.
- **A zero smart account decodes to `null`, never to a real value** — accepting
  it as real would make an EOA-only agent look like a delegation-rail one.

This mirrors the delegation rail's posture on the zero address
([security model](../security/delegation-rail-security-model.md) §7).

## Issuance — opt-in, issuer-signed

A passport is **opt-in and a separate action from agent creation** (owner
decision 2026-07-24): `issue_passport: true` on `POST /agents`, or
`POST /agents/:id/passport` later for an existing agent. Both entry points are
dashboard-authenticated — an agent must not be able to issue itself a
credential — and an agent with no passport row is the normal case, behaving
exactly as before this shipped. Each passport is an attestation the relayer
pays gas for, and opt-in lets the owner choose what goes on-chain (the graph
note above).

The EAS write is **async, best-effort and retryable** — recorded synchronously
(the POST returns 202), anchored fire-and-forget. A failed, slow, or unfunded
attestation can never fail or block agent creation; it degrades to a
`pending`/`failed` passport row that the sweep below retries.

### Anchoring happens at OPT-IN, and that is a revised decision

**Owner decision 2026-07-27, superseding the earlier one on #970.** The epic
originally recorded the opposite:

> "Anchor on FIRST USE, not at agent creation — the biggest cheap privacy win.
> Dormant agents leave no record, the enumerable set shrinks to already-active
> agents (which leak a little via their txs anyway), and we skip gas on agents
> that never transact."

That was implemented in #1013 and then **deliberately not shipped**. Anchoring on
first use means the anchor is released *by* the first payment, and since
anchoring is itself a transaction, that payment almost always settles before its
own attestation lands — so the first payment an agent ever makes is the one
payment a merchant cannot verify. A credential that is absent exactly when it is
first presented inverts the product: the passport exists to be checked at
presentation time. The owner judged that cost higher than the privacy gain.

**Anchoring therefore happens when the owner opts in**, as it has since #972.

Two things follow, and both are stated here rather than left to be rediscovered
— an unrecorded decision is precisely how this drifted the first time (#1013 was
filed because the epic's decision and the code disagreed, and nothing said
which one was current).

**The residual exposure is real and accepted.** An opted-in agent that never
transacts still carries a permanent on-chain attestation, so the enumerable set
of Haven agents is *all opted-in agents*, not just active ones — and Haven pays
gas for agents that never spend. Field minimization (above) bounds what each
attestation says; nothing bounds which agents appear. The
[one-pager](https://github.com/d-hinders/Haven-AI/issues/978) must state this
plainly rather than imply the graph is limited to active agents.

**Opt-in narrows the unverifiable window; it does not close it.** The write is
fire-and-forget, so `POST /agents` returns 201 with the API key while the attest
transaction is still mining. An agent created and used within seconds can still
present before its anchor lands. An integrator that needs certainty must poll
`GET /agents/:id/passport` for `status: 'anchored'` before handing the credential
to something that will immediately transact — the endpoint reports
`pending` vs `anchored` precisely so this is observable. Closing the window
entirely would mean blocking agent creation on a confirmed transaction, which
the "EAS write never blocks anything" rule above deliberately refuses.

**Who signs and pays:** Haven signs the attestation as *issuer*, submitted by
the **gas-only relayer**. That is governance metadata, not spend authority —
the transaction targets the pinned EAS contract and nothing else, carries zero
value, and involves no user key, delegation, or allowance (a test pins the
target and the zero value). Non-custody is unaffected; see the
[delegation-rail security model](../security/delegation-rail-security-model.md)
§2.

### Retry discipline (#1043)

Issuance retries mirror the revocation side: the due-list applies a capped
exponential backoff (30s doubling to 1h, computed from `updated_at +
backoff(attempts)` — no schema change) and **excludes revoked agents**, so a
struggling row costs at most ~24 attempts/day and a revoked agent's pending
row simply stops being due. Rows past the attention threshold (10 attempts —
hours of failing) are counted and logged by the sweep as an operational
alarm rather than churning silently.

A broadcast whose result was lost is **recovered rather than re-minted** where
recovery is possible: the tx hash is persisted the moment the transaction is
broadcast (before the wait), and a retry reads the attestation UID back from
that receipt. Re-minting would create a second live attestation with the first
permanently invisible to Haven. The on-chain wait is bounded (120s) so it
cannot outlive the anchoring claim's 600s stale window.

Two limits on "never re-minted", stated because the unqualified version is not
true today:

- The recovery is **keyed off the persisted tx hash**, so anything that
  replaces the transaction breaks it. That is why
  [#1735](https://github.com/d-hinders/Haven-AI/issues/1735) excludes
  `passport_attest` from the bump worker's fee-replacement path, and why an
  expiry of the 120 s wait leaves the outbound record `broadcast` (for
  chain-first reconciliation) instead of closing it `failed` as a revert.
- `getTransactionReceipt` returns `null` for a **pending** transaction exactly
  as for a dropped one, so the absence of a receipt is not evidence the
  transaction died. Until
  [#1745](https://github.com/d-hinders/Haven-AI/issues/1745) the retry presumed
  dropped and re-minted at the next nonce ≈180 s after broadcast; it no longer
  does. A re-mint now requires **positive evidence that the prior transaction
  can never mine** — its nonce consumed by something else, read as the
  relayer's mined `getTransactionCount` past the nonce the outbound record
  (#1556) stamped at broadcast. A transaction only ever mines into its own
  nonce and a nonce is spent once, so that is arithmetic rather than a
  deadline. Anything weaker — a transaction any node still knows, a missing or
  un-stamped record, a `replaced`/`mined` record, an unreadable provider, or a
  receipt that appears on the confirming re-read — withholds the re-mint and
  leaves the passport retryable.

  Two consequences worth stating, because they are the shape of the trade.
  **The stall ends when the nonce is burned, and in practice that is the
  operator's cancel — not Haven's own traffic.** It is tempting to argue that a
  dropped transaction stops reserving its nonce, so the relayer's next
  broadcast takes the slot and issuance recovers by itself. It does not, and
  the reason is worth knowing: `submitRecorded` allocates from
  `getNonce('pending')`, but the stuck attest still holds a `broadcast` row at
  that nonce, and migration 061's partial UNIQUE index on
  `(chain_id, nonce) WHERE status = 'broadcast'` refuses the stamp — the queue
  retries, re-reads the same nonce, and throws `could not win a nonce lane`.
  So the lane #1735 already documents as blocked stays blocked, and what burns
  the nonce is the same-nonce cancel in the
  [vendor-ops runbook](../operations/delegation-rail-vendor-ops.md) §3. The
  gain is that the cancel is now **sufficient on its own**: once it mines, the
  burned nonce is exactly the evidence the sweep needs, so issuance completes
  on its next tick with no further operator action and no duplicate to hunt
  for first. While it waits, the row keeps failing retryably and alarms
  through `ISSUANCE_ATTENTION_ATTEMPTS`. **The time question is deliberately
  open:** how
  long an attest whose nonce is *still open* may sit before Haven declares it
  dead on its own is an owner decision with duplicate-credential consequences,
  tracked as [#1743](https://github.com/d-hinders/Haven-AI/issues/1743) and not
  taken in code. Until it is, such an attest is live for as long as it holds
  its nonce.

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

**A try/catch isolates a throw, not a hang** — and until [#1742](https://github.com/d-hinders/Haven-AI/issues/1742)
that distinction was a real hole rather than a pedantic one. The sweep's phases
and rows are sequential and `await`ed, so anything that never settles parks
every row behind it, every later phase, and the pooled Postgres connection the
leader lock holds for the whole tick. `revokeOnChain` awaited a bare
`tx.wait()`, which in ethers v6 has no deadline at all, so **one revoke whose
transaction never mined silenced the very alarm quoted above** — the one signal
that reports "agents revoked in Haven still hold a live attestation on-chain"
sat downstream of the stall that caused it. The wait is now bounded
(`PASSPORT_REVOKE_CONFIRM_TIMEOUT_MS`, 120s, under both the bump worker's 180s
adoption age and the 300s revocation lease), so a stuck revoke becomes a
scheduled retry — which the isolation above then handles as designed — instead
of a stalled sweep. Anything else added to this tick inherits no such ceiling
and must bound its own chain waits.

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

### What CLOSES a revocation

"Retries until they agree" needs something able to observe agreement, and until
[#1758](https://github.com/d-hinders/Haven-AI/issues/1758) only one thing could:
a fresh `revokeOnChain` returning a status-1 receipt. That is unreachable in the
case bounding the wait made ordinary. Once a revoke crosses its 120s deadline
and its transaction **later mines**, the attestation is revoked on-chain, so
every fresh attempt reverts `AlreadyRevoked` — recorded as a genuine revert,
rescheduled, forever at the 1h cap — while the bump worker that adopted the
transaction closes only the `outbound_txs` row and never reaches
`agent_passports`. The row stayed `pending` **permanently**: a false stuck-revoke
alarm that never cleared, and hourly relayer gas on a transaction that could
never succeed. Note the shape — this is the same non-convergence the
`claimRevocation` lease prevents between *concurrent* attempts, reappearing
**sequentially**, across the lease boundary.

`reconcileRevocation` now asks the chain before it spends anything: **is this
attestation already revoked?** — `revocationTime != 0`, read as of a *finalized*
block (falling back to ~300 blocks of burial, with the same
[#1745](https://github.com/d-hinders/Haven-AI/issues/1745) check that a node
claiming `finalized` is not just echoing the head). Three things follow, and
each is deliberate:

- **The evidence is positive and transaction-independent.** The revoked bit does
  not care which transaction set it, whether Haven ever saw a receipt, or
  whether an operator revoked by hand — so it converges cases no hand-off from
  the bump worker ever could. Decoding the `AlreadyRevoked` revert as success
  would have been the smaller change and is deliberately not what happens: a
  revert is a claim about one transaction, and it would still burn the gas
  before reinterpreting it.
- **It is read at a SETTLED block because `confirmed` is terminal.**
  `listStuckRevocations` never revisits a confirmed row, so writing it from a
  head read that a reorg then undid would silence the alarm for a still-live,
  merchant-readable credential — the exact inversion of the alarm's purpose.
- **Everything that is not `revoked` behaves as before.** No probe wired, a
  throwing probe, an unreadable UID, a `live` attestation: all fall through to
  submitting the revoke, which is what this code did before the probe existed.
  The probe can only ever remove a stuck row, never create a wrong one.

Migration 049 refuses `revocation_status = 'confirmed'` without a
`revocation_tx_hash`, so the convergence also needs the transaction that did it.
That comes from the durable outbound record (#1556) carrying this revoke's exact
calldata — `mined` (proven status-1) preferred over `broadcast`, never `failed`
or `replaced`. Where the chain agrees but no such record exists, the row stays
`pending` with a reason naming the missing pointer and still refuses to
broadcast: a fabricated hash in an audit column is worse than an honest alarm.

**Still open.** How long a revoke whose attestation is genuinely still live may
go unlanded before Haven declares it dead is *not* decided here. It is the
revoke-side face of [#1743](https://github.com/d-hinders/Haven-AI/issues/1743)'s
owner call, it is not derivable from the code, and such a row keeps retrying and
keeps alarming — correctly, because in that case the credential really is live.

## Verifying a passport (merchant-facing)

Two public, unauthenticated endpoints. The caller is a merchant deciding
whether to serve an agent; it has no Haven account and cannot be asked to get
one.

| Endpoint | Returns |
|---|---|
| `GET /passport/issuer` | The address to pin, the payload version, and the receipt TTL |
| `GET /passport/verify?address=0x…` or `?uid=0x…` | A **signed receipt**, or `{ found: false, reason: "no_passport" \| "unsupported_assurance_level" }` |

Resolution works from **either** agent address — the delegate EOA a merchant
sees on an EIP-3009 header, or the Hybrid account it sees as the delegator in
erc7710 redemption. #971 binds both precisely because #946 made settlement a
per-payment choice, so a merchant can verify from whichever address it holds.

**Duplicate bindings are refused at anchor time and resolved deterministically
(#1042).** `delegate_address` is client-supplied and unique only per-user among
non-revoked agents, so two anchored passports could otherwise reference the
same EOA (revoke-and-recreate, or a different user claiming the address). Two
defenses: the anchoring claim refuses while another agent's anchored,
unrevoked passport binds the same EOA — checked under an EOA-keyed advisory
lock so concurrent claims serialize — and the address lookup orders
unrevoked-first, newest-first with a stable tie-break, so a stale revoked
binding can never shadow the live credential. Re-binding a *revoked* holder's
address is deliberately allowed: that is the legitimate revoke-and-recreate
flow, and the old row loses deterministically.

An agent with **no passport is a normal 200 answer**, not a 404. Issuance is
opt-in, so most agents have none — and an error status is what makes an
integration treat a lookup failure as a pass.

`unsupported_assurance_level` follows the same rule for the same reason
([#975](https://github.com/d-hinders/Haven-AI/issues/975)): it means the
passport carries a level this build cannot summarise, so Haven declines to
answer rather than understate the tier. It is **not** an error status — the
snippet above destructures `receipt` off the body, so a 5xx would throw there
and whether that denies would be the merchant's `catch`. Handle it exactly like
`no_passport`: deny. Unreachable while the `agent_passport_level_issuable`
constraint pins the column to L0.

> **Widening the ladder is an ordered deploy.** Once the CHECK relaxes and an
> L1 row exists, any backend whose `ISSUABLE_ASSURANCE_LEVELS` predates the
> widening answers `found: false` for that agent — including mid-rolling-deploy
> and after a code rollback. Ship the code first, migrate second, and do not
> roll the code back past the migration.

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
- **`standingEpoch`, monotonic** — of two receipts for the same agent, the
  higher epoch is the newer one. `issuedAt` cannot do this: clocks skew. It
  provides **ordering only** ([#1015](https://github.com/d-hinders/Haven-AI/issues/1015)):

  - It tracks the last change to the agent's *record* (`agents.updated_at`), so
    it also moves on a rename or a key rotation. Do not build
    "epoch changed ⇒ standing changed" logic on it.
  - Every writer of `agents.status` also sets `updated_at` (pinned by a test),
    so of two receipts the one reflecting a revoke always carries the higher
    epoch. This does **not** let a merchant holding a single cached receipt
    detect a revoke — `expiresAt` and re-verification bound that, not this.
  - **Equal epoch does not mean equal receipt.** Anchor state (`anchor`,
    `evidenceUid`) lives in `agent_passports` and does not bump
    `agents.updated_at`, so a passport can become anchored with the epoch
    unchanged.
  - `0` means the row carried no timestamp. Two epoch-`0` receipts are mutually
    incomparable — the guarantee degrades rather than lying.

  A dedicated `standing_changed_at` column would make "standing changed" true.
  Deliberately not built until an integrator needs it: it is a migration, and
  changing what the field means is a signed-wire-format break
  (`RECEIPT_VERSION` is inside the signature).
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

## Presenting a passport with an x402 payment

The target is **present inline, verify authoritatively** ([#976](https://github.com/d-hinders/Haven-AI/issues/976)):
the agent carries a compact reference — the attestation UID — with the payment,
so a merchant **verifies rather than discovers**. Discovery means asking Haven
whether an agent has a passport at all; verification means already holding the
pointer and only confirming it.

What is actually deliverable depends on the settlement scheme, and the
narrowness is the point:

| Scheme | Reference rides the payment? | Delivery |
|---|---|---|
| **erc7710** (direct settlement) | Best-effort | `POST /x402/:id/settle` returns `passport: { attestation_uid, chain_id }`, optionally with `verify_url`. The agent presents it however the channel allows. The merchant already sees the delegation during redemption, so this is a **bonus, not the mechanism**. |
| **EIP-3009** ([#946](https://github.com/d-hinders/Haven-AI/issues/946) — the path with real merchant reach) | **No** | The merchant sees a **standard** header from the delegate EOA. The passport cannot ride a delegation chain that is not in the payment. `GET /passport/verify?address=…` is the only delivery **Haven provides to the agent** — `GET /agents/:id/passport` is dashboard-auth, so an agent cannot fetch its own UID, though an owner can hand it over out of band. |

**The 3009 row is why the verifier endpoint is primary, not a fallback.** The
scheme with actual merchant adoption cannot carry the reference at all.
Describing inline delivery as *the* mechanism would present the rarer path as
if it were the common one.

### The reference never goes in the X-PAYMENT header

x402 does not guarantee arbitrary-metadata passthrough. That header is parsed by
a merchant **facilitator Haven does not control**, and an unrecognised key in
the payload is a rejection risk — a failed payment traded for a nice-to-have. So
the reference rides Haven's own response body and the agent decides what to do
with it. A characterization test pins the header's exact key set against this
temptation.

### `verify_url` is a convenience, not a root of trust

The whole reference reaches a merchant **by way of the agent**: Haven returns it
on the settle response, and the agent forwards it over whatever channel it
likes. So every field is agent-controlled by construction — `verify_url`
included. An agent can substitute a URL it operates and have that URL answer
`{ found: true }` for anything. A merchant that resolves the supplied link is
asking the subject to vouch for itself.

**Merchants: take `attestation_uid` + `chain_id` and resolve them against a
verifier you already know** — your own pinned Haven base URL, or EAS on that
chain directly. Those two fields are safe to accept from an agent precisely
because they are checkable against a source the agent does not control. The URL
is not. Authority comes from the pinned issuer (`GET /passport/issuer`) and the
receipt signature, never from where the link pointed.

Haven emits `verify_url` only when it can be honest about it — a configured
`HAVEN_API_URL` **and** a live verifier (`PASSPORT_RECEIPT_SIGNING_KEY`; that
env var is independent of the schema UID, so a deployment can hold anchored
passports while `/passport/verify` 503s). Neither condition met means the field
is absent, not guessed: a link that always fails reads as a broken agent, while
absence is a documented normal answer.

### Absence is a normal answer

`passport` is `null` whenever there is nothing verifiable: no passport row at
all, or one whose status is `pending` or `failed`. Those are the only three
cases — the status enum is `pending | anchored | failed`, and an anchored row
without a UID cannot exist (`CHECK (status <> 'anchored' OR attestation_uid IS
NOT NULL)`, migration 048). A non-anchored passport is deliberately
**indistinguishable from none** — handing an agent a reference a merchant cannot
resolve produces a failed lookup that looks like a *revoked* agent, which is
worse than saying nothing.

A lookup **error** also never fails the payment: the call is wrapped in a total
`try/catch` that degrades to `null`. By the time the reference is attached the
payment is authorised and signed, and a passport is not worth a 500 on a settled
payment. That covers an error, not an unbounded *hang* — nothing here imposes a
timeout. The hang case is handled structurally instead, by computing the
reference **before** the `UPDATE … SET status = 'submitted'` so a slow query
cannot sit in the window where `payment_header` is unrecoverable.

## Registration and configuration

Registration is an **operator step** — an on-chain transaction needing a funded
key, whose UID does not exist until it lands:

```bash
npm run ops:register-passport-schema -w packages/backend            # dry run: verify pins
npm run ops:register-passport-schema -w packages/backend -- --send  # register
```

**It needs no database.** `RPC_URL_BASE_SEPOLIA` is optional (it defaults to
`https://sepolia.base.org`), and `--send` additionally needs
`PASSPORT_SCHEMA_REGISTRAR_KEY` — a **throwaway** testnet key, never the
relayer, which since #908 holds real Base mainnet ETH. Nothing else is
required: an operator runs this by hand, once, on a machine with no reason to
have a Postgres URL.

That property is easy to lose by accident and was lost once: pointing the
script at `modules/passport/index.js` pulls in issuance/revocation/verification,
which reach `config.ts`, whose `requireEnv('DATABASE_URL')` runs at import
time — so the probe died before its first line. It imports from `schema.js`
directly for that reason, and a guard test now spawns it with `DATABASE_URL`
removed to keep it that way.

The script is **fail-closed on the pins**. The EAS addresses in
`modules/passport/schema.ts` are the standard OP-Stack predeploys Base inherits,
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

The two variables are **independent**, so every combination is representable —
including issuance on with verification off, which anchors real passports no
merchant can verify. That state now reports itself: `GET /health` carries a
`passport` block (per-chain `state`, plus `unverifiableChainIds`) and the backend
logs one boot warning naming the chain. Booleans and the published issuer address
only — never key material, never the schema UID.

**The operator procedure lives in
[Passport verification setup](../operations/passport-verification-setup.md)** —
minting a dedicated signing key, setting it per environment, and the two-curl
smoke check that proves a real anchored passport verifies. Treat that runbook as
the reference rather than this section, which fixes the *design* and stops there.

## Related

- [Module boundaries](10-module-boundaries.md) — `modules/passport/` is a module
  with a public `index.ts`; import through it, never a private file.
- [Passport verification setup](../operations/passport-verification-setup.md) —
  the operator runbook for turning the merchant-facing verifier on.
- [Delegation-rail security model](../security/delegation-rail-security-model.md)
  — the custody perimeter the passport describes, and the zero-address posture.
- [x402 payment sequence](04-x402-payment-sequence.md) — the two settlement
  paths that force the dual address binding.
