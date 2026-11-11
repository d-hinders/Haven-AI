---
owner: "@d-hinders"
status: record
covers:
  - .agents/skills/quality-scan/references/dimensions.md
  - scripts/docs/scan-remeasure.mjs
  - scripts/ci/refusal-census.mjs
  - scripts/ci/prove-red.mjs
  - scripts/ci/catalog-conformance.mjs
  - packages/backend/src/rails/delegation-rail.ts
  - packages/backend/src/rails/hybrid-transfers.ts
  - packages/backend/src/modules/payments/sign-payment.ts
  - packages/backend/src/modules/payments/submission-reconciler.ts
  - packages/backend/src/modules/payments/receipt.ts
  - packages/backend/src/modules/x402/replay.ts
  - packages/backend/src/routes/catalog.ts
  - packages/backend/src/modules/accounting/receipt-underlag.ts
  - packages/backend/src/modules/accounting/accounted-connector.ts
  - packages/backend/src/modules/catalog/catalog-discovery.ts
  - packages/mcp-server/src/tools/plain-http-x402.ts
  - packages/mcp-server/src/tools/support/errors.ts
  - packages/mcp/src/tools.ts
  - packages/signer/src/sign-context.ts
  - packages/frontend/src/hooks/useDelegationSend.ts
  - packages/frontend/src/components/DelegationSendModal.tsx
  - packages/frontend/src/context/AuthContext.tsx
  - packages/frontend/src/hooks/useDelegationBudget.ts
  - packages/mcp-server/src/server.ts
  - packages/mcp-server/src/auth.ts
  - packages/sdk/src/passport.ts
last-verified: "2026-11-12"
---

# Quality scan 2026-11-12 — whole repo, hunting defects across verticals

Scope: the whole repository at `origin/dev` @ `9871885a9`, with the owner's
request for this run: find bugs in several verticals. The window since the last
whole-repo entry (2026-11-02, `e0617aa9f`):

```bash
git log --first-parent --oneline e0617aa9f..9871885a9 | wc -l    # 111
git diff --shortstat e0617aa9f 9871885a9                         # 909 files changed, 76564 insertions(+), 18080 deletions(-)
```

How it ran. Five workers, each in isolation from the others' conclusions:

- four **hunters**, one per vertical — the backend payment path; the backend
  outside it (accounting, catalog, tenancy, migrations); the agent surface
  (hosted MCP, local MCP, signer, SDK, CLI, connector, demo merchant); the owner
  dashboard — each briefed with the defect classes the 2026-10-27 channel
  measurement found a tree reading misses, and with an evidence bar: a finding
  is a reproduction that was run, with a positive control;
- one **measurement** worker in its own clone, for the numbered blocks.

The captain then ran every hunter reproduction again, once, from the saved test
files, in a worktree at the scan SHA: 15 test files and 2 scripts, each with the
pass / fail pattern its hunter reported (§ 4). A defect below is "reproduced"
only in that sense: a test or script that was run twice by two parties. Nothing
here was observed against a real bundler, a real accounting provider or
production.

Live calls: read-only, on **dev** only, as the dev agent `test` (§ 3, *live
exercise*). No payment, no signer call, no production call, no third-party
merchant request.

One security hypothesis from the backend hunter is not written in this public
record. It went to the owner directly.

## 1. Structural findings — pending owner decision

### S1 — an operation that was sent and whose outcome is unknown is booked, answered or shown as failed

