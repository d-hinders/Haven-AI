---
owner: "@d-hinders"
status: record
covers:
  - .agents/skills/quality-scan/references/dimensions.md
  - scripts/frontend-copy-lint.mjs
  - docs/contributing/docs-quality-system.md
  - packages/backend/src/modules/mpp/evidence.ts
  - packages/backend/src/modules/accounting/entry.ts
  - packages/backend/src/modules/accounting/transaction-kind.ts
  - packages/backend/src/openapi/spec.ts
  - packages/sdk/src/types.ts
  - packages/sdk/src/payment-mappers.ts
  - .github/workflows/pr-ownership-gate.yml
  - .github/workflows/baseline-verdict-gate.yml
  - .github/workflows/external-intake-gate.yml
last-verified: "2026-10-30"
---

# Quality scan 2026-10-30 — whole repo, weighted to the landings since 2026-10-26

Scope: the whole repository, weighted toward the **51** first-parent landings
after the last complete scan:

```bash
git rev-list --first-parent --count b9f9f1e47..99ef8d063
# 51

git diff --shortstat b9f9f1e47..99ef8d063
# 438 files changed, 22263 insertions(+), 2230 deletions(-)
```

The run was read-only until this report and ledger entry were written. Two
isolated detached worktrees measured the repository and the recent issue/CI
window; the report branch is based on frozen `origin/dev` SHA
`99ef8d063df58c3d012e8cfee35caaff3d67dd6c`. No live Haven call, paid call,
browser run, mutation, database suite, or production change was made.

Every prior ledger finding and candidate is excluded, whatever its disposition.
No prior item materially worsened in the re-measured dimensions below.

## 1. Structural findings

None in the examined sample.

The window is dominated by already-tracked UI consistency, release, accounting,
MCP/SDK and CI work. The new opportunities below have separate mechanisms and
fit one pull request each; there is no measured common pattern that meets the
structural bar or needs parallel slices.

## 2. Improvement candidates — pending owner decision

### C1 — block 2 selects a body example as a contract document, so its recurring coverage figure is inflated

**Opportunity and evidence.** The block says its sample is every document whose
front matter declares `contract: true`, but its selector is a whole-file
anchored grep:

```bash
rg -l '^contract: true' docs --glob '*.md'
# 8 files
```

Parsing only the first front-matter block gives **7**. The false eighth is the
documentation-quality system, whose body contains `contract: true` inside the
front-matter schema example but whose own front matter has no contract key.
Consequently the exact block reports **19** raw cited-but-not-covered paths
across 8 selected documents. Four come from the false document; after excluding
that document and the two raw glob-string false classes, the measurement is
**15 literal gaps across 5 actual contract documents**. Re-running the corrected
sample at `b9f9f1e47` gives the same 15/5, so the contracts did not worsen;
the instrument was counting the wrong sample.

**Expected benefit.** Future scans stop publishing false coverage deltas and
stop asking reviewers to investigate a document outside the declared sample.
This matters because the block's figures are copied into the append-only ledger
and become the next run's baseline.

**Approximate scope.** One PR: select contract documents through an existing
front-matter parser or a shared exported selector, update the measurement
reference, and add a body-only `contract: true` counter-control.

**Verification still needed.** The fixed selector must return 7 contract
documents and preserve the 15/5 literal-gap result at this SHA. A fixture with
the token only in prose must remain excluded while a true front-matter key is
included.

**Tracking.** GitHub search found the prior coupling-gap tasks but no task for
this selector. The ledger records earlier block-2 measurement mistakes, not
this body-example mechanism.

### C2 — `parent_payment_id` is in the receipt/evidence ID domain while the same feed exposes `paymentId` in the intent ID domain

**Opportunity and evidence.** Purchase grouping stores the purchase
`machine_payment_evidence.id` as a fee row's parent. The accounting entry's
public `paymentId` is instead the payment intent id. The real-database test
pins the mismatch by asserting the parent equals the seeded evidence id.

PR #4544 states the residual directly: joining `parent_payment_id` to the
feed's `payment_id` misses; the parent is currently joinable to
`receiptRef`, not to the adjacent public payment id. GitHub search found only
the closed implementation issue #4534 and no open follow-up.

**Expected benefit.** Consumers can group a fee with its purchase without
reverse-engineering two UUID domains or silently dropping the link.

**Approximate scope.** One PR. Either store the parent intent id, or rename the
public field to make the receipt/evidence domain explicit. A semantic change
must decide whether existing rows need a backfill; a rename can stay additive
for compatibility.

