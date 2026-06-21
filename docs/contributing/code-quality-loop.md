# Haven Code Quality Loop

Last updated: 2026-06-21

The running handoff for Haven's **small-PR code-quality cadence**: each pass
finds one narrow, high-value area, hardens it with a guarded and revertable PR,
and records the result here so the next pass starts warm.

> **Not the same as the oracle-grounded loops.** This file is a human-curated
> cadence of small quality PRs. The *oracle-grounded differential loops* (a
> coding agent fuzzes a surface against an independent oracle and leaves a
> permanent differential test) are a different tool — see
> [`loop-engineering.md`](./loop-engineering.md) and the portfolio in
> [`loop-harness-index.md`](./loop-harness-index.md). They compose: when a pass
> here finds a surface that *mirrors or predicts a source of truth*, the right
> move is often to hand it to an oracle-grounded loop rather than write static
> tests.

## How to run a pass

The PR shape ("reject X before Y runs", "guard this terminal-state
transition", "make this contract explicit") is solid — keep it. These five
steps exist to counter the loop's failure modes (drifting toward easy-to-find
work, never measuring whether the codebase is actually healthier, and
self-grading).

1. **Discover against today's code, not this backlog.** The backlog below goes
   stale between passes — surfaces ship, targets land, priorities move. Start
   every pass with a fresh scan (see "Discovery protocol") and reconcile the
   backlog *before* picking a target. Treat any backlog entry older than a few
   weeks as a hypothesis to re-verify, not a work order.
2. **Pick by value, not by findability.** Schema-tightening and validation
   guards are easy to spot, so the loop drifts toward them and quietly defers
   the hard, high-blast-radius work. Each pass, explicitly ask: *is this the
   highest-value narrow target, or just the easiest one I found?* Money
   movement, agent authority, and external financial writes outrank cosmetic
   contract polish.