**The pattern.** The backend sends a user operation in two places and waits for
its receipt in the same call. "Sent, outcome unknown" is recognised at exactly
one point: a throw from the receipt wait inside the agent-payment submit
(`SubmittedUserOpFailedError('receipt_unconfirmed')`, #3564). Every other way
for the answer to go missing after the send is treated as a failure, and each
surface that reads the failure then offers, or instructs, a second payment.

**Measured.**

```bash
# send-and-wait sites in non-test backend source
git grep -n -E "sendUserOperation\(|waitForUserOperationReceipt\(" 9871885a9 -- packages/backend/src ':!**/*.test.ts' ':!**/__tests__/**'
#   → 4 lines in 1 file: delegation-rail.ts:544 + :552 (submitRedemption), :787 + :791 (submitCall)
# callers of the owner-side submit
git grep -n -E "\.submitCall\(" 9871885a9 -- packages/backend/src ':!**/*.test.ts' ':!**/__tests__/**'
#   → 5: hybrid-signer-actions.ts:320, hybrid-transfers.ts:191, agent-delegations.ts:1195 and :1375, agent-rekey.ts:774
```

All five callers answer any throw with `502` and a "… failed" body
(`hybrid-transfers.ts:205` `Transfer failed`; `hybrid-signer-actions.ts:340`
`Signer change failed`; `agent-delegations.ts:1207` `Batch revocation failed`,
`:1386` `Revocation failed`; `agent-rekey.ts:787` `Revocation failed`), and
`submitCall` (`delegation-rail.ts:783-798`) has no post-send distinction at all.
In the dashboard, `git grep -c unconfirmed 9871885a9 --
packages/frontend/src/hooks/useDelegationBudget.ts` → 23, the #3930 fix; the
same grep on `useDelegationSend.ts` and `DelegationSendModal.tsx` → no match.

**Five reproduced defects on this one seam.**

1. *Agent payment: the bundler's answer to the send is lost.* The comment at
   `delegation-rail.ts:542-543` says a throw from the send "means it never
   entered the mempool". viem sends without retry and gives up after 10 s. With
   a loopback bundler that receives `eth_sendUserOperation` and never answers,
   the real `signPayment` returns after 10,171 ms with `502 {"status":"failed",
   "error_code":"onchain_execution_failed", …"The request took too long to
   respond."}`, the row is `failed` with no hash, and the reconciler has 0
   candidates. The hosted mapper's text for that code
   (`packages/mcp-server/src/tools/support/errors.ts:391-392`) tells the agent
   to "create a new payment if they still want to pay". `failed` also frees the
   idempotency key.
2. *Agent payment: the op is mined, a later step throws.* The fiat lookup and
   the confirm write sit in the same `try` as the submit
   (`sign-payment.ts:289-321`). With the submit returning a transaction hash and
   the confirm write throwing once, the answer is the same `502 … failed` and
   the row is `failed` with `tx_hash` null. (Run for the confirm write; the fiat
   lookup is read, not run.)
3. *A sign request that dies after the claim.* The claim writes `submitted`
   before the send (`payment-intents.ts:564-570`); the user-operation hash is
   written only if the route survives to catch a receipt-wait throw. With a
   submit that never returns and the row aged 30 days: status `submitted`,
   `next_action: check_status_later`, no hash; `findOutcomePendingIntents`, the
   erc7710 sweep and the orphan sweep each select 0 rows; a second sign answers
   409. The backend has no `SIGTERM` handler (`grep -rn "SIGTERM\|process.on("
   packages/backend/src` → the two crash handlers at `index.ts:306-313`; read,
   not run), so a deploy during a receipt wait is the ordinary way in.
4. *A payment the reconciler confirms is not booked like one the route
   confirms.* The reconciler's update sets `status`, `tx_hash` and
   `confirmed_at` only (`payment-intents.ts:729-732`) and then calls
   `emitFirstPayment` alone (`submission-reconciler.ts:157-162`). Against the
   same test's control payment (fiat triple set, accounting feed fired once,
   listed by `listUnpushedPaymentIds`), the reconciled payment has all three
   fiat values null, 0 feed calls, is absent from `listUnpushedPaymentIds` —
   whose SQL requires one fiat value (`accounting-feed-syncs.ts:312`) — and
   keeps `submission_outcome: "unknown"` on a confirmed row.
