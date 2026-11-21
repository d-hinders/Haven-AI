---
owner: "@d-hinders"
status: record
covers:
  - .agents/skills/quality-scan/references/dimensions.md
  - scripts/docs/scan-remeasure.mjs
  - scripts/ci/refusal-census.mjs
  - scripts/ci/prove-red.mjs
  - packages/paywall-proxy/src/main.ts
  - packages/paywall-proxy/src/sales.ts
  - packages/paywall-proxy/src/discovery.ts
  - packages/paywall-proxy/src/receipt.ts
  - packages/paywall-proxy/src/handler.ts
  - packages/paywall-proxy/src/test-harness.ts
  - packages/backend/src/rails/sweep.ts
  - packages/backend/src/modules/mpp/sweep.ts
  - packages/backend/src/modules/accounting/fortnox-connector.ts
  - packages/backend/src/modules/transactions/search.ts
  - packages/mcp-server/src/tools/support/checkout-details.ts
  - packages/mcp/src/tools.ts
  - packages/mcp-server/src/log.ts
  - packages/sdk/src/client-checkout-details.ts
  - packages/frontend/src/hooks/useSalesPayments.ts
  - packages/frontend/src/components/sales/CreateSalesKeyDialog.tsx
  - packages/frontend/src/hooks/useMerchantKeys.ts
last-verified: "2026-11-21"
---

# Quality scan 2026-11-21 — whole repo, weighted to the landings since 2026-11-12

