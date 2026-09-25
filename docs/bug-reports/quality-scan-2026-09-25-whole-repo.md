---
owner: "@AntonioSaaranen"
status: current
covers:
  - .github/workflows/qa-dev.yml
  - .github/workflows/promotion-digest.yml
  - scripts/ci/qa-failure-issue.mjs
  - scripts/ci/guard-freshness.mjs
  - scripts/ci/change-classifier.mjs
  - scripts/ci/qa-freshness.mjs
  - scripts/frontend-copy-lint.mjs
  - packages/frontend/scripts/serve-docs.mjs
  - packages/frontend/src/lib/i18n/messages/en.ts
  - packages/backend/src/modules/passport/attestation.ts
  - packages/backend/src/modules/passport/issuance.ts
  - packages/backend/src/infra/repositories/agent-passports.ts
  - packages/backend/src/modules/passport/__tests__/passport-outbound-record.test.ts
  - packages/backend/src/routes/agent-delegations.ts
  - packages/backend/src/routes/agent-rekey.ts
  - packages/backend/src/rails/delegation-policy.ts
  - packages/backend/src/rails/delegation-rail.ts
  - packages/backend/src/routes/__tests__/agent-delegations.test.ts
  - packages/backend/src/infra/relayer-balance-monitor.ts
  - packages/backend/src/infra/delegate-balance-monitor.ts
  - packages/backend/src/infra/outbound-queue.ts
  - packages/qa-agent/src/scenarios/within-budget-settle.ts
  - packages/qa-agent/src/scenarios/delegation-lifecycle.ts
  - packages/qa-agent/src/lib/chain.ts
  - .agents/skills/quality-scan/references/dimensions.md
last-verified: "2026-09-25"
---

# Quality scan 2026-09-25 — whole repo, weighted to the least recently scanned surfaces and today's landings

Scope (owner request 2026-09-25, "kör en ordentlig quality-scan", no scope
named): the whole repository, weighted toward the surfaces the ledger shows
least recently scanned (`sdk`, `core`, `qa-agent`, the backend modules and
`infra/` workers outside the 09-22 data-layer and accounting sample) and
toward what landed on `dev` on 2026-09-25 (#3320/#3323 outbound nonce walk
and fallback re-send, #3327 passport UID, #3326/#3312 last-known balances,
#3316, and the captain's own #3311/#3314).

**Revision.** Every figure is at `origin/dev` @
`2cc233743ba1e51b7a81f47358b05a8a87e49fb9` unless it names another SHA.
`dev` moved during the scan; nothing below reads the moving ref.

**Method.** A captain and three read-only workers, each in a detached
worktree pinned to that SHA and accepted by `scripts/ci/review-isolation.mjs`:
W1 (today's landings), W2 (the least-scanned code), W3 (CI, docs, history —
wave blocks 2–6, incident clustering, workflow archaeology). Mutations used
`cp` backups with `cmp` + `git diff --quiet` restores; real-DB runs used
disposable local databases, each dropped afterwards. No live write was made;
the only chain calls were two read-only `eth_getTransactionCount` reads on
the public Base Sepolia endpoint.

**Double-check (owner instruction during the scan).** Every candidate below
was re-run by the captain in a separate pinned worktree before it was
written here — the worker's mutation re-applied (with the applied diff
printed), the probe re-written from scratch, or the command re-run. Where a
figure is the worker's alone it says so. Three worker figures were corrected
in that pass; each is marked *corrected*.

**Conflict of interest.** #3311 and #3314 were built by the captain. W1
mutated #3311 (caught) and read #3314 adversarially; neither yields a
candidate. That judgement is the workers', not the captain's.

