---
owner: "@d-hinders"
status: record
covers:
  - packages/backend/src/infra/repositories/delegation-budgets.ts
  - packages/backend/src/infra/repositories/agents.ts
  - packages/backend/src/infra/repositories/smart-accounts.ts
  - packages/backend/src/infra/repositories/task-budgets.ts
  - packages/backend/src/infra/repositories/sub-budgets.ts
  - packages/backend/src/infra/repositories/dashboard.ts
  - packages/backend/src/infra/repositories/ops-reads.ts
  - packages/backend/src/infra/repositories/budget-remaining.ts
  - packages/backend/src/infra/repositories/analytics.ts
  - packages/backend/src/infra/repositories/agent-connection-setups.ts
  - packages/backend/src/infra/repositories/agent-rekeys.ts
  - packages/backend/src/infra/repositories/x402-authorizations.ts
  - packages/backend/src/routes/agent-delegations.ts
  - packages/backend/src/routes/machine-payments.ts
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/modules/task-budgets/task-budget-service.ts
  - packages/backend/src/modules/sub-budgets/sub-budget-service.ts
  - packages/backend/src/modules/budget-scope/resolver.ts
  - packages/backend/src/modules/x402/eip3009-settlement-evidence.ts
  - packages/backend/src/modules/x402/eip3009-settlement-sweeper.ts
  - packages/backend/src/modules/payments/agent-payment-status.ts
  - packages/backend/src/modules/mpp/__tests__/eip3009-settlement-evidence.test.ts
  - packages/backend/src/infra/chain/authorization-used-scanner.ts
  - packages/sdk/src/account-reads.ts
  - packages/sdk/src/x402-nonce.ts
  - packages/cli/src/commands.ts
  - packages/frontend/src/components/DelegationBudgetCard.tsx
  - packages/frontend/src/components/marketplace/FundMerchantModal.tsx
  - packages/frontend/src/components/agent-panel/RemoveAgentDialog.tsx
  - packages/frontend/src/lib/sub-budget.ts
  - packages/frontend/src/lib/dashboard-attention.ts
  - packages/frontend/src/lib/budget-caption.ts
  - scripts/docs/covers-gaps.mjs
  - .agents/skills/quality-scan/references/dimensions.md
last-verified: "2026-10-26"
---

# Quality scan 2026-10-13 — whole repo, weighted to the landings since 2026-10-03

Scope (owner request 2026-10-13, "do a quality scan", no scope named): the
whole repository, weighted toward the 159 first-parent landings on `dev` since
the 2026-10-03 scan (`git rev-list --first-parent --count b00d75bd7..641f527d`
→ 159) (the dashboard redesign epics, the EIP-3009 settlement
wave, the connect pair-naming wave, the Gnosis removal, two releases) and
toward the surfaces those landings touched most: the budget tables and their
readers, the x402 settlement evidence seams, CI.

Measured on `origin/dev` @ `641f527d` (2026-10-13). Method: the captain in the
main checkout, two read-only census workers in detached worktrees (budget
liveness; settlement evidence), one read-only GitHub worker (job-level qa-dev,
CI failures, issue bodies, the issue window). The clone arrived shallow at 50
commits and was unshallowed before any history figure was taken. Mutations
used `cp` backups with `cmp` restores; real-database runs used a local
Postgres 16 cluster with a disposable `haven` database; one temporary probe
test was written, run, and deleted (tree clean, `git status --porcelain` → 0).
GitHub was read-only. No live call was made.

**Excluded this run:** every prior finding and candidate, whatever its
disposition. The re-measurable deltas are in §5. None worsened materially.

## 1. Structural finding

### S1 — whether a budget is live is decided at about forty sites with three different answers, and the one shared predicate is four days old and reaches seven of them

**Claim.** Three tables hold spend authority — `agent_delegations`,
`agent_task_budgets`, `agent_sub_budgets` — and every reader decides for
itself whether a row is live: which statuses count, whether `expires_at` is
checked, against which clock, and whether `start_date` matters. The word
"live" names three different sets. Eleven pairs of sites classify the same
row differently; seven of those are verdict conflicts on one row at one
moment, and two were reproduced here by execution against the real database.

**Measured (all at `641f527d`).**

