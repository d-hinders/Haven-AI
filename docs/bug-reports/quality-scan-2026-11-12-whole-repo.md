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
  - packages/backend/src/routes/contacts.ts
  - packages/backend/src/modules/accounting/receipt-underlag.ts
  - packages/backend/src/modules/accounting/accounted-connector.ts
  - packages/backend/src/modules/catalog/catalog-discovery.ts
  - packages/mcp-server/src/tools/plain-http-x402.ts
  - packages/mcp-server/src/tools/support/errors.ts
  - packages/mcp-server/src/server.ts
  - packages/mcp-server/src/auth.ts
  - packages/mcp/src/tools.ts
  - packages/mcp/src/server.ts
  - packages/connect/src/runtime-install.ts
  - packages/signer/src/sign-context.ts
  - packages/sdk/src/passport.ts
  - packages/frontend/src/hooks/useDelegationSend.ts
  - packages/frontend/src/hooks/useDelegationBudget.ts
  - packages/frontend/src/components/DelegationSendModal.tsx
  - packages/frontend/src/context/AuthContext.tsx
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
files, in a worktree at the scan SHA (§ 4). A defect below is "reproduced" only
in that sense: a test or script that two parties ran. Nothing here was observed
against a real bundler, a real accounting provider or production.

Live calls: read-only, on **dev** only, as the dev agent `test` (§ 3, *live
exercise*). No payment, no signer call, no production call, no third-party
merchant request.

**A departure from the skill, named.** The skill has two output levels: up to
two structural findings and up to five candidates. The owner's scope for this
run was a defect hunt, and the hunters returned more reproduced one-PR defects
than five. § 2 therefore has a third list, *Reproduced, beyond the cap of five*
(ten items). They are recorded so the next run excludes them like any prior
candidate; whether any is filed is the owner's decision with the rest.

One security hypothesis from the backend hunter is not written in this public
record. It went to the owner directly.

## 1. Structural finding — pending owner decision

### S1 — between sending an operation and booking its outcome, one failure mode is recognised as "outcome unknown"; the rest are booked or shown as failed, or not booked at all

