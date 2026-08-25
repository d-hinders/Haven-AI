---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/platform/leader-lock.ts
  - packages/backend/src/rails/hybrid-provisioning.ts
  - packages/backend/src/infra/relayer.ts
last-verified: "2026-08-25" # #2055: the split-out note records both halves resolved (#2020 shipped; approval_requests dropped). Prior: #1990: the "Allowance-nonce coordination" subsection said the inert `allowance_nonce_watermarks` table would go when "#1990's job" of dropping tables came round. It would not have: #1990 scoped three named tables and this was never one of them, and #1990 then shipped narrower still — only `safe_approver_metadata`, with `agent_allowances` and `approval_requests` split out to #2020/#2021 after enumeration found live readers on both. The subsection now records the table as inert with NO tracked removal issue, and flags #1993's residue sweep as the likelier home. Scope: that one sentence — the multi-replica lesson, the two-tier fix, the outbound queue, rate-limit counters and the deploy lock were not re-verified. Prior: #1987: the "Allowance-nonce coordination" subsection described machinery this slice DELETED (the coordinator, the watermark repository, `readSharedWatermark`, the structural test, all four call sites, and `generateTransferHash`) entirely in the present tense — rewritten past-tense behind an explicit deleted-banner, and kept rather than removed because the multi-replica lesson outlives the rail. Records that the `allowance_nonce_watermarks` TABLE survives and is now inert until #1990. Other subsections (outbound queue, rate-limit counters, deploy lock) re-read and unaffected. Prior: #1745: the "single point of stall" entry drops the ordering constraint it carried — no duplicate attest is queued while the stuck one is live — and records that the operator's same-nonce cancel now completes issuance by itself. The blocked-lane trade itself is unchanged. Prior: #1735: the "self-healing on the queue lane" claim gains its exception — a stuck `passport_attest` is deliberately NOT fee-replaced (a replacement orphans the hash #1043 recovery is keyed off), so that lane blocks until an operator acts; cross-ref to the #1745 ordering constraint. Prior: #1722: the deploy lock's connection hold now has a real ceiling — the confirmation wait is `tx.wait(1, 120_000)`, bracketed under the bump worker's 180 s adoption age, and expiry hands the tx to that worker instead of marking the record failed. The rest of the accept (burst threshold, fail-open scoping, the 502 shape) re-read and unchanged. Prior: #1680: rate-limit counters join the list of things multiple replicas now handle — the plugin's in-process store made the real ceiling max × replicas, fixed with a shared Postgres tier (fail-open, 250 ms deadline, leader-gated sweep) on the same pattern as the #718 nonce watermark. Prior: #1559: queue-lane nonce correctness is DB-arbitrated (submitRecorded stamp-before-broadcast); multi-replica correctness now gated only on the Safe-bound legacy sites (#1440); #1558 bump worker noted on the stall point
---

# Backend Scaling

What the backend can and cannot do when you add replicas. Short version: **you
may now run more than one, and the relayer is what still caps throughput.**

## What multiple replicas already handle

- **Periodic monitors** — every replica starts the same `setInterval` ticks, so
  each one is wrapped in `runIfLeader` (`platform/leader-lock.ts`). A Postgres
  advisory lock elects one executor per tick; the losers skip rather than queue.
  Without it, an N-replica deployment runs every scan N times and sends up to N
  copies of each alert.
