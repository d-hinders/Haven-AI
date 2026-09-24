---
owner: "@d-hinders"
status: current
contract: true
covers:
  - packages/backend/src/middleware/owner-cli.ts
  - packages/signer/src/delegate-account.ts
  - packages/signer/src/tools.ts
  - packages/signer/src/redemption-guard.ts
  - packages/signer/src/core.ts
  - packages/backend/src/middleware/auth.ts
  - packages/backend/src/routes/auth.ts
  - packages/backend/src/infra/repositories/device-authorizations.ts
  - packages/backend/src/db/migrations/078_device_authorizations.ts
  - packages/backend/src/routes/agent-delegations.ts
  - packages/backend/src/routes/agent-rekey.ts
  - packages/backend/src/routes/agents.ts
  - packages/backend/src/infra/repositories/agent-organizations.ts
  - packages/backend/src/db/migrations/094_agent_organizations.ts
  - packages/backend/src/routes/user-accounts.ts
  - packages/backend/src/routes/transactions.ts
  - packages/backend/src/middleware/retired-safe-names.ts
  - packages/backend/src/modules/agents/rekey-*.ts
  - packages/backend/src/routes/hybrid-accounts.ts
  - packages/backend/src/infra/repositories/agents.ts
  - packages/backend/src/infra/repositories/dashboard.ts
  - packages/backend/src/infra/repositories/transaction-history.ts
  - packages/backend/src/infra/repositories/smart-accounts.ts
  - packages/backend/src/rails/hybrid-signer-actions.ts
  - packages/backend/src/rails/hybrid-transfers.ts
  - packages/backend/src/infra/repositories/hybrid-signers.ts
  - packages/backend/src/rails/hybrid-account-config.ts
  - packages/backend/src/modules/accounts/mainnet-gate.ts
  - packages/frontend/src/components/AccountSignersCard.tsx
  - packages/frontend/src/hooks/useDelegationBudget.ts
  - packages/frontend/src/hooks/useAgentRekey.ts
  - packages/frontend/src/hooks/useAccountSigners.ts
  - packages/frontend/src/hooks/useDelegationSend.ts
  - packages/frontend/src/lib/hybridAccountOps.ts
  - packages/frontend/src/lib/delegationPasskeySigner.ts
  - packages/frontend/src/lib/signer.ts
  - packages/frontend/src/hooks/useAccountOperationGate.ts
  - packages/frontend/src/components/DelegationSendModal.tsx
  - packages/qa-agent/src/pilot/delegation-budget-spike.ts
last-verified: "2026-09-22"
---

# Delegation rail — security model & exit story (epic #821, gate G4)

