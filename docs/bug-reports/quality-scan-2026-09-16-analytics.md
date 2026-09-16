---
owner: "@AntonioSaaranen"
status: current
covers:
  - packages/backend/src/routes/analytics-overview.ts
  - packages/backend/src/modules/payments/refusal-ledger.ts
  - packages/mcp-server/src/tools/catalog-purchase.ts
  - packages/frontend/src/app/(authenticated)/analytics/AnalyticsClient.tsx
  - packages/frontend/src/components/ui/StackedBarChart.tsx
  - packages/frontend/src/components/ui/AreaChart.tsx
  - packages/frontend/src/components/ui/StatTile.tsx
  - scripts/docs/covers-gaps.mjs
last-verified: "2026-09-16"
---

# Quality scan — Analytics page (epic #2944), 2026-09-16

Scope: `packages/frontend/src/app/(authenticated)/analytics/**`, `components/analytics/**`, `components/ui/{StatTile,StackedBarChart,AreaChart}.tsx`, `components/charts/**`, `hooks/useAnalyticsOverview.ts`, `lib/analytics-*.ts`, `e2e/analytics.visual.spec.ts` + fixture, `packages/backend/src/routes/analytics-overview.ts`, `infra/repositories/{analytics,payment-refusals}.ts`, `modules/payments/refusal-ledger.ts`, `docs/product/analytics.md`. Measured on `origin/dev` @ `886781d4`. Owner mandate 2026-09-16 ("think carefully about this one"). Prior ledger findings excluded (none cover this surface; the epic was born 2026-09-13 from the previous scan's neighbourhood but not from a finding).

Method: full read of the endpoint, repository SQL, hook, page and product doc; 5 executed mutations on the real-DB harness and vitest (block 1); covers/stale-numbers/nets probes (blocks 2, 3, 6); incident clustering over the epic's 11 issues; refusal-writer census; deferral census over the last 80 merged PR bodies.

## 1. Structural finding

### F1 — Refusal recording is per-site opt-in with no choke point, so the "Refused" tile is only as complete as the last grep

The epic's owner decision 2 made refusals a **first-class metric** ("count and amount of attempts the guardrails refused, per agent, over time"), and slice A's ledger is the only thing that feeds it. The ledger is written by calling `recordRefusalFireAndForget` beside each refusal response; nothing enforces that a refusal site has a writer, and four do not.

**Evidence**

- Writers: `git grep -n "recordRefusalFireAndForget(" -- 'packages/backend/src/**' | grep -v test` → 6 call sites (3009 pre-check `delegation-authorize.ts:191`, erc7710 no-delegation `:390`, erc7710 pre-check `:471`, direct-payment revert classify `payments.ts:438`, direct no-delegation `:460`, relayer budget `:747`).
- Refusal-shaped returns on the same conditions **without** a writer (code read, each has a written sibling for the identical condition):
  - `delegation-authorize.ts:246–255` — 502 on the 3009 funding-leg `prepareDelegationPayment` catch (the condition `payments.ts:436` classifies into `delegation_expired | delegation_budget_exceeded | onchain_revert` and writes);
  - `:257–264` — 403 "no delegation able to fund EIP-3009 settlement" (sibling of `:390` and `payments.ts:460`);
  - `:587–590` — 429 on `RelayerBudgetExceededError` from `ensureHybridDeployed` (sibling of `payments.ts:747`);
  - `packages/mcp-server/src/tools/catalog-purchase.ts:606` — `DELEGATION_BUDGET_EXCEEDED` raised **in the hosted MCP at prepare, before any backend call** ("refuse BEFORE any funding intent", step 6). This is the guided catalog purchase, the path the tool descriptions tell agents to prefer, and it is a *policy* refusal (the delegated budget), not the user's price cap. The page's footnote disclaims only "Price-cap refusals in your agent's runtime" (`AnalyticsClient.tsx:146,149`; `docs/product/analytics.md:103–105`).
- Compounding: on the 3009 leg the pre-check at `:191` fires only when the on-chain remaining read succeeded (`:181` swallows a failed read into `null`); a degraded RPC turns a recorded `delegation_budget_exceeded` into the unwritten `:246` path — the same refusal on `POST /payments` is recorded.
- The enum is closed (`payment-refusals.ts:29–34`, migration 086 CHECK), so a new refusal class (the hourly cap at `:122`) has no value to write even if a writer were added; the decision "is a rate limit a refusal?" is recorded nowhere.

**Demonstrated cost**: the page under-reports the one insight the epic says only Haven can offer, on the guided path and on the fallback rail, with no failing test — and the epic's promotion checklist item 1 ("one deliberate over-budget x402 attempt … produces a row") passes on the erc7710 leg while saying nothing about the hosted prepare pre-check that a real agent hits first. The epic body itself documented the class ("Refusals are NOT recorded … returns before writing anything"); this is its residue after slice A.

**Changes how contributors work**: today "add a refusal" means "remember the writer, the enum, the migration CHECK and the doc". After the remedy a refusal is written by construction, and adding a refusal class fails a test until the enum, CHECK and doc move together.

**Slices (disjoint)**
1. **Backend siblings** — writers at `delegation-authorize.ts:246`, `:257`, `:587` with the classification the direct route already uses; characterization tests pin the responses byte-identical (the ledger-never-changes-a-refusal rule, `refusal-ledger.ts:5–13`). Money-path, CASP shard.
2. **Hosted pre-check reporting** — the mcp-server's step-6 refusal reports to the backend (a `POST /machine-payments/refusals` that the ledger writes with `source: 'hosted_prepare'`, or the pre-check moves into `GET /machine-payments/allowances`'s caller on the backend). Decision needed: `source` enum widens (migration), and whether cap refusals stay excluded (owner decision 2026-09-13 says yes). Money-path.
3. **Choke point + guard** — one `refuse(reply, {status, body, ledger})` helper on the delegation-rail paths so a refusal response and its ledger write are one call; a repo test that enumerates 403/429/502 policy returns under `modules/x402` and `routes/payments.ts` and asserts each is emitted through it (mutation: an inline `reply.code(403)` with `error_code: delegation_*` must redden it).
4. **Doc** — `docs/product/analytics.md` and the tile footnote name every refusal the ledger cannot see, by path, until slices 1–2 land; the product doc becomes `contract: true` (see C3).