5. *Owner Send.* With the real `useDelegationSend` and `DelegationSendModal`,
   a submit whose answer is lost (a rejected `fetch`, or the backend's 502 for a
   receipt-wait timeout) shows a red alert and relabels the button `Try again`
   (`DelegationSendModal.tsx:325`). Pressing it prepares, signs and submits a
   second operation with the same `to` and `amount_atomic`; the submit body has
   no idempotency key (its keys are `amount_atomic, signature, signature_scheme,
   to, token_address, user_operation`). The backend half: `submitTransfer`
   answers a receipt-wait timeout and a pre-send `AA25` rejection with the same
   status and the same `error`.

*Not observed:* that a real bundler includes an operation whose HTTP answer was
lost, or that the second owner transfer lands. The bundler and the vendor
clients were stand-ins.

**Demonstrated cost.** The repository has already paid for this class three
times, one site at a time: #3564 (closed 2026-10-02: a sent payment whose
receipt was not confirmed was booked failed and never reconciled), #3930
(closed 2026-10-14: a lost activate response reported a failed grant, and the
retry left an extra budget enabled on-chain), #4470 (closed 2026-10-29: a
timeout read as a refusal after funding had moved). Each fix stopped at the
call site its incident named.

**How it changes work.** One rule a contributor can hold: after the send, only
an explicit bundler rejection or an included-and-reverted receipt is a failure;
everything else is outcome-pending and carries the operation hash. Today the
rule exists as a comment on one function.

**Slices (disjoint).**

- *Rail:* `submitRedemption` classifies a transport timeout on the send as
  post-send; `submitCall` throws the same typed error for its receipt wait.
- *Sign route and reconciler intake:* a throw after the submit returned is
  outcome-pending, never `failed`; the hash is written at the claim (the row
  already stores `signHash: authorization.prepared.userOpHash` at
  `create-payment.ts:775` — read, and not checked to be the hash the bundler
  indexes); the reconciler takes claimed delegation-rail rows without a
  transaction hash past a short age.
- *Reconciler booking:* its confirm goes through the route's booking (fiat
  triple, evidence hook, feed) and marks the outcome resolved.
- *Owner transfer:* the route answers a distinct unconfirmed code with the
  operation hash; the dialog shows "unconfirmed — check Activity before sending
  again" with no retry button.
- *The four other owner callers* (signer change, two revocations, re-key
  revocation): the same unconfirmed answer; for re-key the order rule "revoke
  before issue" makes a false failure a stuck stage.

Money-path: every slice.

### S2 — a non-answer is read as an answer

**The pattern.** Four surfaces decide what to tell an agent or an owner from
the absence, or the status class, of a response — and each reads "no usable
answer" as a definite one. #4470 fixed this for the hosted mapper's timeout and
unreachable-host cases only.

**Four reproduced defects, four packages.**

1. *Hosted and local quote: a stated price is silently not compared.*
   `plain-http-x402.ts:953` compares `expected_amount` only when an option was
   selected, and selection needs the agent read. With `GET
   /machine-payments/agent` answering 500, a merchant quoting 1.5 USDC and the
   caller stating `expected_amount: "0.10"`: `safe_to_continue: true`,
   `next_tool_name: haven_pay_x402_quote`, `max_amount_human: "1.5"` prefilled,
   no `price_differs_from_expected` key, warnings `X402_SCHEME_UNKNOWN` and
   `ALLOWANCE_CHECK_UNAVAILABLE`; following `next_arguments` then prepares a
   payment at 1,500,000 atomic. Control: the same call with the agent read
   answering 200 stops with `price_differs_from_expected: true`. The local MCP
   has the same shape (`packages/mcp/src/tools.ts:719-720`; run against its
   built `dist`). The server's own instructions promise the opposite
   (`packages/mcp-server/src/server.ts:90-93`). The on-chain budget still
   bounds the payment; the guard that fails open is the price check.