3. **Keep the PR small, guarded, and revertable.** One surface, terminal
   state, regression coverage for the thing you fixed. No behavior change
   smuggled into a "schema-only" PR. If the fix needs a migration, custody/
   signing change, or multi-entrypoint rewrite, it is a *track* (see "Planned
   tracks"), not a single pass.
4. **Verify independently before marking done.** The loop both picks and grades
   its own work, so "completed" must mean *verified*, not *claimed*. Before
   moving an item to Completed: run the focused checks (`test` / `typecheck` /
   `build` for the package, plus `git diff --check`), and for anything touching
   money movement, agent authority, shared API contracts, status transitions,
   or primary UX, get a `haven-reviewer` pass or a CI assertion that encodes the
   invariant. Prefer leaving a *machine* check behind over a prose claim.
5. **Update the ledger and the coverage map.** Append to Completed Areas, and
   update the Coverage Map so progress is visible as *which surfaces are
   hardened*, not just *how many PRs landed*.

### Discovery protocol

A fast scan to ground each pass in current reality (run from repo root /
`packages/backend`):

- **What landed since last update?** `git log --oneline` since the date at the
  top of this file; reconcile new surfaces against the backlog.
- **Contract drift:** new/changed routes that are missing from
  `src/openapi/spec.ts`, and response shapes typed as bare `string` at the
  DB/API boundary.
- **Test gaps:** route handlers and money/integration libs with no
  route-level/lib-level test (compare `src/routes/*.ts` against
  `src/routes/__tests__/`).
- **Money/precision smells:** `parseFloat` / `Number(` on amounts, formatted
  strings used as quantities, FX/rounding at write time.
- **Secret hygiene:** credential/token fields in new surfaces that could leak
  into responses, logs, errors, or generated artifacts.
- **Idempotency claims:** any "never double X" / dedup / reconciliation code
  whose guarantee is not pinned by a test or an oracle-grounded loop.

## Current Run

- **Status:** between passes — needs a target picked from the refreshed backlog.
- **Prior two targets have landed** and are verified in OpenAPI/tests:
  `MachinePaymentReceipt.proof_status` is an explicit enum
  (`payment_confirmed | merchant_response_observed | protocol_receipt_attached`)
  and `MachinePaymentReceipt.rail` is a required `AgentPaymentRail` reference.
  Both are in `packages/backend/src/openapi/spec.ts`.
- **Discovery snapshot (2026-06-21):** a large surface area shipped since the
  last loop update (2026-06-06) — the reporting feed (connector / orchestrator /
  dedup ledger), Fortnox connection + export, accounting (booking / SIE / VAT /
  BAS), the merchant catalog + discovery, payment fees, delegate sweeps, and
  reconciliation. The new financial-integration surfaces — not the original
  payment routes — are now the highest-risk frontier, and they ship with thinner
  contract and route-level test coverage than the older code.

## Priority Backlog

Refreshed 2026-06-21 against current code. Ordered by blast radius, not by ease.

- **P0 — Reporting/accounting export correctness.** The reporting feed writes
  financial records to external systems (Fortnox). `feed-sync.ts` claims
  "never double-post" via a unique `(provider, payment_id, user_id)` dedup
  ledger with an atomic claim; `feed-orchestrator.ts` is "idempotent and
  resumable". That guarantee is a money-trust invariant and is not yet pinned by
  a route-level regression test or an oracle-grounded loop. Also verify
  book-time FX and rounding (`026_machine_payment_book_time_fx`) are applied
  consistently. *Surfaces:* `src/lib/reporting/feed-sync.ts`,
  `src/lib/reporting/feed-orchestrator.ts`, `src/routes/reporting.ts`,
  `src/routes/accounting.ts`.
- **P0 — Agent credential & external-token hygiene (new surfaces).** Fortnox
  `access_token`/`refresh_token` are stored server-side; confirm they never
  surface in API responses, logs, errors, or generated artifacts, matching the
  redaction bar already set for delegate keys (PRs #261–#264). *Surfaces:*
  `src/lib/fortnox-connection.ts`, `src/routes/fortnox.ts`.
- **P1 — OpenAPI contract drift.** `reporting`, `fortnox`, `accounting`, and
  `x402-resources` routes have **zero** entries in `src/openapi/spec.ts`; the
  published contract no longer matches the surface. Classic narrow,
  schema/test-only loop targets — one route family per PR.
- **P1 — Route-level test coverage for untested handlers.** `accounting.ts`,
  `reporting.ts`, `fortnox.ts`, `x402-resources.ts`, `contacts.ts`, and
  `demo-mpp.ts` lack route-level tests (some have lib-level coverage). Prefer
  tests that assert an invariant (auth required, idempotent write, no
  double-post) over tests that pin current output.
- **P1 — Backend/API validation & error responses on new surfaces.** Apply the
  established "reject invalid input before doing work" pattern (PRs #259, #260,
  #271) to the reporting/fortnox/accounting/catalog inputs.
- **P2 (carried) — x402 / generic machine-payment consolidation.** Still the
  highest-value *hard* item and still the one the loop keeps deferring. It has
  been promoted to a Planned Track (PT-1) so it stops being deferred by default.

## Coverage Map

A standing view of *which surfaces are hardened* so the loop has a notion of
"done" beyond an append-only PR count. Update it whenever a pass changes a row.

| Surface | State | Evidence |
| --- | --- | --- |
| Allowance routing math (auto-exec vs queue) | ✅ Hardened | LP-1/LP-2 oracle-grounded loops, converged |
| Payment/approval terminal-state guards | ✅ Hardened | PRs #258, #272; backend regression tests |
| x402/MPP amount & challenge validation | ✅ Hardened | PRs #259, #260 |
| Credential handoff (delegate keys) | ✅ Hardened | PRs #261–#264; redaction tests |
| Chain-scoped reads (balance/tx/activity) | ✅ Hardened | PRs #265–#270 |
| Owner-side allowance mirror writes | ✅ Hardened | PRs #271, #275, #276 |
| Reconciliation event status contract | ✅ Hardened | PRs #277, #278; OpenAPI enum |
| Machine-payment receipt contract (rail, proof_status) | ✅ Hardened | OpenAPI enums + tests |
| Reporting/accounting export (dedup, FX, idempotency) | ⚠️ Thin | dedup ledger exists; no route-level/invariant test |
| External-token hygiene (Fortnox) | ❓ Unverified | server-side storage; redaction not audited |
| OpenAPI coverage of reporting/fortnox/accounting/x402-resources | ❌ Missing | 0 spec.ts entries |
| Route-level tests for the above handlers | ❌ Missing | no `__tests__` entry |
| x402 / generic machine-payment consolidation | ⏳ Tracked | PT-1 |

## Planned Tracks

Work too large for one pass but too important to defer indefinitely. A track is
a *named, multi-PR plan with an explicit trigger* — the antidote to the loop
quietly avoiding its hardest item.

- **PT-1 · x402 / generic machine-payment consolidation.** Crosses idempotency,
  approval-state, expected-context binding, and multi-entrypoint behavior, so it
  cannot be one small PR. Plan: (1) map the legacy `/x402` vs newer
  machine-payment helper divergence and write characterization tests for both;
  (2) define the shared idempotency/metadata contract; (3) migrate entrypoints
  one at a time behind the shared helper; (4) retire the divergent path.
  **Trigger:** start when the next pass would otherwise touch `routes/x402.ts`
  or `lib/machine-payments.ts`, or after two consecutive passes land only P1/P2
  contract polish (the signal the loop is avoiding the hard work).

## Completed Areas

- PR #258: machine-payment one-shot signature recording no longer sets `submitted` before RPC execution; regression coverage asserts pre-RPC SQL/call order and records `submitted_at` only when a tx hash exists.
- PR #259: x402 amount validation rejects hex, scientific notation, signed, negative, zero, blank, and whitespace-wrapped atomic values before payment work begins.
- PR #260: MPP demo challenge validation rejects invalid `expiresAt` timestamps before authorization, allowance, hash, or execution helpers run.
- PR #261: MCP split credential loading rejects mismatched `agent_id`, `safe_address`, `delegate_address`, `chain_id`, and `network` metadata before returning a merged credential.
- PR #262: signer credential loading accepts only positive integer `chain_id` / `HAVEN_CHAIN_ID` values and rejects malformed present values without leaking delegate key material.
- PR #263: env-based SDK/Python runtime examples reference `HAVEN_API_KEY` / `HAVEN_DELEGATE_KEY` but no longer echo raw credential values in comments.
- PR #264: generated handoff and skill-bundle tests assert reusable examples, skill descriptors, package metadata, and zip paths remain free of raw credential values.
- PR #265: chain-scoped Safe details and connected setup approval readiness prevent stale selected-wallet state or late Safe-detail responses from driving wallet approval and other money/authority readiness paths.
- PR #266: chain-scoped balance and portfolio reads prevent duplicate-address Safes and overlapping token symbols from driving wrong funding readiness or account totals.
- PR #267: chain-scoped transaction/activity reads prevent duplicate-address Safes from fetching, deduping, previewing, or labeling activity against the wrong chain.
- PR #268: x402/payment-history enrichment resolves and applies agent/payment labels by Safe and chain identity instead of transaction hash alone.
- PR #269: temporary frontend x402 bridge was retired, and agent activity feeds publish stored payment/approval Safe identity instead of an agent's current Safe.
- PR #270: list-level agent budget edit/revoke actions are active-wallet scoped, and agent detail uses stored wallet chain identity when auth state is missing that wallet.
- PR #271: owner-side agent allowance mirror writes reject invalid token, amount, reset-period, duplicate-token, and revoked-agent mutation states before storing rows.
- PR #272: one-shot x402 and MPP/generic machine-payment writes are terminal-state guarded for signature recording, stale sign-data refresh, confirmed transition, failed transition, and rail-scoped idempotency replay.
- Antonio PR #273: `useSafeOperationGate` now requires both wallet `address` and `walletClient` before treating EOA signing as ready, keeping wallet recovery visible when the client is not ready.
- PR #274: durable review memory now captures the signer-readiness gate trap from PR #273 in `docs/contributing/ai-review-patterns.md`, the Captain Self-Check Preflight, and the Haven reviewer prompt.
- PR #275: older `/self-sign-agents` allowance writes use the shared owner-side allowance normalizer and block revoked-agent allowance mutations.
- PR #276: whole-agent `/self-sign-agents/:id` delete now requires `status = 'revoked'`, matching `/agents`.
- PR #277: resolved `machine_payment_reconciliation_events` stay resolved on later merchant-retry upserts.
- PR #278: reconciliation event response status values are explicit in OpenAPI/tests.
- Machine-payment receipt `proof_status` and `rail` are explicit in OpenAPI/tests (both prior loop targets; verified landed 2026-06-21).

## Deferred Items

- x402/generic machine-payment consolidation — **no longer "deferred"; now tracked as PT-1** with an explicit trigger.
- Broader payment-state rewrite, DB migrations, custody/signing semantics, Safe ownership assumptions, production chain/token config, and protocol compatibility changes need separate review.
- The self-sign agent track was removed (routes, middleware, and the unused frontend hook); the historical `001_self_sign_agents` / `002_self_sign_payment_intents` migrations are kept so the migration chain stays intact, but the tables are now unused.
- Automated merchant retry, sweep, and operational reconciliation jobs remain deferred.

## Known Baseline Notes

- Focused check pattern after implementation:
  - `npm run test -w packages/backend -- <file>.test.ts` (focused), then `npm run test -w packages/backend` (full).
  - `npm run typecheck -w packages/backend` and `npm run build -w packages/backend`.
  - `git diff --check`.
- Do not run package tests/typecheck/build in parallel when they trigger `npm --prefix ../sdk run build`; the SDK clean build can race on `packages/sdk/dist`.
- Captain self-check should cover CASP guardrails, payment authority boundaries, API schema drift, multi-entrypoint retry consumers, and OpenAPI regression coverage.

## Recommended Next Target

Pick one narrow target from the refreshed P0/P1 backlog. Recommended order:

1. **Pin the reporting "never double-post" invariant** (P0) — add route-level
   regression coverage for the dedup ledger and resumable orchestrator, or hand
   the dedup logic to an oracle-grounded loop. Highest blast radius among the
   new surfaces, and it leaves a durable machine check behind.
2. **Audit external-token redaction** for Fortnox (P0) — small, high-value, and
   matches the existing credential-hygiene bar.
3. **Document one new route family in OpenAPI** (P1, schema/test-only) —
   `reporting`, `fortnox`, `accounting`, or `x402-resources`, one per pass.

Defer broad evidence/reconciliation automation and payment-state rewrites.
Begin PT-1 the moment a pass would otherwise edit `routes/x402.ts` or
`lib/machine-payments.ts`, or after two passes in a row land only contract
polish.