## 2. Improvement candidates

### C1 — Mount `StackedBarChart` on `/analytics`: "Spend over time" never shipped

- **Evidence**: the epic's page item 2 (daily bars by agent, refusals as a marker series) is a built primitive (`components/ui/StackedBarChart.tsx`, 376-line test, `/design-system` row, PR #2984 merged 2026-09-14) with **no importer** under `app/(authenticated)/analytics` or `components/analytics` (`git grep StackedBarChart -- packages/frontend/src` → own file + `design-system/page.tsx` only). PR #2984's body: "`AnalyticsClient` mounting is NOT in this PR … that wiring lands with slice C". Slice C (PR #3014) shipped the placeholder `AnalyticsClient.tsx:292–299` "mount here when `feat/2948-analytics-charts` (head 00ec5433) lands" — that branch had merged the day before. Slice E mounted only `AreaChart`. `by_day` is fetched and used solely for the sparse-days count (`useAnalyticsOverview.ts:114`). The doc says "the charts by #2948" as shipped and has no "Spend over time" section. Deferral census: `gh pr list --state merged --limit 80` bodies matching "not in this PR|lands with|deferred to|follow-up slice" → 4; this is the one whose target never received it.
- **Expected benefit**: the epic's refusals-over-time view exists for users; the placeholder stops asserting a future that already happened.
- **Scope**: one frontend PR — `AnalyticsClient.tsx` (map `by_day[].spent_by_agent` → `StackedBarDay.series` with agent names from `agents[]`, `refusals` per day, `formatValue` from `analytics-format`), the sparse rule (`analyticsDaysWithData` counts partial edge buckets — the spec's own description says the first/last bucket "can be PARTIAL … the page should treat the edge buckets as partial"; decide: mark, drop, or count), a `populated` visual scenario with refusals > 0 already exists so the marker series gets pixel coverage for free, doc section, series-colour parity with the agents table's share column (#2948 AC 1).
- **Verification still needed**: haven-design-reviewer both themes at 1280/390 (the chart is the page's largest element); the 12 analytics baselines will move — declare all of them.

### C2 — Seam guards that executed mutations proved absent (backend route + page)

- **Evidence (block 1, executed)**: `routes/analytics-overview.ts:251` `unsettled_submitted: unsettledSubmitted → 0` → `analytics-overview.test.ts` 19/19 green (the value the page calls "its most load-bearing line"); `AnalyticsClient.tsx:371` dropping the `refused_count === 0` clause of `isEmptyWindow` → 43/43 green (a refusals-only window renders "No agent activity"). Read: `resolveMerchantLabel` (`:61–64`, the doc's stated contact → receipt → address contract) runs only its address fallback in every route test (contacts and receipts mocked empty in all cases); `range.previous_*`, `agents[].share`, `by_day[]` contents, `merchants[].agent_ids` and the whole `currency=eur` column swap are never asserted (route test asserts 12 fields by value, shape-checks the rest). Boundary drift: `totals.refused_count` comes from `(from, to]` (`payment-refusals.ts:206–213`) while `totals.refused_amount` and `by_day[].refusals` come from `[from, to)` (`analytics.ts:701–738`); `analytics.ts:46–48` documents it, the route does not reconcile it, and `screenshot.mjs:1405` asserts an invariant the endpoint does not guarantee.
- **Expected benefit**: the route's shaping — the one layer between proven SQL and a proven page — can no longer drop or swap a figure silently.
- **Scope**: one PR: route tests for the eight unasserted fields incl. an EUR case and a label-order case with seeded contacts/receipts; `AnalyticsClient.test.tsx` refusals-only window; align the per-agent refusal boundary to `[from, to)` (a one-line SQL change + test). No product change.
- **Verification**: each new test proven red by the mutation that motivated it.

### C3 — `docs/product/analytics.md` contradicts the code since #3013, and the coupling gate saw it and blocked nothing

- **Evidence (block 3)**: `analytics.md:102` "neither it nor the API claims a coverage floor it cannot read" — PR #3039 (2026-09-16) added `basis.refusals_recorded_from` and the page renders "Refusals are recorded from <date>" (`AnalyticsClient.tsx:131–137`). `analytics.md:29` "the endpoint is built by issue #2946; the page shell by #2947; the charts by #2948" (present tense, all shipped). `last-verified: "2026-09-15"` while `fc2b72bc` touched 4 of its 7 covered files. The gate named the doc for #3039 (`coupling-gate.mjs` "may need updating") and `--strict` exited 0 because the doc lacks `contract: true` (`coupling-gate.mjs:541`). Block 2: the doc claims ~12 files in prose and declares 7; `covers-gaps.mjs` sees 0 gaps because it derives from backticked paths (2 in this doc). Two constants for one floor (`AnalyticsClient.tsx:87` `MIN_DAYS_FOR_CHARTS = 3` beside the import of `MIN_CHARTABLE_DAYS` whose own comment explains why there must be one); `budgetBandsCaption` never singularises ("1 of 1 agents", `analytics-format.ts:111`); `ci.yml:855,875` and `playwright.config.ts:108` still say "five spec files" / "dark project scoped to the design-system spec alone" (8 specs; dark also matches analytics).
- **Expected benefit**: a product doc that the gate can hold to its claims; the next analytics change re-implicates it.
- **Scope**: one docs+comments PR; the decision inside it: make `analytics.md` `contract: true` with the covers list widened to the files it claims (the gate then blocks the next drift) — or record why a product doc stays advisory.
- **Verification**: `coupling-gate --strict` at the PR's SHAs names the doc as satisfied; `docs:check`.

### C4 — Two states nothing ever renders: fee-flag-on, and sparse

- **Evidence (block 6)**: `git grep flag_on -- packages/frontend packages/backend` → `false` at every fixture and assertion (`screenshot-fixture.test.ts:1057,1138`, `analytics-overview.test.ts:359`, `e2e/fixtures/analytics-overview.ts:97,386`, `screenshot.mjs:1444,1508`); the `true` branch changes the tile's value, delta chip and caption (`AnalyticsClient.tsx:185–191`) and is asserted nowhere in the repo. `analytics.visual.spec.ts:270` scenarios are populated/empty/error; the sparse branch (< 3 days, which withholds all three lower sections) has vitest coverage and no baseline.
- **Expected benefit**: the fee tile's on-state is the state the product is heading to (fee flag); today it would ship unseen.
- **Scope**: one PR: a `flag_on: true` variant in the shared fixture + one route assertion + one visual scenario for sparse (4 new baselines via the sanctioned dispatch).
- **Verification**: haven-design-reviewer on the two new captures.

### C5 — A PR-body deferral needs a home on the target issue (process, one skill edit)

- **Evidence**: 4 of the last 80 merged PR bodies defer an acceptance item to another slice; one (PR #2984 → slice C) lost the item, and the epic checklist could not see it (its five sub-issue boxes are all still unticked while all five are closed). #3038 (zero visual coverage after C/D/E) and the #3013 floor are the same shape: cross-slice acceptance with no owner after the slice closes.
- **Expected benefit**: a deferred item is a comment on the target issue (or a new task) at closeout, so the next slice's builder reads it.
- **Scope**: one PR to `.agents/skills/ship-next/SKILL.md` closeout + `new-task`'s epic section (the checklist owner ticks boxes at closeout).
- **Verification**: the next slice-based epic's closeouts carry the comment; no code.

## 3. Refused under the bar

- **Budget block latency** — `shapeBudgets` runs one 2 s-bounded RPC read per active delegation, 4 in flight, and the page renders nothing until the whole response returns (no partial render, no cache). Hypothesis only: no measurement of active-delegation counts per user, no complaint on record. Not presented.
- **Repository-module mocking in the route test** — the route test mocks `infra/repositories/analytics.js` wholesale; the db-mock ratchet cannot see it. This is the layering #1219 intended (repository proven on the real DB, route proves shaping), so not a hole — the hole is what the route test asserts (C2).

## 4. Coverage record (`Probed clean`, dimension → status → command → result → boundary → missing)

- **Block 1 guard falsifiability** → examined → 5 mutations on the real-DB harness/vitest at `886781d4` → **3 of 5 caught** (TOTALS_SPEND status predicate; `isValueBearingChain` filter; budget-enforcer revert classification); 2 survivors, both *weak test* (C2) → sample: one mutation each in `analytics.ts` (×2), `analytics-overview.ts`, `AnalyticsClient.tsx`, `refusal-ledger.ts` → not mutated: `payment-refusals.ts`, `EmptyStates.tsx`, tables, `StatTile`, the two chart primitives, `chart-scale.ts` (budget spent).
- **Block 2 covers completeness** → examined → `node scripts/docs/covers-gaps.mjs` → 0 new gaps, `analytics.md` absent from the baseline; block recipe under bash → declared 7, cited-backticked 2, cited-but-not-covered 0, covered-but-not-cited 5; **~12 files claimed in prose, not backticked** (C3) → boundary: one doc → the instrument cannot see prose claims.
- **Block 3 stale numbers** → examined → every figure/date/status in `analytics.md`, the three docblocks, `ci.yml:855,875`, `playwright.config.ts:108` → 4 stale in the doc (incl. one now false), 1 stale-and-hiding-a-gap comment (C1), 3 stale gate-scope comments; migration date, merchant-label order, "and N more", balance copy reproduce.
- **Block 4 retired vocabulary** → not examined (scope born after #1440; no residue expected; not run).
- **Block 5 merge-method drift** → not examined (out of scope).
- **Block 6 nets with holes** → partial → visual matrix read from `ci.yml:867–882` + `playwright.config.ts:282–321` (12 baselines inventoried by `npm run visual:baselines`, not by a run); harness scenarios read from `screenshot.mjs:1428–1512`; route-test assertion census by read → fee-flag-on and sparse holes (C4), route seam (C2) → **visual gate and screenshot harness not executed** (Linux baselines / full build needed).
- **Incident clustering** → examined → `gh issue list --search analytics` → 11 issues since 2026-09-13; classes: cross-slice gap ×3 (#3013 floor, #3038 visual, C1 mount), render bug ×1 (#3037), slices ×5, epic ×1.
- **Workflow archaeology** → examined → `gh run list --limit 200` filtered to the epic's branches → 0 reruns, 0 failures.
- **Refusal-writer census** → examined → 6 writers vs 4 unwritten siblings (F1) → boundary: `packages/backend/src/{routes,modules,rails}` + `packages/mcp-server/src/tools`; `agent-delegations.ts:528` and `mpp/sweep.ts:369` relayer-budget errors judged out of the ledger's scope.
- **Deferral census** → examined → 4 of 80 merged PR bodies (C5).
- **Sizing** → scope = 33 tracked files; source 3,383 lines / tests 4,830 (frontend 1,714 / 2,617; backend 1,554 / 2,213; doc 162) — test-heavier than source in both layers, which is why the findings are about *what* the tests pin, not how many there are.

## 5. Dispositions

Owner decision 2026-09-16: **F1 filed as epic #3056** (sub-issues #3052–#3055, `pending-review`); **C1 filed as #3051 and shipped in PR #3057** (the PR that carries this report). C2–C5 pending owner decision.