2. *Hosted mapper: a 429 is "refused as made".* `errors.ts:925` splits on
   `statusCode < 500`. The plugin rate limit, the hourly x402 cap (`retry_after_seconds: 60`)
   and the relayer-budget refusal all reach the agent as `next_action:
   stop_and_tell_user` with "re-calling it the same way cannot succeed"; the
   wait is dropped. Control: a JSON 503 gets the transient step.
3. *Signer: a gateway answer is "Haven refused".* `sign-context.ts:402-431`
   swallows a body that is not JSON to `{}` and maps every non-2xx to
   `SIGN_CONTEXT_REFUSED`. An HTML 502 and a 429 both answer
   `stop_and_tell_user` without the `typed_data_b64` fallback. Control: an
   unreachable host answers `SIGN_CONTEXT_UNREACHABLE` with the fallback.
   Nothing was signed in any case.
4. *Dashboard: a failed session read deletes the session.*
   `AuthContext.tsx:197-205` treats any rejection of `GET /auth/me` as an
   expired token. A rejected `fetch`, a 502 and a 500 each remove the stored
   token and sign the owner out. The reverse case is silent: with the token
   expired while the dashboard is open, 6 polls answered 401, `error` stayed
   null and the old total stayed on screen (`useDashboardOverview.ts:43-46`;
   the API client has no 401 handling — `grep -rn "=== 401"
   packages/frontend/src` outside tests → nothing). Controls: a successful read
   keeps the token; a real 401 on the session read removes it.

**Demonstrated cost.** #4470 (found by a live purchase), #3214 (closed
2026-09-21: a transient 500 on this agent read reached the agent with no next
step) and #3541 (the same 429 had to be classified by hand for the QA harness).

**How it changes work.** A response has three classes — an answer, a refusal,
a non-answer — and a guard that could not run says so and stops; it never
reports the outcome it would have reported had it passed.

**Slices (disjoint by package).** Hosted quote and local quote (stop, or
compare against every payable entry, when the comparison cannot run); hosted
mapper (a 429 branch that relays the wait and keeps the idempotency key);
signer (5xx, 429 and a body that is not JSON join the unreachable family);
dashboard (remove the token on 401 only; one 401 hook in the API client).

Money-path: the two quote slices and the mapper; the signer slice is on the
signing surface.

## 2. Improvement candidates — pending owner decision

Each is one PR. *Verified at scan* names what was run at `9871885a9`; routing
and the money-path verdict come from the two one-liners in the skill.

### C1 — the signed receipt of an EIP-3009 payment names the agent's delegate as the merchant

- **Evidence.** `buildPaymentReceipt` sets `recipient: row.to_address`
  (`receipt.ts:115`) and `merchant_address: row.to_address` (`:139`). On the
  funding leg `to_address` is the delegate. Seen live on dev (backend at the
  scan SHA): `haven_get_receipt` for payment `072899db-…` returns
  `payment.recipient` and `payment.parties.merchant` = `0xcb9a…5ba8`, the
  agent's own delegate, and no settlement hash, while `haven_list_receipts` and
  `haven_get_payment_status` for the same payment name the merchant
  `0x0415…b195` and the settlement transaction. The erc7710 receipt
  `0d3dd923-…` names its merchant correctly (control). A tree test with the
  funding-leg row shape fails on `parties.merchant` (1 failed, 1 passed).
  The party characterization fixtures cover the status read and the receipt
  list for both schemes and not this bundle (`ls
  packages/backend/src/openapi/__fixtures__/party-characterization/` → 4
  fixtures, none for `GET /payments/:id/receipt`).
- **Benefit.** The bundle is described as the self-contained evidence an
  offline verifier checks; for every EIP-3009 payment it states that the agent
  paid itself.
- **Scope.** The receipt row query and builder, one characterization fixture.
- **Verified at scan.** The tree test above; the two live reads. Routing
  `code backend`; money-path.
- **Still needed.** A decision on `recipient` (what was signed) versus
  `parties.merchant` (who was paid), then the fixture.

### C2 — a self-submitted catalog row is listed to agents, hinted, then answered 404

