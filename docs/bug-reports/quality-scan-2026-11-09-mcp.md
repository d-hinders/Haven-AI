---
owner: "@d-hinders"
status: record
covers:
  - packages/mcp/src/tools.ts
  - packages/mcp/src/credentials.ts
  - packages/mcp/src/consent.ts
  - packages/mcp-server/src/tools/contracts.ts
  - packages/mcp-server/src/tools/support/errors.ts
  - packages/mcp-server/src/tools-list.snapshot.json
  - packages/mcp-server/src/strict-tool-input.test.ts
  - packages/signer/src/credentials.ts
  - packages/signer/src/consent.ts
  - scripts/ci/refusal-census.mjs
  - .github/money-path-globs.json
  - docs/architecture/08-local-vs-hosted-mcp.md
  - packages/qa-agent/package.json
  - packages/backend/src/rails/sweep.ts
  - packages/mcp/src/server.ts
  - scripts/ci/money-path.test.mjs
last-verified: "2026-11-09"
---

# Quality scan 2026-11-09 — the two MCPs (scoped)

Scope: `packages/mcp` (the published local `@haven_ai/mcp`), `packages/mcp-server`
(the hosted MCP) and what the two share or duplicate, the signer included
(owner request 2026-11-09: "scan both MCPs"). A scope is a filter, so
`docs/quality/scan-baselines.json` is not updated. Measured at `49747fac3`
(equal to `origin/dev` at fetch time) by one agent, `npm ci --ignore-scripts`,
with core, the SDK, the local MCP, the signer and the hosted MCP built. No
test suite was run and no database was used. GitHub read-only apart from the
filing recorded in the ledger. One read of the public npm registry
(`npm view @haven_ai/mcp dist-tags`). No live Haven, MCP, dev or production
call was made.

Every figure is `command → number` at that SHA, from the repo root. Three
figures come from short scripts the report describes in words; they are marked.

## The shape, measured

- Tool sets. Local: `git show 49747fac3:packages/mcp/src/tools.ts | grep -oE "^  haven_[a-z0-9_]+:" | sort -u | wc -l`
  → 20. Hosted: the keys of `tools` in
  `packages/mcp-server/src/tools-list.snapshot.json` → 29. Shared names: 19.
  Local-only: `haven_pay_x402`. Hosted-only: 10 (`haven_check_funds`,
  `haven_complete_mcp_tool`, `haven_pay`, `haven_prepare_catalog_purchase`,
  `haven_quote_catalog_purchase`, `haven_quote_mcp_tool`,
  `haven_report_delivery_quality`, `haven_report_settlement_evidence`,
  `haven_report_x402_outcome`, `haven_settle_mcp_tool`).
- Size: `packages/mcp/src/tools.ts` 1,547 lines holds all 20 local tools;
  `packages/mcp-server/src` is 14,704 non-test lines.
- Publication: `npm view @haven_ai/mcp dist-tags` → `latest` and `alpha` both
  `0.13.0-alpha.0`. The local package is what a bare `npx @haven_ai/mcp`
  installs.

## Structural finding

### S1 — one agent surface is implemented twice with no shared contract, and the nets cover one side

The local and hosted MCPs expose 19 tools under the same names. Nothing makes
them the same tool.

Measured:

- **Same name, different input contract: 8 of 19.** *(script)* For each
  shared name, the keys of the local zod shape (`toolSchemas` exported by the
  built `@haven_ai/mcp`) against the keys and `required` of the hosted
  snapshot's `inputSchema` → 11 equal, 8 different: `haven_pay_mcp_tool`
  (hosted adds `max_amount`, `max_amount_human`, `include_signing_payload`),
  `haven_pay_x402_quote` (local requires `quote`; hosted takes `url`,
  `payment_required`, caps and five more, none required),
  `haven_quote_x402`, `haven_resume_x402_payment`, `haven_send`,
  `haven_submit`, `haven_sweep_delegate`, `haven_verify_receipt`
  (`receipt` required locally, not hosted). Some differences are by design
  (the local process signs, so it needs no signing payload). None is
  declared as by-design anywhere a test reads.
- **Same name, different description: 10 of 19.** *(script)* The local
  `toolDescriptions[name]` equals the snapshot's `description` for 9.
- **They change together by hand.** `git log --since=2026-09-01 --first-parent --oneline 49747fac3 -- packages/mcp/src | wc -l`
  → 55 landings; of those, the ones whose file list also contains
  `packages/mcp-server/src` → 46 (84%).
- **Three error mappers.** `git grep -nE "function normalizeError" 49747fac3 -- packages/mcp/src packages/mcp-server/src packages/signer/src`
  → `mcp/src/tools.ts:1418`, `mcp-server/src/tools/support/errors.ts:509`,
  `signer/src/tools.ts:1459`. Only the hosted one is exported.