- **First-deploy races on one counterfactual account**
  ([#1673](https://github.com/d-hinders/Haven-AI/issues/1673)). `runIfLeader`'s
  blocking sibling, `withKeyedAdvisoryLock`, serialises the callers that must
  WAIT and then observe what the winner did — a monitor tick that loses the
  race should be skipped, but an account deploy that loses still owes its
  caller an answer. `ensureHybridDeployed` holds it per `(chain, address)` from
  the bytecode check through to the mined receipt, so two concurrent first
  payments from a brand-new agent cannot both pass the check and both broadcast
  a deploy to the same CREATE2 address. Fail-open by construction: an
  unavailable lock degrades to the pre-#1673 duplicate deploy, which costs a
  second relayer gas spend rather than correctness. Read that as scoped to the
  lock — the *request* can still fail, because whatever made the lock
  unavailable can hit the guarded work too. What the hold costs, and why it is
  accepted anyway, is worked through in *Accepted cost* below.
- **Allowance-nonce coordination on every legacy-rail sign-hash builder —
  DELETED (#1987), retained here as the record of a solved problem**
  ([#718](https://github.com/d-hinders/Haven-AI/issues/718),
  [#1196](https://github.com/d-hinders/Haven-AI/issues/1196)).

  > ⚠️ **None of the machinery described below still exists.** Epic #1440
  > slice #1987 deleted `rails/allowance-nonce-coordinator.ts`,
  > `infra/repositories/allowance-nonce-watermarks.ts`, `readSharedWatermark`,
  > `waitForFreshAllowanceNonce`, the structural test that policed the
  > builders, and every one of the four call sites — together with
  > `generateTransferHash` itself. It went with the AllowanceModule rail's
  > execution half, which #1986 had already fail-closed at HTTP 410. **The
  > `allowance_nonce_watermarks` TABLE is still there and is now inert**, and
  > **has no tracked removal issue**. #1990 was never going to drop it: that
  > slice scoped three named tables, this was not one of them, and #1990
  > shipped narrower still — dropping only `safe_approver_metadata`, with
  > `agent_allowances` and `approval_requests` split out to #2020 and #2021 (both since resolved: #2020 retired the allowances surface; #2055 dropped `approval_requests`)
  > after enumeration found live readers on both. Whether this table wants
  > its own slice or belongs on #1993's residue sweep is an open call; do not
  > assume someone owns it. The
  > delegation rail has no equivalent problem: it has no allowance nonce, and
  > its budget is metered on-chain by the caveat enforcers.
  >
  > This subsection is kept rather than deleted because the multi-replica
  > lesson outlives the rail — a process-local `Map` is correct for exactly
  > one replica, and the two-tier fix below is the shape any future
  > cross-replica coordination should copy. Read every present tense in it as
  > past tense.

  #692 wired the coordinator into one call site; #1196 wired the other three
  (`routes/payments.ts`, `modules/mpp/send.ts`, `modules/mpp/authorize.ts`), so
  the guarantee was uniform rather than depending on which endpoint an agent
  happened to use. A structural test asserted every `generateTransferHash`
  caller also called the coordinator, so a fifth builder could not be added
  without one.

  Each site **prefetched** the shared watermark inside the `Promise.all` it
  already awaited for its chain reads, rather than reading it serially
  afterwards: a single indexed lookup against reads orders of magnitude slower
  cost nothing concurrently, and the bound and fail-open guards lived in
  `readSharedWatermark` so no call site could prefetch and forget them.

  The AllowanceModule kept one on-chain nonce per (safe, delegate, token),
  and after a confirmed transfer the next signature had to target the
  incremented value. RPC reads lag, so
  [#692](https://github.com/d-hinders/Haven-AI/issues/692) added a coordinator
  that waited for the increment to become visible.

  That coordinator used to be a process-local `Map` — correct for exactly one
  replica. It became two tiers: the map, plus a shared watermark in
  `allowance_nonce_watermarks` that any replica could read. The wait target was
  the **higher** of the two, so replica B waited on a transfer replica A
  confirmed.

  Every database interaction on that path was **fail-open**, and bounded as well
  as guarded. Both layers caught, and the coordinator additionally raced the
  lookup against a 250 ms deadline — because a rejection is the easy failure and
  a query that is slow but never settles is the one that would actually hang a
  payment. Nothing else would have stopped it: the pool sets no
  `statement_timeout` and Fastify sets no request timeout. A database problem
  therefore degraded this to the old in-process behaviour — a retry at worst —
  because trading a rare retry for an outage is the wrong direction on a money
  path. The [#693](https://github.com/d-hinders/Haven-AI/issues/693) preflight
  remained the thing that kept the money safe under every failure mode; nothing
  here was load-bearing for correctness.

- **Rate-limit counters** ([#1680](https://github.com/d-hinders/Haven-AI/issues/1680)).
  `@fastify/rate-limit` ships an in-process LRU store, so every replica counted
  only the requests routed to it: the effective ceiling was `max × replicas`,
  and it ROSE with load, because more traffic means more replicas. That is the
  worst direction for a control whose job is to bound automation, and it was
  invisible from inside — live probing of dev read `x-ratelimit-remaining` back
  as two interleaved descending series, which is what the defect looks like
  from outside.

  The store is now `rate_limit_counters`, one row per bucket key, incremented
  by a single `ON CONFLICT DO UPDATE` so concurrent replicas serialise on the
  row rather than racing. Same two obligations as the nonce watermark above,
  and for sharper reasons: it is **fail-open** — a database error or a query
  past the 250 ms deadline degrades to per-replica counting, because this
  guards SIGNUP AND LOGIN and failing closed would lock every user out of the
  product's front door over a hiccup. Every degradation is logged, since
  falling back silently is the failure it was built to end.

  It also does **not** consult the database for a client already over its
  limit: the answer cannot change until the window ends, so it is cached in
  memory. The table is written by unauthenticated traffic, so without that a
  flood would cost one row-locked upsert per request — cheap HTTP amplified
  into contention on a single hot row. Expired rows are swept on a
  leader-gated tick; a missed sweep leaves dead rows, never a wrong count,
  because every read filters on expiry.

### Accepted cost: the deploy lock holds a pooled connection ([#1686](https://github.com/d-hinders/Haven-AI/issues/1686))

`withKeyedAdvisoryLock` holds one connection from the **shared application
pool** (`DB_POOL_MAX`, default 20) for as long as the work it serialises runs.
For its only caller today that work spans `submitRecorded` and `tx.wait()`, so
the hold is a chain round-trip — normally seconds.

**The tail is bounded at 120 s** ([#1722](https://github.com/d-hinders/Haven-AI/issues/1722)).
The wait is `tx.wait(1, HYBRID_DEPLOY_CONFIRM_TIMEOUT_MS)` — 120 000 ms — so the
worst-case hold is that deadline plus the surrounding round-trips, not "however
long the transaction takes". Until #1722 the call was bare, and ethers v6's
`wait(confirms?, timeout?)` waits indefinitely that way: a transaction that
never mined (an RPC hiccup, or a base-fee spike past the doubled headroom
`getRelayerFeeOverrides` applies) held its connection for as long as it took.
The accept below rests on the hold being short; this is what makes it so.

The value is bracketed rather than round: one confirmation of a single factory
call on 2 s Base blocks is a handful of blocks, so 120 s never fires on a
healthy deploy; and it sits under `STALE_BROADCAST_SECONDS` (180 s), the age at
which the bump worker adopts a `broadcast` row — so the request has released
the lock, and its connection, before another owner can take the transaction.

**Expiry hands off, it does not fail.** A wait timeout cancels nothing: the
transaction stays in the mempool and may still mine, so the durable outbound
record (#1556) is deliberately left `broadcast` for the bump worker (#1558) to
adopt and, if needed, replace with bumped fees — never marked failed, which
would strand it between two owners. The caller sees the same retryable **502**
it already gets for any other deploy failure, and a retry is safe because the
factory deploy is permissionless, relayer-paid and idempotent on-chain: a
duplicate costs gas and nothing else.

Two residual costs, named because they are accepted rather than absent. Each
retry after an expiry opens its OWN `outbound_txs` row at its own nonce, so a
persistently stuck RPC can leave several `broadcast` rows for one account, each
bumped independently once it ages past 180 s — relayer gas amplification,
bounded by `MAX_BUMPS_PER_NONCE` per lane and by the relayer budget guard
(#717), never a fund risk. And only a `TIMEOUT` takes the hand-off branch: any
other wait error (a transient RPC exception mid-wait) still closes the record
failed, exactly as before #1722 — unchanged behaviour, not a new gap, but the
same ambiguity in a narrower window.

**The burst that would hurt** is brand-new accounts deploying at once. Each
holds a lock connection while, inside that same critical section, the relayer
budget check, the spend row, the outbound record and the `submitRecorded` stamp
compete for the *remaining* pool headroom. Near the ceiling, unrelated requests
app-wide pay up to `DB_POOL_CONNECTION_TIMEOUT` (default 5 s) before their own
`connect()` resolves or rejects.

State the threshold carefully, because the crisp version flatters it. It is not
"20 distinct new accounts": every entrant checks out a connection *before* the
lock is attempted, so callers that merely block count too. And the pool is
shared with all other traffic rather than reserved for this path — so the real
threshold is 20 minus whatever else the backend is doing.

Worse, the retries are not independent of the burst. A deploy that fails leaves
no bytecode, so the fast path does not engage and the retry re-enters the lock
for the same account — and both call sites invite that retry by design
(`delegation-authorize.ts` says so in as many words: "a failed deploy leaves
nothing half created and authorize can simply be retried"). The failures that
produce those retries — RPC trouble, a gas spike past the fee headroom, a
relayer budget cap — are exactly the conditions a burst creates. So the same
few accounts can re-enter concurrently, and the number of *distinct* accounts
needed to threaten the pool is lower than the headline figure suggests. Treat
"on the order of 20" as the optimistic end of the range, not the bar.

**Why this is accepted rather than fixed.** Both call sites
(`modules/x402/delegation-authorize.ts`, `routes/agent-delegations.ts`) pass
`expectedAddress`, so the pre-lock `getBytecode` fast path short-circuits
permanently once an account exists. The lock is therefore reached about **once
per account** — never on the payment hot path. ("Ever" would overstate it: a
deploy that reverts leaves bytecode absent, so a legitimate retry re-enters the
critical section for that account again.) At dev-pilot volume the burst above
is not reachable.

**Be precise about what failing open does and does not promise**, because the
distinction is most of the reason to write this down: it protects the LOCK, not
the work the lock guards. As it happens, almost all of that work protects
itself. `assertRelayerBudget` and `recordRelayerSpend` are fail-open against a
database error — "Fail OPEN — availability guard" and "Never throws" in their
own doc comments (`infra/relayer-spend-guard.ts`) — and `openOutboundRecord`
catches, warns, and continues with a null id, which `infra/outbound-queue.ts`'s
header states as deliberate policy. (`assertRelayerBudget` does throw when the
gas cap is genuinely exceeded; that is the guard working, not a pool symptom,
and it surfaces as a 429.)

The **one** write in that section that is not fail-open is `submitRecorded`'s
stamp, `markOutboundTxBroadcast`: it catches a unique violation to retry the
nonce lane and rethrows everything else, because `infra/repositories/outbound-txs.ts`
is fail-closed on purpose — post-#1559 the stamp IS the nonce fence, not an
optimisation, so degrading it would trade a latency problem for a correctness
one. That is the write a pool timeout can actually break, and it is the right
one to have chosen. It surfaces as a retryable **502** at both call sites
(`POST /x402/authorize` and grant activation; a 429 there means the relayer
budget cap, not the pool).

So the honest worst case is a failed payment *attempt*, not merely added
latency. What stays safe is the part that matters: authorize fails closed
BEFORE the intent row exists so nothing is left half-created, the factory
deploy is permissionless and grants its deployer nothing, and no funds move.
Wasted gas and a retry — never a loss.

Stated plainly, because it is the uncomfortable part: **the mitigation for pool
exhaustion is losing the mitigation.** That equilibrium is defensible while the
only caller is once-per-account-rare. It is not one to leave undocumented,
which is why it is written here rather than merely assumed.

**Three triggers, any of which reopens this as real work:**

1. A second, more frequent caller of `withKeyedAdvisoryLock`. Its doc comment
   names once-per-subject-rare as a constraint on new callers for exactly this
   reason.
2. Onboarding volume where tens of first-ever payments land within seconds.
3. An existing call site quietly ceasing to pass `expectedAddress`. This one
   deserves naming separately because trigger 1 would not catch it: no caller
   is added, `expectedAddress` is optional and unenforced beyond its `?`, and
   the "once per account" guarantee erodes with nothing mechanical to flag it.

**The shape to build when triggered** is shrinking the critical section: hold
across the bytecode check and the *broadcast*, release before `tx.wait()`, and
have queued callers poll instead of waiting on the lock. Note the trap before
reaching for it — releasing after broadcast does **not** close the
duplicate-broadcast window on its own, because bytecode stays `0x` until the tx
is *mined*, so a queued caller re-checking inside the lock would still see
nothing and broadcast a duplicate. A correct shrink needs in-flight detection
via the durable `outbound_txs` record
([#1556](https://github.com/d-hinders/Haven-AI/issues/1556)), a polling path
for the loser, and a degraded path past the poll deadline. The state machine
for that exists (queued/broadcast/mined/failed) — but not a lookup scoped to
"is there an in-flight row for this account", so the work includes writing and
indexing that query, not just wiring a poll onto something ready-made.

The alternative, if isolation is preferred over shrinking, is a **dedicated
small pool for advisory locks** — lock holds then cannot starve request-serving
queries, at the cost of a second pool to configure and monitor.

## What still serialises: the relayer

One relayer EOA per chain signs every sponsored transaction (Safe deploys,
owner-signed execs, Hybrid deploys, allowance transfers, sweeps). An EOA has a
single sequential nonce, so **replicas do not multiply relayer throughput** —
they queue behind the same key. Two consequences worth planning around:

1. **Throughput ceiling.** Adding replicas raises how many requests you can
   accept, not how many transactions you can land. The bottleneck moves to the
   relayer, and past that point new replicas buy latency, not capacity.
2. **Single point of stall — self-healing on the queue lane, with one named
   exception.** One stuck transaction blocks every later submission on that
   chain. Since #1558 the leader-locked bump worker replaces a stuck
   queue-lane tx with bumped fees (and alerts after 3 attempts); the
   Safe-bound legacy sites have no bump path until they retire (#1440).

   The exception, deliberate since [#1735](https://github.com/d-hinders/Haven-AI/issues/1735):
   a stuck **`passport_attest`** is NOT replaced. A same-nonce replacement is
   safe on-chain — at most one transaction per nonce mines — but it mints a
   new tx hash, and the anchor's #1043 receipt recovery is keyed off the hash
   it recorded; a replaced attest becomes unfindable and issuance re-mints,
   producing a second live, revocable credential. So the worker alerts
   (`outbound-bump: stuck broadcast from a non-idempotent submitter`) and the
   **lane stays blocked until an operator intervenes**. That is the accepted
   trade: a blocked lane is loud, bounded and human-recoverable; a duplicate
   attestation is silent and permanent. See
   [`delegation-rail-vendor-ops.md`](delegation-rail-vendor-ops.md) §3 for the
   operator response. The ordering constraint that procedure used to carry —
   check for a duplicate attest the sweep already queued at the next nonce,
   because cancelling would release it — is **gone since
   [#1745](https://github.com/d-hinders/Haven-AI/issues/1745)**: the passport
   retry now re-mints only on positive evidence that the stuck transaction can
   never mine (its nonce consumed by something else), so no duplicate is queued
   while it is live. That also makes the cancel below self-completing — once it
   mines, the burned nonce is exactly the evidence the sweep needs, and
   issuance recovers on its next tick without further operator action. The
   cancel remains **necessary**, though: a dropped attest does not free its own
   nonce here, because its row is still `broadcast` and 061's partial UNIQUE
   `(chain_id, nonce) WHERE status = 'broadcast'` refuses the stamp, so the
   queue cannot take the slot back by itself.
   Unblocking the lane automatically still wants that same-nonce **cancel**
   (a 0-value self-send), which would clear the lane *and* definitively kill
   the attest so a fresh anchor is correct — a new mechanism, deliberately not
   built under #1735.

   The lane's other passport tenant, `passport_revoke`, **is** rebroadcast-safe
   and so is fee-replaced normally; when one of those stalls anyway, the
   operator procedure is
   [`stuck-revoke-alarm.md`](stuck-revoke-alarm.md).

### Multi-replica CORRECTNESS: closed for the queue lane (#1559)

The correctness half of the old constraint — two replicas reading the same
pending nonce and colliding — is **closed for queue-lane submitters** (sweeps,
Hybrid deploys, passport anchors, the bump worker). They submit through
`infra/outbound-queue.ts`'s `submitRecorded`: sign → **stamp** the durable
`outbound_txs` row under the partial UNIQUE (chain, nonce) live-broadcast
index → broadcast. Postgres arbitrates the nonce lane: the losing replica's
stamp is rejected, it re-reads and re-signs. The guarded stamp doubles as the
fence — whoever stamps, sends.

The Safe-bound legacy sites (`safe-deploy`/`safe-exec`, allowance transfers,
the deployers) still rely on the in-process `withRelayerSendLock` only, so
**multi-replica remains gated on them** until #1440 retires the rail. The
throughput ceiling above is unchanged either way — one key is still one
sequential nonce.

### Evaluation: a relayer key pool

[#718](https://github.com/d-hinders/Haven-AI/issues/718) asked whether to move to
N round-robin keys per chain. The finding is **not yet, and here is the
threshold** — the change is cheap to build and expensive to operate, so it should
follow evidence rather than precede it.

| | Single key (today) | Key pool (N per chain) |
|---|---|---|
| Throughput | 1 in-flight tx per chain | N, near-linear |
| Stuck tx | stalls the chain | stalls 1/N of capacity |
| Funding | one balance to watch | N balances, N low-balance alerts |
| Key custody | one secret per environment | N secrets, N rotations |
| Attribution | trivial | needs the spending key on every row |
| Mainnet posture | the recorded [#908](https://github.com/d-hinders/Haven-AI/issues/908) waiver covers ONE shared key | a new decision — the waiver does not extend to a pool |

**Build it when** the relayer-gas events
([#717](https://github.com/d-hinders/Haven-AI/issues/717), table
`relayer_gas_events`) show submissions queueing — the signal is submission
latency rising while request latency stays flat, or a measured backlog on one
chain. That data now exists, which is why this is an evidence question rather
than a guess.

**Do not build it as a reliability fix for stuck transactions.** A pool reduces
the blast radius of a stall from 100% to 1/N; it does not prevent one. Fee
bumping and replacement handling address the cause, a pool only dilutes the
symptom, and it is possible to have both — in that order.

### Before adding a pool

Whoever picks this up should read the interaction with two existing pieces:

- `infra/relayer-spend-guard.ts` (#717) attributes spend per caller; a pool needs
  the spending key recorded alongside, or attribution silently aggregates across
  keys.
- The mainnet gate's waiver ([#908](https://github.com/d-hinders/Haven-AI/issues/908))
  was recorded for a single shared relayer key. N keys is a different risk
  statement and needs its own decision, not an inherited one.

## Operating notes

- Replica count is a Railway setting; nothing in the code reads it.
- `allowance_nonce_watermarks` is disposable. Losing it degrades to the
  pre-#718 in-process behaviour, never to incorrectness — so it needs no backup
  policy of its own.
- **The riskier direction is a row that is too HIGH, not a missing one.** The
  write is backed by a single confirmation, so a reorg (or an RPC reporting a
  nonce from a dropped block, or two environments sharing a database) can
  persist a nonce the chain never reaches — and `GREATEST` means it can never
  come back down. The read therefore ignores any row older than **5 minutes**:
  the window this tier closes is seconds-scale RPC lag, so an older watermark
  carries no information, and bounding it caps the damage of a bad row at
  minutes rather than permanently. Without that bound, one bad row would make
  every later authorize for the triple poll to the full timeout, forever,
  surviving restarts.
- The watermark only ever rises (`GREATEST` in the upsert). A lower incoming
  value can only be a late write from a replica that fell behind, and honouring
  it would re-open the window the table exists to close.