**The pattern.** The backend sends a user operation in two functions and waits
for its receipt in the same call. "Sent, outcome unknown" is raised at one
throw site: the receipt wait of the shared redemption submit
(`SubmittedUserOpFailedError('receipt_unconfirmed')`, #3564). Every other way
for the answer to go missing after the send is a failure to its caller, and the
surfaces that read that failure offer, or instruct, a second payment. The
recovery path that does exist (the submission reconciler) selects only rows the
route managed to mark, and books less than the route does.

**Measured.**

```bash
# send-and-wait sites in non-test backend source
git grep -n -E "sendUserOperation\(|waitForUserOperationReceipt\(" 9871885a9 -- packages/backend/src ':!**/*.test.ts' ':!**/__tests__/**'
#   → 4 lines in 1 file: delegation-rail.ts:544 + :552 (submitRedemption), :787 + :791 (submitCall)
# callers of the redemption submit, and of the owner-side submit
git grep -n -E "rail\.submitRedemption\(" 9871885a9 -- packages/backend/src ':!**/*.test.ts' ':!**/__tests__/**'
#   → 3: delegation-authorization.ts:195, task-budget-service.ts:328, sub-budget-service.ts:426
git grep -n -E "\.submitCall\(" 9871885a9 -- packages/backend/src ':!**/*.test.ts' ':!**/__tests__/**'
#   → 5: hybrid-signer-actions.ts:320, hybrid-transfers.ts:191, agent-delegations.ts:1195 and :1375, agent-rekey.ts:774
```

- The one throw site is `delegation-rail.ts:552-563`. Three callers treat the
  typed error as "may have landed": the sign module (`sign-payment.ts:424`,
  for the receipt-unconfirmed variant) and the two budget routes
  (`routes/task-budgets.ts:368`, `routes/sub-budgets.ts:195`, which test for
  the error class and so see both of its variants; their close flows were not
  exercised in this run).
- `submitCall` (`delegation-rail.ts:783-799`) has no post-send distinction. All
  five of its callers answer any throw with `502` and a "… failed" body:
  `hybrid-transfers.ts:205` `Transfer failed`; `hybrid-signer-actions.ts:340`
  `Signer change failed`; `agent-delegations.ts:1207` `Batch revocation
  failed`, `:1386` `Revocation failed`; `agent-rekey.ts:787` `Revocation
  failed`.
- In the dashboard, `git grep -c unconfirmed 9871885a9 --
  packages/frontend/src/hooks/useDelegationBudget.ts` → 23 (the #3930 fix); the
  same grep on `useDelegationSend.ts` and `DelegationSendModal.tsx` → no match.

**Five reproduced defects on this seam.**

1. *Agent payment: the bundler's answer to the send is lost.* The comment at
   `delegation-rail.ts:542-543` says a throw from the send "means it never
   entered the mempool". With a loopback bundler that receives
   `eth_sendUserOperation` and never answers, the real
   `submitDelegationPayment` throws after about 10 s (10,043 ms in the
   captain's run) with an ordinary error, not the typed one; the real
   `signPayment`, against the same bundler, answers `502 {"status":"failed",
   "error_code":"onchain_execution_failed", …"The request took too long to
   respond."}`, the row is `failed` with no hash, and the reconciler has 0
   candidates. The hosted mapper's text for that code
   (`packages/mcp-server/src/tools/support/errors.ts:391-392`) tells the agent
   to "create a new payment if they still want to pay". The idempotency lookup
   (`payment-intents.ts:422`) and its partial index
   (`020_send_idempotency_key.ts:29-30`) both exclude `failed` rows, so the key
   is free again.
2. *Agent payment: the op is mined, a later step throws.* The fiat lookup and
   the confirm write sit in the same `try` as the submit
   (`sign-payment.ts:289-321`). With the submit returning a transaction hash and
   the confirm write throwing once, the answer is the same `502 … failed` and
   the row is `failed` with `tx_hash` null. (Run for the confirm write; the fiat
   lookup is read, not run.)
3. *A sign request that dies after the claim is never picked up.* The claim
   writes `submitted` before the send (`payment-intents.ts:564-570`); the
   user-operation hash is written only if the route survives to catch a
   receipt-wait throw. With a submit that never returns and the row aged 30
   days: status `submitted`, `next_action: check_status_later`, no hash;
   `findOutcomePendingIntents`, the erc7710 sweep and the orphan sweep each
   select 0 rows; a second sign answers 409. Outside tests the backend has two
   process handlers, both for crashes (`index.ts:306` and `:310`), and none for
   `SIGTERM` (`git grep -n "SIGTERM\|process.on(" 9871885a9 --
   packages/backend/src` → those two lines and three in tests; read, not run),
   so a deploy during a receipt wait is the ordinary way in.
4. *A payment the reconciler confirms is not booked like one the route
   confirms.* The reconciler's update sets `status`, `tx_hash` and
   `confirmed_at` only (`payment-intents.ts:729-732`) and then calls
   `emitFirstPayment` alone (`submission-reconciler.ts:157-162`). Against the
   same test's control payment (fiat triple set, accounting feed fired once,
   listed by `listUnpushedPaymentIds`), the reconciled payment has all three
   fiat values null, 0 feed calls, is absent from `listUnpushedPaymentIds` —
   whose SQL requires one fiat value (`accounting-feed-syncs.ts:312`) — and
   keeps `submission_outcome: "unknown"` on a confirmed row.
5. *Owner Send.* With the real `useDelegationSend` and `DelegationSendModal`
   and a stubbed API client, a submit whose answer is lost (the client's
   `post` rejecting with `Failed to fetch`, or with the backend's 502 for a
   receipt-wait timeout) shows a red alert and relabels the button `Try again`
   (`DelegationSendModal.tsx:325`). Pressing it prepares, signs and submits a
   second operation with the same `to` and `amount_atomic`; the submit body has
   no idempotency key (its keys are `amount_atomic, signature, signature_scheme,
   to, token_address, user_operation`). The backend half: the real
   `submitTransfer` answers a receipt-wait timeout and a pre-send `AA25`
   rejection with the same status and the same `error`.

*Not observed:* that a real bundler includes an operation whose HTTP answer was
lost, or that the second owner transfer lands. The bundler and the vendor
clients were stand-ins.

**Demonstrated cost.** No production incident is on record. What is on record
is the same failure mode fixed three times, one call site at a time: #3564
(closed 2026-10-02, found in review of #3494: a sent payment whose receipt was
not confirmed was booked failed and never reconciled), #3930 (closed
2026-10-14, found in review of PR #3929: a lost activate response reported a
failed grant, and the retry left an extra budget enabled on-chain) and #4470
(closed 2026-10-29, found by the 2026-10-27 refusal-census trial; one of its
items is the funding-wait timeout that reached the agent as an unknown error
after funds had moved). Each fix stopped at the site its issue named.

**How it changes work.** One rule a contributor can hold: after the send, only
an explicit bundler rejection or an included-and-reverted receipt is a failure;
everything else is outcome-pending, carries the operation hash, and is booked
by one function whichever path confirms it. Today the rule is a comment on one
function.

**Slices.** The rail slice comes first: the two owner-side slices need its
typed error. The two reconciler slices edit different statements of the same
repository file.

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
  revocation): the same unconfirmed answer. An inference, not run: a re-key
  whose revocation landed but answered "failed" would stay at its stage until
  the owner retries; the code's own comment there says retrying is safe.