Design doc for issue #824. The delegation stack (Hybrid DeleGator accounts +
MetaMask Delegation Framework) changes Haven's security model in three ways
the Safe/session stack did not have; this doc names them, maps every existing
non-custody invariant to its delegation-rail equivalent, fixes the custody
semantics of the delegation object itself, and specifies the independent exit
story with an acceptance test. (Since #834 the Smart Sessions **session rail
is retired** — `session_key` accounts get HTTP 410 from the payment paths —
so the "Safe/session stack" comparisons below are the mapping's historical
baseline. **The legacy AllowanceModule path is now retired too (#1440), so the
delegation rail is the only live rail** — nothing can enter it, nothing on it
can spend, and its execution machinery is deleted; the closure sequence is in
the [decision log](../archive/decision-log.md#2026-08-14--retire-the-safe-rail-entirely-1440). Existing
Safe rows are untouched and still readable to a direct database query, though
no account, agent or dashboard surface displays them (the transactions
surface is not among the filtered queries: `LIST_BASIC_SAFES_FOR_USER_SQL` and
`LIST_AGENTS_FOR_TRANSACTION_FILTERS_SQL` have no rail predicate, so it still spans
every account and agent row);
since #2847 the relayed owner-signed execution route is deleted with the last
live Safe-rail behaviour, and since #2848 the frontend Safe signing helpers
(`lib/safe-tx.ts`) are gone too, so nothing on the legacy rail answers with
live behaviour at all. Neither was ever a policy rail. Read every
"vs the Safe/session stack" comparison below as a comparison against a
**retired** baseline, not a live alternative.) The implementation issues are #831 (CI
invariants) and #832 (exit tool); this doc is their contract.

Contracts in scope (Base Sepolia; mainnet addresses pinned at #825): 
DelegationManager `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3`, the Hybrid
DeleGator implementation behind `toMetaMaskSmartAccount`, and the caveat
enforcers referenced below — all Consensys Diligence-audited (Aug 2024 / Apr
2025), deployed immutable, and forkable. Spike evidence:
[`delegation-budget-rail-spike.md`](../research/delegation-budget-rail-spike.md).

## 1. What changes vs the Safe/session stack

1. **UUPS upgradeability.** A Hybrid DeleGator is a UUPS proxy whose upgrade
   authority is the account's **own signers** — not Haven, not MetaMask. This
   is a new surface (the Safe proxy pattern had owner-controlled masterCopy
   semantics, but our stack never exercised it). Consequence: "who can
   upgrade" becomes part of the custody perimeter and must be provable.
2. **Authority is a held object, not account state.** A Smart Sessions grant
   lives in account storage; a delegation is a **signed message the agent
   holds**. Different theft model: exfiltrating a delegation (plus the
   delegate key) is sufficient to spend — but only within the caveat stack.
3. **The exit story loses Safe{Wallet}.** Haven's CASP/GTM line — "inspect
   and revoke everything without us" — was demonstrable via a mature
   third-party UI. On this stack it must be **rebuilt and demonstrated**
   (§4) before any external user touches the rail.

## 2. Invariant mapping (implemented — `non-custody.invariants.test.ts`, #831)

Every invariant in `non-custody.invariants.test.ts` maps as follows. "CI"
means a named check in the delegation-rail invariant suite; nothing is
dropped.

| # | Session/legacy invariant (baseline; session rail retired, #834) | Delegation-rail equivalent | Enforcement |
|---|---|---|---|
| 1 | No private-key/seed columns in the schema | Unchanged, plus: **no delegation-signing key columns** | CI (schema scan) |
| 2 | Agent secrets stored hashed | Unchanged | CI (existing) |
| 3 | Exactly one server-side signer: the gas-only relayer | **Zero** value-bearing server signers on this rail (no relayer leg exists); the sponsorship credential is the only vendor secret | CI (signer-construction scan scoped to the delegation rail) |
| 4 | No server-side key generation | Unchanged — delegate keys and account owners are client-generated | CI (existing, extended to delegation modules) |
| 5 | Session-rail owner is watch-only (refuses to sign) | Account interactions use a **watch-only owner**; Haven never holds a DeleGator signer | CI (watch-only pattern scan) |
| 6 | No viem key-based signers server-side | Unchanged, extended to `smart-accounts-kit` call sites | CI |
| 7 | UserOps submitted with caller-provided signature only | Redemptions submitted with **client-signed** UserOp/tx only; the backend constructs and relays, never signs | CI (the #737 pattern, delegation flavor) |
| 8 | Session-config modules signer-free | Delegation lifecycle modules (grant/replace/revoke construction, #827/#828) are **signer-free and relayer-free**: they build payloads and typed data, never sign | CI (module import/AST scan) |
| 9 | Bundler credential read in exactly one place | Unchanged (one choke point; `redactVendorSecrets` on every error surface) | CI (existing) |
| 9a | *(new, #1061)* **Redaction covers the shapes vendors actually use** | `redactVendorSecrets` catches `apikey=`/`api_key=`/`api-key=`/`key=`/`token=`/`secret=` query params, URL basic-auth (`https://user:pass@host`), and key-in-path segments (`/rpc/<token>`, `/v2/<token>`) — not just the one `apikey=` spelling | Unit tests on the redactor |
| 10 | Paymaster has no value-transfer surface | Unchanged — sponsorship pays gas only; proven in the spike (agent key held zero ETH and zero USDC) | CI + spike evidence |
| 11 | *(new)* **No upgrade path from Haven code** | Haven's codebase contains no call site that can reach the account's UUPS upgrade function; upgrade authority = account signers only | CI (ABI/selector scan for `upgradeToAndCall` against DeleGator targets) |
| 12 | *(new)* **Delegations are client-signed only** | No Haven code path calls `signDelegation`/EIP-712 delegation signing with a server-held key (pilot scripts with throwaway testnet keys excepted, path-scoped) | CI (import + call-site scan) |
| 13 | *(new, #888)* **Signer changes are client-signed only** | Enrolling/removing a backup signer (`addKey`/`removeKey`/`transferOwnership`) is PREPARED by Haven and signed by an EXISTING account signer; the submit step pins the DB sync to the signed calldata. Haven holds no key that can change an account's signer set. Since #1081 this is one shared implementation reached by both the agent-scoped and account-scoped routes | CI (shared-core + both-routes + config-loader scan) |

**Monitored-not-enforced:** enforcer/manager *contract immutability* is a
property of the deployed bytecode, not our code — covered by pinning exact
addresses with audit provenance (#825) and the #826 tripwires (framework repo
activity, alternative 7710 implementations), not by CI.

**Passport attestations (#970) — a new relayer use, still not value-bearing:**
the L0 agent-passport anchor (`modules/passport/attestation.ts`) is the one place
the relayer signs something other than gas on a user-authorised transaction —
it submits EAS `attest`/`revoke` calls with Haven as issuer. That is governance
metadata, not spend authority: the transaction targets the pinned EAS contract
only, carries zero value, encodes no transfer, and involves no user key,
delegation, or allowance (a test pins the target and the zero value). It does
not add a value-bearing server signer, so invariant 3 stands. See
[11-agent-passport-schema](../architecture/11-agent-passport-schema.md).

**Read-only reporting columns (#2871) — no invariant moves:** the covered
repository `infra/repositories/transaction-history.ts` now also projects
`machine_payment_evidence.fx_rate_sek` and `.fx_source` alongside the
`amount_sek` it already read, so the transaction CSV export can state the
book-time rate it used instead of an unexplained SEK figure. Both columns ride
the existing `LEFT JOIN`, inside the same `pi.user_id = $N` +
`us.id = ANY($N)` tenant scoping, and nothing writes: no signer, no authority
and no spend path is implicated, and invariants 1–13 above are untouched. This
statement is about the repository projection, which is what this document's
front-matter coupling reaches; the export route that consumes it is reviewed
under #2871 and is not a contract surface here.

**Relayer gas budgets (#717) — an availability control on the same signer:**
every relayer-paid operation (deploys and sweeps; Safe execs and allowance
transfers too, until #1440 deleted them) runs a per-identity window budget before the relayer signs (over-cap → 429,
the intent/sweep left retryable, never burned) and records its submitted txs
with receipt gas numbers (`relayer_gas_events`) for attribution. Direction of
failure is the OPPOSITE of the money-path gates and deliberate: a database
error fails **open**, because this guard protects the shared gas sponsor's
availability while funds stay caveat-gated on-chain regardless — failing
closed would let a DB hiccup take down the very operations it exists to keep
up.

## 3. Delegation custody semantics (#828's contract)

> **Re-verified #2929 (dark-mode epic #2925, slice 3/3):** the dark-token sweep
> touched two files in this document's coverage list, `DelegationSendModal.tsx`
> and `WalletButton.tsx`. Both edits are presentation-only, verified against the
> diff at the base of this branch: the token-symbol input's and the modal
> container's literal `bg-white` became `bg-[var(--v2-bg)]`, the avatar rim's
> `border-white/70` moved to the fixed-paint `.v2-avatar-chrome` utility, and the
> QR container's white box became the never-invert `.v2-light-surface`. No class
> that carries a value a custody or authority statement rests on (the badge
> tones, the `disabled` states) changed. No handler, fetch, signer call, key
> read, caveat value, or user-visible claim about who signs, what may be spent,
> or when revocation bites changed. A CSS token rename in a delegation-surface
> file is not a semantics change: this paragraph is that re-verification record.

**Where the signed delegation lives:** the agent receives it through the
existing credential channel (same trust envelope as the agent API key).
Haven stores a copy server-side for reconstruction, revocation targeting and
observability. It is **not** key material — but it is spend-enabling in
combination with the delegate key, so it is stored with the same care as
`api_key_hash`-class data: encrypted at rest, never logged, never in error
surfaces.

**Leak analysis:**

| Compromised | Attacker gets | Bounded by |
|---|---|---|
| Delegation object alone | Nothing — redemption requires the delegate key's signature | — |
| Delegate key alone | Nothing beyond existing agent-credential risk — no delegation, no authority | — |
| Both (agent fully compromised) | Spend **within the caveat stack**: ≤ period budget per period, only to pinned recipients, until expiry or revocation | `MultiTokenPeriodEnforcer` + `allowedCalldata` + `Timestamp`; owner kill-switch `disableDelegation` |
| Haven fully compromised | Constructs malicious payloads but **cannot sign** grants, redemptions, or upgrades (invariants 3/5/7/11/12); worst case = denial of service | The perimeter this doc exists to prove |

Blast radius on full agent compromise is therefore **identical in kind** to
the retired session rail's (one period's budget per recipient) — with
revocation one `disableDelegation` away.

**Batch revocation (#1400):** `POST /agents/:id/delegations/revoke-all`
prepares ONE UserOp batching a `disableDelegation` call per pending/active
delegation (`prepareCalls`, `ExecutionMode.BatchDefault` — atomic: all
disable or none do). The owner signs that UserOp exactly as a single revoke;
Haven still cannot sign it (invariant 3 unchanged). Fail-closed ordering: the
DB rows flip to `revoked` only AFTER the UserOp lands, so a crash window can
leave on-chain-disabled rows still marked active (a directionally safe
surplus — a later redemption attempt reverts on-chain), never the reverse.
Because `disableDelegation` is NOT idempotent (`AlreadyDisabled` revert) and
the batch is atomic, the prepare step reconciles that window (#1423): it reads
`disabledDelegations(hash)` for every candidate, heals already-disabled rows
to `revoked`, and drops them from the batch — a failed read degrades to the
full batch rather than blocking revocation. A heal marks a row revoked
WITHOUT an owner signature, so a false positive would defeat the kill switch
— therefore reads are pinned to `finalized` (no reorg transients), a hash
counts as disabled only when TWO consecutive reads agree, and every heal is
logged distinctly from an owner-signed revoke. The heal reads the dedicated
endpoint (`RPC_URL_BASE*`) ONLY, never the failover nodes the rail's other
reads use (#3255): lag cannot cause a false heal (the flag only goes
false→true and nothing here calls `enableDelegation`), but a lying node can,
so the set of nodes trusted with it is kept to one. A persistently lying
dedicated endpoint remains outside this control's threat model. The same
heal-or-prepare check guards the per-hash revoke route (409 "Already
revoked … reconciled" instead of an eternal 502). Batches are capped at 25
calls (422 pointing at per-hash revocation beyond it), with a coarse
pre-read ceiling of 100 so an over-cap agent cannot burn unbounded RPC reads
either. An empty batch is a 409
(`Nothing to revoke`), which callers treat as already-done. The
per-delegation revoke and the kill-switch story above are unchanged.

**One slot, one pending offer (#2613).** A `(agent, token, recipient|open)`
slot holds at most one still-pending build at a time. This is a property about
what the owner is asked to *sign*, which is why it belongs here rather than in
an operations note: two pending grants for one slot are two different unsigned
authorities over the same budget, and nothing in the UI or the CLI says which
one the owner meant. It is not a custody or authority defect — Haven still
cannot sign either of them, and neither carries more spend than the caveat
stack allows — but "the owner approves exactly the authority they asked for"
is weakened by being handed a choice nobody designed.

The build path used to read for a reusable pending row, read the next version
and insert as three unsynchronized statements. Two concurrent identical builds
could each miss the read before either committed and each insert, because the
delegation's `startDate` anchor is `nowSec - 60`: a request pair straddling a
second boundary produces two different `delegation_hash` values, so the unique
index never collided. The three statements now run in one transaction holding
`pg_advisory_xact_lock` on the slot, so the second caller's read happens after
the first commits and returns that row instead of building a competitor to it.
The chain round trip that derives the delegate account address is taken
*before* the lock — a slot held across an RPC turns a slow node into a stalled
slot, which would trade a duplicate-offer defect for an availability one.

**Archiving cannot hide a live delegation agent (#1436).** "Removed" is a
promise about spending, so the database enforces the delegation path:
`ARCHIVE_AGENT_SQL` requires `status='revoked'` **and** `NOT EXISTS` any
`pending`/`active` row in `agent_delegations`, in one statement. Revoking flips
only the agent's status — it never touches delegations — so revoke+archive
through the API (bypassing the dashboard's revoke-all-first ordering) cannot
file a delegation agent under Removed while its budget stays redeemable
on-chain. The refusal names the remedy that applies (`revoke-all` for live
budgets, "revoke first" for a live credential) rather than one generic 409.
Legacy AllowanceModule records are different: Haven may unlink the readable
record at any status because archiving changes no old Safe permission. Owners
manage that remaining permission outside Haven where they have access. This is
record archival/unlinking, not an on-chain Safe permission change. **Since
#2413 the dashboard does not render those records at all** — the account and
agent list queries filter to `account_type = 'delegator_hybrid'` — so the
unlink path above is reached only for a live delegation account. The legacy
rows are untouched and still readable to a direct query; what changed is that
no account, agent or dashboard surface displays them, and no on-chain Safe permission is affected
either way. Conversely,
the unlink route refuses with `409` while a delegation agent has a pending or
active delegation, or while a recovery sweep is prepared/submitting, so an
in-flight live operation cannot lose its Safe binding. The guard only ever
REFUSES or files a record — it grants nothing, signs nothing, and touches no
chain.

> **Re-verified #2946 (analytics overview, slice B of #2944):** this diff
> touched one file in this document's coverage list,
> `middleware/owner-cli.ts`, by adding one entry to the allow-list —
> `GET /analytics/overview`, a read-only, owner-scoped aggregate over booked
> payment, refusal, fee, gas-count and snapshot rows (`DELEGATION_RAIL_ONLY`
> on every join; every statement a `SELECT`). The entry is a literal spec path
> (naming-epic decision), it sits behind `authMiddleware`, and
> `owner-cli-route-census.test.ts` discovered the route and measured
> `routeAllowsOwnerCli` at the door without a hand-edited count — exactly
> the §9 discipline. Nothing an owner-CLI token can now reach signs, moves
> funds or changes authority. §9 otherwise unchanged; nothing else re-read.

> **Re-verified #2945 (payment-refusals ledger, dep-boundary rework):** this
> diff touched one file in this document's coverage list,
> `infra/repositories/smart-accounts.ts`, by pure addition: the refusal
> ledger's owner-scoped account resolution moved verbatim out of
> `modules/payments/refusal-ledger.ts` into this repository as
> `FIND_OWNED_ACCOUNT_ID_BY_ADDRESS_AND_CHAIN_SQL` +
> `findOwnedAccountIdByAddressAndChain` (`SELECT id FROM smart_accounts WHERE
> user_id = $1 AND account_address = $2 AND chain_id = $3 LIMIT 1`,
> executor-last with the pool as default, `rows[0]?.id ?? null`). The new
> function is a read: it grants nothing, signs nothing, and touches no chain
> state; it feeds the fire-and-forget refusal records on the payment path,
> where unknown addresses and lookup failures resolve NULL (the
> swallow-to-NULL catch stays in the ledger's `resolveAccountId`). Every
> predicate, tenant scope, authority check and signing path this document
> describes is unchanged; the §6 owner-scoped `(address, chain)` lookup
> prose, the unlink transaction and the §8 settlement writes are untouched.
>
> **Re-verified #2911 (naming epic #2906, phase 3 — the schema rename):** this
> diff touched twelve files in this document's coverage list (`routes/auth.ts`,
> `routes/agents.ts`, `routes/user-safes.ts`, `routes/hybrid-accounts.ts`,
> `infra/repositories/{agents,dashboard,transaction-history,smart-accounts,
> hybrid-signers}.ts`, `rails/hybrid-account-config.ts`,
> `modules/accounts/mainnet-gate.ts`) by SQL identifier only: `user_safes` →
> `smart_accounts`, `safe_address` → `account_address`, `safe_id` →
> `account_id`, `user_safe_id` → `account_id`, `safe_tx_hash` →
> `account_tx_hash`, plus the row reads that follow. Every predicate, tenant
> scope (`WHERE user_id = $1`), authority check, signer-set rule and signing
> path in this document is unchanged; the four sentences above that named the
> old table or columns now name the new ones with the old in parentheses. The
> wire keys this document quotes (`safe_address`, `safe_id` on responses) are
> still emitted — the #2907 alias mappers are untouched and fed by local shims.
>
> **Superseded by #2914 (2026-09-17), appended rather than rewritten:** that
> last sentence was true when it was written and is not now. The contraction
> deleted `openapi/wire-aliases.ts` and the local shims with it, so the
> responses this document quotes carry `account_address` / `account_id` and
> nothing else. Read the paragraph above as the record of what #2911 did; read
> this one for what the wire does today.
>
> **Extended by the #2914 follow-up (2026-09-17), same day.** #2914 left three
> retired RESPONSE names standing: `safes` on `GET /user/accounts`, `safeName`
> on the `GET /transactions` feed, and `safes` on `GET /transactions/filters`.
> All three are gone now — the first two were deliberate one-release twins for
> the published CLI, the third was simply missed and found in review. So "carry
> `account_address` / `account_id` and nothing else" is true of the ENVELOPE
> keys too, not just the row fields. Nothing in this document's security
> argument moves: an envelope key is not an authority boundary, the queries are
> still `WHERE user_id = $1`, and the retired REQUEST names are still refused
> with a 400 rather than ignored — which is the part that matters here, since
> an ignored `safeId` filter would widen a query the ownership scope is
> supposed to narrow. This document's coverage list gains
> `routes/transactions.ts` and `middleware/retired-safe-names.ts` in the same
> change, because those two files are what make the claims above true and
> neither was declared.
>
> **Scope of this re-read** (so the `last-verified` date is not carrying an
> unstated claim; it is NOT bumped — it already reads 2026-09-17 from an
> earlier change today): the envelope keys on `GET /user/accounts`,
> `GET /transactions` and `GET /transactions/filters`; that every query behind
> them is still scoped to the caller's `user_id`; and that the retired request
> names are still refused with a 400. Nothing else in this document was
> re-read. On the scoping: the two list queries bind it as `$1`, while the
> x402 legs behind `GET /transactions` bind it as `$2` alongside an account-id
> `ANY(...)` — the same ownership property, written differently. An earlier
> draft of this note said `WHERE user_id = $1` flatly; review measured it.

> **Re-verified #3166 (edit budget limits in place):** this diff touched one
> file in this document's coverage list, `hooks/useDelegationBudget.ts` — it
> gains `editBudget`, a frontend composition of the EXISTING lifecycle routes
> (build → owner signs → activate → per-hash revoke prepare → owner signs →
> submit) so the dashboard can change one active budget's limits without
> regenerating the delegate key. Nothing this document describes moves: the
> delegate key and local signer are untouched by construction (the only two
> ceremonies are OWNER signatures made client-side — the delegation itself and
> the revoke UserOp — and no rotate/rekey endpoint is on the flow's wire
> order, pinned by the hook test). Ordering is activate-then-revoke: Haven
> cannot revoke by itself (the revoke UserOp needs an owner signature), and
> revoking first would leave the agent with no budget if the new grant were
> abandoned. While the flow runs the old budget keeps working; between the two
> signatures both delegations exist on-chain (combined exposure = their sum,
> each bounded by its own caveat enforcers) — the window is stated in the UI
> copy and closed by the second signature. Refusals surface verbatim: the
> in-flight re-key guard (§3) refuses the BUILD step, and a revoke-all that
> raced the edit either 409s the activation (old state untouched) or is
> reported as success-shape when the per-hash revoke finds the old row already
> reconciled. Abandoned at any point, the old budget stays live and untouched.
> Scope of this note: that one hook. Nothing else in this document was
> re-verified.
>
> **Re-verified #3093 (frontend hooks: array wire keys default to `[]`):** this
> diff touched one file in this document's coverage list,
> `hooks/useDelegationBudget.ts`, by one expression: `setBudgets(res.delegations)`
> became `setBudgets(res.delegations ?? [])`, so a `GET /agents/{id}/delegations`
> answer without the key renders an empty budget card instead of sending the
> route into the ErrorBoundary. Nothing this document describes moves —
> `pickSigningPath`, the passkey/EOA dispatch, the grant/revoke ceremonies and
> the signer-set read (`/account-signers`) are untouched; a missing key was
> never a security state, only a crash. Scope of this note: that one
> expression. Nothing else in this document was re-verified.

> **Re-verified #3127 (converted amounts on the transaction feed):** this diff
> touched four files in this document's coverage list — `routes/transactions.ts`,
> `infra/repositories/transaction-history.ts`, `routes/auth.ts` and
> `infra/repositories/dashboard.ts` — and none of them moves an authority or
> custody boundary. The transactions change is additive projection only: every
> route keeps its auth hook and its `user_id`-scoped queries (the two
> machine-payment SQL statements gained `mpe.fx_rates` in their SELECT list —
> one more column from the same row, same WHERE, same bind shape); the new
> per-request read is the same scoped preference read the preferences route
> already served, keyed by the JWT subject; `routes/auth.ts`'s change is the
> signup INSERT gaining a `currency_preference` value (the user's own row,
> from a constant — nothing about session issuance, device flow or credential
> verification moves); and `dashboard.ts` gained one WRITE beside its reads —
> the portfolio-snapshot INSERT carries the snapshot's `total_sek` as one more
> bind on the same row, same user scope, no authority surface. No file here
> that signs, delegates, relays or gates is touched. Scope of this note: those
> four files and the two SQL statements' SELECT lists. Nothing else in this
> document was re-verified.

> **Re-verified #2912 (naming epic #2906, phase 3b — the `account_type` data
> migration):** this diff touched one file in this document's coverage list,
> `infra/repositories/smart-accounts.ts`, and only its comment: the retired
> `account_type` value is renamed `'safe'` → `'legacy_safe'` by
> `085_account_type_legacy_safe.ts`, and the CHECK is tightened to
> `('legacy_safe','delegator_hybrid')` — no `DELETE`, no row removed, inert
> history kept representable under its new name (epic #1440's decision,
> restated on #2912's issue). `DELEGATION_RAIL_ONLY`'s equality test
> (`= 'delegator_hybrid'`) is unaffected — it was never keyed on the retired
> value's spelling — and the migration's own test asserts the real repository
> query (`listAccountsWithTypeForUser`) still matches only the live-rail rows
> after the rename. Every predicate, tenant scope, authority check and
> signing path in this document is unchanged.

> **Re-verified #2851 (safe-retirement epic #1440, final slice):** the unlink
> transaction in `infra/repositories/smart-accounts.ts` no longer nulls out
> `self_sign_agents.safe_id` before deleting the account row — that step
> existed only to satisfy `self_sign_agents`' own `NO ACTION` foreign key, and
> the table itself is dropped by migration `083`. Nothing above depends on it:
> the guards this section describes (live-delegation, open-sweep, in-flight
> re-key refusal) are unaffected, no permission or chain state changes, and
> the same migration's `account_type` default flip (`'safe'` →
> `'delegator_hybrid'`) changes what an *omitting insert* gets, never the
> `account_type = 'delegator_hybrid'` filter value the list queries above
> compare against.

> **Re-verified #3227 (repository tenant scope):** this diff touched
> `infra/repositories/smart-accounts.ts`, a file this document covers. The
> unlink transaction's orphan and delete, and the re-default's set, used to
> match rows by id alone and relied on the route's ownership check. Now each
> is also scoped to the caller in SQL (`AND user_id = $2`). A cross-tenant
> call matches no row: the unlink returns `false` and promotes nothing, and
> the re-default leaves every row, and the legacy mirror, unchanged. The
> guards this section describes run first and are untouched: live
> delegation, open sweep, in-flight re-key. No permission, signer set or
> chain state changes. Scope of this note: the unlink and re-default writes.
> Nothing else in this document was re-verified.

The unlink guard also refuses while an agent re-key is in flight, so the Safe
binding cannot disappear between re-key stages. This is a database
serialization guard only: it grants nothing, signs nothing, and touches no
chain.

**Credential revocation closes new grant lifecycle steps (#2025).** An agent
already revoked at request entry cannot build or activate a fresh delegation:
both routes refuse before constructing a budget, parsing an owner signature,
deploying an account, or changing delegation state. The build and activation
database transactions re-check the lifecycle row before their writes, so a
revoke that races the initial read cannot create a new pending or active record
(it may still do preliminary activation work before the later lock). Of the ten
owner-scoped lifecycle callers, only build and activate are guarded; the list
read, account-signer read/prepare/submit, revoke-all prepare/submit, and
per-hash revoke prepare/submit remain deliberately exempt for audit, recovery,
and removal of authority already issued. This is deliberately not a replacement
for the owner signature or the on-chain caveats, which remain the authority and
enforcement.

## 4. Exit story — design + acceptance test (#832's contract)

**Claim to keep true for the live delegation rail:** *a user can enumerate and
revoke every delegation on their account, and recover control of the account
itself, without Haven.* Legacy Safe permissions are a separate retired rail:
they remain outside Haven and require the Safe owner to manage or revoke them
through the Safe's own owner-capable interface when that owner has a usable
wallet path. A legacy Safe owned only by a Haven passkey, or whose owner access
is unknown, receives no Haven promise of a self-serve Safe exit; this exception
does not weaken the independent delegation-rail claim above. #2413 makes the
exception starker and it is stated rather than softened: Haven no longer
displays those accounts, so it no longer offers even the read surface or the
`Safe{Wallet}` deep link it used to. Nothing about the on-chain position
changed — the owner's route out was always Safe's own interface, and still
is — but Haven has stopped pointing at it.

Design (minimum viable, in order of preference):

1. **A statically hostable, open-source exit page** (no Haven backend): connect
   the account's owner (passkey or EOA) → enumerate delegations Haven has
   issued for the account (from public inputs: the account address + the
   published caveat/enforcer addresses; delegations are off-chain objects, so
   enumeration uses redemption events + `disabledDelegations` reads for state,
   and Haven's published delegation-format doc for decoding) → one-click
   `disableDelegation` per row → signer management (add/remove passkey/EOA).
2. **A documented manual path** (published in Haven's public docs): the same
   two operations via a block explorer with the DelegationManager ABI — exact
   contract addresses, function names, and argument construction, written for
   a technically competent user.

**Honest limitation to document:** off-chain delegations that Haven issued but
never surfaced cannot be *discovered* by a third party until first redemption
— the exit page therefore also renders Haven's attested list when available,
but the **revocation guarantee never depends on Haven**: `disableDelegation`
works on any delegation the user can reconstruct, and rotating/removing the
compromised delegate signer (or in the worst case moving funds out — the
account's signers always can) is the universal backstop.

**Acceptance test (verbatim from #824, verified in #832):** a person holding
only their account credentials (passkey/EOA) and Haven's *public* docs — no
Haven session, no Haven support — (a) enumerates the active authorities on a
Base Sepolia test account, and (b) executes `disableDelegation` and confirms
further redemption fails. Recorded as a walkthrough with tx links.

## 5. Copy rules (per `copy-guidelines.md` + the #736 formulation bank)

- MAY say: "your money stays in your own account", "budgets are enforced by
  public, audited contracts — we can't override them", "you can revoke your
  agent's budget yourself, even without Haven — here's how" (link §4).
- MUST NOT say: "audit-ready", "your keys never leave your device" (passkey
  platform semantics vary), anything implying Haven holds/controls funds, or
  "MetaMask wallet" (the account uses MetaMask's *contracts*, not the wallet
  product).
- The exit path is a **published feature**, referenced from the dashboard
  ("your exit path") — not fine print.

## 6. Recovery & the signer-set model (shipped, epic #836)

The interim single-passkey stance is retired — recovery shipped.

**The model.** An account's authority is its **signer set**: one or more passkeys
(P256) and/or one EOA owner. Any enrolled signer can add or remove others
(`addKey` / `removeKey` / `transferOwnership` on the Hybrid). A **backup signer
is the entire recovery story**: lose the device holding your primary passkey,
and the backup removes the lost one and enrols a replacement. The user-facing
walkthrough is [account-recovery.md](../product/account-recovery.md); the
independent-of-Haven path is [exit/README.md](../exit/README.md).

**Owner send (#1083) rides the same op discipline:** an owner-initiated
transfer from the treasury is a sponsored account op the OWNER signs —
prepare/submit split, the submitted UserOperation pinned to the re-derived
transfer calldata, scheme chosen by the device (#1086), and no Haven-held key
anywhere (invariants 5/7/12/13 unchanged). Sponsorship pays gas only; the
transfer itself is bounded by nothing but the owner's signature, which is the
point — it is the owner's own money.

**The signer set is symmetric (#1087, #1199):** enrolling an EOA owner is not
a one-way door — `remove_owner` encodes `transferOwnership(address(0))` through
the same prepare/submit path and returns the account to passkey-only. Removing
a passkey uses that same shared path and is subject to the same recovery rule.
Either removal is refused before any op is prepared when it would leave the
account with **no** signer — the account itself refuses that on-chain. A removal
that leaves exactly ONE signer is **permitted** on any chain: the dashboard
names the consequence and asks for confirmation, and the API does not refuse
(see §7 for the decision).

**Recovery invariants (non-custody preserved through recovery):**

- **Haven can never change an account's signer set.** Every `addKey`/`removeKey`/
  `transferOwnership` is prepared by Haven and **signed by an existing signer**
  (WebAuthn or EOA). Haven holds no key that can add, remove, or use a signer —
  invariant 13, CI-enforced.
- **The account enforces ≥1 signer on-chain** (`CannotRemoveLastSigner`, proven
  in the #884 spike), and that is the only hard floor. Haven mirrored a **≥2**
  refusal in the API until #1153 turned it into a recommendation. Both signer
  removal actions now permit an informed two-to-one transition: the UI names
  the no-recovery consequence before calling, while the API preserves no
  stricter policy gate.
- **Storage tracks the chain, not the reverse.** The stored signer set (which the
  deploy path rebuilds the account config from, and which the client sign path
  reads for the *credential* only — the account **address** is pinned, never
  re-derived from it, #891) is synced only *after* the
  on-chain op confirms, and the submit step **pins the sync to the signed
  calldata** — the DB can never record a signer the owner didn't actually sign.
  (#985 moved `Executor` out of `infra/repositories/hybrid-signers.ts` into the
  shared `infra/transaction.ts`; that is a declaration site, not a behaviour —
  the queries, their ordering and the post-confirmation sync are unchanged.)
- **UUPS upgrade authority stays with the signers** (invariant 11); recovery
  changes signers, never the implementation.

**Read surface (#1079).** The signer set is additionally readable at account
level via `GET /accounts/hybrid/:address/signers` — owner-scoped (dashboard
JWT + ownership check on `smart_accounts`) and returning **public-key material
plus per-credential enrollment time** (`key_id`, P256 x/y, owner address, and
`created_at` since #1679 — a timestamp the UI uses to label rows
"Passkey · added {date}"; nothing secret, nothing spend-enabling). It powers
login-time signer resolution and the account-level recovery card. It is a
read: no route lets Haven — or this endpoint's caller — change a signer set
without an existing signer's signature (invariant 13 unchanged).

**Management surface (#1081).** Signer changes are reachable the same two ways:
agent-scoped (`/agents/:id/account-signers/{prepare,submit}`, #888) and
account-scoped (`POST /accounts/hybrid/:address/signers/{prepare,submit}`), the
latter so an account with **zero agents** can enrol its second signer before
anything else exists — which is when the backup-signer recommendation
(#908→#1153) matters most.
**The frontend now uses the account-scoped surface exclusively (#1089):**
`AccountSignersCard` is the single home for backup & recovery, rendered on the
account page for any `delegator_hybrid` account — including one with zero
agents — and no longer duplicated on the agent page. The agent-scoped route
stays live server-side (it is the same shared implementation below, just
resolved differently) but has no remaining frontend caller.
The two surfaces differ only in how the account is resolved: agent lookup
versus an owner-scoped `(address, chain)` lookup on `smart_accounts`. Authority
rules, the last-signer refusal (§7), the calldata encoding and the signed-op
matching
are **one implementation** (`rails/hybrid-signer-actions.ts`), because two copies
of a spend-authority rule is how they drift apart. Invariant 13 is asserted
against that shared core and against both routes reaching it. Client-side, the
signing ceremony selects the passkey whose credential is actually enrolled on
the signing device rather than blindly `passkeys[0]`, so recovery with a backup
key works from the backup device (`hybridPasskeyToSignWith` in `lib/signer.ts` —
since #1933 the one place the credential is chosen, called by
`lib/delegationPasskeySigner.ts`, which inlined a second copy of the rule until
then; `pickSigningPath` in `hooks/useDelegationBudget.ts`
chooses the *path*, passkey versus EOA, and never the credential). Since #2732
the hook also runs one background reader — a visible-only poll of the read-only
`GET /agents/:id/delegations` whose failed ticks leave the last rendered budgets
untouched (no error-branch flip) — while the signer set is deliberately **not**
polled: it is fetched on mount and refreshed after explicit signer changes,
never on a timer. `passkeys[0]`
survives as the fallback for the case where **no** device marker matches — a
cleared or never-written marker — and that fallback is safe rather than a
loophole: the marker is a local hint, so the worst it costs is a ceremony the
authenticator resolves from its own credential lookup, and no wrong-account
signature is reachable either way because the account address handed to the kit
is **pinned** to the one provisioning derived, never re-derived from the current
signer set (#891). UI surfaces treat a
DISMISSED signing sheet as a neutral cancel, never an error (#1085) — a user
changing their mind is not a failure mode. Scheme selection is
likewise a **device** decision, never an account-shape decision: a mixed
account (EOA owner *and* passkeys) accepts either signer on-chain, so the
client requests the scheme it can actually produce (`signature_scheme` on the
prepare routes, validated server-side against the real signer set) — enrolling
a backup wallet never disables the passkey path. When no enrolled passkey is
marked on the current device, the client still requests the passkey scheme
(the browser's cross-device WebAuthn flow is a real signing path) and the UI
shows an informational "may be on another device" hint next to the working
action rather than a false blocker (#1097) — availability copy must never
overstate what is actually gated.

**Marker-less signer *offering* is a recorded decision, not an implicit
refusal (#1969, owner decision 2026-08-26).** Until #1969, the dashboard's
active-signer resolution contradicted everything above: `useActiveSigner`
(`lib/signer.ts`) refused to return a passkey signer unless a device marker
matched, so a marker-less user (new device or browser profile; cleared site
data followed by re-login — the signer-set blob re-hydrates from the
owner-scoped read while markers are written only at enrolment; or a passkey
enrolled from another device) saw a wallet-connection CTA in the header while
every signing surface in this section worked, and `useAccountOperationGate`
(named `useSafeOperationGate` before #2913)
simultaneously blocked gated actions for the same state. The decision:
`useActiveSigner` resolves any **non-empty** hydrated signer set, mirroring
`pickSigningPath`'s precedence exactly — marker-matched passkey → connected
EOA when the connected wallet **is** the set's named owner (#2068) → any
passkey — so a mixed account keeps
signing with its connected owner wallet and only the pure-passkey marker-less
case changed; the fallback credential is **disclosed** in the wallet menu
(#1952's rendering, reachable since this decision) before any ceremony. This
offers no signer that cannot sign: the set is the account's on-chain-enrolled
signers, selection draws only from that account+chain-scoped set, and device
availability — the one unknown — is answered by the ceremony itself.
**That sentence was aspirational until #2068 made the EOA rung honest:**
both `pickSigningPath` and the #1969 mirror read "a wallet is connected" as
satisfying the EOA rung whenever the set named an owner, without comparing
the connected **address** to `owner_address` — so a mixed account with an
unrelated wallet connected was offered a signer whose signature the account
rejects at verification time. The rung now requires the connected address to
equal the named owner (case-insensitive); a non-owner wallet falls through
to the passkey rung, and for an **owner-only** set — where there is no
passkey to fall to — the resolution is `null`: a signer offered but failing
at signature time is worse than absent. A hydrated set with a NON-OWNER
wallet connected never reaches the generic connected-EOA return (which
otherwise serves accounts without a hydrated set — legacy Safes,
pre-hydration renders); the owner-matched case deliberately re-uses that
same shared return, and it is correct there because the address was just
proven equal to `owner_address`.
Refusing (the pre-#1969 status quo) was declined as incoherent with the
#1097 rule above and with shipped signing behaviour; offering **silently**
was declined per #1952's design record. `useAccountOperationGate`'s hybrid
branch now answers `ready` for a non-empty set for the same reason, and —
since #2068 — for an owner-only set exactly when the connected wallet is
the named owner (the same address check; an unrelated wallet stays blocked,
and since #2073 that block has its own name: the gate answers
`wrong_wallet`, carrying both addresses, rather than folding the mismatch
into `no_signer`. The distinct kind changes what the UI *says* — the header
wallet pill and the action-area caption name the mismatch instead of asking
the user to connect the wallet they already connected — and never what may
*sign*: every consumer treats it as blocked, `wrong_wallet` is produced
only by the hybrid branch's address compare, and the owner on the wrong
network deliberately stays `no_signer` so the wrong-chain guidance keeps
precedence); `passkey_on_other_device` remains the legacy-Safe answer,
where the block is real because the stored signer metadata a Safe passkey
needs is genuinely absent from the device.

**The honest limit, stated plainly:** a **single-signer account has no recovery**
— if its only signer is lost, the account is unreachable by the user *and* by
Haven. This is inherent to self-custody, not a Haven policy. Mitigation is
structural: onboarding nudges a backup, the account itself refuses removal of
its last signer, and the dashboard requires an explicit confirmation before an
informed two-to-one transition. Copy never promises recovery Haven cannot
deliver.

### 6a. Agent delegate-key rotation — a DIFFERENT layer (#1698, epic #1694)

> **Display metadata is not authority (#3164, 2026-09-22).** The agent row
> gained an `organization_id` (migration `094_agent_organizations`, the
> per-user folder tree in `infra/repositories/agent-organizations.ts`) and
> the label set before it (#3167). Both are categorization for the `/agents`
> list: no query that decides what an agent may spend reads them, they
> appear on no delegation, budget or revocation path, and `rekey` — the flow
> above, which deliberately preserves identity — is untouched by them. A
> folder rename or delete moves display placement only; it can never grant,
> widen or restore spending authority.

Everything above is about the **account's signer set**: the passkeys and EOA
owners that sign delegations. An **agent's delegate key** — the key that
*redeems* delegations — is a separate layer, and its loss has the opposite
answer, for a reason worth stating rather than leaving implicit.

The delegate never held owner authority. It holds only what a signed
delegation grants it, and that grant is revocable by the account owner. So a
lost or exposed delegate key is **recoverable**, where a lost sole account
signer is not: the owner revokes the old delegation and issues a new one to a
new delegate, keeping the agent's id, name, history and passport IDENTITY.
That is `POST /agents/:id/rekey…` (`routes/agent-rekey.ts`), and it is the
reason the "no recovery" limit above is scoped to the *signer set* rather than
to keys in general.

The word *identity* is load-bearing and was added in #1699, because the
unqualified "keeps its passport" was read as "the attestation is untouched" and
that is not what happens — see the re-anchoring property below.

Eight properties of that flow belong in this document because they are
security properties, not implementation detail:

- **Revoke precedes issue, always.** Both halves are on-chain and
  owner-signed, so partial failure is possible either way, and the two
  orderings fail differently. Revoke-then-issue fails to *the agent has no
  authority* — recoverable, and the right posture when a key is lost, since a
  lost key is already inert. Issue-then-revoke fails to *two simultaneously
  live keys* on a funded account, which nothing recovers by retrying. The
  ordering is enforced by a stage machine AND by CHECK constraints on
  `agent_rekeys`, so it holds across the several requests the flow spans.
- **The budget meter carries across the rotation — amount AND period
  boundary.** A re-key is not a way to refill a budget. The remainder frozen by
  the revoke is issued as a **carry** grant, anchored inside the old period and
  expiring at the old boundary — or at the old grant's own expiry, if that
  falls first — paired with a **steady** grant starting at that same instant on
  the original budget and cadence (`modules/agents/rekey-carry.ts`). Either
  piece may be absent rather than wrong: a fully spent period yields no carry,
  and a grant that dies at or before the boundary yields no steady. The two
  never overlap, so total spend before the boundary is capped at the remainder
  and every later period is the original grant untouched. Carrying only the
  *amount* is the bypass this
  defends against: each re-key would restart the clock, so an agent on a daily
  budget could be handed its remainder hourly — the period is half the grant,
  and dropping it turns a rate limit into a tally. The defence composes rather
  than being separately checked, which is why it holds for repeats: re-keying a
  carry grant reads a grant whose boundary is that same instant, so no number
  of re-keys inside one period can sum to more than the original budget. Two
  refusals belong to the same invariant — a remainder larger than the granted
  budget is refused rather than clamped, and a remaining-budget reading that
  did not come from the chain is refused rather than carried, because
  `readRemainingBudget` falls back to the FULL budget on a failed read and
  carrying that fallback would hand the new key a fresh full period.
- **The carry is planned on the clock the remainder was MEASURED on, and only
  dropped on the clock it is issued on.** A re-key spans several requests with
  an owner signature in the middle, so the meter reading and the issue can fall
  in different budget periods. The remainder is a fact about the period the
  revoke froze it in and means nothing in any other, so `planCarry` takes both
  clocks: `agent_rekeys.metered_at` anchors the boundary and every classification
  (expired, dormant, live), while the issue-time clock is used for exactly one
  thing — dropping a piece whose window the delay has already outrun, rather than
  asking the owner to sign a grant that can never redeem (#1849). Before this the
  route passed the issue clock for both, which could not over-grant — the
  remainder is still a ceiling — but silently *under*-granted: an owner who
  finished after a boundary had a spent period's remainder charged against a
  fresh one, at worst leaving an agent on zero for a period it was owed a full
  budget in. A missing `metered_at` is refused (409) rather than defaulted to
  now, because that default is precisely the defect. This is why "either piece
  may be absent rather than wrong" has a third cause alongside a fully spent
  period and a grant that dies at the boundary; every drop is reported to the
  owner with the window that closed named, so an absent grant is explained
  rather than merely missing.
- **An abandoned post-revoke re-key is recoverable — on the owner's explicit
  signal, never on a clock** (#1868). Abandoning a re-key that got past the
  revoke leaves the agent with no authority (the delegations are already
  retired on-chain), and until #1868 it also *forfeited* the frozen carry: a
  fresh re-key found nothing to revoke and walked to `metered` with an empty
  snapshot, so recovery was a manual owner re-grant that could not preserve
  the period boundary. Now the fresh re-key **inherits** the abandoned row's
  frozen measurement — snapshot, `revoked_at`, `metered_at` and the revoke tx
  wholesale (`adoptAbandonedCarry`), so the carry arithmetic stays anchored to
  the clock the remainder was measured on (the property above) and the period
  still cannot be refilled by rotating. Three guards keep this from failing
  open. The **abandonment signal is the owner's explicit abandon call**
  (`stage='abandoned'`), never elapsed time: a merely slow re-key still holds
  the unique in-flight slot, so a successor cannot even open, and there is
  deliberately no `NOW() - metered_at` predicate anywhere — a timeout that
  guessed wrong on a live re-key would fail open where the wedge failed
  closed. Adoption is **refused when any grant was made after the abandoned
  revoke** (the abandoned re-key's own inert `pending` rows excepted — they
  can never activate), because a manual re-grant spent in the same period plus
  the old remainder would exceed the original budget; the refusal falls back
  to the empty walk, which is the fail-closed direction. And a **completed**
  re-key's snapshot is never adopted — its carry was already issued. The
  in-flight 409 also names the `new_delegate_address` the parked re-key is
  bound to, so an interrupted owner resumes against the key the flow actually
  holds rather than the one they last typed. **A budget grant hits the same
  wedge** (#2416): `POST /agents/:id/delegations/build` refuses while a re-key
  is in flight — the same lock, for the same reason — and until #2416 reported
  that refusal as "Revoked agents cannot receive new budget delegations", so an
  owner who parked a re-key was told their live `active` agent was revoked.
  Which requests are refused did not move; what changed is that the refusal
  names the REASON — the in-flight re-key, and the remedy of finishing or
  abandoning it. It does **not** name the bound `new_delegate_address` the way
  the re-key-open 409 above does, and deliberately so: the address answers
  "which key is this flow holding", which is the resuming owner's question, not
  the granting owner's. The wedge is still the security property — a parked
  re-key must keep holding its slot against a new grant — and telling the owner
  the wrong reason for a correct refusal is how a fail-closed guard gets
  mistaken for a broken account.
- **Non-custody is unchanged.** The new keypair is generated on the target
  machine and Haven receives only its public address. Nothing in the flow
  accepts, stores or transports private key material, and a design that
  "restores" a key to a new host is out of scope by owner decision — refused,
  not built.
- **An agent can never re-key itself.** Authorisation is the account owner
  through the dashboard; an agent presenting its own credential is refused
  explicitly. An agent rotating its own credentials would be an agent editing
  its own authority.
- **The revoke is signed by a signer the DEVICE chose, not one the server
  guessed** (#1870). §6's rule — scheme selection is a device decision, never
  an account-shape decision — reads as though it always held across the prepare
  routes. It did not hold here: the re-key's revoke prepare passed no signer to
  the account, so the underlying default inferred the EOA owner whenever one
  existed. On a mixed account that is a guess, and a costly one, because the
  UserOp's verification gas is estimated against a dummy signature sized for
  the inferred signer — a WebAuthn signature is several hundred bytes where an
  EOA's is 65. The route now resolves `signature_scheme` through the same
  `rails/hybrid-signer-actions.ts` core §6 describes, passes the choice down,
  and reports the resolved scheme back so the client branches instead of
  guessing. **The refusal ordering is the security property**, not the field: a
  scheme the account cannot sign is refused `409` in the *prepare* step, which
  writes nothing and leaves the re-key at `preflight`. That is deliberate under
  the revoke-precedes-issue rule above — a failure after the revoke is the
  expensive direction, so a new way to fail must land before it.

- **The passport ANCHOR is retired and reissued, and standing never moves**
  (#1699). An EAS attestation is immutable and `PASSPORT_SCHEMA`'s first field
  is `address agentEoa`, so there is no mutable-anchor option: the moment the
  rotation completes, the live attestation names a key the agent no longer
  holds. Re-key therefore revokes it and issues a new one naming the new key —
  and the same revoke-before-issue rule applies for the same reason, one layer
  up. Minting first would leave TWO live credentials for one agent, one of them
  naming a retired key, and a partial failure would make that permanent;
  revoking first fails to *this agent has no passport right now*, which is
  recoverable. The window between them is real, and it is reported as
  `re_anchoring` rather than hidden — never as `anchored`, which would tell a
  merchant a credential is current when the address it names cannot spend.

  **What does NOT move is `standing`.** It derives from `agents.status`
  (`modules/passport/revocation.ts`), which a re-key never writes, so no chain
  failure in this path can cost an agent its standing — the worst available
  outcome is a stale anchor that keeps retrying. That is the two-layer split of
  §epic #970 doing the job it was built for: the DB is authoritative and the
  anchor is eventually consistent, and re-anchoring is the case that makes the
  distinction observable rather than theoretical. The queue is the invariant
  "the attestation names an address the agent no longer uses", so a re-key
  whose process died before enqueuing anything is still picked up.

  Passport remains governance metadata, never spend authority: nothing in this
  property grants, withholds or delays what an agent may spend.

One consequence the owner should hear before starting: re-key retires the key
that could **sweep** any residual balance on the old delegate EOA, so the
preflight reads that balance and refuses until the owner says what happened to
it. After the rotation it is unrecoverable — by the user and by Haven alike —
in the same structural sense as the single-signer limit above.

## 7. Two signers: a recommendation, not a gate (#1153)

**This section previously recorded a launch GATE.** It said no mainnet
delegation-rail account could operate below two enrolled signers without a
recorded waiver, and `modules/accounts/mainnet-gate.ts` enforced exactly that at
provisioning, at grant activation, and at owner removal.

**It no longer does. Owner decision, 2026-08-07, verbatim:**

> "This is too hard, create a issue where this requirement is changed from
> being a hard one, to a soft recommendation of adding a backup, but this
> recommendation should only be displayed to the user after they have funded
> the account. I do not want users to have this in their face directly at
> onboarding."

and, on owner removal:

> "convert this from a block to a warning instead, the user should be able to
> move to a one signer set up."

**What this does and does not change.** It does not make single-signer accounts
safer, and it does not lower the risk stated in §6: such an account has **no
recovery**, and losing the device loses the funds with no path back through
Haven or anyone else. That is now a risk the user may take. What changed is
*when and how* they are told: after funding, when there is something to
protect, instead of as a wall in the first minute — where it blocked the
one-Face-ID, zero-transaction onboarding this rail exists to offer, at the
moment the user has nothing at risk and no context for what a backup protects.

**The mechanism now:**

- **Provisioning and grant activation do not consider signer count.** A
  single-signer account may be created on a value-bearing chain and may receive
  a budget.
- **`remove_owner` and `remove_passkey` succeed** in dropping a value-bearing
  account to one signer. The dashboard requires an explicit confirmation
  naming the consequence before it calls; an API-level acknowledgement flag
  was rejected on #1153 because it would still be a block to any non-UI caller,
  which is the thing being removed.
- **The recommendation is delivered after funding**, and only when the account
  is genuinely below two signers — recommending a backup to someone who has one
  teaches them to ignore the banner.
- **`needsBackupSignerRecommendation`** replaces `signerFloorError`. Same
  condition, no refusal: it answers "would this account benefit from a backup",
  and the fail-closed chain classification stays because over-recommending on
  an unknown chain is harmless while staying quiet on a real one is not.
  Since #1205 the predicate has its production call site: the session safes
  payload (`/auth/me`, login) carries the computed answer
  (`needs_backup_recommendation`) plus `value_bearing_chain`, mapped by
  `sessionAccountPayload` (`sessionSafePayload` before #2910) in the same module — so the dashboard's banner branches
  on the server's classification instead of re-deriving chain semantics
  client-side.
- **The waiver column survives as history, not as an unblock.**
  `smart_accounts.single_signer_waiver_at` (migration 046) is still written when an
  acknowledgement is sent, and nothing requires it to proceed. It no longer
  silences the recommendation either — it never made an account recoverable; it
  only recorded that someone had been told once, and the risk is ongoing.

**What did NOT relax:** the account still refuses to remove its *last* signer.
That is a different rule — it mirrors an invariant the account enforces
on-chain, and dropping to zero signers bricks the account rather than merely
making it unrecoverable.
- **Activation is atomic** (#1061): retiring the previously ACTIVE grant for a
  `(token, recipient)` slot and activating the new one run in **one
  transaction**. As two independent statements, a failure between them left the
  slot with zero active grants — every payment 403s while the old grant is still
  perfectly valid on-chain, i.e. a self-inflicted outage with no on-chain cause.
  It is now replace-and-activate or neither. This is availability hardening, not
  a custody change: neither statement can create authority the owner did not
  sign. **Since #2411 the order inside that transaction is owned by one
  repository call** (`activatePendingDelegationInSlot`, `infra/repositories/delegation-budgets.ts`):
  the sweep retires the slot's *other* active grants **first** and **excludes
  the row being activated by id** (`AND id <> $4`), so it is correct in either
  order. #2331 had briefly inverted the order with no exclusion, and every
  activation committed with its own row `replaced` — zero active grants in the
  slot, first payment 403 — the same self-inflicted outage #1061 closed, by a
  different door. Both halves are pinned on real Postgres
  (`delegation-budgets.test.ts`, "activation replace sweep (#2411)"), and the
  mocked route test pins the statement order. Same custody posture: a sweep
  that retires one row too many or too few changes which owner-signed grant
  Haven *selects*; it cannot create, widen, or redeem one.
  **And since #2415 that transaction makes no network call.** #2331 added a
  correct guard — refuse a pending delegation that was built for a delegate key
  the agent has since rotated away from — but placed the address derivation it
  needs (`computeHybridAccountAddress`, one RPC) *between* `BEGIN` and `COMMIT`,
  so a slow or hanging RPC held the agent row lock and a pooled connection while
  every other writer that lock serializes (Safe unlink, re-key open, re-key
  completion, sibling activations) waited behind it. The derivation now runs
  **before** `BEGIN`, on the delegate key from the pre-lock read, and the lock's
  job is to assert the locked row still carries that exact key — which is what
  makes the pre-computed address current at commit time. The refusal, its 409
  and its message are unchanged; a re-key committing between the read and the
  lock is still caught, now by the key comparison rather than by re-deriving.
  Deliberately not a stored column: the delegate address computed at `build`
  time is by construction the `delegate` field already inside `delegation_json`,
  so persisting it would compare a value against itself. Availability hardening
  only — no authority, custody or signature boundary moves.

Two honest limits of the mechanism (review-noted): the signer count is
**DB-sourced** — an owner can change the signer set directly on-chain without
Haven's sync, so the floor protects the owner from themselves rather than
proving on-chain state (the on-chain `CannotRemoveLastSigner` guard is the
hard backstop). And a provisioning-time EOA owner is **not signature-verified**
— the floor counts enrolled signers, it cannot prove each is usable (the zero
address, which provably is NOT a signer, is rejected at every entry point).

The dashboard now delivers the recovery recommendation after funding, and both
two-to-one signer-removal paths require an explicit consequence confirmation.
The API deliberately has no waiver or acknowledgement gate: it permits those
informed transitions while the account's on-chain last-signer guard remains the
hard backstop.

## 8. x402 dual-scheme settlement — the EIP-3009 interop bridge (#946)

> **Re-verified #2910 (naming epic #2906, phase 2b):** this diff touched six
> files in this document's coverage list — `routes/auth.ts`,
> `routes/agents.ts`, `routes/user-safes.ts`, `infra/repositories/agents.ts`,
> `rails/hybrid-account-config.ts`, `modules/accounts/mainnet-gate.ts` — by
> identifier rename only: locals and parameters `safeId`/`safeAddress` →
> `accountId`/`accountAddress`, the object-literal fields `NewAgent.safeId` →
> `accountId` and `CreatedAgent.safeInfo` → `accountInfo`, and
> `sessionSafePayload` → `sessionAccountPayload` (the §6 sentence naming it
> updated). Every SQL literal in the
> touched repository files is byte-identical (64 literals, 0 differences), no
> route path, wire key, tenant-scoping clause, signing path or authority
> check changed, and the `RelayerOperation` union lost only its dead
> `'safe_deploy'` member (historical `relayer_gas_events` rows still read —
> pinned by test). Every claim in this document that names one of these
> files still holds under the new identifiers; nothing else re-read.

> **Re-verified #2907 (naming epic #2906, phase 0):** the funding-leg
> `sign_data.components` object (`delegation-authorize.ts`, `replay.ts`) gains
> a `payer_account` field — an additive, same-value twin of the deprecated
> `safe` field, not a rename into `components.account` (which already means
> the *delegate* account address on this shape, a different address). No
> authority, signing path, or invariant mapping changes: `payer_account` is a
> read-side label, mutation-tested equal to `safe`
> (`openapi/payer-account-alias.test.ts`). `routes/user-safes.ts` also gained
> an additive `/user/accounts` prefix registration of the same handler
> module — §2's invariant mapping and this doc's route list are otherwise
> unaffected: no new authority, no new signing path.
>
> **Review-findings correction, same PR:** that additive `/user/accounts`
> mount was NOT reflected in `middleware/owner-cli.ts`'s `OWNER_CLI_ALLOWED_
> ROUTES`, which named only the `/user/safes` literal — `routeAllowsOwnerCli`
> compares the registered route's exact URL, so an `owner_cli` token that
> could read `GET /user/safes` and `GET /user/safes/{safeId}/funding` got a
> 401 on the identical `/user/accounts` / `/user/accounts/{safeId}/funding`
> mount, for the same data, through the same handler. This is a REFUSAL gap,
> not an authorization grant — the token already had this read through the
> `/user/safes` prefix — so fixing it (adding the two twin entries) does not
> widen the owner_cli surface §9 below describes; it makes the surface
> actually reachable through both names, which is the whole point of an
> additive rename. Proven with a parity test that fails 4 assertions when the
> twin entries are removed.
>
> **Superseded at #2914:** the contraction removed the `/user/safes` pair from
> `OWNER_CLI_ALLOWED_ROUTES` rather than keeping both, so the allow-list now
> carries the `/user/accounts` names alone and matches §9 exactly. A reader
> should not act on the "adding the two twin entries" instruction above — it
> records what #2907 did, not what the list holds today.

> **Re-verified #2850:** this diff touched two files in this document's
> covered-paths list — `routes/agent-rekey.ts` and `routes/agents.ts` — each by
> exactly one import-path line: `getTokenBalance` now imports from
> `infra/chain/relayer-reads.ts` (the shared chain-read module renamed out of
> its `rails/allowance-module.ts` name). No handler, authority check, signing
> path, or invariant mapping in either route changes; §2's
> relayer-free/signer-free scans read unchanged bodies at a new import path.

> **Re-verified #3132:** this diff touched one file in this document's
> covered-paths list — `routes/transactions.ts` — by adding a per-row
> `scope: { source: 'wallet', filter }` to the aggregated feed's response
> after filtering and pagination (the feed is wallet-scoped; `agentId` /
> `accountId` are named as narrowing). The read is unchanged in what it
> reads: the same `listBasicAccountsForUser(sub)` ownership scope, the same
> `agentExistsForUser` check on a foreign `agentId`, the same 400 bodies. No
> handler gains authority, no write path is added, no signing path or
> invariant mapping moves; §2's relayer-free/signer-free scans read an
> unchanged body apart from the response map. Nothing else in this document
> was re-verified in this pass.

The rail settles x402 two ways, selected per payment (`routes/x402.ts`):

- **erc7710 direct settlement (default & destination, #830):** the settlement
  redeems the budget delegation itself — enforcers run at every payment,
  against every merchant; no funding leg, no hot balance, no sweep.
- **EIP-3009 fallback (temporary interop bridge, #946 / RFC #791 §18):** for
  facilitators that cannot redeem a delegation chain. The budget delegation is
  redeemed with `to = the agent's own delegate EOA` (a sponsored UserOp the
  agent signs — the same prepare/submit split as any redemption), then the EOA
  signs a standard EIP-3009 header client-side and the facilitator settles
  EOA→merchant.

What the bridge deliberately gives up, for 3009 payments only — and the
compensating controls:

1. **A transient hot balance returns** on the delegate EOA between funding and
   settlement. Bounded: the funding is the exact payment amount; the header's
   forward validity window is capped SDK-side (merchant-requested timeout
   clamped to ≤600 s, plus a 300 s settlement margin — ≤900 s total, #1256:
   the margin is what lets the header clear the facilitator's
   `validBefore ≥ now + maxTimeoutSeconds` verify rule after the funding leg
   confirms; without it every purchase against a ≥300 s-timeout merchant
   failed structurally); the delegate-balance monitor
   covers delegation-rail agents; the rail-agnostic sweep route recovers
   residuals to the **treasury Hybrid** (`agent.account_address` — the
   `agents.account_id` → `smart_accounts.account_address` read, columns
   renamed by #2911), with the
   0.01 USDC recoverability floor and sub-floor residuals visible in the ledger.
2. **Budget meters at the funding hop, not at settlement.** Verify-without-
   settle strands the amount on the EOA → sweep reconciles it; the budget
   consumption is honest (funds genuinely left the treasury).
3. **The merchant hop has no on-chain policy.** This is why 3009-mode
   structurally requires an **open (unpinned) budget**: a recipient-pinned
   delegation cannot fund the EOA (the pin locks `transfer(to,…)` to the
   merchant), and the server only funds via delegations whose caveats permit
   the EOA as recipient. **Pinned agents are erc7710-only** (owner decision
   2026-07-15, recorded on #946) — a pin is never weakened for interop.

Non-custody is unchanged: the agent signs both legs client-side (the funding
UserOp's typed data and the 3009 header); Haven prepares and relays, holds no
key, and sponsorship can pay gas but never move value. The scheme is recorded
per intent (`machine_metadata.settlement_scheme`) so 3009-mode usage is
auditable and its retirement measurable.

Hardening shipped with #961: the per-agent hourly x402 cap now guards the
delegation branch too (every authorize costs a sponsored bundler estimation,
so the cap is sponsorship-cost protection on the #717 surface — placed after
the idempotent-replay lookup so recovery retries are never rate-limited);
one-shot authorize+execute is refused loudly (a signature over
not-yet-prepared state can never be valid); and idempotent replays resume
with the ORIGINAL reconstructed signing payload rather than re-running
estimations — the stored intent, not a fresh prepare, is the source of truth
for what the agent signs.

### 8.1 The settlement child — verified signer, honest bearer semantics (#1061)

Two properties of the erc7710 settlement leg, corrected in #1061:

- **The settle signature is verified against the delegate key, not merely
  shape-checked.** `POST /x402/:id/settle` recovers the signer from the child
  delegation's EIP-712 typed data and refuses anything that is not the agent's
  `delegate_address` — with a `400`, *before* the intent status flips, so the
  intent stays signable and the client can re-sign the same payload. Previously
  any hex (`0x0` included) passed the shape check and burned the intent, turning
  a client-side signing bug into an unrecoverable payment. This is the
  authentication/authorisation split enforced concretely: the bearer token
  identifies the agent, the recovered delegate signature is what authorises.
  Unlike `payments.ts`, the child's typed data is fully known server-side, so
  the check is possible here.
- **The child is a bearer instrument, and the doc says so.** It is issued to
  `ANY_BENEFICIARY`; the redeemer *caveat* is the constraint that would narrow
  it, and no live path populates it yet (`requirements.extra` is not parsed —
  [#1058](https://github.com/d-hinders/Haven-AI/issues/1058)). The real
  guarantee is therefore the caveat stack, not the recipient: exact amount,
  payee-pinned, ≤600 s expiry. Worst case on a leaked child is "the merchant is
  paid without delivering" for that one quoted amount — the leak-analysis table
  in §3 is unchanged, since redeeming still cannot exceed those bounds.

## 9. Owner CLI sessions — the device-code login (#2526)

`haven login` mints an owner session through a browser approval rather than a
password. The reason is the epic's standing constraint: an agent drives this
CLI, and an agent must never hold its user's password. The cold-test agent
correctly refused to type one.

The token is the ordinary 7-day owner JWT with one difference —
`purpose: 'owner_cli'` — and that difference is the whole security story.

**The default is refusal, and it always was.** #1640 refuses every
`purpose`-carrying token on every authenticated route, stated the safe way
round so that "a future single-purpose token inherits this refusal by default".
That is unchanged. What #2526 adds is a single exception, and it is an
**opt-in**: a route accepts the token only by being on the allow-list in
`packages/backend/src/middleware/owner-cli.ts`.

**Why an allow-list and not a deny-list.** A deny-list is a promise that
somebody will remember. Every route added after it is written would be granted
by default, and the day nobody remembers is the day an agent-driven token can
sign something. `owner-cli-route-census.test.ts` discovers every registered
route from the route modules — it does not hard-code a count, which would go
stale on the next pull request — and measures, for each, what
`routeAllowsOwnerCli` actually answers at the door. It also checks the reverse
direction, and caught three entries naming routes that do not exist on its
first run; an entry for a missing route grants nothing while reading like
coverage. A later check — that every listed route is genuinely behind
`authMiddleware` — caught a fourth
(`GET /agent-connection-setups/{setupId}/connector-status`, gated by an
agent-API-key check that never consults `purpose`). A fifth test holds the list
against an independent opinion about which path *shapes* are authority, so
adding `PUT /user` or a `rekey` route goes red without anyone extending a
fixture.

**What that does and does not prove, stated exactly.** The no-third-state
property is structural: `isOwnerCliAllowed` returns a boolean and nothing falls
through. This section previously said the census *asserts* it. It did not: the
assertion was written in terms of `isOwnerCliAllowed` itself and reduced to
`!X && X`, so it passed for any list, including an empty one. Two independent
reviewers caught it before merge; the suite did not. The tests above replace it
with checks phrased against something the list does not define — the
enforcement function, the modules' real auth wiring, and path shape — and each
has a recorded mutation that makes it fail. No test can object to a *considered*
entry on the list: that is what review is for, and why this list is short.

**The list IS the enforcement.** These route modules attach auth with one
module-level hook, so a per-route marker would mean two sources of truth that
must agree — a listed route whose marker was forgotten grants nothing, a marked
route nobody listed grants something nobody decided. The middleware reads the
list, so the census guards real behaviour rather than a parallel document.

**What an owner-CLI session cannot do**, by construction rather than by
enumeration: signer changes, re-keying an agent — neither its
delegate key (`/agents/{id}/rekey/*`) nor its API key
(`/agents/{id}/rotate-key`) — passkey management, the user's own
credential/password/email, account provisioning, transfers, and every
delegation signature step: `activate`, `revoke/submit`, `revoke-all` and
`revoke-all/submit`. It can create an agent and ask for a budget. It cannot
approve one. Since #2539 it can also construct a budget change and revoke
one — `POST /agents/{id}/delegations/build` and
`POST /agents/{id}/delegations/{hash}/revoke` — both
construct-and-hand-off: the route builds the unsigned delegation or prepares
the sponsored revocation, the CLI prints the dashboard signing link, and the
signature happens in the owner's browser, every time. **The human keeps
every signature**, which is the same boundary §3 draws for the delegation
itself. Since #2534 it can also read the
funding instructions for one of the owner's accounts
(`GET /user/accounts/{accountId}/funding`): balances, chain facts and the documented
minimum-useful amounts a human acts on — the same read-only category as the
rest of the list, moving no money and touching no delegation state.

**`POST /agents/{id}/rotate-key` was on the list and is not** — owner decision,
2026-09-05. It issues a fresh plaintext agent API key and invalidates the old
one, on any of the owner's agents rather than only one this session created, so
a live agent still holding the previous key starts getting 401s immediately.
That is a credential mint plus a self-inflicted denial of service, and it sat
against the boundary this section draws. It was scoped in by the issue and
removed on review; the census pins the shape (`rotate-key`) as authority, so it
cannot return without a test going red. An agent that needs a key rotated asks
its human — the same answer the list gives for everything else that changes
authority rather than reading it.

`POST /auth/device/approve` is itself absent from the list, deliberately: a CLI
session approving further CLI sessions would turn one human approval into an
unbounded grant.

**The grant rows.** Both codes are hashed at rest (migration 078), user codes
are 8 characters from an alphabet with no `0`/`O`/`1`/`I`/`L`/`U`, single use is
enforced inside the UPDATE rather than by a read-then-write, and rows are
purged after a ten-minute expiry — they are spent credentials, not history. A
wrong, expired or already-decided code all answer alike, so codes are not
enumerable by a signed-in caller.

What actually carries that last claim is **entropy, not the rate limit**, and
the distinction matters because the limit is not always armed: `authRateLimit`
returns no limit at all when `TRUST_PROXY_HOPS <= 0` (§ the #1670 reasoning —
an unbindable per-IP limit behind an untrusted proxy is a denial of service
wearing the costume of a protection). A user code is 8 characters over a
30-symbol alphabet — about 39 bits — inside a ten-minute window, which is not
searchable even entirely unthrottled. A reader should not come away thinking
the tier is load-bearing here; it bounds row creation, not guessing.

> **Re-verified #3167 (2026-09-20):** the covered file this diff touches is
> `routes/agents.ts` — it gains only the `labels[]` read-along on its list,
> by-id, and PUT responses (joined from the new per-user label tables) and no
> authority decision moves: delegation lifecycle, budget derivation, rekey and
> revoke handling are byte-identical, and the new label data access lives in a
> dedicated repository module that nothing in the delegation, budget, or
> enforcement path imports (its header states that boundary; the issue's own
> hard guard demands it). A label is a name and a colour; it carries no grant,
> no caveat, and no key. Perimeter unchanged for this model — the CASP shard
> `docs/regulatory/casp-changelog/2026-09-20-3167.md` carries the full
> analysis.

> **Re-verified #3030 (2026-09-21, request validation slice 2):** this diff
> touches three files in this document's coverage list — `routes/auth.ts`,
> `routes/transactions.ts`, `routes/user-accounts.ts` — and moves no authority
> or custody boundary: it moves SHAPE checks out of the handlers and into the
> OpenAPI request schemas the plugin now ENFORCES on these modules
> (`index.ts` `enforcedModules`). What each file lost is a hand-rolled type or
> pattern check that the spec's schema states (`auth.ts`: the password
> bounds, `typeof` on name/email/user_code/device_code — the email FORM and
> the control-character and blank-after-trim rules stay in the handler, and
> the `via` marker the dashboard sends is now declared; `transactions.ts`:
> the uuid / `user`-or-uuid / `<chain>:<address|native>` / positive-integer /
> `in|out` shapes on its filters, while ownership (`listBasicAccountsForUser`,
> `agentExistsForUser`, `findAccountOwnership`) and chain support stay
> exactly where they were; `user-accounts.ts`: `typeof name` and the
> pre-lookup uuid check, with `renameAccountForUser` still scoped to the
> caller). Auth precedes validation on every ENFORCED route: `authMiddleware`
> runs as an `onRequest` hook and validation is preValidation, so an
> anonymous caller gets 401 before any 400. Three enforced routes had theirs
> as a `preHandler` (after validation) — `POST /auth/device/lookup`,
> `/approve` and `GET /analytics/funnel` — which the enforced schema turned
> into a 400 for an anonymous malformed request (measured in review, both
> rounds); all three moved to `onRequest` in this diff, pinned by
> `auth-device.test.ts` and `analytics.test.ts`. Two shadowed money-path
> modules still register `authMiddleware` as a `preHandler`
> (`agent-passports.ts`, `agent-connection-setups.ts`); their 401-first
> consequence holds today because a module outside `enforcedModules`
> refuses nothing, whatever the mode; both are slice-4 files (#3032) and
> must move to `onRequest` before that slice flips them — #3032's body
> carries that line — and
> the retired Safe-inflow 410s (`POST /user/accounts`, `PUT /user/account`,
> `/deploy`) gained a route-level `onRequest` so they still precede
> validation: a malformed body is told the flow is gone, not to fix its
> request (pinned in `safe-inflow-retired.test.ts`). The three files carry
> no inline tenant SQL; ownership runs in the repositories they call
> (`listBasicAccountsForUser`, `agentExistsForUser`, `findAccountOwnership`,
> `renameAccountForUser`), none of which this diff touches. Scope of this
> note: those three files' request-shape edits and the hook order. Nothing
> else in this document was re-verified.

> **Re-verified #3255 (2026-09-23, backend RPC failover):** this diff touches
> the rail's viem clients in `rails/delegation-rail.ts`,
> `rails/hybrid-provisioning.ts` and the `createTreasuryOps` callers. Each now
> reads through `infra/chain/rpc-transport.ts`, a viem `fallback()` over the
> dedicated endpoint, an optional second provider and the public node, so a
> quota-dead provider no longer fails prepare. What enforces a spend is
> unchanged: budget, recipient pin and expiry still revert in
> `eth_estimateUserOperationGas` on the bundler, which this diff does not
> touch, and every UserOp still needs the account signer's signature. An
> `eth_call` revert is terminal and is never retried on the next node. The
> `disabledDelegations` heal is the exception: it stays on the dedicated
> endpoint only (`dedicatedOnly`, pinned by `rpc-transport-guard.test.ts`),
> keeps its `finalized` tag and two-read rule, and the sentence on lying RPC
> endpoints above now says why. A lagging fallback node can make
> `ensureHybridDeployed` spend relayer gas on a reverting or spurious deploy,
> never move funds. The relayer's ethers provider stays on one node (#1533).
> Scope of this note: those RPC reads. Nothing else in this document was
> re-verified.

> **Re-verified #3032 (2026-09-24, request validation slice 4, independent
> prep):** this diff touches `routes/agent-passports.ts` and
> `routes/agent-connection-setups.ts`, and moves no authority or custody
> boundary. The #3030 note above records both modules as the two shadowed
> money-path files still authenticating in a `preHandler`, and says they must
> move to `onRequest` before slice 4 enforces them. They move in this diff:
> `agent-passports.ts`'s module-level hook and the four owner routes of
> `agent-connection-setups.ts` (`POST /`, `GET /:setupId`,
> `POST /:setupId/budget-approval`, `POST /:setupId/cancel`) now authenticate in
> `onRequest`, so an anonymous caller gets 401 before any 400 once they are
> enforced. This is pinned by `auth-before-request-validation-3032.test.ts`,
> which enforces both modules and includes an authenticated off-spec control
> that must answer 400. Neither module is enforced yet: `enforcedModules` and
> the default flip stay with the rest of #3032, after #3031. The connector
> routes (`/resolve`, `/register`, `/:setupId/install-status`,
> `/:setupId/connector-status`) authenticate inside their handlers by setup
> token or by the agent API key, and are unchanged. The same diff declares the
> four request fields today's connector and dashboard send (`local_mcp`,
> `mcp_server_name`, `skill_installed`, `superseded_agent_ids`); they are
> loosenings, so nothing that is accepted today is refused. Scope of this note:
> those two files and those four fields. Nothing else in this document was
> re-verified.

## 10. The edge signer's signing surface (#3272)

The agent's delegate key lives in `@haven_ai/signer` on the user's machine. For
most of the rail's life, `haven_sign` would sign **any** EIP-712 typed data it
was handed. The only exceptions were a `Delegation` without a Haven-signed
context (#1476) and a bare hash (#3169). It worked as a signing oracle: on
2026-09-24 it returned a valid signature over a made-up `Probe` message
(`primaryType: "Probe"`, no `verifyingContract`). Since #3272 the MCP tool
layer signs only these shapes, and refuses everything else with
`TYPED_DATA_NOT_ALLOWED` (no signature, no audit entry):

- **A direct-payment `PackedUserOperation`**, only when all of these hold:
  - it passes the #3271 binding check;
  - its chain has pinned delegation contracts (Base, Base Sepolia);
  - its sender is the signer's OWN delegate account: the counterfactual
    HybridDeleGator for the delegate key, derived offline by CREATE2 in
    `packages/signer/src/delegate-account.ts` and pinned to the MetaMask kit;
  - its `callData` is a single `execute` to the DelegationManager calling
    `redeemDelegations`, with exactly one delegation: a single grant made to
    this account by a different account, in
    `SingleDefault` mode, canonically encoded (`redemption-guard.ts`).
- **An erc7710 settlement child or an EIP-3009 funding leg**, against a
  Haven-signed expected context (versions 2 and 3 only; the bare-hash v1
  context was removed in #3272).
- **The EIP-3009 merchant header**, against the recorded binding.
- **The sweep home**, against Haven's recovery binding.

The core's `signDelegationTypedData` remains a verbatim primitive for embedders.
The allowlist lives in the tool layer, and an embedder calling the core
directly owns that check.

**The blast-radius questions #3272 asked, and where each now stands:**

- **The delegate wallet's token balance.** The EIP-3009 bridge funds the
  delegate EOA, so a `TransferWithAuthorization` or USDC `Permit` signed
  through the old oracle could move that balance. A max-value `Permit` would
  also have covered every future funding leg. **Closed for an updated signer:**
  neither is a `PackedUserOperation`, so both are refused (pinned by the signer's
  tests).
- **Capture of the delegate account.** `transferOwnership`, `updateSigners`
  and `addKey` on the HybridDeleGator are `onlyEntryPointOrSelf` (upstream
  MetaMask delegation-framework v1.3.0, read against the source, not the
  deployed bytecode), so a UserOp the account executes on itself reaches
  them. That can happen two ways, and an updated signer refuses both:
  - A direct self-call (`execute` targeting the account itself) is refused,
    because the only permitted target is the DelegationManager.
  - A self-call smuggled through `redeemDelegations` is refused too. In
    v1.3.0, a redemption with an EMPTY permission context is self-authorised:
    the DelegationManager calls `executeFromExecutor` on the caller, which runs
    any execution as the account. The #3272 review reproduced exactly that
    capture against an early version of the allowlist, which checked only the
    function selector.

  The allowlist therefore decodes the redemption. It must carry exactly one
  permission context holding exactly one delegation: a grant to this signer's
  own account from a different account, in `SingleDefault` mode, with every
  level canonically encoded. An empty chain, a multi-link chain, a
  self-granted delegation and a delegation to another account are each
  refused, and each case is pinned by a test. The
  treasury was never exposed beyond the caveats either way: budget, recipient
  pin and expiry are enforced by the DelegationManager on redemption. A
  captured delegate account would still have been able to redeem the budget
  every period until the owner revoked it.
- **ERC-1271.** `isValidSignature` is on the ABI. Whether the account accepts a
  plain owner ECDSA signature over a raw digest, without ERC-7739 wrapping, is
  **not verified in this repository**. **Reduced for an updated signer:** it
  now signs only EIP-712 digests in the HybridDeleGator `PackedUserOperation`
  domain of its own account (plus the Haven-bound x402, header and sweep
  payloads), not arbitrary digests a protocol could present for a 1271 check.
- **Installed signers.** A signer installed before #3272 keeps the oracle until
  it is upgraded. Haven cannot gate that: the attack never passes through
  Haven, and the hosted MCP cannot see the signer's handshake. Credential
  rotation does not help, because the new key lands in the same old signer. The
  remedy is the signer upgrade (a connector re-run), carried by the release
  notes (`packages/signer/CHANGELOG.md`).

> **Scope of this section:** written for #3272 against the signer at that
> change. The rest of this document was not re-read for it, and
> `last-verified` is not bumped.