- **The nets are on the hosted side.**
  `git ls-tree -r --name-only 49747fac3 packages/mcp-server/src | grep -ciE "snapshot|corpus|fingerprint"`
  → 5 files (the `tools/list` snapshot, the contract fingerprint, the
  next-arguments corpus and two tests); the same over `packages/mcp` → 0.
  The refusal census (block 8) feeds one mapper:
  `git grep -n "tools/support/errors.ts" 49747fac3 -- scripts/ci/refusal-census.mjs`
  → the hosted one. The QA agent cannot drive the local package:
  `git show 49747fac3:packages/qa-agent/package.json | grep "@haven_ai"` →
  the package's own name, `@haven_ai/sdk` and `@haven_ai/signer`; no
  `@haven_ai/mcp`.

Demonstrated cost. The repo has paid for this divergence one key at a time:
#2312 (2026-08-31, twenty hosted tools silently stripped undeclared
arguments), #2348 (2026-09-01, "the four tools where the local MCP teaches a
different argument name"), #2349, #2353, and #3411 (2026-09-28, the legacy
`idempotencyKey` spelling). `docs/architecture/08-local-vs-hosted-mcp.md`
records the worst case in its own table: for `haven_send` the local spelling
on the hosted surface was a "Total loss" — the payment went out with no
idempotency key, so a retry was a second payment. The remedy each time was a
per-key pin in `packages/mcp-server/src/strict-tool-input.test.ts`, which
imports the local schemas to check the keys named so far
(`git grep -c "localToolSchemas" 49747fac3 -- packages/mcp-server/src/strict-tool-input.test.ts`
→ 7 lines). A difference nobody has named yet is checked by nothing. C1
below is one, found by this scan.