Routing and money-path for the ten files the slices change
(`delegation-rail.ts`, `sign-payment.ts`, `submission-reconciler.ts`,
`payment-intents.ts`, `hybrid-transfers.ts`, `hybrid-signer-actions.ts`,
`agent-delegations.ts`, `agent-rekey.ts`, `useDelegationSend.ts`,
`DelegationSendModal.tsx`; the skill's two one-liners, control `sweep.ts` →
`money-path`): `code frontend backend packages`; the eight backend files
`money-path`; the two dashboard files `off`. Cited as evidence only:
`index.ts` (`off`) and the hosted `errors.ts` (`money-path`).

### Withdrawn at review: a second structural finding

The first draft carried S2, "a non-answer is read as an answer", over four
defects in four packages. The independent review found it does not meet the
skill's bars as worded: it has no measured census, and each of its remedies is
one PR. The four defects are in § 2 under *beyond the cap*, marked ‡.

## 2. Improvement candidates — pending owner decision

Each is one PR. Routing and money-path verdicts are the outputs of the skill's
two one-liners for the files named; the control `sweep.ts` printed
`money-path` in every run.

### C1 — the signed receipt of an EIP-3009 payment names the agent's delegate as the merchant

- **Evidence.** `buildPaymentReceipt` sets `recipient: row.to_address`
  (`receipt.ts:115`) and `merchant_address: row.to_address` (`:139`). On the
  funding leg `to_address` is the delegate. Seen live on dev: `haven_get_receipt`
  for payment `072899db-…` returns `payment.recipient` and
  `payment.parties.merchant` = `0xcb9a…5ba8`, the agent's own delegate, and no
  settlement hash, while `haven_list_receipts` and `haven_get_payment_status`
  for the same payment name the merchant `0x0415…b195` and the settlement
  transaction. The erc7710 receipt `0d3dd923-…` names its merchant correctly
  (control). The party characterization directory holds four JSON fixtures
  (status and receipt list, each for both schemes) and none for `GET
  /payments/:id/receipt`.
- **Benefit.** The bundle is described as the self-contained evidence an
  offline verifier checks; for every EIP-3009 payment it states that the agent
  paid itself.
