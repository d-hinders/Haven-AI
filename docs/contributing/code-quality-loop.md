# Haven Code Quality Loop

Last updated: 2026-06-24

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
- **Is it actually live?** Check feature gates (`config.*Enabled`, entitlements)
  and route registration before targeting a surface. Code behind a permanently
  -off legacy gate, a demo prefix, or no registration is *out of scope* (see
  "Out of scope"). Distinguish *legacy/superseded* (won't return — leave alone)
  from *staged rollout* (off-by-default but wired into a live path and under
  active development — in scope).

## Out of scope — kept but not in use

These surfaces exist in the tree but are **not part of the live product path**.
Do **not** spend quality-loop effort on them — no new tests, no contract work,
no refactors. The only legitimate action is *removal*, which is a product
decision for the captain/owner, not a quality-loop pass. Re-confirm a surface is
still dormant before excluding it (a flag can flip).

| Surface | Why excluded | Gate / signal |
| --- | --- | --- |
| SIE / "full bookkeeping" export | Superseded by the reporting feed (draft-transaction sync); the route returns `410` by default | `config.legacyBookkeepingEnabled` (off); `routes/accounting.ts` `/export`, `lib/sie-exporter.ts`, `lib/ledger-exporter.ts` |
| MPP demo rail | Internal demo surface, not a production rail | registered at `/demo/mpp`; `routes/demo-mpp.ts` |
| Self-sign agent tables | Track removed; migrations kept only for chain integrity | `001_self_sign_agents`, `002_self_sign_payment_intents` (unused) |
| Fee module | Built but dormant — quote is always zero and no funds move while disabled | `config.feeEnabled` (off); `lib/fee/fee-module.ts` |

> Note: the **reporting feed** is also flag-gated (`reportingFeedEnabled`,
> hosted-only) but is **in scope** — it is wired into the live settlement path
> and is the forward direction that replaces SIE. Flag-off ≠ dead when the
> surface is under active rollout.

## Current Run

- **Target:** pin the reporting feed's "never double-post" guarantee with an
  *integrated* regression guard.
- **What shipped:** `packages/backend/src/lib/reporting/__tests__/feed-dedup.integration.test.ts`
  — drives the real `claimSync` / `markPushed` / `markFailed` and the real
  orchestrator against an in-memory oracle of the `reporting_feed_syncs` unique
  constraint, then re-feeds the same payment (re-sync, racing claim, post-failure
  retry) and asserts exactly one connector push each time. Test-only; no runtime
  change.
- **Correction to prior discovery:** the earlier backlog claimed the guarantee
  was unpinned. It was already covered at the *unit* level
  (`feed-sync.test.ts`, `feed-orchestrator.test.ts`) — I missed those because
  they live in `lib/reporting/__tests__/`, not `lib/__tests__/`. The real gap was
  that both unit tests mock the seam they share, so neither exercises the dedup
  mechanism reacting to its own prior write. This pass closes that specific gap.
- **Verification:** focused `vitest run src/lib/reporting` green (20 tests);
  `npm run typecheck` (backend `tsc --noEmit`) exit 0.
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

- **P0 — Reporting/accounting export correctness.** The "never double-post"
  dedup guarantee is now pinned (unit + integrated guard — see Current Run).
  Remaining: verify book-time FX and rounding
  (`026_machine_payment_book_time_fx`) are applied consistently and never
  recomputed at feed time, and that the unique index in the migration matches
  the `ON CONFLICT (provider, payment_id, user_id)` target (SQL-level, which the
  behavioral oracle deliberately does not cover). *Surfaces:*
  `src/lib/reporting/reporting-transaction.ts`, `src/lib/accounting-entry.ts`,
  `src/db/migrations/033_reporting_feed_syncs.ts`, `src/routes/reporting.ts`,
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
- **P1 — Route-level test coverage for untested *live* handlers.**
  `reporting.ts`, `fortnox.ts`, `x402-resources.ts`, and `contacts.ts` lack
  route-level tests (some have lib-level coverage). For `accounting.ts`, cover
  the live endpoints (`/categories`, `/reconcile`) only — **not** the `/export`
  SIE path (legacy, see "Out of scope"). Skip `demo-mpp.ts` (demo). Prefer tests
  that assert an invariant (auth required, idempotent write, no double-post) over
  tests that pin current output.
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
| Reporting feed dedup ("never double-post") | ✅ Hardened | unit tests + integrated `feed-dedup.integration.test.ts` guard |
| Reporting/accounting FX-at-book-time correctness | ⚠️ Thin | book-time SEK frozen; not separately pinned |
| External-token hygiene (Fortnox) | ✅ Hardened | route-level redaction guard + connection lifecycle tests (#539) |
| OpenAPI coverage of reporting/fortnox/accounting/x402-resources | ➖ Out of scope | `spec.ts` is intentionally the *agent-payment* surface (see `spec.test.ts`: auth/dashboard/accounting deliberately excluded). Publishing these families is a captain scope decision, not a quality pass. |
| Route-level tests for fortnox/contacts/reporting handlers | ✅ Hardened | #540 (fortnox), #541 (contacts), #542 (reporting) |
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
- Reporting feed "never double-post": added `feed-dedup.integration.test.ts`, an integrated guard that drives the real claim/push/retry lifecycle against an in-memory oracle of the `reporting_feed_syncs` unique constraint, complementing the existing boundary-mocked unit tests (2026-06-21).
- **`code-quality-hardening` track (2026-06-24, autonomous `/loop /ship-next`, backlog `docs/backlogs/code-quality-hardening.yml`).** Hardened the newer financial-integration surfaces, which shipped with thinner route/credential coverage than the older payment routes. Six small reviewer-gated PRs; +44 backend tests (510 → 544):
  - PR #539: Fortnox OAuth tokens (`access_token`/`refresh_token`) are pinned to never leak in `/status`/callback/connect-url/delete responses or headers (sentinel-string guard against a connection row that genuinely holds the tokens), plus `getValidFortnoxAccessToken` lifecycle coverage. Matches the delegate-key redaction bar (#261–#264).
  - PR #540: Fortnox route invariants — auth, the legacy `/push` 410 gate (short-circuits before token work), ISO-date 400s, and OAuth callback error redirects (a forged/wrong-purpose state never reaches the token exchange).
  - PR #541: contacts route invariants — auth on all four endpoints, user-scoped reads/writes (a non-owned row is a 404, never a cross-user mutation), shared-`lib/address` validation before writes, and the 201/400/404/409 contract.
  - PR #542: reporting feed route invariants — auth, the entitlement gate (real `requireReportingFeed`, 404 when unavailable), `/status` hides the gated data path for unentitled accounts, and one `/sync` request delegates to exactly one `syncUser` call (route adds no double-post on top of the lib's idempotency).
  - PR #543: contacts duplicate-address detection now keys on Postgres SQLSTATE `23505` instead of a `message.includes('unique')` substring (which could mask unrelated errors as 409). Surfaced by the #541 review; matches the `routes/agents.ts` pattern; a non-unique DB error now re-throws (500) rather than being swallowed.
  - Discovery correction: the earlier "OpenAPI contract drift" backlog item for reporting/fortnox/accounting was *not* accidental drift — `spec.ts` is intentionally scoped to the agent-payment surface (`spec.test.ts`). Dropped from the track rather than making a unilateral scope decision; recorded in the Coverage Map.
  - Follow-up noted (not done): `routes/passkeys.ts:109` uses a `code as {...}` cast rather than the `unknown` + `'code' in err` narrowing now standard in contacts/agents — a candidate for a future pass.

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

1. **Audit external-token redaction** for Fortnox (P0) — confirm
   `access_token` / `refresh_token` never surface in responses, logs, errors, or
   generated artifacts; small, high-value, matches the existing credential bar.
2. **Document one new route family in OpenAPI** (P1, schema/test-only) —
   `reporting`, `fortnox`, `accounting` (live endpoints only), or
   `x402-resources`, one per pass.
3. **Pin the migration-vs-`ON CONFLICT` unique-key match** for
   `reporting_feed_syncs` (P0 remainder) — the one double-post failure mode the
   behavioral oracle deliberately does not cover.

Defer broad evidence/reconciliation automation and payment-state rewrites.
Begin PT-1 the moment a pass would otherwise edit `routes/x402.ts` or
`lib/machine-payments.ts`, or after two passes in a row land only contract
polish.