Relation to prior work: the 2026-08-18 entry refused "local/hosted MCP tool
mirroring" as "already parity-tested". That was before #2312; the parity
tests it meant cover descriptions and the keys later incidents named. The
2026-10-03 S1 (epic #3615) covered the budget-scope keys on both surfaces.
Neither measured the contract as a whole.

How it changes work: 84% of local changes are also hosted changes, made
twice. A manifest of declared differences turns "did I update both?" from
memory into a failing test.

**The decision under it is the owner's**: what support level the local MCP
has. The architecture doc calls it "an advanced `--local` option"; it is also
the package `latest` points at. Three coherent answers, each with a
different remedy:

1. *First-class.* Both surfaces share a contract source and both get the
   nets (slices A–D below).
2. *Supported, deliberately smaller.* Keep two implementations, but declare
   every difference (slice A) and close the money-relevant gaps (C1, C2).
3. *Frozen or retired.* Stop adding to it; the remedy is a deprecation
   notice and a pin, not parity work.

Proposed slices, disjoint by file:

- **A. A parity manifest.** One test that, for every shared tool name, lists
  each difference in input keys, `required` and description with a one-line
  reason, and fails on a difference that is not listed. Subsumes the per-key
  pins.
- **B. One table of typed backend refusals in the SDK**, used by both
  mappers (C1).
- **C. A `tools/list` snapshot for the local package**, as the hosted one has.
- **D. The local package on the money-path perimeter** (C2).

## Improvement candidates (one PR each)

### C1 — the local MCP answers a typed backend refusal generically, without the next-step fields the convention requires

- **Evidence (observed by execution, with a stubbed SDK client).** *(script)*
  Ten backend `error_code` values were each thrown as a `HavenApiError`
  from a stub client and passed (a) to the hosted `normalizeError` and (b)
  through the built local package's `haven_send` handler. Hosted: a typed
  code for 9 of 10 (`DELEGATION_BUDGET_EXCEEDED`, `DELEGATION_EXPIRED`,
  `TASK_BUDGET_EXCEEDED`, `PREPARE_REVERTED`, `SUBMISSION_OUTCOME_UNKNOWN`,
  `RAIL_UNAVAILABLE_FOR_CHAIN`, `ACCOUNT_VALIDATION_FAILED`,
  `SIGNATURE_REJECTED`, `ONCHAIN_EXECUTION_FAILED`; `insufficient_balance`
  stays `API_ERROR`) and `next_tool_omitted_reason` on 10 of 10. Local:
  `API_ERROR` for 10 of 10, `next_action: stop_and_tell_user` for 10 of 10,
  `next_tool_omitted_reason` on 0 of 10, with the raw backend body passed
  through. For `delegation_budget_exceeded` and `delegation_expired` the two
  surfaces give different steps: hosted `fund_account_or_raise_allowance`,
  local `stop_and_tell_user`.
  The local package has no test naming the code:
  `git grep -cE "delegation_budget_exceeded|DELEGATION_BUDGET_EXCEEDED" 49747fac3 -- packages/mcp/src`
  → 0 files; the same over `packages/mcp-server/src` → 34 lines.
- **What was not shown.** The stub bypasses the SDK client's own request
  path, so this is the handler's answer to that error object, not an
  end-to-end purchase. The body shape `{ error, error_code }` is the one the
  hosted mapper recognised.
- **Benefit.** `CLAUDE.md` requires every MCP payment-flow response to name
  its next tool or say why none follows. `lint:next-steps` scans
  `packages/mcp/src/tools.ts` for literal sites, so it cannot see what a
  mapper produces at runtime. An over-budget agent on the local MCP is told
  to stop, with no reason field, where the hosted one is told the budget is
  spent and what the owner can do.
- **Scope.** Move the typed-refusal table (code → typed code, step, reason)
  to the SDK; both mappers read it. Or, smaller: teach the local mapper the
  codes. One PR. `packages/mcp-server/src/tools/support/errors.ts` is
  money-path, so owner-gated.
- **Verified at scan.** The probe above. Routing: `packages/mcp/src/tools.ts`
  → `code connect mcp mcp_server`; `errors.ts` → `code mcp_server`.
  Money-path: `packages/mcp/src/tools.ts` → `off`; `errors.ts` →
  `money-path`; control `sweep.ts` → `money-path`. Tracking: no open issue
  titled for the local MCP. Mutation recipe *unrun* — the shared table does
  not exist.
- **Still needed.** Run block 8's recorded backend errors through the local
  mapper too, so the comparison covers every recorded code, not ten.

### C2 — the package that loads the delegate key and signs in-process is off the money-path perimeter

- **Evidence.** The matcher (control first):
  `packages/backend/src/rails/sweep.ts` → `money-path`;
  `packages/mcp/src/tools.ts` → `off`; `packages/mcp/src/credentials.ts` →
  `off`; `packages/signer/src/credentials.ts` → `money-path`;
  `packages/mcp-server/src/tools/support/errors.ts` → `money-path`.
  `git show 49747fac3:.github/money-path-globs.json | grep -nE '"packages/(mcp|mcp-server|signer)[/"*]'`
  → `packages/mcp-server/src/**` and `packages/signer/**`; nothing for
  `packages/mcp`. The file's own rationale for the signer reads "the
  edge-signer package that actually holds the delegate key"; the local MCP
  holds it too (`packages/mcp/src/credentials.ts` reads `delegate_key`,
  `packages/mcp/src/server.ts:85` passes it on). No note in the file records
  a decision to leave the package out. 55 landings touched
  `packages/mcp/src` since 2026-09-01.
- **Benefit.** A change to how the local package loads the key or builds a
  payment currently gets no `money-path` label, no money playbook and no
  QA-freshness count unless it also touches a listed file (at least 46
  of the 55 did: they also touched `packages/mcp-server/src`).
- **Scope.** A perimeter decision, so the owner's: add `packages/mcp/src/**`
  to `globs` or to `controlGlobs`, with the labeler and perimeter-reference
  entries. No QA leg drives the local package (S1), so a runtime glob would
  ask for a QA run that does not exercise it; `controlGlobs` — label and
  human review, no QA re-run — fits what exists. One PR.
- **Verified at scan.** Matcher output above. Routing for
  `.github/money-path-globs.json` not run. Prior art:
  `gh api search/issues … money-path-globs "packages/mcp"` → no issue about
  this package; #4122 is the SDK precedent. Mutation recipe *unrun*.
- **Still needed.** `node --test scripts/ci/money-path.test.mjs` green with
  the three lists agreeing.

### C3 — delegate-key credential loading and consent are written twice, in the local MCP and the signer

- **Evidence.** *(script)* Line-level matching (`difflib`) of
  `packages/mcp/src/credentials.ts` (446 lines) against
  `packages/signer/src/credentials.ts` (233) → 128 matching lines; of
  `consent.ts` (377 vs 208) → 92. Three exported functions carry the same
  name in both — `readAccountAddressField`, `readAccountAddressEnv`,
  `warnIfCredentialFilePermissive`; whitespace-stripped body hashes: the
  second equal, the other two different. Read side by side, the two
  different pairs behave the same today: the signer moved its permission
  check into `file-mode.ts`, the local MCP kept the inline original.
- **What was not shown.** No behavioural difference. This is a duplication
  figure, not a defect.
- **Benefit.** The next hardening of key-file handling lands in one place.
- **Scope.** A shared module in the SDK's edge entry, both packages
  re-pointed. One PR; `packages/signer/**` is money-path.
- **Verified at scan.** Figures above. Routing:
  `packages/signer/src/credentials.ts` → `code connect mcp_server signer
  qa_agent`; `packages/mcp/src/credentials.ts` → `code connect mcp
  mcp_server`. Mutation recipe *unrun*.
- **Still needed.** A characterization test over the credential-file shapes
  both loaders accept, before either is replaced.

## Coverage record

- Tool-set and contract comparison → examined → the figures above, 19 shared
  names. Output shapes of the shared tools were not compared.
- Error mapping → partial → ten codes by execution through one local
  handler; block 8's full recording not run (needs the backend suite's
  database).
- Co-change → examined → first-parent landings since 2026-09-01.
- Net coverage per package → examined → the file and dependency checks above.
  Per-gate allowlists (block 6 proper) not walked.
- Duplication with the signer → partial → `credentials.ts`, `consent.ts` and
  the three `normalizeError`; `signer-compat` twins not assessed beyond
  noting an existing field-for-field parity test.
- Hosted internals (the five large tool files) → not examined → the
  2026-09-10 finding (epic #2806) covers that file family; excluded.
- Live behaviour → not examined → no live call.
- Blocks 1, 2, 3, 4, 5, 9 → not examined → out of scope. Block 6 → partial
  (C2). Block 8 → partial (C1, ten synthetic codes, local side only new).