**Verification still needed.** A real-database test should join a fee's parent
to the purchase feed entry using the documented public fields. Preserve
settlement-order independence, first-write-wins, orphan fees and retried
purchase legs.

### C3 — direct payments now enter the accounting feed but are classified as an unknown merchant instead of a transfer

**Opportunity and evidence.** The direct-payment branch supplies no resource
URL, MCP tool, merchant receipt or delivery reference. The classifier therefore
cannot reach its route-based `transfer` vocabulary:

```text
deriveTransactionKind({
  direction: 'out',
  resourceUrl: null,
  mcpToolName: null,
  merchantReceiptJson: null,
  deliveryReference: null
})
→ {"kind":"unknown","basis":"none","route":null}
transactionDescription(...)
→ "Unknown merchant (unclassified)"
```

PR #4546 explicitly records this residual after adding direct payments to the
feed. GitHub search found no open follow-up.

**Expected benefit.** A plain wallet transfer is described as a transfer on
the accounting underlag instead of an unknown merchant purchase, reducing
manual bookkeeping interpretation.

**Approximate scope.** One PR across the transaction-kind signals/classifier,
the accounting entry mapper, focused unit and real-database tests, receipt
rendering assertions, and the accounting contract documentation.

**Verification still needed.** Add a pure classifier case plus a real direct
payment feed/receipt case that says `transfer`. Protocol purchases, API fees,
refunds and unknown routes must retain their current outcomes.

### C4 — the served receipt schema omits `delivery_reference`, a live backend field the SDK consumes

**Opportunity and evidence.** At the scan SHA:

```text
MachinePaymentReceipt OpenAPI schema: delivery_quality present; delivery_reference absent
generated core MachinePaymentReceipt: delivery_quality present; delivery_reference absent
SDK raw receipt + mapper: delivery_reference present and consumed
backend evidence emitter: delivery_reference present
```

The response passes only because the receipt schema allows additional
properties. PR #4479 names this as an explicit backend follow-up. GitHub search
found #4469 closed and no open issue for the schema field.

**Expected benefit.** Generated clients and contract reviewers can discover a
field the backend already serves and the SDK already maps; a future schema
closure cannot silently drop it.

**Approximate scope.** One PR: add and describe the OpenAPI property, regenerate
core types, and update response-shape/mapper contract tests and the relevant
contract note.

**Verification still needed.** Run generated-type drift, backend response-shape
tests, SDK mapper tests and a recorded receipt response through the existing
round-trip instrument.

### C5 — two sibling `pull_request_target` gates retain the same cancellation shape proven to create empty check suites

**Opportunity and evidence.** #4524 demonstrated that a per-PR concurrency
group with `cancel-in-progress: true` can cancel a pending run before it
creates a check run, leaving the newest suite on a head at “Expected — Waiting
for status to be reported.” PR #4526 removed that group from External intake
gate and recorded a 5/5 post-merge burst with complete suites.

The PR ownership gate and Baseline change gate still use the same trigger and
concurrency shape:

```yaml
on:
  pull_request_target:
    types: [opened, edited, synchronize, reopened, ready_for_review]
concurrency:
  group: <gate>-${{ github.event.pull_request.number }}
  cancel-in-progress: true
```

PR #4526 explicitly lists both as planned follow-up. GitHub search found no
separate tracking issue. The ownership/baseline contexts may be advisory today;
the proven hazard still creates ambiguous empty suites and becomes
merge-blocking whenever either context is required.

**Expected benefit.** Every event produces a terminal verdict, avoiding empty
same-SHA suites and eliminating a known future required-check deadlock.

**Approximate scope.** One CI PR covering the two workflows and their static
workflow tests. `docs.yml` remains outside this candidate because #4524 asked
for an observed incident before changing that separate workflow.

**Verification still needed.** Mutation/static tests must reject reintroduced
concurrency. Because `pull_request_target` runs the default-branch copy, a
post-merge label/body-edit burst must show every suite containing a terminal
check run.

## 3. Coverage record

All measurements below are at `99ef8d063` unless stated otherwise.

- **Sizing → examined.** Tracked TS/TSX/MJS under each package's `src`, split
  on tests: backend 120,895 source / 160,644 test lines; frontend 77,394 /
  84,225; SDK 19,621 / 22,603; MCP server 14,114 / 25,456; QA agent 15,133 /
  13,283; connect 12,436 / 15,676; signer 5,564 / 9,363; core 25,730 / 985
  (24,096 generated API-type lines; adjusted non-generated 1,634 / 985);
  remaining packages were within a few percent of the 2026-10-26 baseline.