**Excluded this run:** every prior ledger finding and candidate, whatever its
disposition, including the 2026-09-22 F1 (epic #3231, open), its C1–C5
(shipped), the 2026-09-15 mock families (`accepted-as-debt`) and the
2026-08-18 outbound-lifecycle finding (`shipped`; its re-surface bar — "the
queue lane failing" — is met today, but the incident is already tracked on
#2769 and is handled as context there, §3).

---

## 1. Structural finding

### S1 — qa-dev goes red on RPC-provider behaviour in waves, each triaged as a flake and fixed one provider quirk at a time

**Pattern.** The money-flow harness is the only gate that exercises what dev
actually shipped, and it keeps failing on the RPC provider's behaviour rather
than on a Haven defect. Each wave is triaged as transient (the #2769 tracker
text: "A transient testnet/RPC flake can be cleared by re-dispatching"; the
09-20 triage "No code change involved"), absorbed by an in-step retry
(`qa-dev.yml:242-265`, `QA_MAX_ATTEMPTS=2`), and closed by a fix for that
provider's quirk. Nothing records the failure class, so the next provider
behaviour starts from zero.

**Evidence (three waves).**
- Wave 1, 2026-09-02 → 09-06 — public-endpoint and rate-limit signatures in
  8 of 11 dated `qa-failure` issues: #2443, #2449, #2485, #2496, #2508,
  #2543, #2564, #2594 (W3). *Re-run by the captain:* `gh issue view <n>
  --json body` for those 8 with `test("429|rate.?limit|sepolia.base.org|timeout|Too Many|upstream|RPC";"i")`
  → 8 of 8 true. Fixed by #2511 → #2552/#2553.
- Wave 2, 2026-09-18 → 09-23 — Alchemy 429s ("FALLBACK, not a live enforcer
  read"): 3 money-flow failures plus attempt-1 failures absorbed by the
  retry (W3). Fixed by #3255/#3257 and the dRPC swap (#3262).
- Wave 3, 2026-09-24 → 09-25 — dRPC free-plan behaviour: batch/timeout
  (codes 31/30, 408) and the `pending` block tag refused with "No label
  `flashblocks`" (W3: 18 failures). Fixed by #3292, #3320 and #3323 on
  2026-09-25. Five read-as-zero issues in the same window (#3295, #3296,
  #3297, #3317, #3318); #3317's body calls itself "the same failure class the
  owner saw in the dRPC batch-limit incident, #2769".
- Instrument (W3): `money-flow` check-runs over the last 100 Railway dev
  deployments (2026-09-18T19:27Z → 09-25T19:25Z) → 592 runs: 472 skipped,
  90 success, 26 failure; of the 26, 21 carry a provider signature. Of the 90
  successes, 19 passed only on the in-step attempt 2 (log marker
  `passed on attempt 2/2`).
  *Partial re-run by the captain* (the 15 newest runs whose `money-flow` job
  concluded success, via the jobs API and each job's log) → 2 of 15 passed on
  attempt 2. A newer, narrower window than W3's; consistent in direction, not
  a re-derivation of 19 / 90.
- State at the pin (W3): money-flow red from 12:54Z, 12 consecutive failures
  through 19:06Z on `2cc23374`; after #3320/#3323 merged, all 7 completed
  runs failed.

**Demonstrated cost.**
- Promotion #3325 (0.5.0-alpha.1) merged 2026-09-25T17:04Z with
  `qa-override` (`gh pr view 3325 --json labels` → includes `qa-override`)
  and three relayer legs red — the second override in the last 100 merged
  `main` PRs (W3; the other is #1504, 2026-08-17).
- Three fix PRs in about eight hours on 2026-09-25; five `ci-health` issues in
  29 hours duplicating #2769's signal (C-extra-1 below).

**How contributors would work differently (bar 4 — the owner's call).** A
provider or plan change runs a conformance probe before the swap; an
RPC-signature failure is classified and counted, not closed as a flake; an
attempt-2 pass is recorded rather than hidden inside a green run. *Untested
hypothesis:* that such a probe would have caught the dRPC `pending` and batch
refusals before #3262's swap on dev.

**Slices (disjoint).**
(a) an RPC conformance probe under `scripts/ci/` — batch size, `pending`,
`eth_sendRawTransaction`, rate behaviour; (b) the provider-swap runbook step
that runs it; (c) `scripts/ci/qa-failure-issue.mjs` records the failure class
and counts attempt-2 passes; (d) the #2769 triage rule.

**Tracking.** Class-level searches (`rpc provider conformance`, `provider
capability rpc`, `transient rpc flake`) find no open issue for the class;
the related work is #2769 (open), #3262 (open), #3255, #3292, #3320, #3323.
Not a re-surface: the 2026-08-18 entry refused a merchant/QA-flakiness wave
and the 09-17 entry recorded a qa-dev cluster as closed — both a different
class.

---

## 2. Improvement candidates (one PR each) — pending the owner's word

### C1 — the promotion digest overwrites any open issue labelled `promotion`, and has overwritten #3262's operator procedure

- **Surface:** `.github/workflows/promotion-digest.yml:130-132` —
  `gh issue list --label promotion --state open --jq '.[0].number'`, then
  `gh issue edit "$num" --body "$body"`.
- **Evidence (re-run by the captain):** #3262 (the prod RPC swap,
  `operator-verify`) carries `promotion`.
  `gh api graphql … issue(number:3262){userContentEdits{totalCount}}` → 35
  edits, 33 by `github-actions`, the first 2026-09-24T09:04:02Z, the latest
  2026-09-25T19:21:19Z; its body now opens "**3 commit(s) on `dev` not yet in
  prod**". The operator procedure survives only in its author's 07:30 and
  07:34 revisions.
- **Mechanism:** the newest open `promotion` issue captures the upsert; any
  human who labels an issue `promotion` loses its body.
- **Cost:** the procedure is needed now — #3325 promoted #3257, which #3262
  waits on. The author was notified on #3262 during this scan.
- **Scope / benefit:** select the digest by title or a dedicated label, never
  by `promotion` alone; one PR.
- **Verification still needed:** a workflow test that a second
  `promotion`-labelled issue is left untouched.
- **Tracking:** no open issue (`promotion-digest label`).

### C2 — the #3327 passport UID repair: the sweep stalls on correct rows, its reader accepts a foreign attestation, and the mint path's attester guard has a test that cannot fail

Three defects in one surface (`modules/passport/attestation.ts`,
`modules/passport/issuance.ts`, `infra/repositories/agent-passports.ts`),
landed today in PR #3327. All three are the captain's re-runs.

- **(a) The sweep never reaches the rows it exists to repair.**
  `LIST_ANCHOR_REPAIRS_DUE_SQL` (`agent-passports.ts:291-297`) orders
  oldest-first with `LIMIT 10`; a row whose UID already matches returns
  without a write (`attestation.ts:384-385`), so its `updated_at` never moves
  and it stays at the head of every tick. Real-DB probe through the real
  `repairAnchoredUids` and `repairAnchorUidFromReceipt`, chain reads stubbed:
  10 older correct rows plus 1 newer phantom row →
  tick 1–3 each `{"attempted":10,"repaired":0,"unrepairable":10}`, 20 chain
  reads per tick, phantom still stored; control with `limit=11` →
  `{"attempted":11,"repaired":1,…}` and the row holds the real UID. The
  comments claim the opposite (`agent-passports.ts:286-288`,
  `issuance.ts:396-397`), and healthy rows are logged as `unrepairable`.
  At `PASSPORT_SWEEP_INTERVAL_MS = 5 * 60 * 1000` (`index.ts:475`) that is
  20 × 288 = 5,760 chain reads a day once ten correct rows are eligible.
  Not traced: whether any steady-state writer bumps `updated_at` on such a
  row, so "never" is shown for three ticks, not proven forever. Population
  not measured (the #3294 review counted 18 dev attestations).
- **(b) The repair's reader is not "the same proven-ours reader".**
  `repairAnchorUidFromReceipt` calls `recoverAnchorFromReceipt`
  (`attestation.ts:373`), which takes the first `Attested` log from the EAS
  address with no schema or attester check (`:415-455`), while the comment at
  `:349` says it re-derives from "the same proven-ours reader the mint path
  records from" (`readMinedAttestationUid`, which checks both, `:196-200`).
  Probe: one `Attested` log with a foreign schema and a foreign attester →
  `readMinedAttestationUid(…, { from: relayer })` → `null`;
  `repairAnchorUidFromReceipt` → `{"repaired":true,"uid":"0xf0…"}` and one
  write. Runtime likelihood is low (the transaction is the relayer's own
  `attest` call) — a hypothesis, not measured.
- **(c) The attester guard's test cannot fail.** Mutation
  `if (attester !== opts.from.toLowerCase()) continue` → `if (false && …)`:
  `passport-outbound-record.test.ts` 7 / 7 passed → 7 / 7 passed. Cause: the
  fixture writes the attester topic as 20 bytes (`:184`,
  `'0x' + '77'.repeat(20)`); `ethers` `parseLog` on it → `data out-of-bounds`,
  so the log is dropped by the decode `catch`, never by the guard; a 32-byte
  padded topic parses (attester `0x7777…`).
- **Scope:** order or advance the selector so a matching row leaves the head
  of the queue (e.g. stamp a checked-at column, or exclude verified rows);
  give the recovery reader the mint reader's schema and attester checks;
  fix the fixture to a padded topic. One PR. **Verification still needed:**
  a real-DB test of the selector (none executes it:
  `git grep -c "LIST_ANCHOR_REPAIRS_DUE_SQL\|listAnchorRepairsDue" -- packages/backend`
  → definitions, one mocked test, one caller), and each change mutation-proven.
- **Tracking:** no issue beyond #3294 (closed by #3327); #3327 has no review
  comment on ordering or the reader.

### C3 — three owner revoke submit routes record a revocation without checking the signed calldata revokes those delegations

- **Surface:** per-hash revoke `routes/agent-delegations.ts:919-962`,
  revoke-all `:765-810`, re-key revoke `routes/agent-rekey.ts:575-637`;
  `rails/delegation-policy.ts:270-277` (`buildRevocation`).
- **Evidence (re-run by the captain).**
  - Census, per file `grep -c 'submitCall('` / `grep -c 'does not match the requested'`:
    `agent-delegations.ts` 2 / 0, `agent-rekey.ts` 1 / 0,
    `rails/hybrid-signer-actions.ts` 1 / 1, `rails/hybrid-transfers.ts` 1 / 1
    (the two binding sites are the positive control; `rails/delegation-rail.ts`'s
    two hits are the interface and the implementation, not call sites).
    `submitCall` itself sends the handed userop and checks only inclusion
    success (`delegation-rail.ts:528-545`).
  - The rule's origin: `git log -S "does not match the requested signer change"`
    → `07161a2a1`, 2026-07-12, #906 ("so the stored signer set can never
    diverge from what was signed on-chain"). Per W2, the revoke-all (#1422,
    2026-08-14) and re-key (#1762, 2026-08-22) sites were written after it.
  - The per-hash route flips `agent_delegations.status` to `revoked` for
    `:hash` once the client-supplied `user_operation` succeeds (read at
    `:919-962`).
  - Tests pin the unbound shape: `vitest -t "successful submit marks the row
    revoked|submit marks exactly the batch revoked ONLY after the UserOp
    lands"` → 2 passed; the first submits `user_operation: { nonce: '1n' }`
    with no calldata.
  - Mutation `disableDelegation` → `enableDelegation` in `buildRevocation`:
    `delegation-policy`, `agent-delegations` and
    `modules/agents/__tests__/rekey-characterization` 120 / 120 passed →
    120 / 120 passed (applied diff printed, restore proven). Against a real
    DelegationManager that mutant would revert, so it fails closed; what it
    shows is that nothing pins the selector or the delegation encoded.
- **Mechanism:** the userop must be signed by the account owner and must
  succeed, so this is not a third-party revoke. It is database/chain
  divergence: a stale prepare or a second tab pairs one hash's userop with
  another hash, the row reads `revoked`, and the delegation stays enabled
  on-chain — for re-key, `markRevoked` advances the re-key while the old key
  keeps its on-chain authority. Nothing reconciles DB `revoked` → chain
  enabled (W2: the two `readDisabledDelegationHashes` callers heal only the
  other direction). *Hypothesis; no end-to-end run.*
- **Scope:** one shared submit helper requiring the expected
  `disableDelegation` calldata for every hash it records (#906's inclusion
  check), `HASH_RE` on the re-key list, the two unbound-shape tests replaced,
  the `buildRevocation` test decoding the selector. One PR, money-path.
- **Tracking:** no issue (W2's eight searches); adjacent context: #3284
  (delegate-key signing surface), #3028/#3031 (request schemas), #1423.

### C4 — two gating qa-dev scenarios claim an on-chain effect they never read from any node

- **Surface:** `packages/qa-agent/src/scenarios/within-budget-settle.ts`
  (invariant "A payment inside the budget settles on-chain and is logged as a
  receipt.", `:29`; `run.ts:42-45` calls it the suite's positive control) and
  `…/delegation-lifecycle.ts` (the revoke).
- **Evidence (re-run by the captain).** Direct chain reads in each file
  (`getTransactionReceipt|waitForReceipt(|balanceOf(|getCode(|readContract(|waitForTransactionReceipt|disabledDelegations`)
  → 0 and 0. The one imported helper, `readOnchainBudget`, reads the budget
  through Haven's own API (`api.getAllowances()`) before paying — the
  "backend agrees with itself" reading `lib/chain.ts:21-28` warns against.
  Positive control: `fetch('http://127.0.0.1:9')` → fails. With
  `QA_RPC_URL_BASE_SEPOLIA=http://127.0.0.1:9`, `vitest run
  delegation-lifecycle.test.ts within-budget-settle.test.ts -t passes` → 3
  passed.
- **Mechanism:** a backend defect that records `confirmed` or `revoked`
  without the chain effect still passes the harness that gates promotion.
  Class precedent: #2968, #3294, #1754. With C3, no layer observes a revoke
  on-chain inside the gate (W2: only `pilot/delegation-budget-spike.ts` does,
  outside `run.ts`).
- **Scope:** read the receipt of the settle's `tx_hash` (`status === 1`,
  ideally the USDC `Transfer`) and `disabledDelegations(hash)` after revoke on
  the observer node; tests for both fail paths. One PR, qa-agent only.
- **Tracking:** #1065 (closed, created the leg); nothing covers observing
  the revoke.

### C5 — both balance monitors drop an alert after one failed webhook delivery, and a 4xx/5xx is not even logged

- **Surface:** `infra/relayer-balance-monitor.ts:40-116`,
  `infra/delegate-balance-monitor.ts:265-292`.
- **Evidence (re-run by the captain).** Source: the "alerted" state is
  committed before the send (`lowAlerted.add(chainId)`; the delegate monitor
  assigns `moduleAlertState` before its loop), and `sendWebhookAlert` never
  checks `res.ok` (`git grep -c "function sendWebhookAlert"` → 1 in each
  file — two copies). Probe of the relayer monitor with the balance held low
  and the webhook answering 404 → run 1: 1 post; run 2: 0 posts; 0 "webhook
  failed" warnings; 2 "below low-water" warnings (the condition persisted).
  Tests: `git grep -lE "getRelayerBalanceStatus|runRelayerBalanceMonitor"`
  over test files → 0; the delegate monitor has 1 test file
  (`infra/__tests__/delegate-balance-monitor.test.ts`), with 0 lines
  mentioning `webhook` or `fetch`. *Corrected:* W2 reported 2 test files for
  the delegate monitor; the captain's grep finds 1.
- **Cost:** the relayer monitor exists because the relayer running dry
  "previously surfaced only as failing payments" (its header); #777's
  acceptance criteria say a failure is "swallowed (logged)" — a 404 is
  neither delivered nor logged.
- **Scope:** one shared sender checking `res.ok`, committing the alerted
  state only after delivery (or re-arming on failure); tests for 404,
  network error and re-arm on both monitors. One PR.
- **Tracking:** #777 (closed) only.

### Verified, held back by the five-candidate cap (the owner may swap any in)

- **C-extra-1 — guard-freshness files a new issue on every qa-dev flap and
  cannot see its own 4-day budget** (`scripts/ci/guard-freshness.mjs`:
  `--limit 50` at `:528`, `JOB_LOOKUP_BUDGET = 12` at `:495`, upsert reuses
  only `--state open` at `:607`). Re-run by the captain:
  `gh issue list --label ci-health --state all` → five issues in 29 hours
  (#3270, #3291, #3299, #3315, #3321); `gh run list --workflow qa-dev.yml
  --event deployment_status --limit 50` → a window of 15:45Z → 19:47Z on
  2026-09-25. W3 ran the module's own `selectQualifyingRuns`/`evaluate`
  against live data → `never-succeeded` despite a money-flow success at
  11:32Z (not re-run by the captain). `qa-failure-issue.mjs` (#2767) already
  reopens by title.
- **C-extra-2 — the change classifier routes the served docs nowhere.**
  Re-run: `classifyChangedFiles([f])` for the 4 sources in
  `serve-docs.mjs`'s `ALLOWLIST` → `{}` each; control `…/app/page.tsx` →
  `code,frontend`. Incident: #3287 edited
  `docs/security/delegation-rail-security-model.md`, merged with Frontend
  checks skipped, and broke `served-docs.test.ts` on dev (#3288, closed by
  a reword, #3290). The 09-22 C4 counted only non-Markdown files, so this is
  new, not a re-surface.
- **C-extra-3 — the copy lint does not scan the app's message catalog**
  (`packages/frontend/src/lib/i18n/messages/en.ts`, "the source of truth for
  the app's copy"). Re-run: clean tree `npm run lint:copy` → exit 0; with
  "Your spending policy." inserted into `en.ts` (applied diff printed) → exit
  0; the same phrase in `components/AccountSignersCard.tsx` → exit 1.
  *Corrected in the captain's pass:* the first attempt at this mutation used a
  GNU-only `sed` address that BSD `sed` accepted as a no-op; the exit 0 it
  produced was discarded and the mutation re-done with its diff shown.
- **C-extra-4 — three instruments in the scan reference misread**
  (`.agents/skills/quality-scan/references/dimensions.md`): block 3's regex
  cannot match its own founding specimens (W3); block 6 names
  `completenessWarningFromJobs` "the real observable", but the function's own
  comment says that under `QA_REQUIRE_ALL_LEGS=1` "this code path never sees
  them" (`qa-freshness.mjs:560-567`, read by the captain); and the ledger's
  "`qa-dev.yml` last 40 → 40 / 40" is run-level, where job-level reads 35
  skipped / 5 success (W3).

## 3. Context for tracked work (not new items)

- **#2769 — the nonce gap after #3320.** `submitRecorded` stamps a record
  `broadcast` before `broadcastSigned` (`outbound-queue.ts`, the stamp, then
  the broadcast), and none of its four inline callers (`attestation.ts:254`,
  `sweep.ts:161`, `hybrid-provisioning.ts:286`, `attestation.ts:718`) wraps
  the call in a `catch` that closes the record. Captain's probe with the real
  `submitRecorded` and injected deps (pending refused, primary broadcast
  refused, fallback 503): send 1 → `fallback 503`, record A stays
  `broadcast@5`; with the fallback up, send 2 walks to nonce 6 while the chain
  sits at 5. W1's further probe (not re-run by the captain): the bump worker
  then fee-bumps the walked lanes to their cap and raises INCIDENT alarms for
  lanes blocked by the hole, not by fees. The design documents the stall for
  a DROPPED transaction and names "a lane past its bump cap"
  (`outbound-queue.ts:285-297`); what it does not name is a post-stamp
  broadcast failure as a source of the hole. Public-node reads at
  2026-09-25T19:09Z and 19:10Z: `latest = pending = 3170` for the relayer,
  posted on #2769. Proposed as a comment on #2769 (Daniel's claim), not a
  new issue.
- **Class note.** C2(b), C3, C4 and #3294/#2968 share one shape — Haven
  records an on-chain effect without chain evidence of it. A census of the
  writes that assert on-chain state was not taken, so this is not proposed
  as a structural finding; it is the obvious next probe.

## 4. Re-checked and unchanged

- #3311 (captain's) — W1 mutation M5 (`parties.delegate_account` left
  un-checksummed) → 1 failed / 2 passed: caught.
- #3314 (captain's) — self-test 130 / 130; review-body blocks remain unread,
  documented (W1: design-review mentions in a review body 2 of 36
  baseline-touching PRs since 2026-09-01).
- The 09-22 shipped candidates C3 and C5, re-probed by W3 with restores:
  `lint:wire-types` with `src/types` hidden → exit 1; `lint:next-steps` with
  `mcp-server/src/tools.ts` hidden → exit 1; `branch-hygiene` → 6 resyncs in
  36 PRs for 2026-09-22 → 09-25.

## 5. Coverage record (block → examined / partial / not examined → command → result)

- **Sizing** → examined (W3) → the 09-22 command at `2cc23374`
  (control: the same command at `fd7b1289` → backend 77,152, identical to the
  ledger) → source / test lines: backend 80,798 / 101,079; frontend
  51,892 / 45,854; sdk 13,481 / 13,991; mcp-server 7,783 / 15,189; connect
  11,534 / 14,376; core 18,316 / 347 (17,579 generated `api-types.ts`);
  qa-agent 7,306 / 5,229; demo-merchant-mcp 3,741 / 4,042; signer
  3,833 / 6,991; cli 2,578 / 2,467; mcp 1,992 / 3,825.
- **Block 1 (guard falsifiability)** → examined, two samples, 10 mutations:
  - W1, today's money-path landings (reference census with
    `--since=2026-09-25T00:00:00Z` → 17 landings, 11 money-path, 49
    candidate files; 5 mutated): M1 #3327 attester guard **survived** (weak
    test, C2(c) — re-run by the captain, 7 / 7 → 7 / 7); M2 #3323 fallback
    hash check caught (1 failed / 20); M3 #3320 ledger `chain_id` caught
    (1 / 25); M4 #3316 client-compat caught (1 / 30); M5 #3311 caught
    (1 / 3). 44 candidate files not mutated.
  - W2, least-scanned code (5 mutated): M1 `buildRevocation`
    **survived** (weak test, C3 — re-run by the captain, 120 → 120); M2
    `x402-hosted-mcp-signer.ts:405` merchant-leg status check **survived**
    (weak test; the only revert test reverts both receipts, so the earlier
    check always returns first; a later check still catches a merchant
    revert at runtime — a note, not a candidate); M3 sdk
    `x402-funding-leg.ts:202` caught; M4 core `amount.ts` precision refusal
    caught; M5 backend `x402/settle.ts:79` caught.
- **Block 2 (`covers:` completeness)** → examined (W3) → the reference loop
  under `bash` with `set -f` and `grep -rl`, each miss confirmed with
  `coupling-gate.mjs --strict --changed=<path>` (positive control → 1) → 18
  across 6 of 8 contract docs (09-22: 17 across 5): CASP guardrails 6,
  dev-environment 4, x402 sequence 3, docs-quality system 2,
  package-dev-channel 2, delegation security model 1 (new, from #3282);
  runtime-compatibility and branch-and-release-flow 0.
  `npm run docs:covers-gaps` → 138 pairs / 36 docs (unchanged). Over-wide:
  the delegation security model declares 44 paths and cites 5.
- **Block 3 (stale numbers)** → partial (W3) → sample A, the 25 newest shards
  by dated name → 1 figure line by the block's regex, 0 with a command (the
  regex is C-extra-4); re-derived "83 commits" (`git rev-list --count
  fe717b58..20176679` → 83) and "77" → 77; "59 files", "651 excluded" and
  "4411 passed" not re-derived (need a build or Postgres). Sample B, the 09-22
  `Probed clean:` commands verbatim → `any` 24 (unchanged); db-mock gauge
  54 / 273 / 57 (unchanged); TODO/FIXME/HACK/XXX → 0 (control `import` →
  1,499 files; 09-22: 1,437).
- **Block 4 (retired vocabulary)** → examined (W3) → positive control 36
  shards; 192 files, 46 historical / 146 live (09-22: 191 / 46 / 145 — the +1
  is `DashboardClient.degraded.test.tsx`, #3312); code half unchanged;
  `lint:retired-rail-prose` green; `safe-account-rename-census.mjs 2cc23374`
  → 766 hits, all allowed (09-17: 752).
- **Block 5 (merge-method drift)** → examined (W3) → since
  2026-09-22T00:00:00Z → 0 merge-commit / 53 squash; since 2026-09-15 →
  0 / 172; since 2026-08-10 → 282 / 743 / 1,028 (the 282 unchanged, 4
  sync-backs). Promotion #3325 is a two-parent merge on `main`, the correct
  method.
- **Block 6 (nets with holes)** → examined (W3), all four halves: copy lint
  87 unscanned files (09-15: 75), 6 with hits, all comments or a regex
  literal, control → 1 — the hole is C-extra-3; money perimeter 31 verb
  files, 19 outside (09-21: 28 / 18; the one new outsider is an sdk
  `__fixtures__` file); visual gate 9 of 26 routes by the literal instrument,
  12 of 26 resolving concrete-id visits; docs boundary pinned with
  `ls-tree` → 39 (unchanged); `qa-freshness.mjs` exit branches — Gap 1
  (`:521`), the #2164 version-only partition (`:930-944`), `qa-override`
  (`dev-gate.yml:73-92`, used on #3325), KNOWN LIMIT (`:131`),
  `hotfix_no_money_path` (`:466-471`), and the completeness warning (`:568`),
  dead under `QA_REQUIRE_ALL_LEGS=1` (C-extra-4).
- **Incident clustering** → examined (W3) → `gh issue list --search
  'created:>=2026-09-22T00:00:00Z'` → 52 (37 closed / 15 open), hand-classed:
  09-22 scan filings 9, signing-surface epic 6, failed read shown as zero 5,
  client-compat epic 5, ci-health flap 5, RPC/relayer 5, Safe residue 4,
  other 13. The untracked recurring class is S1.
- **Workflow archaeology** → examined (W3) → `ci.yml` last 200 (09-20 →
  09-25): 5 with attempt > 1 (4 parked bot-push runs), 14 failures, 0 on
  `dev`; qa-dev: see S1 — run-level conclusions count gate-skipped runs as
  success, so job-level `money-flow` is the reading.
- **Least-scanned code** → examined within W2's sample: test architecture
  (qa-agent fakes `fetch`/`HavenApi`; 2 of 14 gating scenarios without a
  test file), validation (the owner-userop submit sites, C3), duplication
  (address regex 2 identical copies; 3 USDC tables in sync; bigint reviver 5
  copies at C3's sites), fat controllers (largest handler span ≤ 258 lines),
  `any` 22 non-test lines tree-wide by W2's regex, 5 in the sample.
- **Infra workers** → partial: both balance monitors (C5); the bump worker,
  relayer and outbound queue as today's landings (§3); `relayer-spend-guard`
  not read.
- **Live exercise** → not taken beyond two read-only nonce reads.

## 6. Instrument lessons from this run

- A fresh worktree needs `npm run build -w packages/core` and
  `-w packages/sdk` before backend suites: without the sdk dist 4 of 5 files
  failed at import while Vitest's `Tests` line still read "25 passed" — read
  the `Test Files` line.
- `gh run list` for qa-dev counts gate-skipped runs as success: the 60 newest
  "successful" runs held 0 harness logs. Use the `money-flow` job's
  conclusion, and grep its log for `passed on attempt`.
- BSD `sed` accepts the GNU `0,/re/` address as a silent no-op; print the
  applied diff before trusting any mutation result.
- `ethers`' `JsonRpcProvider` bypasses a stubbed global `fetch`: "green with
  fetch faked" does not prove no chain read; a dead observer port with a
  positive control does.
- `fetch` resolves on 4xx/5xx, so a catch-and-log best-effort block never
  sees a rejected webhook (C5).
- `\b` in `git grep -E` false-zeroed again; `rg` exists only as a harness
  shell function; `timeout` is absent on macOS; `branch-hygiene --since`
  rejects an ISO instant; `coupling-gate.mjs` without `--out` writes
  `coupling-comment.md` into the working directory; a zsh unquoted pathspec
  variable is not word-split; `createdb` as `haven` is refused (create as
  the OS superuser with `-O haven`).

## 7. Decisions requested

1. S1 — file as an epic with slices (a)–(d), or record `accepted-as-debt`?
2. C1–C5 — file each as a standalone task? C1 is live harm today.
3. C-extra-1 … C-extra-4 — swap any into the five, file separately, or leave
   recorded here?
4. §3 — post the nonce-gap analysis as a comment on #2769?