- **Scope.** The receipt row query and builder, one characterization fixture.
- **Verified at scan.** `zzscan-main-receipt.test.ts` (the funding-leg row
  shape through the real builder) → 1 failed on `parties.merchant`
  (`0xcb9a…5ba8`), 1 passed; run by the captain and again by the reviewer. The
  two live reads. Routing → `code backend packages`; money-path →
  `receipt.ts off`, `payment-intents.ts money-path`. Mutation recipe *unrun*:
  the field does not exist on the row yet.
- **Verification still needed.** A decision on `recipient` (what was signed)
  versus `parties.merchant` (who was paid); then the fixture for both schemes,
  and that `verifyPaymentReceipt` still reads only `authorization`.

### C2 — a self-submitted catalog row is listed to agents, hinted, then answered 404

- **Evidence.** `GET /catalog` serves verified self-submitted rows to agents;
  `GET /catalog/:id` returns them only when the caller is not an agent
  (`routes/catalog.ts:432`). `discoveryHintFor` emits
  `haven_quote_catalog_purchase { catalog_id }` for such a row.
- **Benefit.** A row of the self-submission directory would be reachable
  through the guided path (not run: nothing here bought one).
- **Scope.** One condition in the route, or one hint branch in the hosted
  tool; one test on each side.
- **Verified at scan.** `zzscan-b-catalog-ingestion-detail.test.ts` → the
  agent listing contains the id, the owner detail read answers 200, the agent
  detail read answers `404 {"error":"Catalog entry not found"}`.
  `zzscan-b-ingestion-hint-loop.test.ts` (the backend stubbed with that 404) →
  following the hint returns `CATALOG_ENTRY_NOT_FOUND`, whose text sends the
  agent back to `haven_discover_tools`. Routing → `code backend mcp_server
  packages`; money-path → `routes/catalog.ts off`,
  `tools/catalog-purchase.ts money-path`. Whether dev or production holds a
  `verified_payable` submission was not checked. Mutation recipe *unrun*: the
  branch it would mutate does not exist yet.
- **Verification still needed.** The same two tests green; a guided quote of
  an ingestion row end to end, which nothing in the suite does today.

### C3 — an Accounted push ends `skipped` when the first answer is lost and the merchant receipt arrives before the retry

- **Evidence.** The underlag's seller block and transaction lines are derived
  from the captured merchant receipt (`receipt-underlag.ts:423`, `:437`,
  `:440-441`; `entry.ts:342-343`), so the bytes can change between attempts,
  while the idempotency key is derived from the payment id alone
  (`accounted-connector.ts:217`; its header comment at `:150-152` says the
  bytes are deterministic).
- **Benefit.** A document that is in the customer's store is recorded as
  filed; the late receipt attach, which needs a `pushed` row, can run.
- **Scope.** Pin what the first claim rendered, as #3767 did for the booked
  hash; or keep receipt-derived fields out of the underlag.
- **Verified at scan.** `zzscan-b-underlag-bytes-retry.db.test.ts` on real
  Postgres with the repository's own Accounted router: attempt 1 stored,
  answer lost; a receipt captured; attempt 2 → `skipped`,
  `IDEMPOTENCY_KEY_REUSE`, `external_ref` null, one document at the provider.
  Control without the receipt: the retry replays and the row is `pushed`.
  Routing → `code backend packages`; money-path → both files `off`. Mutation
  recipe *unrun*: the pin it would mutate does not exist yet.
- **Verification still needed.** The same test green; the behaviour of the
  live Accounted API on a same-key, different-bytes upload (the provider side
  here is the simulator).

### C4 — on a `--local` install, task budgets and sub-budget signatures point at a signer the connector removed

