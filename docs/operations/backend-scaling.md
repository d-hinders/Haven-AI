---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/rails/allowance-nonce-coordinator.ts
  - packages/backend/src/infra/repositories/allowance-nonce-watermarks.ts
  - packages/backend/src/platform/leader-lock.ts
  - packages/backend/src/infra/relayer.ts
last-verified: "2026-08-21" # #1680: rate-limit counters join the list of things multiple replicas now handle — the plugin's in-process store made the real ceiling max × replicas, fixed with a shared Postgres tier (fail-open, 250 ms deadline, leader-gated sweep) on the same pattern as the #718 nonce watermark. Prior: #1559: queue-lane nonce correctness is DB-arbitrated (submitRecorded stamp-before-broadcast); multi-replica correctness now gated only on the Safe-bound legacy sites (#1440); #1558 bump worker noted on the stall point
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
- **Allowance-nonce coordination on every legacy-rail sign-hash builder**
  ([#718](https://github.com/d-hinders/Haven-AI/issues/718),
  [#1196](https://github.com/d-hinders/Haven-AI/issues/1196)). #692 wired the
  coordinator into one call site; #1196 wired the other three
  (`routes/payments.ts`, `modules/mpp/send.ts`, `modules/mpp/authorize.ts`), so
  the guarantee is uniform rather than depending on which endpoint an agent
  happens to use. A structural test asserts every `generateTransferHash` caller
  also calls the coordinator, so a fifth builder cannot be added without one.

  Each site **prefetches** the shared watermark inside the `Promise.all` it
  already awaits for its chain reads, rather than reading it serially
  afterwards: a single indexed lookup against reads orders of magnitude slower
  costs nothing concurrently, and the bound and fail-open guards live in
  `readSharedWatermark` so no call site can prefetch and forget them.

  The AllowanceModule keeps one on-chain nonce per (safe, delegate, token),
  and after a confirmed transfer the next signature must target the incremented
  value. RPC reads lag, so [#692](https://github.com/d-hinders/Haven-AI/issues/692)
  added a coordinator that waits for the increment to become visible.

  That coordinator used to be a process-local `Map` — correct for exactly one
  replica. It is now two tiers: the map, plus a shared watermark in
  `allowance_nonce_watermarks` that any replica can read. The wait target is the
  **higher** of the two, so replica B waits on a transfer replica A confirmed.

  Every database interaction on that path is **fail-open**, and bounded as well
  as guarded. Both layers catch, and the coordinator additionally races the
  lookup against a 250 ms deadline — because a rejection is the easy failure and
  a query that is slow but never settles is the one that would actually hang a
  payment. Nothing else would stop it: the pool sets no `statement_timeout` and
  Fastify sets no request timeout. A database problem therefore degrades this to
  the old in-process behaviour — a retry at worst — because trading a rare retry
  for an outage is the wrong direction on a money path. The
  [#693](https://github.com/d-hinders/Haven-AI/issues/693) preflight remains the
  thing that keeps the money safe under every failure mode; nothing here is
  load-bearing for correctness.

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

## What still serialises: the relayer

One relayer EOA per chain signs every sponsored transaction (Safe deploys,
owner-signed execs, Hybrid deploys, allowance transfers, sweeps). An EOA has a
single sequential nonce, so **replicas do not multiply relayer throughput** —
they queue behind the same key. Two consequences worth planning around:

1. **Throughput ceiling.** Adding replicas raises how many requests you can
   accept, not how many transactions you can land. The bottleneck moves to the
   relayer, and past that point new replicas buy latency, not capacity.
2. **Single point of stall — now self-healing on the queue lane.** One stuck
   transaction blocks every later submission on that chain. Since #1558 the
   leader-locked bump worker replaces a stuck queue-lane tx with bumped fees
   (and alerts after 3 attempts); the Safe-bound legacy sites have no bump
   path until they retire (#1440).

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