- **Fat controllers → examined as a census.** 50 production backend route
  files / 257 registrations; 4 files at or above 1,000 lines. Largest:
  payments 1,572 lines / 7 registrations, up 11 lines from the ledger's last
  largest-route reading. No material structural delta.
- **Block 1, guard falsifiability → not examined.** The four-day delta and
  usage budget did not justify dependency installation plus mutations. No
  mutation result is claimed.
- **Block 2, contract-doc `covers:` → examined.** Exact reference selector:
  8 documents / 19 raw misses. Correct declared sample: 7 documents / 15
  literal misses across 5, unchanged at the previous scan SHA. The coupling
  baseline remains green at 124 pairs / 33 docs. C1 is the instrument defect.
- **Block 3, stale numbers → partial.** Positive control 3/3. Newest 25
  regulatory shards: 7 regex matches on 5 lines, 0 with an inline command;
  only 3 are measured figures, the rest protocol/status/migration notation.
  This matches the 2026-10-26 7/0 reading. `any` density 39 and DB-mock
  gauge 54 mocks / 270 positional calls / 57 files, both unchanged.
- **Block 4, retired vocabulary → examined.** Positive control 36 shards;
  196 files, 47 historical / 149 live; prose ratchet green at 32 hits / 30
  files; code-half references unchanged. Exact match to the prior baseline.
- **Block 5, merge-method drift → examined.** Since 2026-08-10: 282 merge
  commits / 1,396 squash landings / 1,681 total. Merge count is unchanged;
  every new landing is squash. The latest wrong-method landing remains
  2026-09-07. Squash-only enforcement holds in the examined window.
- **Block 6, nets with holes → examined.** Copy-lint perimeter 66 unscanned /
  4 with hits; money perimeter 32 verb files / 20 outside, unchanged; visual
  gate 15 exact routes of 27, unchanged; pinned Markdown outside both docs
  boundaries 43, unchanged; freshness-gate exit branches unchanged.
- **Block 8, refusal census → not examined.** It needs core/MCP builds,
  Postgres and the backend response-recording suite. No short fixture result
  is treated as evidence.
- **Block 9, field round-trip → not examined.** It shares block 8's fresh
  recording prerequisite. C4 comes from a direct schema/emitter/mapper
  comparison and still requires the block-9 verification named above.
- **Incident clustering → examined.** GitHub search for issues created since
  2026-10-26 returned 81: 25 open / 56 closed. The large UI, accounting,
  release, MCP/SDK, CI and Railway clusters are already tracked. No untracked
  multi-PR mechanism met the structural bar.
- **Workflow archaeology → examined.** Newest 100 `ci.yml` runs: 82 success,
  11 cancelled, 7 failure; all seven failures were feature branches, six
  involving visual regression. Forty-two sampled `dev` runs had no failure.
  Five sampled scheduled/manual QA money-flow logs completed every leg and
  passed on attempt 1/2.
- **Comment archaeology → examined.**
  `git grep -n -w -E 'TODO|FIXME|HACK|XXX' -- 'packages/*/src/*'` → 0;
  positive control `import` → 2,204 files. One stale future-tense comment was
  refused under the candidate bar: a one-line wording correction with no
  evidenced behavioural or contributor cost.
- **Cross-package duplication → partial.** Changed copies inspected were
  parity-pinned or prior accepted debt. No new duplicated policy met the bar.
- **Validation/contracts → partial.** C4 is the observed live mismatch;
  blocks 8/9 and a full contract census were not run.
- **Data-layer coverage → partial.** The DB-mock gauge and changed accounting
  SQL/tests were read; no database suite or full repository census was run.
- **Live exercise → not examined.** No dev, production, MCP or paid call.

## 4. Verification and limitations

- Both detached measurement worktrees ended with
  `git status --porcelain` empty.
- Focused backend execution was unavailable in one detached tree because
  dependencies were not installed (`tsup: command not found`). C3's pure
  classifier reproduction ran with Node's type stripping; its database and
  PDF verification remains explicitly outstanding.
- Novelty was checked against the full quality ledger, bug-report search,
  current GitHub issues and the source PRs that disclosed the residuals.
- This report makes no claim about unexecuted mutations, database behaviour,
  blocks 8/9, browser behaviour, or a live runtime.