- **Evidence.** `GET /catalog` serves verified self-submitted rows to agents;
  `GET /catalog/:id` returns them only when the caller is not an agent
  (`catalog.ts:432`). `discoveryHintFor` emits
  `haven_quote_catalog_purchase { catalog_id }` for such a row. Route test:
  the agent listing contains the id, the owner detail read answers 200, the
  agent detail read answers `404 {"error":"Catalog entry not found"}`. Hosted
  test: following the hint returns `CATALOG_ENTRY_NOT_FOUND` whose text sends
  the agent back to `haven_discover_tools`.
- **Benefit.** Every row of the self-submission directory becomes buyable
  through the guided path.
- **Scope.** One condition, or one hint branch; one test each side.
- **Verified at scan.** Both tests. Whether dev or production holds a
  `verified_payable` submission was not checked. Routing `code backend`;
  money-path.

### C3 — an Accounted push ends `skipped` when the first answer is lost and the merchant receipt arrives before the retry

- **Evidence.** The underlag's seller block and transaction lines are derived
  from the captured merchant receipt (`receipt-underlag.ts:423, 437-441`;
  `entry.ts:342-343`), so the bytes can change between attempts, while the
  idempotency key is derived from the payment id alone
  (`accounted-connector.ts:217`; its header comment at `:150-152` says the
  bytes are deterministic). On real Postgres with the repository's own Accounted
  router: attempt 1 stored, answer lost; a receipt captured; attempt 2 →
  `skipped`, `IDEMPOTENCY_KEY_REUSE`, `external_ref` null, one document at the
  provider. Control without the receipt: the retry replays and the row is
  `pushed`.
- **Benefit.** A document that is in the customer's store is recorded as
  filed; the late receipt attach, which needs a `pushed` row, can run.
- **Scope.** Pin what the first claim rendered, as #3767 did for the booked
  hash; or keep receipt-derived fields out of the underlag.
- **Verified at scan.** The test, both arms. The provider is the simulator,
  not the live API. Off the money-path globs; routing `code backend`.

### C4 — on a `--local` install, task budgets and sub-budget signatures point at a signer the connector removed

- **Evidence.** The local MCP answers `haven_open_task_budget`,
  `haven_close_task_budget` and the sub-budget sign step with `next_tool:
  'mcp__haven-signer__haven_sign'` (`packages/mcp/src/tools.ts:442, 991,
  1010`); it registers no tool whose name contains "sign"; its own
  instructions say there is no signer namespace (`server.ts:117-120`); the
  connector's local mode removes the signer entry
  (`runtime-install.ts:476-478`, pinned by its own tests). Run against the
  built `dist`.
- **Benefit.** The feature works on that topology, or says it cannot.
- **Scope.** Sign those contexts in-process in the local MCP, or refuse with a
  typed answer. Adjacent, not the same: #4808 (closed) recorded the topology
  for the signer's descriptions only.
- **Verified at scan.** The script; the connector tests unmodified. A pending
  task budget reserves nothing (read). Money-path.

### C5 — x402 authorize with the same idempotency key after settle answers an untyped 409 "retry the original request"

- **Evidence.** `delegationReplay` answers only `pending_signature` and
  `confirmed` rows (`replay.ts:55`). For a `submitted` row the route does its
  pre-checks, hits the unique index and answers `409 {"error":"Idempotent
  replay in progress — retry the original request"}`
  (`delegation-authorize.ts:612, 1112`) with no `payment_id`, `status` or
  `error_code` — immediately after settle and 30 days later. `POST /payments`
  answers the row's real status with its id (`create-payment.ts:235`).
  Control: the same key while pending replays as 201 with the id.
- **Benefit.** The agent that reuses its key, as the hosted surface tells it
  to, learns which payment it is and that retrying cannot help.
- **Scope.** One branch in `delegationReplay`, before any pre-check.
- **Verified at scan.** The test on real Postgres. Money-path.

### Reproduced, not proposed as candidates (outside the cap of five)

Each was run by its hunter and again by the captain.

