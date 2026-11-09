---
owner: "@d-hinders"
status: record
covers:
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/routes/agent-delegations.ts
  - packages/backend/src/routes/agent-rekey.ts
  - packages/backend/src/index.ts
  - packages/backend/src/modules/payments/agent-payment-status.ts
  - packages/backend/src/modules/mpp/budget-precheck.ts
  - packages/backend/src/modules/x402/settlement-observed.ts
  - packages/backend/src/modules/x402/intent-by-key.ts
  - packages/sdk/src/merchant-answer.ts
  - packages/sdk/src/merchant-completion.ts
  - scripts/dep-lint.mjs
  - docs/architecture/10-module-boundaries.md
last-verified: "2026-11-09"
---

# Quality scan 2026-11-09 — architecture (scoped)

Scope: **architectural structure only** (owner request 2026-11-09: "see if you
find architectural improvements"). A scope is a filter, so the wave blocks
1–6, 8 and 9 were not taken and `docs/quality/scan-baselines.json` is not
updated. Measured at `49747fac3` (the branch tip, an ancestor of `origin/dev`
at fetch time) by one agent, `npm ci --ignore-scripts`, nothing built, no test
suite run, no database. The clone arrived shallow (50 commits) and was deepened
with `git fetch --shallow-since=2026-08-01 origin dev` before any history
figure. GitHub was read-only. No live Haven call was made.

Every figure below is `command → number` at that SHA, run from the repo root
unless a `cd` is shown.

## What is already sound (so nobody re-derives it)

- `npm run lint:deps` → "No dependency-boundary violations across 522 source
  files (15 import edge(s) waived)"; inline-SQL gauge 35 call sites across 9
  files, at its ceiling of 35.
- A `no-circular` probe over the eleven packages `dep-lint` does not scan
  (config and loop under *C1*) → 0 cycles in `frontend`, `mcp-server`, `mcp`,
  `connect`, `signer`, `cli`, `qa-agent`, `ops`, `ui`, `demo-merchant-mcp`;
  1 in `sdk`.
- Frontend network access is concentrated: files calling `apiFetch(` /
  `fetch(` under `packages/frontend/src` by top directory → hooks 13, lib 4,
  components 3, app 2.

The backend import graph is governed and clean. What follows is about what the
graph rules do not see: where orchestration lives *inside* a permitted edge.

## Structural finding

### S1 — the direct-payment lifecycle is orchestrated inside route closures; the two rules that would forbid it have never been enabled

`docs/architecture/10-module-boundaries.md` sets the target as "thin fastify
routes: validate -> call module -> serialize" and records rules 2 and 5 (the
ones that bind routes to module entry points) as not enforced, awaiting a
`http/` directory. x402 and MPP reached that shape; the direct rail and the
owner-authority routes did not.

Measured:

- `grep -nE "^\s*app\.(get|post|put|patch|delete)" packages/backend/src/routes/payments.ts`
  → registrations at lines 412, 893, 1435, 1454, 1493, 1538, 1552. `POST /`
  is one closure of 481 lines (412–892) and `POST /:id/sign` one of 542
  (893–1434): 1,023 of the file's 1,572 lines.
- The sign closure is the submit state machine, inline:
  `sed -n 893,1434p packages/backend/src/routes/payments.ts | grep -oE "await [a-zA-Z_]+\(" | sort -u | wc -l`
  → 17 distinct awaited functions (claim, submit, confirm, fail,
  outcome-pending, release, expire ×2, sponsored-gas, evidence, budget reads).
- The same lifecycle on the other two rails: `wc -l` →
  `routes/x402.ts` 210 lines over `modules/x402/` (17 non-test files),
  `routes/machine-payments.ts` 397 over `modules/mpp/` (16).
  `modules/payments/` holds 9 files of helpers, not the flow.
- Growth: `git show $(git rev-list -1 --before=<date> --first-parent HEAD):packages/backend/src/routes/payments.ts | wc -l`
  → 898 (before 2026-09-15), 1,561 (before 2026-10-15), 1,572 today.
- The same shape in the owner-authority routes: `wc -l` →
  `agent-connection-setups.ts` 1,556, `agent-delegations.ts` 1,389,
  `agent-rekey.ts` 1,276, `dashboard.ts` 1,163. `agent-delegations.ts`
  carries a `pg-only-in-infra` waiver for "8 grant-lifecycle statements on a
  dedicated client" (printed by `npm run lint:deps`).
- Route layer as a whole (50 non-test route files): imports from
  `../infra/repositories/` 90, from `../modules/` 71, from `../rails/` 33
  (`cat <route files> | grep -cE "from '\.\./<layer>/"`).