- **Evidence.** The local MCP answers `haven_open_task_budget`,
  `haven_close_task_budget` and the sub-budget sign step with `next_tool:
  'mcp__haven-signer__haven_sign'` (`packages/mcp/src/tools.ts:442, 991,
  1010`). A comment above its instructions says there is no separate signer
  namespace (`packages/mcp/src/server.ts:117-120`); the instructions
  themselves say it signs in-process. The connector's local mode removes the
  signer entry (`packages/connect/src/runtime-install.ts:476-478`).
- **Benefit.** The feature works on that topology, or says it cannot.
- **Scope.** Sign those contexts in-process in the local MCP, or refuse with a
  typed answer. Adjacent, not the same: #4808 (closed) recorded the topology
  for the signer's descriptions only.
- **Verified at scan.** `local-taskbudget.mjs` against the built `dist` →
  tool names containing "sign": `[]`; both tools answer the `next_tool`
  above. The hunter also ran the connector's own local-mode tests unmodified
  (they assert the removal); the captain did not run those. Routing → `code
  connect mcp mcp_server packages`; money-path → `packages/mcp/src/tools.ts
  off`. A pending task budget reserves nothing (read). Mutation recipe
  *unrun*: neither remedy's branch exists yet.
- **Verification still needed.** A task budget opened and closed through the
  local MCP alone, on dev.

### C5 — x402 authorize with the same idempotency key after settle answers an untyped 409 "retry the original request"

- **Evidence.** `delegationReplay` answers only `pending_signature` and
  `confirmed` rows (`modules/x402/replay.ts:55`). For a `submitted` row the
  route does its pre-checks, hits the unique index and answers `409
  {"error":"Idempotent replay in progress — retry the original request"}`
  (`delegation-authorize.ts:612, 1112`) with no `payment_id`, `status` or
  `error_code`. `POST /payments` answers the row's real status with its id
  (`create-payment.ts:235`).
- **Benefit.** The agent that reuses its key, as the hosted surface tells it
  to, learns which payment it is and that retrying cannot help.
- **Scope.** One branch in `delegationReplay`, before any pre-check.
- **Verified at scan.** `zzscan-a-replay-submitted.test.ts` on real Postgres
  (real `authorizeX402` and `settleX402`, chain seams mocked) → the 409 above
  immediately after settle and with the row aged 30 days, after one
  remaining-budget read and one deploy check. Control: the same key while
  pending replays as 201 with the id. Routing → `code backend packages`;
  money-path → both files `money-path`. Mutation recipe *unrun*: the branch it
  would mutate does not exist yet.
- **Verification still needed.** The same test green; the hosted tool's answer
  for the new body.

### Reproduced, beyond the cap of five

Run by a hunter and again by the captain. ‡ marks the four withdrawn from S2.

- ‡ **The quote's stated price is not compared when the agent read fails.**
  `plain-http-x402.ts:953` compares `expected_amount` only when an option was
  selected, and selection needs the agent read. Calling the hosted **handler**
  directly with that read answering 500, a merchant quoting 1.5 USDC and
  `expected_amount: "0.10"`: `safe_to_continue: true`, `max_amount_human:
  "1.5"` prefilled, no `price_differs_from_expected` key; `next_arguments`
  then prepares a payment at 1,500,000 atomic (the test prints these fields;
  it asserts only that the quote succeeded). Control: with the read answering
  200 the quote stops. **Condition:** the hosted server runs an
  identity gate before every non-exempt handler
  (`packages/mcp-server/src/server.ts:311-314`), and that gate reads the same
  endpoint, so through the server the defect needs the gate's read to succeed
  and the handler's own read, moments later, to fail; the reproduction
  bypassed the gate. The local MCP has no gate: there the quote comes back
  plain, with no `price_differs_from_expected` key and no stop
  (`packages/mcp/src/tools.ts:719-720`; run against `dist`). The on-chain
  budget still bounds the payment.