- **Amount fields.** `1,5` leaves Send's Review disabled with no message
  (`DelegationSendModal.tsx:182-195`; the same gate in `SetBudgetDialog.tsx:175`
  and `EditBudgetModal.tsx:241`, read). `0.0000004` reaches Review as
  `Send 0 USDC`, is submitted as `amount_atomic: "0"`, and the owner is shown
  `amount_atomic must be a positive integer (atomic units)`.
- **Owner Send above the balance** answers `502 Could not prepare the
  transfer` and the dialog offers `Try again` (`hybrid-transfers.ts:142-146`).
  The revert text in the test is a stand-in's.
- **A contact the Contacts page accepts cannot be reviewed in Send.**
  Contacts validates 40 hex characters; Send uses a checksum-strict check. An
  all-uppercase address is listed and selectable; Review stays disabled with
  no message.
- **Contacts are unique per raw string.** The same address in checksum and
  lower case is stored twice (`000_initial.ts:67`, `contacts.ts:58`), and the
  two name lookups (`.find` and a `Map`) then return different names.
  Repository-level reproduction; reachable through the API, not the page.
- **One Bazaar index entry with a field of the wrong type aborts discovery.**
  `tags: "weather"`, `tags: [7]`, `serviceName: 42` or `description: {}` throws
  outside the per-candidate `try` (`catalog-discovery.ts:298-303`, `:48-50`);
  later candidates are never ingested. Discovery is off by default. #4341
  fixed the write-time sibling.
- **A merchant pricing its standard and erc7710 entries differently.** The
  quote reports and prefills the standard entry (`plain-http-x402.ts:1008,
  1031`) while it compares and pays the erc7710 one: `next_arguments` followed
  as given is refused `PRICE_EXCEEDS_MAX`, and an expectation equal to the
  displayed amount is told it "does not match". Fails closed.

### Leads from the blocks, not findings

- Block 1 survivor: the task-budget recipient caveat is pinned by count only.
  Pinning the delegate account instead of the recipient in
  `task-budget-delegation.ts` leaves `task-budget-delegation.test.ts` 4 of 4
  green. The SDK guard appears to refuse such a child at signing (read, not
  run).
- Block 1 survivor: `packages/mcp-server/src/auth.ts:20` is dead code; no
  behavioural defect.
- Block 8: the three unmarked typed codes on agent payment routes are the three
  the 2026-11-02 entry named (`rail_not_supported`, `budget_requires_recipient`,
  `balance_changed`). Typed codes on agent-facing routes outside the
  instrument's payment-route rule also reach the generic branch
  (`no_delegation_for_target`, `signature_mismatch`, `issuer_retired`,
  `sub_agent_retired`, `rail_not_resumable`); whether a tool-level handler
  answers them was not checked.
- Live: `haven_get_receipt` with an id that is not a UUID answers "params/id
  must match format uuid", naming the route's parameter and not the tool's
  `payment_id`.

## 3. Coverage record

**Escape analysis** (issues created 2026-11-02..2026-11-12, `gh issue list
--state all --search 'created:>=2026-11-02 -label:epic'` → 89; 11 carry a
`Found by` line). By the captain's reading of title and body, 28 are defects
that did not come from a scan:

| Class | Issues | Block that should have seen it |
|---|---|---|
| Dev tooling and CI | #4809 #4786 #4776 #4767 #4769 #4768 #4740 #4716 #4651 #4659 #4643 #4623 #4622 #4748 (14) | block 6 for #4776, #4786, #4767 (a script that exits 0 without running); none for the rest |
| Agent guidance and onboarding wording | #4808 #4697 #4675 #4746 #4713 (5) | none |
| Catalog and header conformance, from a live purchase | #4754 #4755 (2) | block 10, added since |
| What a money field claims | #4688 #4668 (2) | none (block 9 compares key names, not values) |
| Operator incident | #4654 #4655 (2) | none |
| Dashboard, from walkthroughs | #4660 #4646 #4747 (3) | none |