Scope: the whole repository at `origin/dev` @ `682c5fc3e`, on the owner's
request "run a quality-scan and file what you find" (2026-11-21). The window
since the previous whole-repo entry is `9871885a9..682c5fc3e` → **111**
first-parent landings, 859 files, +102,732 −4,449
(`git rev-list --first-parent --count 9871885a9..682c5fc3e`,
`git diff --shortstat 9871885a9 682c5fc3e`). Most of it is new surface: the
merchant kit (`packages/paywall-proxy`), the shared settlement code
(`packages/merchant-payments`), merchant services and Sales in the backend and
dashboard, checkout details (#4868) and the Stripe sandbox work.

**Method.** Five workers, as in the 2026-11-12 run: four hunters, one per
vertical (the sell side: kit, settlement code and Sales backend; the backend
outside it; the agent surface; the owner dashboard), each required to run a
reproduction with a positive control, and one measurement worker in its own
worktree for the numbered blocks. The captain re-ran every reproduction at the
scan SHA (§ 4). No live call moved money or used a signer; the only live call
was one unauthenticated read of the dev catalog listing. GitHub was read-only
during the scan.

**A departure from the skill, named:** as in the 2026-11-12 run, the report
carries a list of reproduced one-PR defects beyond the cap of five (§ 2.2).
They are prior art for the next run's exclusion like any candidate.

**Excluded this run:** every prior finding, candidate and beyond-cap defect in
the ledger, whatever its disposition. Two items here are new sites of the
2026-11-12 S1 class (epic #4816); they are reported as follow-ups to that
epic, not as a re-surface (C3, and the Sales key defect in § 2.2).

## 1. Structural findings

None in this run. The reproduced defects fall on the newest surfaces, each
with a one-PR remedy. The closest thing to a pattern is S1's class recurring at
two sites #4816 did not list (C3; the Sales key create in § 2.2). That is
already an epic, so the sites are filed as its follow-ups. The merchant kit
carries three defects and the block 1 survivor below (C2, C4, § 2.2), but they
have four different mechanisms and no recorded cost yet, so they do not meet
the bar's criteria 1 and 3.

## 2. Improvement candidates — filed on the owner's request

### C1 — hosted `haven_submit` relays the funding when it cannot read the stored challenge, so a required checkout detail is dropped after money moves

- **Where:** `packages/mcp-server/src/tools/support/checkout-details.ts:221-226`.
  `storedChallengeForSubmit` turns any failure of
  `GET /x402/:id/payment-required` into `null`. Then
  `checkoutDetailsBeforeSubmit` (`:243`) answers "no request", and
  `state-direct-recovery.ts` goes on to relay or submit.
- **What happens:** a plain-HTTP EIP-3009 payment whose merchant requires
  `receipt_email`, sharing on, and the stored-challenge read failing (a 503, or
  a 429 — the route is rate-limited). The funding is relayed, the answer is
  `status: confirmed` with `next_action: retry_original_x402_request`, and there
  is no `additional_retry_headers`. The agent retries without the required
  field, so the payment ends funded and undelivered. On erc7710 the
  `retry_headers` likewise come back without `X-Checkout-Details`.
- **The contrast:** when the owner's details read fails instead, the same tool
  refuses before spending (`CHECKOUT_DETAILS_UNAVAILABLE`, "Nothing was funded,
  submitted or sent"). A failed details read fails closed; a failed request read
  fails open.
- **Design text:** `docs/architecture/13-checkout-details.md` (around line 446)
  states the fail-open as intended ("When the stored challenge cannot be read,
  the submit proceeds as today"), justified by the pay tool's earlier check. The
  pay tool checked availability only, so the justification does not cover the
  submit. This contradicts that document's rule that a required field which
  cannot be shared stops the purchase before money moves.
- **Verified at scan:** `node r1-submit-failopen.mjs ok|fail|availfail` and
  `node r1b-erc7710.mjs ok|fail` against the built dist with a fake client
  (§ 4). Decisive (`fail`): calls
  `getX402StoredPaymentRequired,submitSignature,getPaymentStatus,getX402MerchantCallContext`,
  `funding relayed (submitSignature called): true`,
  `additional_retry_headers keys: ABSENT`. Positive control (`ok`): calls
  include `readCheckoutDetails`, and the keys are `[ 'X-Checkout-Details' ]`.
- **Remedy (one PR):** read a 409 (a direct payment) and a 200 with no stored
  challenge as "no request"; refuse any other failure before the relay or
  submit, with a new reason; update the design text and its pinned test.
- **Two sibling gaps on the same surface** (reproduced, filed with C1):
  - the request-mode pay tool leaves the caller's own headers out of the 16 KB
    header-block estimate (`checkout-details.ts:84` and `:249` call
    `estimatePaidHeaderBlockBytes` without `requestHeaders`; the SDK counts
    them at `packages/sdk/src/client-checkout-details.ts:208`). With a
    14.5 KB `Cookie`, hosted estimates 2,429 bytes and proceeds to
    `createX402Intent`; the SDK estimates 16,939, over the 16,384 ceiling. The
    comment at `checkout-details.ts:231-232` says the opposite of the code;
  - the local MCP gives every checkout-details refusal the same "then retry"
    step, with no `phase`, `stage` or payment id
    (`packages/mcp/src/tools.ts:1919-1920`, `:1992-2003`), where hosted maps
    each stage. Reproduced output only; no other local stage was run.

### C2 — the merchant kit loses an in-flight sale report when the proxy stops

- **Where:** `packages/paywall-proxy/src/main.ts:172-182` — `close()` stops the
  outbox timer and closes the store; it never awaits `sales.idle()` and never
  writes pending reports to the outbox. `src/index.ts:62` runs `close()` on
  SIGTERM. A report lives only in the in-memory `inFlight` map
  (`src/sales.ts:167`) until the reporter finishes its resends, and nothing at
  startup looks for settled rows with `sale_reported = 0`.
- **Why it is common, not rare:** Haven answers 425 `transaction_not_visible`
  with `Retry-After: 10` until the transaction has 3 confirmations, so in
  practice every sale spends at least 10 seconds in memory, and the README's
  deploy procedure stops the old process before starting the new one.
- **Verified at scan:** `shutdown2.repro.test.ts` (production resend delays,
  Haven answering 425, `close()` after the first POST). Decisive:
  `{"atExit":{"old_reporter_pending":1,"old_reporter_queued":0,"outbox_file_lines":"absent"},"new_proxy":{"outbox_depth":0,"haven_posts_in_2s":0,"store_state":"delivered","saleReported":false}}`.
  Positive control (`shutdown-loses-report.repro.test.ts`, no restart):
  `"store_saleReported":true`.
- **Remedy (one PR):** write the record to the outbox before the first
  attempt (or have `close()` wait a bounded time and then queue what is
  pending), and at startup queue every settled row with `sale_reported = 0`
  that is not already in the outbox.

### C3 — a stranded-delegate sweep whose receipt wait times out is booked `failed`, and cannot be replayed

- **Where:** `packages/backend/src/rails/sweep.ts:159-171` — after broadcast,
  the 90-second receipt wait returns null and the rail throws
  `Sweep tx <hash> not confirmed within 90s` (its own comment says "Timeout is
  NOT failure"). `packages/backend/src/modules/mpp/sweep.ts:373-387` —
  `submitSweep` catches it, calls `markSweepFailed` with no `tx_hash`, and
  answers 502 "Sweep relay failed".
- **What follows:** the stranded-funds event is never resolved (its only
  resolver is on the success path, `sweep.ts:392`); a retry with the same nonce
  answers 409 "Sweep is failed, expected prepared", so the agent never learns
  the hash; and a landed sweep shows in transaction history as an unattributed
  deposit, because attribution requires `status = 'submitted' AND tx_hash IS
  NOT NULL` (`infra/repositories/transaction-history.ts:302-320`). Funds cannot
  move twice: the balance only covers one transfer.
- **Verified at scan:** `h2-sweep-timeout-repro.test.ts` on the existing sweep
  route harness. Decisive: `{"status":502,"body":{"error":"Sweep relay failed",…},"txHashWrittenToSweepRow":false,"strandedEventResolved":false}`,
  then the retry `{"status":409,…}`. Positive control (relay returns the hash):
  `{"status":200,…,"strandedEventResolved":true}`.
- **Remedy (one PR):** a typed outcome-unknown error from the rail that carries
  the hash (#4817's typed error is the precedent); `submitSweep` records the
  hash and answers "check later", not "failed". The S1 class at a site #4816
  did not list, so it is filed as that epic's follow-up.

### C4 — the merchant kit's facilitator fake ignores its arguments, so no test sees what the kit asks the facilitator to settle

- **Where:** `packages/paywall-proxy/src/test-harness.ts:190`, `:197` —
  `FakeFacilitator.verify()` and `settle()` take no arguments; the suite pins
  only `settleCalls`, `verifyCalls` and event counts.
- **Verified at scan:** block 1's probe P2 changed
  `packages/paywall-proxy/src/handler.ts:753` so the facilitator settle gets
  `payTo: 0x…dEaD` and `amount: '1'` instead of the verified requirements:
  `proxy.test.ts` 89 of 89 green; the whole paywall-proxy suite 297 of 297
  green (cp-backup rig, restored clean).
- **Not observed:** what the real CDP facilitator would do with mismatched
  requirements.
- **Remedy (one PR):** record `payload` and `requirements` in the fake and
  assert the settled requirements in the "forwarded only after settlement"
  test. The P2 mutation is the acceptance check.

### C5 — the Sales payments list leaves a permanent hole after "Show more" when more than a page of payments arrives between two re-reads

- **Where:** `packages/frontend/src/hooks/useSalesPayments.ts:75-79`
  (`mergeLivePage`) and `:139-157` (`reread` re-reads page 1 only and keeps the
  cursor once more than one page is loaded).
- **What happens:** with more than one page loaded, more than one page of new
  payments between two re-reads (a hidden tab, a busy per-call seller, the
  merchant index catching up) puts the fresh first page on top of the old rows.
  The payments between the two are never shown, and the cursor points past the
  old rows, so "Show more" cannot load them.
- **Verified at scan:** `h4-sales-live-gap.test.ts`, page size 2, rows
  [5..1], four new payments. Decisive: `MERGED [9,8,5,4,3,2,1]` and, through the
  hook, `HOOK {"rows":[9,8,5,4,3,2,1],"total":9,"hasMore":false}`. Positive
  control: one new payment merges to `[6,5,4,3,2,1]`.
- **Prior art in the repo:** the Transactions feed re-reads the whole loaded
  window for this reason (`useTransactionsFeed.ts:311-314`, #2732).
- **Remedy (one PR):** re-read the loaded window, or detect the gap and reset
  the list and cursor; add the more-than-one-page test.

### 2.2 Reproduced, beyond the cap of five

- **Merchant kit — the discovery document omits `BASE_PATH`**
  (`packages/paywall-proxy/src/discovery.ts:215` emits `product.route`
  unchanged; `src/handler.ts:1249` serves products only under the base path).
  With `BASE_PATH=/api`, the listed `GET /v1/lookup` answers 404
  `unknown_route` whose `discovery_url` points back at the same document; the
  402 is at `/api/v1/lookup`. Control: no `BASE_PATH`, the listed route answers
  402. Haven's catalogue reader stores the route the same way
  (`backend/src/modules/catalog/merchant-products.ts:165`).
- **Merchant kit — the receipt prices a settled payment from today's products
  file** (`packages/paywall-proxy/src/receipt.ts:104`,
  `priceAtomic: params.product.price`). After a price change and restart, a
  proof retry gets a receipt for the new price while PAYMENT-RESPONSE says
  what settled: `"signed_value":"20000"` with `"totalt_inkl_moms":"0.03"`.
  Control (no price change): `"totalt_inkl_moms":"0.02"`. Haven's accounting
  books the settled amount and flags the receipt as `differs`
  (`backend/src/modules/accounting/receipt-statement.ts:190-213`); the
  merchant's own receipt is still wrong.
- **Sales key create reads a lost answer as "Nothing was created"**
  (`packages/frontend/src/components/sales/CreateSalesKeyDialog.tsx:14-19`;
  `hooks/useMerchantKeys.ts:59-63` re-reads the list only on success). A
  dropped connection or a 502 with no JSON body after the insert committed
  (`backend/src/routes/merchant-keys.ts:95-106`) shows "Haven could not create
  the key. Nothing was created. Try again.", the list is not re-read, and "Try
  again" mints a second key. Decisive: `COPY "Haven could not create the key.
  Nothing was created. Try again." GET calls 1` for both cases. Control: a 409
  shows its own sentence. The S1 class on a non-money owner write.
- **Fortnox `Comments` carries characters outside Haven's own allowed set**
  (`backend/src/modules/accounting/fortnox-connector.ts:197` builds
  `Resource ${resourceHost}.` from `URL.host`, which keeps a port, and it never
  passes through `fortnoxSafeText` at `:151-156`). Decisive:
  `https://merchant.example.com:8443/pay` → `"allowedSetOnly":false,"forbiddenChars":":"`;
  an IPv6 literal → `"[:]"`. Control: no port → `true`. Not run against
  Fortnox; the claim is against Haven's declared set, not a Fortnox rejection.
- **A transaction row named by its resource host cannot be found by that
  name** (`backend/src/modules/transactions/search.ts:55-60` passes
  `x402ResourceUrl: null` to `allRecipientNames`, while the row's name and the
  CSV's `counterparty_name` use the host, `routes/transactions.ts:262`,
  `:485`). Decisive: `"rowShows":{"label":"api.weatherly.example","kind":"x402"},"searchForShownLabel":false`.
  Controls: an address fragment and the agent name are found.

### 2.3 Scan instruments (measurement worker)

- **The block 1 census sample never advances.** The SHA-pinned census lists
  the same first five files at `8486093df`, `9871885a9` and `682c5fc3e`
  (`auth.test.ts`, `boot.test.ts`, `log.test.ts`, `http.test.ts`,
  `node-version.test.ts`): mutating a file does not change its last-touch
  commit, so every run takes the same five, and files 6 onward have never
  been sampled.
- **Block 8's "answered" predicate misses a typed stop inside `API_ERROR`.**
  Three of this run's six unmarked agent-payment-route rows are
  `relayer_budget_exceeded` 429s that the hosted mapper answers with a typed
  stop (`mcp-server/src/tools/support/errors.ts:438`, `:1044-1049`, pinned by
  `retry-by-cause.test.ts`); the census reads `answer.code === 'API_ERROR'`
  (`scripts/ci/refusal-census.mjs:283`) as unanswered.
- **The sizing row omits two packages added 2026-11-17**:
  `packages/merchant-payments` (3,517 / 1,751 lines) and
  `packages/paywall-proxy` (5,689 / 5,056), measured with the row's own
  recipe. The root `npm run build` builds neither, nor `demo-merchant-mcp`.

### 2.4 Leads, not findings

- Sell side: the kit's `check` command reports "sales key: ok" without
  comparing the key's account to `PAY_TO` or `NETWORK` (`check.ts:353-402`); a
  facilitator `success:false` with no transfer inside `SETTLE_RESOLVE_MS` is
  answered "Nothing was paid" although a refusal can follow a broadcast.
- Backend: a merchant receipt captured while another push is in flight may not
  reach the document (`modules/mpp/merchant-receipt.ts:145-159`); the
  evidence upsert overwrites `merchant_address` on conflict
  (`infra/repositories/machine-payments.ts:62-75`); two grace predicates treat
  an unreadable timestamp in opposite ways.
- Agent surface: after an `unsent` checkout-details refusal, "start a new
  purchase" may meet #4846's replay inside the same idempotency time bucket.
- Dashboard: clearing a Stripe-held sale does not refresh the period total; an
  own-account payer with no name renders as a third-party wallet; company
  details check control characters in the legal name only.
- qa-dev job `136250115674` (2026-11-20), attempt 2/2, leg
  `x402-delegation-3009`: "payment settled but settlement_scheme was "erc7710",
  not "eip3009"" — no matching issue found.
- Block 3's `any` row and block 6's money-perimeter row moved on prose: all
  five new `any` hits and both new money-verb hits are in comments.

## 3. Coverage record

All at `682c5fc3e`; parentheses are the 2026-11-12 entry at `9871885a9`. The
measurement worker's commands and outputs are kept with the scan's scratch
files; every manifest row was re-run by `scripts/docs/scan-remeasure.mjs`
(3 flagged, 0 failed, 0 controls failed, 0 refused), and this PR writes those
figures into `docs/quality/scan-baselines.json`.

- **sizing** → examined → the manifest row → backend 137,317 / 186,022
  (124,298 / 167,714); frontend 92,170 / 101,799 (83,583 / 93,776); sdk 21,678
  / 24,819; core 28,559 / 1,020; qa-agent 20,299 / 18,510; mcp-server 15,305 /
  27,870; signer 5,641 / 9,872; connect 12,440 / 15,676; cli 3,199 / 3,611; ops
  3,199 / 2,266; ui 2,849 / 2,402; mcp 3,206 / 6,130; demo-merchant-mcp 6,587
  / 10,041 (4,105 / 4,591). Outside the row: merchant-payments 3,517 / 1,751;
  paywall-proxy 5,689 / 5,056. Fat controllers → 57 route files, 4 at or above
  1,000 lines, 237 registrations, largest 1,556 (50 / 4 / 216 / 1,556).
- **block 1** (guard falsifiability) → examined → the census command →
  **292** candidate files (253); 5 census mutations → 4 caught, 1 survived
  (M3, `packages/mcp-server/src/log.ts:40` params guard deleted, 6 of 6 green:
  weak test, no malformed case reaches it); 2 probes → 1 caught (P1, the local
  MCP's version floor, 4 of 9 red), 1 survived (P2, C4: weak test). Total
  **5 caught, 2 survived** (5 / 2), 0 shadowed, 0 mutation-red. Files 6–292
  not sampled.
- **block 2** (`covers:` completeness) → partial → the manifest rows → 15 / 5
  / 7 (unchanged); covers-gaps 123 / 33 (unchanged); control passed.
- **block 3** (stale numbers) → partial → the manifest rows → head sample 20 /
  0 (7 / 1; a different 25 shards); `any` 44 (39, flagged, all five new hits
  prose); db-mock gauge 54 / 270 / 57 (unchanged); zod 0; controls passed; one
  shard figure re-derived (#4872's "23 tests" → 23 passed).
- **block 4** (retired vocabulary) → partial → the manifest row → 200 / 48 /
  152 (199 / 48 / 151); control 36. The new file is a frontend test fixture
  key.
- **block 5** (merge-method drift) → examined → 282 merge commits (282);
  squash / total 1,642 / 1,927 (1,531 / 1,816).
- **block 6** (nets with holes) → partial → copy lint 130 / 15 (121 / 15);
  ls-tree control 51 / 1; money perimeter 34 / 21 (32 / 20, flagged; both new
  hits comments); visual gate 16 / 28 (15 / 27, flagged; `/sales` is shot);
  docs boundary 45 (45). Exit-branch reading not done.
- **block 8** (refusal census) → examined → 623 files, 619 passed, 2 failed
  (two 5,000 ms timeouts under concurrent load, not assertions:
  `src/rails/__tests__/hybrid-account-config.test.ts`,
  `src/db/migrations/__tests__/132_inbound_transfers_account_time.test.ts`),
  2 skipped; 7,970 tests; 493.6 s; **3,439 rows; 2,802 error rows; 698 keys;
  204 typed rows reach the generic branch** (2,232 / 1,626 / 578 / 143);
  **6 unmarked on agent payment routes** (3) — the three new ones are the
  instrument gap in § 2.3; 5xx transient 37 (37; 4 new, 4 gone — the gone four
  are the owner submits #4820 / #4821 typed); non-answers 2 (2); SDK error
  sites 31 (31). 43 new unmarked typed rows are on merchant and owner routes
  that no hosted MCP tool reaches. A baseline re-recording at `9871885a9`
  reproduced the 2026-11-12 figures (2,233 rows; 1,626 / 578 / 143 / 37 / 2 /
  31). Positive control passed.
- **block 9** (field round-trip) → examined → emitted-never-read **5**, the
  same five; read-never-emitted **13**, the same 13; control passed. The new
  `GET /agents/:id/checkout-details` read is outside the `MAPPERS` table; joined
  by hand, clean.
- **block 10** (catalog conformance) → fixtures examined; default tier
  examined → the dev listing at 2026-11-21T23:15:17Z → 26 entries, 24 active,
  12 http / 12 mcp, 0 bazaar (unchanged); dev deployed revision `682c5fc3e`
  (deployment record); third-party tier not examined → not requested.
- **comment archaeology** → examined → 0 markers (control `import` → 2,563).
- **residual archaeology** → examined → PRs merged to `dev`
  2026-11-12T00:00:00Z .. 2026-11-21T23:09:45Z, counted at 23:09:45Z → **110**
  PRs; 49 with an inline `Residual risk:` line, 6 saying none; 1 with a
  residual heading, 4 bullets, 0 citing an issue. The uncited residuals
  cluster on the merchant kit (#4924, #4972, #5013, #5016 — the last one
  became #5022), MCP and signer (#4844, #4837, #4842, #4834) and the Sales
  dashboard (#5002, #4999).
- **escape analysis** → examined → 104 issues created since 2026-11-12: 10
  epics, 14 carrying `Found by: quality-scan` (#4817–#4830, the previous run's
  filings), 2 standing reports, 1 external solicitation, **13 defects not
  found by a scan**, 63 epic slices and features read by title only. By class:
  CI and dev tooling 4 (#4947, #4971, #4976, #5022 — workflow archaeology, and
  block 6 for #4976); found in code review 4 (#4955, #4931, #4946, #4932 — no
  block); a sandbox run 1 (#4866 — block 8's class, outside its sample); copy
  and UX from owner or design review 4 (#4980, #4839, #4984, #5026 — no block).
  This run's own 12 reproduced defects (11 from the hunters, C4 from block 1) by class: a lost answer read as a known
  outcome 2 (C3, the Sales key), a durable record kept only in memory 1 (C2),
  a read failure read as "nothing requested" 1 (C1), a fake that cannot see
  what it is asked 1 (C4), a value re-read from current state instead of what
  settled 1, a partial re-read merged into a longer list 1 (C5), and one each
  of a path prefix dropped, a character set not applied, a search haystack
  missing a shown name, a stage dropped by one surface, and an estimate that
  leaves out one of its inputs.
- **workflow archaeology** → examined → 3,730 Actions runs created
  2026-11-12T00:00Z .. 2026-11-21T23:09:45Z; 16 with `run_attempt > 1`; CI 10
  reruns of 266 runs (18 failed, 48 cancelled); Update visual baselines 10
  failures of 29 runs; Publish paywall proxy image 3 failures of 5 (#5022);
  qa-dev money-flow jobs: 121 ran, 549 skipped; 117 success, 3 failure, 1
  cancelled; 2 passed on attempt 2/2 (job `135469783113`, attempt 1 failed only
  `merchant-locked-budget`; job `135968521340`, attempt 1 failed only
  `x402-delegation-3009-grace-resume`).
- **incident clustering** → partial → the escape classes above; no count over
  time.
- **live exercise** → not examined beyond block 10's listing read.
- cross-package duplication → not examined; validation / contracts → partial
  (blocks 8, 9 and the hunters' route tests); data-layer coverage → partial
  (the gauge).
- novelty → each hunter's ledger grep and GitHub searches, listed with its
  item in the workers' reports; the captain read the title and state of every
  issue cited here.

## 4. Verification and limitations

The captain re-ran, at `682c5fc3e`: the three sell-side vitest reproductions
(5 passed, each printing the decisive line quoted above), the base-path run and
its control, the two backend scripts (Fortnox comment, search host), the four
agent-surface scripts (C1's three modes, the header estimate in both modes, the
local stage output), and the three vitest reproductions that need a source
file in place (the sweep route test, 3 passed; the Sales live merge and the
Sales key dialog, each failing exactly where its hunter reported and passing
its control). The sweep reproduction ran in a separate worktree with the
reproduction file copied in and removed afterwards.

Limits:
- Every agent-surface reproduction uses a fake Haven client against the built
  dist; no hosted MCP request was made.
- The Fortnox item is measured against Haven's own declared character set; no
  request reached Fortnox.
- The facilitator in C4 is a fake; what a real facilitator does with mismatched
  requirements is not observed.
- The sell-side backend half (Sales ingest, Sales reads) was read, not run
  against a database.

One observation from the sell-side hunt is not written here: it concerns the
production scope of a dev-only feature, and it was filed, worded neutrally, as
#5028 on the owner's instruction during the scan.

## 5. Independent review

To be completed by the `haven-reviewer` pass on this pull request.