- ‡ **The hosted mapper answers a 429 "refused as made … cannot succeed".**
  `errors.ts:925` splits on `statusCode < 500`, and `packages/mcp-server/src`
  has no 429 handling. Fed the SDK's errors for three 429 bodies (the plugin
  rate limit; the hourly x402 cap with `retry_after_seconds: 60`; a
  relayer-budget body paraphrased by the test), `normalizeError` answers
  `stop_and_tell_user` and drops the wait. Control: a JSON 503 gets the
  transient step.
- ‡ **The signer reports a gateway answer as "Haven refused".**
  `sign-context.ts:402-431` swallows a body that is not JSON to `{}` and maps
  every non-2xx to `SIGN_CONTEXT_REFUSED`. An HTML 502 and a 429 both answer
  `stop_and_tell_user` without the `typed_data_b64` fallback. Control: an
  unreachable host answers `SIGN_CONTEXT_UNREACHABLE` with the fallback.
  Nothing was signed.
- ‡ **The dashboard deletes a valid session on a failed read, and misses an
  expired one.** `AuthContext.tsx:197-205` treats any rejection of `GET
  /auth/me` as an expired token: a rejected request, a 502 and a 500 each
  remove the stored token. With the token expired while the dashboard is open,
  6 polls answered 401, `error` stayed null and the old total stayed on screen
  (`useDashboardOverview.ts:43-46`; `git grep -n "=== 401" 9871885a9 --
  packages/frontend/src` outside tests → nothing; the same grep for `=== 409`
  matches). Controls: a successful read keeps the token; a 401 removes it.