- Parity by copy: `grep -rnE "^(export )?(async )?function <name>\b"` over
  non-test backend source → `isBigint`, `isBigintN`,
  `bigintToNStringReplacer`, `nSuffixStringToBigintReplacer` each defined in
  both `agent-delegations.ts` and `agent-rekey.ts`; `parseChainId` in three
  route files; `safeDetails` in seven files (five routes, two rails), all
  seven bodies byte-identical one-line wrappers.

Demonstrated cost: seven issues between 2026-09-30 and 2026-10-29 name the
direct-payment entrypoint — #3494, #3500, #3503, #3564, #3609, #4354, #4533 —
five of them in three days (09-30 → 10-02), four labelled `money-path` and
`bug`. Two state the asymmetry in their titles: #3503 ("POST /payments has no
remaining-budget pre-check") and #4533 ("direct payments … are never fed —
only x402 payments are"). The file grew 898 → 1,561 lines across that window.
*Classification is from titles and labels; the fix PRs were not read.*

Relation to prior work: the 2026-10-03 S1 (epic #3615) took one question —
budget scope — out of these closures into a module. This finding is the
remainder: the lifecycle itself. It is not a re-surface of #3615's claim, but
it is adjacent, and the owner may judge it the same debt.

How it changes work: a handler's logic is reachable only through
`app.inject` (`cat packages/backend/src/routes/__tests__/payments*.test.ts | wc -l`
→ 5,018 lines in 11 files); a module-level flow is callable with injected
collaborators, and rule 5 becomes enableable per file.

Proposed slices, disjoint by file, each behaviour-preserving:

1. `POST /payments` create flow → `modules/payments/`, route keeps validate /
   call / serialize.
2. `POST /payments/:id/sign` submit state machine → `modules/payments/`.
3. `agent-delegations.ts` grant lifecycle → module + repository (retires the
   8-statement waiver).
4. `agent-rekey.ts` stages → the existing `modules/agents/rekey-*` files.
5. A shrink-only ratchet (per-route handler length, or rule 5 enabled
   file-by-file) so the shape cannot grow back.

Slices 1 and 2 touch `routes/payments.ts`, which the money-path matcher
classifies `money-path` (below) — they are owner-gated, not autonomous work.

## Improvement candidates (one PR each)

### C1 — `no-circular` is checked in 2 of 13 packages, and `sdk` has a runtime cycle

- **Evidence.** `scripts/dep-lint.mjs` `SCAN_ROOTS` lists
  `packages/backend/src` and `packages/core/src` only. A probe with one rule
  (`no-circular`, tests and `e2e/` excluded, `tsPreCompilationDeps: false` so
  type-only imports are not counted), run as
  `cd packages/<p> && npx depcruise src --config <probe> --ts-config tsconfig.json --output-type err`
  → `sdk`: 1 violation, `src/merchant-answer.ts → src/merchant-completion.ts →
  src/merchant-answer.ts`; the other ten packages: 0. Both edges are value
  imports: `merchant-answer.ts:7` imports `parseMerchantSettlement`,
  `merchant-completion.ts:23` imports `decidePostFundingMerchantAnswer`.
- **Benefit.** The architecture doc calls a cycle "a defect regardless of
  intent" and makes it the one unwaivable rule; the rule runs on two of the
  thirteen packages. Both files are published SDK money-path code.
- **Scope.** Move the shared parser to a leaf (or invert one edge); add the
  eleven roots to a `no-circular`-only pass. One PR.
- **Verified at scan.** Probe output above. Routing:
  `packages/sdk/src/merchant-answer.ts` → `code backend sdk connect mcp
  mcp_server signer demo_merchant qa_agent`; `scripts/dep-lint.mjs` and
  `.dependency-cruiser.cjs` → `code backend`. Money-path: both SDK files
  `money-path`, the two lint files `off`, control `sweep.ts` `money-path`.
  Tracking: `gh api search/issues … "merchant-answer" cycle OR circular` → 0.
  Mutation recipe *unrun* — the extended lint does not exist yet.
- **Still needed.** SDK suite green after the move; the extended lint red on
  a reintroduced cycle.

### C2 — background jobs are hand-wired in the composition root and proven by regex over its source

- **Evidence.** `git grep -c "setInterval(" HEAD -- packages/backend/src/index.ts`
  → 10; `runIfLeader(` → 9. Each block repeats try / `runIfLeader` / log /
  `void run()` / `setInterval(...).unref()` (lines 646–1064 of 1,071).
  Because importing `index.ts` boots the server, wiring is asserted by reading
  the file as text: 3 backend test files `readFileSync` it by path
  (`non-custody.invariants.test.ts`, `catalog-ingest-monitor-wired.test.ts`,
  `anchor-seams-wired.test.ts`), the last two regex-matching wiring. That technique failed once on record: #4411
  (2026-10-25) — a `/*` inside a line comment made the stripper swallow
  `index.ts` lines 599–633, so a guard could pass on changed code.
  `index.ts` is the fifth most-touched production file since 2026-09-01:
  51 of 1,229 first-parent landings.
- **Benefit.** A job table (`name`, lock key or "per-replica", interval,
  `run`) is importable, so "is job X leader-gated and scheduled" becomes a
  value assertion, not a source scan; a new job is one row.
- **Scope.** `index.ts` plus one new `platform/` file; the two wiring tests
  move to the table. One PR.
- **Verified at scan.** Counts above. Routing: `index.ts` → `code backend`.
  Money-path: `off`. Tracking: no open issue found for a job registry.
  Mutation recipe *unrun* — the table does not exist yet.
- **Still needed.** Every tick keeps its lock key, interval, first-run
  behaviour and the relayer monitor's deliberate per-replica exemption.

### C3 — `machine_metadata` is an untyped JSON column re-parsed by private helpers; `settlementSchemeOf` exists four times with three bodies

- **Evidence.** `grep -rnE "^(export )?function \w*[mM]etadata\w*\("` over
  non-test backend source → 10 functions, 8 of them parsers of the same
  column (`metadataOf` ×2, `metadataRecord`, `parseMachineMetadata`,
  `metadataObject` ×2, `parsedMachineMetadata` ×2).
  `grep -rnE "^(export )?(async )?function settlementSchemeOf\b"` → 4
  definitions (`x402/intent-by-key.ts`, `x402/settlement-observed.ts`,
  `payments/agent-payment-status.ts`, `mpp/budget-precheck.ts`); whitespace-
  stripped body hashes → 3 distinct. One falls back to the stored settlement
  state's shape, two return any string, and parity is held by a comment:
  "parsed the way `settlement-observed.ts` does". 31 production files
  reference `machine_metadata`.
- **Benefit.** One typed reader for the column removes a class of drift on a
  field that selects the settlement scheme. No defect is claimed: the three
  bodies were not shown to disagree on any stored row.
- **Scope.** One reader in `modules/transactions/` or `domain/`, the eight
  parsers and four scheme readers re-pointed. One PR, but all four scheme
  files are `money-path` — owner-gated.
- **Verified at scan.** Counts and hashes above. Routing: `code backend`.
  Money-path: `agent-payment-status.ts`, `budget-precheck.ts`,
  `settlement-observed.ts` → `money-path`. Tracking: one closed issue (#1706)
  on threading the field, none on the readers. Mutation recipe *unrun*.
- **Still needed.** A characterization test over the stored shapes (string,
  object, null, scheme absent with a `{child, budget}` state) run against all
  four current bodies before any is replaced.

## Considered, not established

- `design-system/page.tsx`: 5,837 lines, touched by 147 of 1,229 landings
  since 2026-09-01 — the most-touched file in the repo. No conflict count or
  incident was measured, so this is a figure, not a candidate.
- `db/migrations/index.ts`: a hand-kept registry of 125 migrations, 49
  landings. A number-collision cost was not established (a commit-message
  grep for "renumber" matched 8 commits, unread).
- `sdk/src/types.ts` (3,381 lines, 72 landings) sits beside the generated
  `core/src/api-types.ts`: prior finding (epics #1442, #3028), excluded.
- `mcp-server/src/tools/contracts.ts` (58 landings): prior finding (epic
  #2806), excluded.

## Coverage record

- Sizing → examined → per-package source / test lines by `git ls-files … |
  xargs cat | wc -l`; largest files by `wc -l`.
- Backend layering → examined → `npm run lint:deps`, per-route import counts,
  handler boundaries in the four largest routes. Handlers under 200 lines
  were not read.
- Cycles outside backend/core → examined → the probe above, 11 packages.
- Cross-package duplication → partial → backend function-name duplicates
  only (47 names defined in more than one non-test file, `up` and `down`
  of the migrations among them); `mcp` vs `mcp-server` vs `signer` tool definitions
  not compared.
- Frontend architecture → partial → sizing, cycle probe and fetch-site census
  only; component composition not read.
- Churn → examined → first-parent landings since 2026-09-01 per production
  file (1,229 landings).
- Incident clustering → partial → the seven direct-payment issues, by title
  and label.
- Workflow archaeology → not examined → out of scope.
- Blocks 1, 2, 3, 4, 5, 6, 8, 9 → not examined → scope is architecture; the
  weekly re-measurement (#4635, at `f03f90102`) reports no flagged, failed or
  refused row.
- `any` density → not examined here → the weekly row reads 39, unchanged.