This run's own reproduced defects, by class: post-send outcome (5), a
non-answer read as an answer (4), cross-surface disagreement on one fact (3:
the receipt merchant, the listed-then-404 row, the quote's two prices), a
handoff to something the surface lacks (1), input validation in the dashboard
(4), replay shape (1), a retry that is not byte-stable (1), one poisoned item
aborting a batch (1). None of the first three classes has a block.

**Residual archaeology** (PRs merged to `dev` 2026-11-02T00:00:00Z ..
2026-11-12T00:00:00Z, taken 2026-11-11T23:10Z): 115 PRs; 61 carry an inline
`Residual risk:` line, 7 of those say none; 13 carry a residual heading; 45
top-level bullets, 3 citing an issue or PR. Product-surface residuals that cite
no issue: #4730 (the passport extension on the hosted-plus-signer EIP-3009
header; a stored challenge above 64 KB), #4662 (an older CLI on a device-code
session is told to log in again, which does not help), #4649 (`presetAddress`
resolves as `new` when contacts fail to load), #4653 (the all-null-chain
picker with no selectable row), #4667 (a persistent `unknown` balance read
stays green).

**Probed clean** (block → examined / partial / not examined → command → number, all at `9871885a9`; parentheses are the 2026-11-02 entry at `e0617aa9f`):