- The one helper, `delegationLiveWindowSql` in
  `packages/backend/src/infra/repositories/delegation-budgets.ts:82`, encodes
  `expires_at > EXTRACT(EPOCH FROM NOW())` and nothing else. It was introduced
  by `0108c6d9` (2026-10-09, #3802):
  `git show 0108c6d9^:packages/backend/src/infra/repositories/delegation-budgets.ts | grep -c delegationLiveWindowSql`
  → 0. That PR changed **11** code files
  (`git show --format= --name-only 0108c6d9 | grep -vE '\.md$|\.test\.|__tests__' | wc -l`)
  and added **6** call sites
  (`git show 0108c6d9 -- packages/backend/src | rg '^\+.*delegationLiveWindowSql\(' | rg -v 'export function' | wc -l`).
- Helper call sites today → **7 in 5 files**
  (`rg -n "delegationLiveWindowSql\(" packages/backend/src --glob '!**/*.test.*' --glob '!**/__tests__/**' --glob '!**/migrations/**' | grep -v 'export function'`):
  `ops-reads.ts:78,222,334`, `delegation-budgets.ts:108`,
  `budget-remaining.ts:69`, `agent-connection-setups.ts:183`, `analytics.ts:814`.
- Inline copies of the same spendable window on the same table → **3**, all in
  `delegation-budgets.ts`: the payment selector (`:302-309`, adds
  `start_date <= now`), the by-hash selector (`:457-461`, adds `start_date`),
  the merchant-budget list (`:684-685`, no `start_date`). The first two are
  inline by decision (comment `:77-79`); the third has no comment.
- A second definition, the LIVE status set
  `LIVE_DELEGATION_STATUSES_SQL = ('pending','active','replaced')` with **no
  expiry** (`delegation-budgets.ts:482`) → **7 SQL uses in 3 files**
  (`agents.ts:320,356,733,739,746`, `smart-accounts.ts:310`,
  `delegation-budgets.ts:498`) plus **2 hand copies in TypeScript**:
  `packages/frontend/src/components/agent-panel/RemoveAgentDialog.tsx:20` and
  `packages/cli/src/commands.ts:1088`. It drives `live_delegation_count`, the
  archive guard, the account-delete guard and the CLI revoke gate.
- A third, status-only or no predicate at all: the budget list route
  `packages/backend/src/routes/agent-delegations.ts:262` returns every status
  and gates its chain-remaining read on `status === 'active'` alone
  (`:278`, `:286`); the dashboard's received-sub-budget read
  `packages/backend/src/infra/repositories/dashboard.ts:365` is
  `(asb.status = 'open') AS open`; `sub-budgets.ts:254-260` is
  `status IN ('open','closing')`; the merchant funding picker
  `packages/frontend/src/components/marketplace/FundMerchantModal.tsx:173` is
  `status === 'active'`.
- Task and sub budgets have **no helper at all**:
  `rg -c 'delegationLiveWindowSql|EXTRACT\(EPOCH' packages/backend/src/infra/repositories/task-budgets.ts packages/backend/src/infra/repositories/sub-budgets.ts`
  → 0; **10** SQL sites each spell `status … AND expires_at > $n` against an
  app-clock parameter
  (`rg -n "expires_at (>|>=|<=|<) \\$" …/task-budgets.ts …/sub-budgets.ts | wc -l`
  → 10). Two of those are payment-time selectors with **no production
  caller** (`task-budgets.ts:271`, `sub-budgets.ts:409`) while TypeScript
  copies make the live decision
  (`packages/backend/src/modules/task-budgets/task-budget-service.ts:131`,
  `packages/backend/src/modules/sub-budgets/sub-budget-service.ts:182`).
- Clients restate the predicates from raw wire status: the SDK keeps an
  expired `closing` task budget that the backend has dropped since `2dd8a91d`
  (`packages/sdk/src/account-reads.ts:360`); the dashboard card, the
  sub-budget parent filter and the budget caption each spell their own
  (`packages/frontend/src/components/DelegationBudgetCard.tsx:312-314`,
  `packages/frontend/src/lib/sub-budget.ts:133`,
  `packages/frontend/src/lib/budget-caption.ts:276`). The sub-budget tree
  rows render "ends" from expiry alone, so a `closed` row with a future
  expiry reads as live (`DelegationBudgetCard.tsx:851,876`).
- Disagreement pairs: **11**, of which **7** are verdict conflicts on the same
  row (P1, P2, P3, P5, P6, P9, P12 below; P4, P7, P8 and P11 are naming,
  clock, `start_date` and dead-copy differences). Each pair, with the sites
  that disagree:

  | # | one site says | the other says | kind |
  |---|---|---|---|
  | P1 | `routes/agent-delegations.ts:262` lists every status; `:278`, `:286` read chain remaining for `status === 'active'` with no expiry | `delegation-budgets.ts:106-108` drops an expired `active` row | verdict |
  | P2 | `FundMerchantModal.tsx:173` picks a budget on `status === 'active'` alone | `DelegationBudgetCard.tsx:312-314`, `sub-budget.ts:133` require `expires_at > now` | verdict |
  | P3 | `dashboard.ts:365` `(asb.status = 'open') AS open` | `sub-budgets.ts:184` `status = 'open' AND expires_at > $2` | verdict (proven) |
  | P4 | `sub-budgets.ts:184` "open" = open and unexpired | `sub-budgets.ts:254-260` "open" = `open` or `closing`, no expiry; `dashboard.ts:365` status only | naming |
  | P5 | `task-budgets.ts:139` drops an expired `closing` task row (since `2dd8a91d`) | `sdk/src/account-reads.ts:360` keeps `closing` whatever its expiry | verdict |
  | P6 | `sub-budgets.ts:218` lists `closing` for signature regardless of expiry | `sub-budget-service.ts:267-268` says an expired `closing` row needs no signature; `:363` serves a sign context for `closing` with no expiry check | verdict |
  | P7 | `delegation-budgets.ts:108`, `:307-308` compare against the database clock | `task-budgets.ts:128` and the other nine task/sub sites compare against an app-clock parameter | clock |
  | P8 | `delegation-budgets.ts:307`, `:384`, `:421-431` require `start_date <= now` | `delegation-budgets.ts:106-108`, `:684-685` do not | `start_date` |
  | P9 | `agents.ts:320` counts `('pending','active','replaced')` with no expiry | `delegation-budgets.ts:106-108` returns only unexpired `active` rows | verdict (proven) |
  | P11 | `task-budgets.ts:271`, `sub-budgets.ts:409` payment selectors (no production caller) | `task-budget-service.ts:131`, `sub-budget-service.ts:182` decide in TypeScript | dead copy |
  | P12 | `DelegationBudgetCard.tsx:851`, `:876` render "ends" from expiry alone | the tree payload carries `closed` rows (`sub-budgets.ts:304-322`, no status filter) | verdict |

  (The census's P10 — the CLI and dialog copies of the LIVE set agree with the
  SQL constant — is an agreement, not a pair.) Two pairs were proven by
  execution on the real database with a temporary repository test (seed,
  call the repo's own SQL, assert, delete the file):
  - **P9** — one `active` delegation with `expires_at = now − 60`:
    `listActiveDelegations([agentId])` → 0 rows; the `live_delegation_count`
    subquery from `agents.ts:320` → **1**. The agent "has no budget" and
    "cannot be archived or revoked" at the same time. 1 passed.
  - **P3** — one `open` received grant with `expires_at = now − 60` behind a
    live parent-child row: `RECEIVED_SUB_BUDGETS_FOR_AGENTS_SQL` → `open =
    true`; `listForAgent(childId, { status: 'open' })` → 0 rows. The
    dashboard's `hasUsableBudget`
    (`packages/frontend/src/lib/dashboard-attention.ts:133-138`) therefore
    reads an expired grant as a usable budget and suppresses the Needs-you
    item. 1 passed.

**Demonstrated cost.** Five issues in nine days, each the same defect at a
different site, each fixed at that site: #3542 (2026-10-01, a dashboard revoke
leaves the on-chain budget live), #3553 (10-01, sub-budget issuance accepts a
revoked agent), #3729 (10-07, CLI revoke leaves a live budget — fixed by
adding the second hand copy of the LIVE set), #3773 (10-08, expired `closing`
task rows listed as live forever — fixed in one SQL site), #3802 (10-09,
expired budgets counted as active — fixed by introducing the helper and
converting 6 sites in 11 code files, leaving the 3 inline copies, the list
route and every task and sub site untouched). The 2026-10-03 scan's S1 (epic
#3615, now closed) consolidated *which* delegation the pre-check reads; its
resolver still reads liveness through the inline by-hash SQL
(`packages/backend/src/modules/budget-scope/resolver.ts:242,271`) and the
task and sub TypeScript predicates. No open issue names the predicate
itself: a semantic issue search for a shared budget-liveness predicate returns
two of the fixes above (#3773, #3802) and two unrelated issues, and no issue
for the predicate.

**Why the bar is met.** Structural (a pattern, not a defect list); measured;
costed by the issue record and by the fix shape (one predicate, eleven files);
it changes how contributors work (a reader calls one of two named predicates
per table and never spells `status`/`expires_at` again; clients consume a
wire `is_live`, never recompute it); and it slices into disjoint PRs.

**Proposed slices (disjoint).**

1. **Name the two delegation sets in one module.** `spendable` (status
   `active`, inside the window, with `start_date` as a named option) and
   `still_enabled_on_chain` (the LIVE set), both SQL fragments and both
   documented; adopt `spendable` at the three inline copies and the list
   route's enrichment gate. Behaviour-preserving where a site is already
   right, characterised first.
2. **One predicate per table for task and sub budgets**, one clock, adopted at
   the 10 expiry sites and the two status-only reads; the two caller-less
   payment selectors are wired or deleted.
3. **Liveness on the wire, not recomputed.** Every budget-shaped response
   carries `is_live` (and keeps `is_expired`); the SDK, CLI and frontend
   restatements consume it; the two TypeScript copies of the LIVE set are
   replaced by one shared constant with a test that pins it to the SQL
   constant.
4. **Fix the proven and hard conflicts as behaviour, each with a real-DB
   test:** P1 (list route vs view), P3 (dashboard received sub), P5 (SDK vs
   backend on expired `closing`), P6 (awaiting list vs close path), P12 (tree
   render of `closed`). Each is an owner decision on intended semantics first.
5. **A shrink-only census ratchet** over inline
   `status = '…' … expires_at` predicates on the three tables outside the
   helpers, plus client-side restatements, so the pattern cannot regrow.

Slice 1 and 2 are independent; 3 depends on 1 and 2 naming the fields; 4
can start now; 5 lands last.

## 2. Improvement candidates (one PR each) — pending the owner's word

### C1 — the agent-reported EIP-3009 merchant settlement hash is attributed by shape, while the nonce proof the sweep uses since #3888 sits one call away

- **Observed.** `packages/backend/src/modules/x402/eip3009-settlement-evidence.ts:130-139`
  verifies a reported hash for existence, status, block window and an exact
  delegate→merchant `Transfer`, and passes no delegation hash or nonce, so
  *which payment* the transfer settled rests on the agent's `payment_id`.
  The writer's own comment names the residual: a hash can be recorded on any
  payment with the same agent, amount, token, delegate and merchant whose
  funding confirmed in the window
  (`packages/backend/src/infra/repositories/x402-authorizations.ts:462-480`).
  Since `1018deb3` (#3888) the passive sweep attributes by the derived nonce
  (`deriveX402PaymentNonce` in `packages/sdk/src/x402-nonce.ts:57`;
  `findAuthorizationUsedTx` in
  `packages/backend/src/infra/chain/authorization-used-scanner.ts:163`) and
  the two paths write through one CAS.
- **Expected benefit.** The accounting feed books EIP-3009 payments under
  this hash (#3767) and receipts headline it (#3763); a misreported
  `payment_id` on a same-shaped sibling could today steer both. Checking the
  reported transaction's `AuthorizationUsed` log for this payment's derived
  nonce makes attribution chain-proven on the agent path as it already is on
  the sweep. Hypothesis, not an incident: no misattribution is on record.
- **Scope.** One PR: the evidence module, its test, the status copy. The
  nonce derivation and the log reader exist.
- **Verification still needed.** A real-DB test where a sibling's verified
  transfer is reported against the wrong payment id and is refused with the
  attribution reason, and the right one recorded.

### C2 — the 2026-10-03 scan report never landed, and the ledger names a path that is not in the tree

- **Observed.** The ledger's 2026-10-03 entry says the full report "is held
  outside the repo until the owner decides"; the owner decided the same day
  (epic #3615, five slices, all closed). `ls docs/bug-reports | grep
  2026-10-03` → nothing at `641f527d`. The entry carries the path and no
  file:line evidence of its own, so the evidence behind #3615's S1 and behind
  that run's one still-undecided candidate (its C1; its C2 shipped via #3624,
  §4) is recoverable only outside the repository.
- **Expected benefit.** `new-task` sweeps the bug reports as prior art before
  filing; a reader rediscovering either 10-03 candidate live will file a
  sibling.
- **Scope.** One docs PR: commit the report (with its `covers:`), or amend
  the entry's pointer with a dated line to say where it lives.
- **Verification still needed.** The coupling gate on the committed file.

### C3 — block-1 survivor: the "one hash per payment" compare-and-set is the only guard for a two-hashes-one-payment race, and nothing tests it

- **Observed by execution.** Removing
  `AND target.machine_metadata->>'merchant_settlement_tx_hash' IS NULL` from
  `RECORD_EIP3009_MERCHANT_SETTLEMENT_SQL`
  (`x402-authorizations.ts:493`) left every suite run green: **76 / 76**
  across five suites (the EIP-3009 sweeper, the settlement-evidence suite,
  the x402-authorizations repository suite, delivery-reference and the
  agent-reported-outcome suite) — of which only the first two (**43 tests**)
  reach the writer; the repository suite never names it, and the two outcome
  suites seed `tx_hash` equal to the reported hash, so `isFundedEip3009Payment`
  is false and the seam is never entered. *Corrected in the new-task spec
  review:* first written as "the five suites that reach it". Diagnosis: *not load-bearing at
  the tested condition*. The writer pre-reads the recorded hash inside a
  transaction that holds an advisory lock keyed by the **hash**
  (`x402-authorizations.ts:529-536`), so a same-hash race serialises and the
  pre-read answers before the UPDATE. Two *different* hashes for one payment
  — the sweep's nonce-proven hash and an agent-reported sibling hash — take
  different locks, both pre-reads see null, and only the CAS stops the second
  from overwriting the first. The one concurrency test drives the opposite
  race, one hash across two payments
  (`packages/backend/src/modules/mpp/__tests__/eip3009-settlement-evidence.test.ts:400`).
- **Expected benefit.** The guard the module's doc comment describes as
  "a payment takes one hash only" becomes tested, or the lock is widened to
  the intent id so the pre-read covers both races. Observed burden only; no
  incident.
- **Scope.** One PR: a real-DB concurrency test (the repo has the
  `db-concurrency-proof` pattern) and, if the owner prefers, a second
  advisory lock on the intent id.
- **Verification still needed.** The new test red against the mutation
  above, green on the tree.

### Verified, held back (notes, not proposed)

- Two docs carry `status: archived` outside the archive folders, so
  `scripts/docs/covers-gaps.mjs` prints "outside the governed set — claims no
  longer checked" on every run (`npm run docs:covers-gaps` → 2 docs; both
  files are tracked). Move or re-status them; one line each.
- *Design visual regression* failed in **7 of 13** determinable `ci.yml`
  failures in the 3.5-day window (advisory on `dev` by owner decision on
  #3231); #3871 and #3872 (nondeterministic baselines) were fixed 2026-10-10.
  Tracked, decided; not proposed.
- The hosted tools/list golden (#3817, merged 2026-10-10 04:46Z) went red on
  `dev` the same morning when a green PR crossed it (#3886): `dev` does not
  require up-to-date branches (owner step O1), and #3890 shipped a watcher
  rather than a gate. One incident; context, not a finding. There are now 11
  committed baseline or snapshot artifacts
  (`git ls-files | grep -E 'snapshot\.json$|baseline\.json$' | wc -l` → 11)
  that two concurrent green PRs can both legitimately move.
- The sign route books `failed` only from its catch; the fiat lookup swallows
  its own errors and the gas record is awaited-and-swallowed, so the only
  throw between a landed UserOp and its confirm is the confirm's own DB write
  (`packages/backend/src/routes/payments.ts:1036-1075`). Read, not executed;
  the #3564 class is otherwise closed. Not proposed.

## 3. Context for tracked work (not new items)

- **qa-dev is healthy at the job level.** The 60 newest runs
  (2026-10-12T10:59Z → 10-13T15:44Z) all concluded `success` at run level, and
  a `money-flow` job failure fails its run, so `money-flow` failed in none of
  the 60. Of the 25 newest runs created at or before 2026-10-13T15:42Z,
  `money-flow` ran in **5** (5 success) and was gate-skipped in **20** (the
  gate dedups by deployment SHA; read per run from each run's jobs list).
  Every success log read (5) says `passed on attempt 1/2`; none carries
  `attempt 2/2`. The 31 scheduled runs from 09-13 to 10-13 show 4 failures:
  10-02, 10-03, 10-04 all at the QA-wallet balance preflight, and 09-24 a
  backend 502. #3631 (daily balance check) shipped 10-05; nine green
  scheduled days since. *Corrected in review:* first written as "25 looked
  up, 10 ran", a hand-chosen run set with no command.
- **The dashboard redesign cluster** — 39 of the 138 issues filed since
  10-03, including four "match the mockup" re-fixes between 10-12 and 10-13
  (#3897, #3908, #3910, #3912) — is runtime-UX surfaced by the owner's own
  review, out of this scan's scope by the skill's rule.
- **Vercel deployment records** (#3913, open, operator-verify) and the
  **connect pair-naming wave** (12 issues) are feature waves with open
  owners; not items here.
- **Settlement evidence per leg** was probed as a candidate finding and
  refused under the bar: no write in the backend is gated on a merchant's
  HTTP 200 (money-path modules make no outbound merchant fetch), two of the
  three chain-verifying legs share the #2092 verifier, and the EIP-3009 wave
  (10 issues since 10-03) is a shipped feature, not an unfixed class. C1 and
  C3 are its residue.

## 4. Re-checked and unchanged (prior items, for the record)

- 2026-10-03 C2 (the ops single-flight cache flake) → **`shipped`** via
  #3624, `0224c883`, 2026-10-04 — a disposition the ledger did not carry.
- 2026-10-03 C1 (#3609 raw error text) → #3609 closed; not re-surfaced.
- 2026-10-03 S1 → epic #3615 closed (all five slices). 2026-09-25 S1 → epic
  #3335 closed 2026-09-29. 2026-09-22 F1 → epic #3231 closed 2026-09-26.
  2026-09-15 F1 → epic #3028 closed 2026-09-29. 2026-09-16 F1 → epic #3056
  closed 2026-09-20. 2026-09-17 F1 → epic #3105 closed 2026-09-20.

## 5. Coverage record (block → examined / partial / not examined → command → result)

- **sizing** → examined → `git ls-tree -r --name-only origin/dev packages/<p>/src`,
  `.ts|.tsx|.mjs`, split on `.test.|__tests__|.spec.`, `git show | wc -l`
  summed → backend 109,321 / 140,397 (10-03: 101,373 / 127,733; +7.8 % /
  +9.9 % in 10 days); frontend 62,690 / 61,829; sdk 18,387 / 19,977; core
  24,845 / 607; qa-agent 9,693 / 7,784; mcp-server 12,586 / 23,237; signer
  5,271 / 8,404; connect 12,436 / 15,676; cli 3,159 / 3,454; ops 3,127 /
  2,114; ui 2,203 / 1,639.
- **block 1 (guard falsifiability)** → examined → the reference's census
  script → 31 candidate test files across 4 of the last 20 landings; 5
  mutations, one per file, newest landing first:
  - M1 `machine-payments.ts` supersession read → `return null`: **caught**,
    2 red of 98 across the two route suites.
  - M2 `agent-payment-status.ts` verified-settlement outranking clause →
    `true`: **caught**, 1 red of 28.
  - M3 `attention-dismissals.ts` user scoping on the backup-signer insert
    dropped: **caught**, 1 red of 15 (real DB).
  - M4 `x402-authorizations.ts:493` CAS clause → `AND TRUE`: **survived**,
    76 / 76 green across five suites, 43 of them in the two that reach the
    writer — diagnosed in C3.
  - M5 `sdk/account-reads.ts:103` supersession mapping → always null:
    **caught**, 1 red of 58.
  - Every restore byte-identical (`cmp`); 26 census files not mutated (budget
    is 5).
- **block 2 (`covers:` completeness)** → examined → the reference loop under
  `bash` with `set -f` → 8 contract docs, 20 raw misses of which 2 are glob
  strings; each of the other 18 confirmed with the strict coupling gate run
  the way CI runs it, one changed path at a time (the gate named the loop's
  doc for none of them) → **18 across 6 of 8** docs: x402
  sequence 3, docs-quality system 2, dev-environment 4, package-dev-channel
  2, CASP guardrails 6, security model 1 — unchanged from 10-03 and 09-25.
  `npm run docs:covers-gaps` → 130 pairs / 35 docs (10-03: 134 / 36); 2 docs
  outside the governed set (note above).
- **block 3 (stale numbers)** → partial → positive control 3 / 3; the 25
  newest shards (`2026-10-08-3781` … `2026-10-13-3772`) → **20**
  figure-bearing lines, **6** with a command (10-03: 1 / 0 — the release
  record and verification notes now quote their commands); `any` → 37 (10-03:
  30); lines not led by a comment marker → 16
  (`rg -n ': any\b|as any' packages/*/src --type ts -g '!*test*' | rg -v ':[0-9]+:\s*(//|\*|/\*)' | wc -l`),
  of which about 6 are string or JSX prose, so the 10-03 "code lines 10" is
  not comparable and no delta is claimed; db-mock gauge 54 / 270 / 57 (unchanged); guard
  scripts 69 (09-15: 49), non-spawning self-tests 23 of 71 (09-15: 20 — the
  `|guard-cli` term included); zod in backend 0. The 09-08 refusal-bearing
  count not re-taken.
- **block 4 (retired vocabulary)** → examined → positive control 36 shards →
  195 files, 46 historical / 149 live (10-03: 194 / 46 / 148; +1 live);
  `npm run lint:retired-rail-prose` → 33 hits / 31 files, green below
  baseline; code half unchanged (`failPendingX402Intent` only its defining
  file; the other two plus one comment line in the QA agent).
- **block 5 (merge-method drift)** → examined at `641f527d` → since
  2026-10-03T00:00:00Z → 0 merge-commit / 162 squash / 162 (clean); since
  2026-09-07T12:00:00Z → 0 / 648; since 2026-08-10T00:00:00Z → 282 / 1,054 of
  1,339 (282 unchanged).
- **block 6 (nets with holes)** → examined, four halves → copy lint 52
  unscanned / 4 with hits (10-03: 98 / 6; #3882 and #3884 widened the scan to
  six lib files and the hooks directory); money perimeter 32 verb files / 20
  outside (unchanged); visual gate 15 of 28 app routes shot (10-03: 15 of 31;
  the site switch-over deleted pages), 13 unshot listed by path; the 8 ops
  routes outside the measure; docs boundary, pinned → 39 (unchanged); the
  freshness gate's exit branches unchanged by kind (the reference's
  exit-branch grep over the freshness gate → 14 lines).
- **incident clustering** → examined → issues created since
  2026-10-03T00:00:00Z → **138** (9 open / 129 closed); by hand into classes:
  dashboard redesign 39, connect pair naming 12, budget lifecycle 11 (6 of
  them the #3615 family), EIP-3009 settlement 10, Gnosis removal 10, site
  redesign 7, egress hardening 6, QA funding 5, release 4, hosted tool
  contract 3, money-path perimeter globs 3, Vercel 3, visual baselines 2,
  other 23. The untracked recurring class is S1.
- **workflow archaeology** → examined → `ci.yml` newest 100 (10-10T00:21Z →
  10-13T15:41Z) → 77 success / 15 failure / 8 cancelled; 13 with attempt > 1,
  all feature branches; `dev` runs 35 → 30 / 1 / 4, the one failure the
  #3886 golden skew. Failing jobs over the 13 determinable failures: visual 7,
  MCP server 3, browser smoke 3, backend 1, repo-CI-config 1. qa-dev read at
  the `money-flow` job level (§3); 31 scheduled runs 09-13 → 10-13, 4
  failures.
- **comment archaeology** → `git grep -c -w -E 'TODO|FIXME|HACK|XXX' -- 'packages/*/src/*'`
  → 0 (control `import` → 1,994 files).
- **live exercise** → not taken.
- **novelty** → the tracker was read (138 issues, 0 open PRs, a semantic
  search for the S1 predicate); bug-report bodies were not re-read, so
  novelty against them is unverified.

## 6. Instrument lessons from this run

- The cloud checkout is **shallow (50 commits)**: `git rev-parse b00d75bd7`
  fails, block 5 reads 50 total, and `git show <old-sha>:<path>` is
  impossible. `git fetch --unshallow origin` first; it took under a minute.
- `rg -l "$fn"` with an empty `$fn` matches every file and produced a 9.9 MB
  result. Guard the variable before the search.
- `agent_sub_budgets_self_parent_chk` requires a grant row to name a
  parent-child row; a probe that seeds a grant alone fails on the constraint,
  not on the predicate under test.
- `coupling-gate.mjs --changed=<glob>` is expanded by the shell; the block-2
  loop's two glob-string "misses" must be dropped before confirmation, or the
  gate confirms a path that was never a path.
- `rg` is a real binary on this machine (`/usr/bin/rg`), so the reference's
  bash blocks ran as written.

## 7. Decisions requested

1. **S1** — file as an epic with the five slices (the owner's call on the
   semantics in slice 4 belongs on the epic), accept as debt, or reject.
2. **C1, C2, C3** — file as standalone tasks, accept as debt, or reject,
   each on its own.
3. The notes in §2 are not proposed; say if any should be.

Nothing was filed. On approval the ledger decision goes in a **separate**
pull request and the handoff is `new-task`, per the skill.

## 8. Dispositions re-checked 2026-10-26 (weekly docs audit #4438, at dev `ebf567f1c`)

The report body and §7 above are left as written. Every finding and candidate
has since been remediated, re-read at this head:

- **S1 (whether a budget is live was decided at about forty sites with three
  different answers)** — closed. The three answers are now three named
  predicates, each with one home:
  - spendability: `spendableDelegationSql(tableAlias, { requireStarted })` in
    `infra/repositories/delegation-budgets.ts:110-120` — the former
    `delegationLiveWindowSql`, which no longer exists anywhere in the tree;
  - still-enabled: `STILL_ENABLED_DELEGATION_STATUSES` in `@haven_ai/core`,
    imported by the CLI (`commands.ts:854`) and the frontend
    (`RemoveAgentDialog.tsx:4`) instead of hand-copied;
  - window-closed: the third question, added as `#4353` beside the other two.
  Task budgets got the same treatment: `liveTaskBudgetSql` /
  `isLiveTaskBudget` (`task-budgets.ts:141,152`) with the wire `is_live` flag
  (#3922), consumed by `routes/task-budgets.ts:94` and
  `routes/agent-task-budgets.ts:36`.
- **C1 (the agent-reported EIP-3009 settlement hash was attributed by shape)** —
  closed (#3925). `modules/x402/eip3009-settlement-evidence.ts:130-136` now
  carries the nonce attribution a merchant-settlement record must have: the
  EIP-3009 nonce the transaction burned and `nonceDerived`, whether it is the
  one derived from this payment's id.
- **C2 (the 2026-10-03 scan report never landed, and the ledger named a path
  that is not in the tree)** — closed. `docs/bug-reports/quality-scan-2026-10-03-whole-repo.md`
  is in the tree at this head and is one of the documents this audit
  re-verifies.
- **C3 (the "one hash per payment" compare-and-set was the only guard for a
  two-hashes-one-payment race, and nothing tested it)** — closed (#3927).
  `infra/repositories/__tests__/x402-authorizations.test.ts:402` is a real-DB
  suite titled *eip3009 merchant-settlement writer: one hash per payment
  (#3927)*, and `:478` pins the compare-and-set alone by direct SQL: the
  blocked UPDATE writes 0 rows.

All 34 covered paths in `covers:` still exist. The 50 covered commits since
2026-10-13 — the #4372 doc sweeps, the 0.11.0-alpha.0 release and the budget
end-date landings — changed the covered files but supersede nothing measured
here.