- **Send's amount field.** `1,5` leaves Review disabled with no message
  (`DelegationSendModal.tsx:182-195`; the same gate in `SetBudgetDialog.tsx:175`
  and `EditBudgetModal.tsx:241`, read). `0.0000004` reaches Review as `Send 0
  USDC` and is sent to the prepare route as `amount_atomic: "0"`; the owner is
  shown the backend's string for that, `amount_atomic must be a positive
  integer (atomic units)` (stubbed in the test).
- **Owner Send above the balance.** The real `prepareTransfer` answers `502
  Could not prepare the transfer` (`hybrid-transfers.ts:142-146`; the revert
  text is a stand-in's). That the dialog then offers `Try again` is inferred
  from its behaviour on the other failures, not run for this one.
- **A contact the Contacts page accepts cannot be reviewed in Send.**
  Contacts validates 40 hex characters; Send uses a checksum-strict check. An
  all-uppercase address is listed and selectable; Review stays disabled with
  no message.
- **Contacts are unique per raw string.** The same address in checksum and
  lower case is stored twice (`000_initial.ts:67`;
  `packages/backend/src/routes/contacts.ts:58` passes the address through).
  Run at repository level. The dashboard's two name lookups (a `Map` and a
  `.find`) would then disagree; the test re-implements both, the product's
  were read.
- **One Bazaar index entry with a field of the wrong type aborts discovery.**
  `tags: "weather"`, `tags: [7]`, `serviceName: 42` or `description: {}`
  throws outside the per-candidate `try` (`catalog-discovery.ts:298-303`,
  `:48-50`); later candidates are never ingested. Discovery is off by default.
  #4341 fixed the write-time sibling.
- **A merchant pricing its standard and erc7710 entries differently.** The
  quote reports and prefills the standard entry (`plain-http-x402.ts:1008,
  1031`) while it compares and pays the erc7710 one: `next_arguments` followed
  as given is refused `PRICE_EXCEEDS_MAX`, and an expectation equal to the
  displayed amount is told it "does not match". Fails closed.

Prior work beside the ‡ items: #4470 (PR #4516) covered the hosted mapper's
timeouts, unreachable hosts and status 0 for a body that is not JSON, the SDK
evidence classifier and nine deterministic SDK sites; #3214 (closed
2026-09-21, from that day's scan) was a transient 500 on the quote fetch of
`haven_quote_x402`; #3541 classified real 429s for the QA harness. None names
the 429 branch, the signer's fetch or the dashboard's session read.

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

**Escape analysis.** `gh issue list --state all --limit 500 --search
'created:>=2026-11-02 -label:epic'` → 89 issues. 11 bodies contain the words
"found by"; 2 carry a `Found by:` line as the convention writes it (#4808,
#4804). By the captain's reading of title and body, 28 are defects that did not
come from a scan. The other 61 were read by title only — epic slices, scan-born
issues and features — and are **not classified** one by one (#4696 may be a
defect among them).

| Class | Issues | Block that should have seen it |
|---|---|---|
| Dev tooling and CI | #4809 #4786 #4776 #4767 #4769 #4768 #4740 #4716 #4651 #4659 #4643 #4623 #4622 #4748 (14) | block 6 for #4776, #4786, #4767 (a script that exits 0 without running); none for the rest |
| Agent guidance and onboarding wording | #4808 #4697 #4675 #4746 #4713 (5) | none |
| Catalog and header conformance, from a live purchase | #4754 #4755 (2) | block 10, added since |
| What a money field claims | #4688 #4668 (2) | none (block 9 compares key names, not values) |
| Operator incident | #4654 #4655 (2) | none |
| Dashboard | #4660 (from a code review) #4646 #4747 (3) | none |

This run's own reproduced defects, by class (20, counting S1's five
separately): the seam after the send (5), a non-answer read as an answer (4),
cross-surface disagreement on one fact (3: the receipt merchant, the
listed-then-404 row, the quote's two prices), input handling in the dashboard
(3), and one each of contact casing in the backend, a handoff to something the
surface lacks, replay shape, a retry that is not byte-stable, and one item
aborting a batch. The first and third classes have no block. Block 8 states
the second as its clean criterion ("no non-answer … reads as a refusal"), but
its instrument did not reach these four: a 429, the signer's own fetch, the
quote's skipped comparison and the dashboard's session read.

**Residual archaeology** (PRs merged to `dev` 2026-11-02T00:00:00Z ..
2026-11-12T00:00:00Z, taken 2026-11-11T23:10Z): 115 PRs; 61 carry an inline
`Residual risk:` line, 7 of those say none; 13 carry a residual heading; 45
top-level bullets, 3 citing an issue or PR. Product-surface residuals that cite
no issue: #4730 (the passport extension on the hosted-plus-signer EIP-3009
header; a stored challenge above 64 KB), #4662 (an older CLI on a device-code
session is told to log in again, which does not help), #4649 (`presetAddress`
resolves as `new` when contacts fail to load), #4653 (the all-null-chain
picker with no selectable row).

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
  examined → not requested. Dev was deploying `cbb1798b9` at that instant
  (the deployment record was created 23:14:52Z); #4814 changes nothing under
  `packages/backend`.
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
  refusals through the dev hosted MCP, all made before 2026-11-11T23:10:37Z
  (the instant the next command in the session printed), so before dev began
  deploying `cbb1798b9`. Result: candidate C1 and one lead.
- validation / contracts → partial (blocks 8, 9 and the hunters' route tests);
  data-layer coverage → partial (the gauge); cross-package duplication → not
  examined.
- novelty → each hunter's GitHub searches, the ledger and the bug reports'
  names; the captain read the cited issues' titles and states, and the
  reviewer their bodies.

## 4. Verification and limitations

- **What "reproduced" means here.** 15 test files and 2 scripts, written by
  the hunters, run by them, then run once more by the captain at `9871885a9`
  (logs kept outside the repository): A — 3 files, 6 tests, all green (each
  asserts the faulty behaviour and its control); B — 5 files, each red where
  it states the correct behaviour (four as failed assertions, the discovery
  one as four cases throwing a `TypeError`), with its control passing; C — 3
  files and 2 scripts, the two `EXPECTATION` tests failing as written; D — 4
  files, 18 tests, all green. A sixteenth file is the captain's own receipt
  test for C1. The worktree was clean afterwards (`git status --short` →
  empty). The reproduction tests are not committed: they assert defects.
- **Stand-ins.** The bundler, the paymaster client, the accounting provider,
  the Bazaar index and the HTTP client were stand-ins in every reproduction.
  No finding claims an on-chain outcome.
- **Likelihood is not measured.** S1's defects need a lost answer or a process
  death inside a window of seconds; nothing in this run counts how often that
  happens on dev or production.
- **Hunters' own notes.** One hunter's runs let the test harness migrate its
  worker schema in the local default database; one ran `git fetch` in the
  shared worktree, moving its `origin/dev` to `cbb1798b9` (#4814, merged after
  the scan SHA). That landing touches one file cited above,
  `packages/mcp/src/tools.ts` (+12/−1: an import and the
  `haven_get_payment_status` handler); no cited line's content changes, but
  the lines sit one to eleven lower at `cbb1798b9`. Every line in this report
  is read at `9871885a9`.
- **Not reached**, by vertical: the machine-payment routes in depth, the
  settlement sweepers, task- and sub-budget close flows (payment path); the
  Fortnox connector internals, catalog submissions, re-key, passkeys (rest of
  backend); the device-code login and connect flows end to end, the N-1
  client against the current backend, the signer's SIWX and audit log (agent
  surface); agent create / remove / re-key screens, receipts and analytics
  pages, `packages/ui` primitives (dashboard).

## 5. Independent review

**First pass**, `haven-reviewer` in its own clone, at head `42f2ccc39`:
changes requested. By the reviewer's own count it checked 60 line references
(57 held), every count with a command, all 21 manifest rows against the
runner's output, the block figures against their raw outputs, 20 issue and PR
claims against their bodies, and each quoted reproduction output against the
captain's logs and the test sources. Seven blocking corrections, sixteen
should-fix and ten nits; all applied:

- **A structural finding withdrawn.** S2 did not meet the skill's bars; its
  four defects moved to *beyond the cap*.
- **A defect narrowed.** The hosted quote's skipped price comparison was
  written as following from one failed agent read. The hosted server's
  identity gate reads the same endpoint first, so the defect needs the gate's
  read to succeed and the handler's to fail; the reproduction bypassed the
  gate. The local quote was written as answering `safe_to_continue: true`; it
  returns a plain quote.
- **Wrong attributions.** #4470 was found by the refusal-census trial, not a
  live purchase; #3214 was a 500 on the quote fetch, not on the agent read;
  the three issues S1 cites are review and scan findings, not incidents.
- **A wrong figure.** "10,171 ms" for `signPayment` was a hunter's timing of
  `submitDelegationPayment`; the captain's run measured 10,043 ms for that
  function, and the `signPayment` test does not time its call.
- **A false universal.** "#4814 touches none of the files cited" — it touches
  one. "Recognised at exactly one point … the agent-payment submit" — one
  throw site, in the shared redemption submit, read by three callers.
- **Money-path verdicts** that were asserted, not run: C4 is `off`, C2's
  route file is `off` and its hint file `money-path`. All verdicts above are
  now the one-liners' output.
- **Run versus read**, tightened in eight places (the connector tests, the
  dashboard's name lookups, the over-balance dialog, the re-key inference, the
  process-handler grep, the 429 bodies, the amount string, the instant of the
  live calls), and the "beyond the cap" list named as a departure.

**Second pass** (the delta), at head `94eb159bd`: all seven blockers resolved
and no blocking item; changes requested on four should-fix and three nits, all
one-line text corrections that change no finding — the mutation-recipe line
missing from C2–C5; S1's routing sentence covering files it did not name; "the
first three classes have no block", when block 8 states the second as its
clean criterion; the first pass's tallies quoted without saying whose count
they were; a deployment instant two seconds off; "three routes" for a module
and two routes; a missing reference for the idempotency exclusion. The captain
applied them directly, without a third pass, under the owner's standing rule
for text corrections. The corrected head is recorded on the PR.
