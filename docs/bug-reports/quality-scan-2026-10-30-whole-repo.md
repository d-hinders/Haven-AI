---
owner: "@d-hinders"
status: record
covers:
  - .agents/skills/quality-scan/references/dimensions.md
  - scripts/frontend-copy-lint.mjs
  - docs/contributing/docs-quality-system.md
  - packages/backend/src/modules/mpp/evidence.ts
  - packages/backend/src/modules/mpp/purchase-group.ts
  - packages/backend/src/infra/repositories/machine-payments.ts
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
across 8 selected documents. Four come from the false document (two of them
the glob strings `packages/**/*.md` and
`packages/backend/src/docs-drift/*.test.ts`, two real paths:
the money-path globs file and core's generated API types);
19 − 4 leaves **15 literal gaps across 5 actual contract documents**, each
confirmed with `coupling-gate.mjs --strict --changed=<path>` (none names its
document). The ledger has recorded "17 across 6 of 8" since 2026-10-03: that
is these 15 plus the false document's two real-path misses. Re-running the
corrected sample at `b9f9f1e47` gives the same 15/5, so the contracts did not
worsen; the instrument was counting the wrong sample.
`dimensions.md:124-125,165` still describes 8 documents and treats
`docs-quality-system.md` as a contract document.

**Expected benefit.** Future scans stop publishing false coverage deltas and
stop asking reviewers to investigate a document outside the declared sample.
This matters because the block's figures are copied into the append-only ledger
and become the next run's baseline.

**Approximate scope.** One PR: select contract documents through an existing
front-matter parser or a shared exported selector, update the measurement
reference, and add a body-only `contract: true` counter-control.

**Verified at scan.**

```text
rg -l '^contract: true' docs --glob '*.md' | wc -l          → 8 (front-matter parse → 7)
classifyChangedFiles(.agents/skills/quality-scan/references/dimensions.md) → (none)
money-path: dimensions.md → off   (control rails/sweep.ts → money-path)
```

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

**Verified at scan.** `evidence.ts:602-616` sets the parent to the purchase's
`machine_payment_evidence` row id; `entry.ts:328` sets `paymentId` from
`payment_intent_id` and `receiptRef` from the evidence row id;
`purchase-correlation.db.test.ts:188-200,235` asserts the parent equals the
seeded `evidenceId`, distinct from its `intentId`. Routing and money-path:

```text
classifyChangedFiles(evidence.ts, purchase-group.ts, machine-payments.ts, entry.ts) → code backend
modules/mpp/evidence.ts                      → money-path
modules/mpp/purchase-group.ts                → money-path
infra/repositories/machine-payments.ts       → money-path
modules/accounting/entry.ts                  → off
(control rails/sweep.ts                      → money-path)
```

A remedy that changes what the parent column stores touches money-path files
and takes that playbook; a rename confined to `entry.ts` does not.

**Verification still needed.** A real-database test should join a fee's parent
to the purchase feed entry using the documented public fields. Preserve
settlement-order independence, first-write-wins, orphan fees and retried
purchase legs.

### C3 — direct payments now enter the accounting feed but are classified as an unknown merchant instead of a transfer

**Opportunity and evidence.** The direct-payment branch supplies `NULL` for the
resource URL, merchant receipt and delivery reference (`entry.ts:459-480`).
It does select an MCP tool name
(`pi.machine_metadata->'mcp_call_context'->>'toolName'`, `entry.ts:474`), but
that is null in practice: only `x402/delegation-authorize.ts` writes
`mcp_call_context`. The classifier therefore cannot reach `transfer`
(`transaction-kind.ts:66`), which it reaches only through a route verb
(`:330`):

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

**Verified at scan.** The classifier reproduction above (Node type stripping).
Routing and money-path:

```text
classifyChangedFiles(transaction-kind.ts, entry.ts, receipt-underlag.ts) → code backend
modules/accounting/{transaction-kind,entry,receipt-underlag}.ts → off
```

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

**Verified at scan.** `MachinePaymentReceipt` (`spec.ts:13314-13405`) carries
`delivery_quality`, no `delivery_reference`, and `additionalProperties: true`
at `:13405`; the `delivery_reference` at `spec.ts:961` belongs to another
schema. The backend emits it (`evidence.ts:1102`); the SDK declares it
(`types.ts:2782`) and reads it (`payment-mappers.ts:211-212`). Routing and
money-path:

```text
classifyChangedFiles(spec.ts, core/src/api-types.ts, sdk/src/payment-mappers.ts)
  → code frontend ops backend sdk connect mcp mcp_server signer core qa_agent
openapi/spec.ts, core/src/api-types.ts, sdk/src/payment-mappers.ts → off
```

**Verification still needed.** Run generated-type drift, backend response-shape
tests, SDK mapper tests and a recorded receipt response through the existing
round-trip instrument.

### C5 — two sibling `pull_request_target` gates retain the same cancellation shape proven to create empty check suites

**Opportunity and evidence.** #4524 demonstrated that a per-PR concurrency
group can cancel a pending run before it creates a check run, leaving the
newest suite on a head at “Expected — Waiting for status to be reported.” The
pending-run cancellation is the group's default behaviour whatever
`cancel-in-progress` says (#4524, *Verified* 3); `cancel-in-progress: true`
additionally cancels the running one. PR #4526 removed the group from External
intake gate, and #4524's operator-verify comment (probe PR #4528, 2026-10-29)
recorded a 5/5 post-merge burst, every gate suite with one check run.

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

Neither listens for `labeled`, so the burst is `opened` plus a quick body edit
(`edited`) on the same head. PR #4526 lists both as planned follow-up, and
#4524 settled that a follow-up issue would be filed through `new-task`; GitHub
search found none. Neither context is required on `dev` today, but PR
ownership gate is the pending 17th required context
(`docs/contributing/autonomous-pr-loop.md:584`): once applied, it inherits
this failure mode. Until then the hazard creates ambiguous empty suites.

**Expected benefit.** Every event produces a terminal verdict, avoiding empty
same-SHA suites and eliminating a known future required-check deadlock.

**Approximate scope.** One CI PR covering the two workflows and their static
workflow tests. `docs.yml` remains outside this candidate because #4524 asked
for an observed incident before changing that separate workflow.

The remedy is removing the group (as #4526 did) or `queue: max`; flipping
`cancel-in-progress` to `false` alone does not stop pending-run cancellation.

**Verified at scan.**

```text
grep -n cancel-in-progress pr-ownership-gate.yml baseline-verdict-gate.yml → :78 true, :77 true
external-intake-gate.yml → no concurrency: block (comment only, :68, :83)
classifyChangedFiles(both workflows + their scripts/ci/*.test.mjs)
  → code frontend ui ops backend sdk connect mcp mcp_server signer cli demo_merchant core qa_agent full
money-path: both workflows → off
```

**Verification still needed.** Mutation/static tests must reject reintroduced
concurrency. Because `pull_request_target` runs the default-branch copy, a
post-merge burst of `opened` plus body edits (or pushes) must show every suite
containing a terminal check run; these two gates do not trigger on labels.

## 3. Coverage record

All measurements below are at `99ef8d063` unless stated otherwise.

- **Sizing → examined.** The 09-22 command pinned with `git ls-tree`/`git show`:
  tracked `.ts`/`.tsx`/`.mjs` under each `packages/<p>/src`, split on
  `\.test\.|__tests__`: backend 120,895 source / 160,644 test lines; frontend 77,394 /
  84,225; SDK 19,621 / 22,603; MCP server 14,114 / 25,456; QA agent 15,133 /
  13,283; connect 12,436 / 15,676; signer 5,564 / 9,363; core 25,730 / 985
  (24,096 generated API-type lines; adjusted non-generated 1,634 / 985);
  remaining packages were within a few percent of the 2026-10-26 baseline.
- **Fat controllers → examined as a census.** Non-test `.ts` under
  `packages/backend/src/routes` at the scan SHA → 50 files; 4 at or above
  1,000 lines. Registrations,
  `grep -oE '\b(app|ownerApp)\.(get|post|put|patch|delete|route)\b'` over
  those 50 → **212** (*corrected in review*: the first reading said 257 with no
  command, and no candidate command reproduces it). Largest: payments 1,572
  lines / 7 registrations, up 11 lines from the 2026-10-26 reading of 1,561.
  No material structural delta.
- **Block 1, guard falsifiability → not examined.** The four-day delta and
  usage budget did not justify dependency installation plus mutations. No
  mutation result is claimed.
- **Block 2, contract-doc `covers:` → examined.** Exact reference selector:
  8 documents / 19 raw misses. Correct declared sample: 7 documents / 15
  literal misses across 5, unchanged at the previous scan SHA. The coupling
  baseline remains green at 124 pairs / 33 docs. C1 is the instrument defect.
- **Block 3, stale numbers → partial.** Positive control 3/3. Newest 25
  regulatory shards by dated name (`2026-10-25-4372` … `2026-10-30-4552`),
  the reference's two `rg` lines → **16 figure-bearing lines, 2 with a
  command** (*corrected in review*: the first reading, 7/0, was the
  `b9f9f1e47` sample, not this SHA's). 12 of the 16 are measured figures; 4
  are notation (a `500/502` status pair, migration numbers `093/094/…`, an
  issue number before "tests", a `1/2/3-link` count). The two commanded lines
  are the 0.12.0/0.13.0 release shards' "re-measured" lines, and 5 more
  measured lines are the bullets directly under them.
  The remaining 5 uncommanded measured lines are test-run counts in PR
  verification shards (`4449:99-100`, `4394:56`, `4458:81`, `4415:46`),
  against 3 at `b9f9f1e47`; not raised as a candidate. `any` density 39 and
  DB-mock gauge 54 mocks / 270 positional calls / 57 files, both unchanged.
- **Block 4, retired vocabulary → examined.** Positive control 36 shards;
  196 files, 47 historical / 149 live; prose ratchet green at 32 hits / 30
  files; code-half references unchanged. Exact match to the prior baseline.
- **Block 5, merge-method drift → examined.** Since 2026-08-10: 282 merge
  commits / 1,396 squash landings / 1,681 total. Merge count is unchanged;
  every new landing is squash. The latest wrong-method landing remains
  2026-09-07. Squash-only enforcement holds in the examined window.
- **Block 6, nets with holes → examined.** Copy-lint perimeter **66**
  unscanned / 4 with hits (64 / 4 on 2026-10-26; the script is unchanged, and
  the +2 are two new files, the frontend's `agent-facet.ts` and the SDK's
  test-support `low-s.ts`); money perimeter 32 verb files /
  20 outside, unchanged; visual gate 15 exact routes of 27, unchanged; pinned
  Markdown outside both docs boundaries 43, unchanged; freshness-gate exit
  branches unchanged.
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

## 5. Independent review

`haven-reviewer` at head `7141367` (base `99ef8d063`), briefed to re-derive
every locally reproducible figure at the scan SHA; the captain re-checked
the GitHub-side claims (PR #4544, #4546, #4479, #4526 and issue #4524 bodies
and comments, and open-issue searches for C1–C5). Verdict: no blocking, four
should-fix, six nits. All five candidates verified against the code. The
corrections are applied in place above and marked where a figure changed:

- block 3 shard reading 7/0 → **16/2** at the scan SHA;
- route registrations 257 (no command) → **212** with its command;
- block 6 copy-lint figure stated as 64 → 66, not "unchanged";
- the *Verified at scan* field (routing and money-path) added to C1–C5;
  C2's remedy touches money-path files;
- C1's arithmetic (19 − 4) and its link to the ledger's 17/6;
- C3's MCP-tool signal is selected but null in practice;
- C5: the 5/5 burst is recorded on issue #4524 (probe PR #4528), not PR
  #4526; pending runs are cancelled by the group itself, so
  `cancel-in-progress: false` alone is not a remedy; the two gates do not
  trigger on labels; PR ownership gate is the pending 17th required context;
- `covers:` adds the two files where C2's parent id is written.

Everything else re-derived as recorded: the 51-landing window and shortstat,
all sizing figures, 50 route files / 4 ≥ 1,000 lines / payments 1,572, block 2
8/19 → 7/15/5 at both SHAs, 124 pairs / 33 docs, `any` 39, DB-mock gauge, block 4,
block 5, the other three block-6 halves, and the comment-archaeology counts.
Not re-derived locally: issue, CI-run and QA-log counts (GitHub only).