- sizing → examined → the manifest row → backend 124,298 / 167,714 (121,063 /
  160,892); frontend 83,583 / 93,776; sdk 20,679 / 23,628; core 26,194 / 985;
  qa-agent 20,292 / 18,508; mcp-server 14,330 / 26,472; signer 5,488 / 9,545;
  connect 12,436 / 15,676; cli 3,196 / 3,611; ops 3,199 / 2,266; ui 2,849 /
  2,402; mcp 3,010 / 5,449; demo-merchant-mcp 4,105 / 4,591. The runner flags
  the signer and cli source shrinking; both are the moves the 2026-11-11 entry
  traced (#4792, #4662). Fat controllers → 50 route files, 4 at or above 1,000
  lines, 216 registrations, largest `agent-connection-setups.ts` 1,556 (50 / 4
  / 212 / `payments.ts` 1,572; that file is 291 lines after #4760 and #4761).
- block 1 (guard falsifiability) → examined → the census command → **253**
  candidate files (the selector changed in #4806; 1 by the old sample);
  `prove-red.mjs census` → 5 census mutations + 2 probes → **5 caught, 2
  survived**, 0 shadowed, 0 mutation-red, 0 refused (3 caught of 3). Survivors:
  dead code in the hosted `auth.ts`; a count-only pin on the task-budget
  recipient caveat. Files 6–253 not sampled.
- block 2 (`covers:` completeness) → partial (the manifest rows only) → 15 / 5
  / 7 (unchanged); covers-gaps 123 pairs / 33 docs (124 / 33); selector control
  passed. The strict-gate confirmation of each miss was not run.
- block 3 (stale numbers) → partial (the manifest rows only) → head sample 7
  figure lines / 1 with a command (13 / 2, a different 25 shards); `any` 39
  (39); db-mock gauge 54 / 270 / 57 (unchanged); zod 0; controls passed.
- block 4 (retired vocabulary) → partial (the manifest row only) → 199 / 48 /
  151 (196 / 47 / 149); shard control 36. The code half was not run.
- block 5 (merge-method drift) → examined → 282 merge commits since 2026-08-10
  (282); squash / total 1,531 / 1,816 (1,420 / 1,705).
- block 6 (nets with holes) → partial (the manifest rows only) → copy lint 121
  / 15 (111 / 14; the new hit file is `packages/sdk/src/passport.ts`); money
  perimeter 32 / 20; visual gate 15 / 27; docs boundary 52 (43, flagged; #4804
  tracks the instrument). The exit-branch reading was not done.
- block 8 (refusal census) → examined → the backend suite recorded once: 573
  files, 572 passed, 1 skipped, 7,235 tests, 359 s → **2,232 rows; 1,626 error
  rows; 578 keys; 143 typed rows reach the generic branch** (2,203 / 1,614 /
  574 / 142); 3 unmarked on agent payment routes, the same three by name; 5xx
  read as transient 37 (36; the new row is `POST /agents/:id/passport` 503);
  non-answers 2; SDK error sites 31 (26 / 5); positive control passed.
- block 9 (field round-trip) → examined → emitted-never-read **5**, the same
  five; read-never-emitted **13**, all "emitted in source, state not reached";
  mapper read-key sets identical at both SHAs; positive control passed.
- block 10 (catalog conformance) → fixtures examined (the three fixture pairs
  and the header half as the reference states them); default tier examined →
  one unauthenticated read of the dev listing at 2026-11-11T23:17:50Z → 26
  entries, 24 active, 12 http / 12 mcp, 0 bazaar; third-party tier not
  examined → not requested.
- incident clustering → partial → the escape analysis above; no count over
  time.
- workflow archaeology → not examined.
- comment archaeology → examined → the manifest rows → 0 markers (control
  `import` → 2,326 files).
- residual archaeology → examined → the figures above.
- live exercise → examined, read-only, dev only. Runtime identity before the
  first call: tree `git rev-parse HEAD` → `9871885a9`; dev backend → the
  post-deploy run for `9871885a9` concluded success; dev hosted MCP →
  `server_version` `0.14.0-alpha.0`, `contract_fingerprint`
  `d4850f2c0419c6a6` (from `haven_get_agent`); published → all five packages
  `0.14.0-alpha.0` on `alpha` and `latest`, `dev` tag
  `0.0.0-dev.202611111056.ed17c8e`; the local signer runtime → not
  determinable (not read, and no signer tool was called). Calls: 13 reads and
  refusals through the dev hosted MCP. Result: candidate C1 and one lead.
- validation / contracts → partial (blocks 8, 9 and the hunters' route tests);
  data-layer coverage → partial (the gauge); cross-package duplication → not
  examined.
- novelty → each hunter's GitHub searches (named in its report), the ledger and
  the bug reports' names; the captain read the cited issues' titles and states.

## 4. Verification and limitations

- **What "reproduced" means here.** 15 test files and 2 scripts, written by
  the hunters, run by them, then run once more by the captain at `9871885a9`:
  A — 3 files, 6 tests, all green (each asserts the faulty behaviour and its
  control); B — 5 files, each failing on the assertion that states the correct
  behaviour, with its control passing; C — 3 files and 2 scripts, the two
  `EXPECTATION` tests failing as written; D — 4 files, 18 tests, all green.
  The worktree was clean afterwards (`git status --short` → empty).
- **Stand-ins.** The bundler, the paymaster client, the accounting provider,
  the Bazaar index and `fetch` were stand-ins in every reproduction. No
  finding claims an on-chain outcome.
- **Likelihood is not measured.** S1's defects need a lost answer or a process
  death inside a window of seconds; nothing in this run counts how often that
  happens on dev or production.
- **Hunters' own notes.** One hunter's runs let the test harness migrate its
  worker schema in the local default database; one ran `git fetch` in the
  shared worktree, moving its `origin/dev` to `cbb1798b9` (#4814, merged after
  the scan SHA; that landing touches none of the files cited above — `git diff
  --stat 9871885a9 cbb1798b9`).
- **Not reached**, by vertical: the machine-payment routes in depth, the
  settlement sweepers, task- and sub-budget close flows (payment path); the
  Fortnox connector internals, catalog submissions, re-key, passkeys (rest of
  backend); the device-code login and connect flows end to end, the N-1
  client against the current backend, the signer's SIWX and audit log (agent
  surface); agent create / remove / re-key screens, receipts and analytics
  pages, `packages/ui` primitives (dashboard).

## 5. Independent review

Recorded here after the reviewer's pass at the PR head.
