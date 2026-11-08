---
owner: "@d-hinders"
status: current
contract: true
covers:
  - packages/backend/src/middleware/owner-cli.ts
  - packages/backend/src/domain/user-signers.ts
  - packages/backend/src/domain/x402-settlement-timing.ts
  - packages/backend/src/routes/user.ts
  - packages/frontend/src/components/PasskeyElsewhereHint.tsx
  - packages/backend/src/infra/repositories/merchants.ts
  - packages/backend/src/modules/catalog/merchant-catalog.ts
  - packages/backend/src/db/migrations/101_merchant_pay_to.ts
  - packages/backend/src/routes/merchants.ts
  - packages/backend/src/infra/repositories/delegation-budgets.ts
  - packages/backend/src/modules/mpp/budget-precheck.ts
  - packages/mcp-server/src/tools/support/quote-response.ts
  - packages/sdk/src/delegate-account.ts
  - packages/sdk/src/redemption-guard.ts
  - packages/sdk/src/direct-payment-guard.ts
  - packages/sdk/src/settlement-child.ts
  - packages/sdk/src/task-budget-guards.ts
  - packages/sdk/src/sub-budget-guards.ts
  - packages/sdk/src/userop-binding.ts
  - packages/sdk/src/client.ts
  - packages/sdk/src/receipt.ts
  - packages/sdk/src/x402-erc7710.ts
  - packages/sdk/src/x402-funding-leg.ts
  - packages/sdk/src/delegate-sweep.ts
  - packages/signer/src/tools.ts
  - packages/signer/src/core.ts
  - packages/signer/src/no-funding-leg.ts
  - packages/sdk/src/x402.ts
  - packages/backend/src/modules/x402/x402-delegation.ts
  - packages/backend/src/modules/x402/delegation-authorize.ts
  - packages/backend/src/rails/delegation-policy.ts
  - packages/backend/src/infra/chain/settlement-transfer-verifier.ts
  - packages/backend/src/middleware/auth.ts
  - packages/backend/src/routes/auth.ts
  - packages/backend/src/infra/repositories/device-authorizations.ts
  - packages/backend/src/db/migrations/078_device_authorizations.ts
  - packages/backend/src/routes/agent-delegations.ts
  - packages/backend/src/routes/agent-rekey.ts
  - packages/backend/src/infra/repositories/agent-rekeys.ts
  - packages/backend/src/infra/transaction.ts
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
  - packages/frontend/src/components/NewAccountDialog.tsx
  - packages/frontend/src/lib/new-account.ts
  - packages/frontend/src/lib/signer.ts
  - packages/frontend/src/hooks/useAccountOperationGate.ts
  - packages/frontend/src/components/DelegationSendModal.tsx
  - packages/frontend/src/components/DelegationBudgetCard.tsx
  - packages/frontend/src/components/haven/BudgetMeter.tsx
  - packages/qa-agent/src/pilot/delegation-budget-spike.ts
  - packages/backend/src/modules/passport/attestation.ts
  - packages/backend/src/modules/passport/revocation.ts
  - packages/backend/src/modules/passport/issuance.ts
  - packages/backend/src/infra/repositories/agent-passports.ts
  - packages/backend/src/routes/ops.ts
  - packages/backend/src/modules/ops/**
  - packages/backend/src/middleware/ops-auth.ts
  - packages/ops/**
  - packages/frontend/scripts/check-kit-analytics-define.mjs
last-verified: "2026-11-06"
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
surface is not among the filtered queries: `LIST_BASIC_ACCOUNTS_FOR_USER_SQL` and
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
2. **Authority is a signed object, not account state.** A Smart Sessions
   grant lives in account storage; a delegation is a **signed message, and
   not a secret one**: Haven stores it and every redemption publishes it in
   its calldata. Different theft model: the delegate key is what must be
   protected — once the agent has paid under a budget, the key alone spends,
   but only within the caveat stack (§3 leak table; #4377 note in §3).
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
| 9a | *(new, #1061)* **Redaction covers the shapes vendors actually use** | `redactVendorSecrets` catches `apikey=`/`api_key=`/`api-key=`/`key=`/`token=`/`secret=` query params, URL basic-auth (`https://user:pass@host`), and key-in-path segments (`/rpc/<token>`, `/v2/<token>`) — not just the one `apikey=` spelling. Since #3371 an RPC URL's key does not reach those patterns at all: the failover transport (`infra/chain/rpc-transport.ts`) scrubs viem's request errors in place, deriving the key-like segments from every configured endpoint URL (dRPC path, `dkey=`, `/v3/`, `/v2/`, QuickNode) | Unit tests on the redactor; transport scrub tests on `rpc-transport` |
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

**Passport UID repair and recovery (#3395) — reads stay read-only; refusals
keep the record honest:** the anchor-UID repair sweep and the #1043 recovery
write only to `agent_passports` (the CAS UID swap, the confirmation and
pacing stamps), never to any payment, budget or authority surface, and they
never sign or broadcast anything. Their authority relevance is narrower: a
UID is written only from an `Attested` log the proven-ours reader accepts
(pinned schema, attested by the mined tx's own sender, tx targeting the
pinned EAS contract), and every row the sweep cannot answer is paced out of
the head on a dedicated column (`uid_repair_next_at`) rather than re-taken
every tick — pacing cannot widen any client's powers and cannot reorder what
the merchant verifier is handed (it never touches `updated_at`, the column
that verifier breaks ties on). Two #3342 residuals are named rather than
handled and live in the passport doc: a reorg between a fresh revoke's
mining and its head-read confirmation could mark a row `confirmed` for an
attestation the reorg resurrected, and a schema re-registration makes
pre-existing rows permanently unrepairable until they are re-anchored.
Neither moves spend authority; both are passport-record correctness, and the
second is an owner-runbook obligation on re-registration.

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

The sponsored-UserOp gas of the PAYMENT path is a separate ledger, not rows in
that table (#3837, migration `sponsored_userop_gas_events`): every UserOp
submitted through `submitDelegationPayment` (both direct payments and the x402
EIP-3009 funding leg) records its EntryPoint `actualGasCost` there, including a
landed-but-reverted op and a cost-NULL `receipt_unconfirmed` one. It is
monitoring only — no budget counts it, no reader of `relayer_gas_events`
(`gas_sponsored_ops`, `relayerSpendSummary`, `assertRelayerBudget`) sees it —
and a recording failure is swallowed: metrics can never gate a payment. See
`docs/operations/sponsored-gas.md`.

## 3. Delegation custody semantics (#828's contract)

**Where the signed delegation lives:** Haven stores it server-side for
reconstruction, revocation targeting and observability, and embeds it in
every redemption it prepares — inside the UserOp the agent signs for a direct
payment or the EIP-3009 funding leg, and, on erc7710, inside the
`payment_header` the agent forwards to the merchant. On erc7710 a second
Haven-side copy rides the settlement evidence: the SDK's settlement report
posts that header, which is stored in
`machine_payment_evidence.payment_proof_header` and returned to the owner by
`GET /payment-intents/:paymentId/evidence`. Once any redemption under it is
mined, it is also public chain data. No connector credential file stores it.
It is **not** key material — but it is spend-enabling in combination with the
delegate key, so it is stored with the same care as `api_key_hash`-class
data: encrypted at rest, never logged, never in error surfaces. That care is
defence in depth for the window before first use, not a secrecy guarantee:
the delegate key is what must be protected.

**Leak analysis:**

| Compromised | Attacker gets | Bounded by |
|---|---|---|
| Delegation object alone | Nothing — redemption requires the delegate key's signature | — |
| Delegate key alone | The same as the next row once the agent has paid under a budget, on any rail: every redemption carries the owner-signed chain in its `redeemDelegations` calldata (public once mined, and seen before that by the bundler, by the merchant and facilitator on erc7710, and by the agent's signer), so treat the delegation as public. Before the first redemption: nothing beyond existing agent-credential risk (the sign-context read needs the API key). In either phase, plus any delegate-EOA residue the EIP-3009 bridge left (§8, compensating control 1), which the budget already metered at the funding hop | As the next row |
| Both (agent fully compromised) | Spend **within the caveat stack**: ≤ each budget's period amount per period, only to pinned recipients (any recipient for an open budget, which the EIP-3009 bridge requires), until expiry or revocation | `ERC20PeriodTransferEnforcer` + `allowedCalldata` when pinned + `Timestamp`; owner kill-switch `disableDelegation` |
| Haven fully compromised | Constructs malicious payloads but **cannot sign** grants, redemptions, or upgrades (invariants 3/5/7/11/12); worst case = denial of service | The perimeter this doc exists to prove |

Blast radius on full agent compromise is therefore bounded by the sum of every
enabled budget delegation's period amount per period: each slot's live grant (a
re-keyed agent's carry/steady pair sits in one slot) and every `replaced` row
until its Stop lands (see the #3933 bullet below). Each spends only to its
pinned recipient, or to any recipient for an open budget, and revocation is one
`disableDelegation` away.

**Batch revocation (#1400):** `POST /agents/:id/delegations/revoke-all`
prepares ONE UserOp batching a `disableDelegation` call per still-enabled
delegation (`prepareCalls`, `ExecutionMode.BatchDefault` — atomic: all
disable or none do; "still enabled" spans `pending`, `active` AND `replaced`
rows since #3343 — a replaced row's delegation is live until its own disable
lands). The owner signs that UserOp exactly as a single revoke; Haven still
cannot sign it (invariant 3 unchanged). Fail-closed ordering: the DB rows
flip to `revoked` only AFTER the UserOp lands, so a crash window can leave
on-chain-disabled rows still marked active (a directionally safe surplus — a
later redemption attempt reverts on-chain), never the reverse. What makes
that ordering honest is the CALldata binding (#3343): a submit route records
`revoked` only after its server verifies the signed UserOp's calldata —
decoded from the account's `execute` envelope, selector-checked — actually
disables the delegation(s) it is about to mark, by `delegationIdentity`
(signature excluded), against the set the SERVER derives (`pending`/`active`/
`replaced`), not a client-supplied hash list. The per-hash route refuses an
op that does not disable its one row (400, before submission); revoke-all and
the re-key revoke refuse an op that does not disable exactly the server's
whole still-enabled set (409 re-prepare — the re-key stays at `preflight`,
its point of no return). The client pairing of a userop with delegation
hashes, and any client-supplied hash list, are not trusted inputs. Because
`disableDelegation` is NOT idempotent (`AlreadyDisabled` revert) and
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

An abandoned re-key can still leave a slot holding two pending rows at once —
its own inert re-key replacement plus a later ordinary build's row — because
re-key rows are excluded from reuse (#3386) rather than merged with it. No
Haven flow presents that re-key row for signing again, so it is a leftover,
not a second live offer, and a later re-key revokes it along with every
other non-revoked row (`pending` included) before it can complete. A re-key's
own `pending` replacement rows cannot be activated outside that re-key's own
completion (`ACTIVATE_REKEY_DELEGATION_SQL` inside `completeRekey`): the raw
activate route (`POST /agents/:id/delegations/:hash/activate`) refuses any
row with `rekey_id IS NOT NULL` before the slot sweep, with the same filter
kept in `ACTIVATE_PENDING_DELEGATION_SQL` as a backstop. This does not claim
such a row can never be *signed* — an owner who still holds a stale payload
can sign it — only that a signed one is never accepted through the ordinary
route. Separately, the stalled-issue race that could plant one of these rows
in the first place is closed: `insertRekeyDelegation` re-checks the inserting
re-key's OWN stage (must still be `metered`) under the agent-row lock, not
merely that *some* re-key of the agent is in flight, so a stalled issue
request for an abandoned re-key can no longer insert rows while a different,
successor re-key is the one actually in flight (#3439).

**Merchant-locked budgets (#3331).** A budget built with `merchant_slug` is an
ordinary recipient-pinned budget whose pin the server fills with the
merchant's verified payTo on the agent's chain. That is the one address every
active, verified x402 operator offer of the merchant there names in its own
402 challenge (`merchant_catalog.pay_to`, recorded by the read-only catalog
probe). The client does not choose it: a sent `recipient_address` must equal
it (409 otherwise). No merchant-locked budget is issued when:
- the merchant has no such offer on the agent's chain;
- the offers disagree, or one of them names no payTo;
- another merchant's non-delisted offer on that network names the same
  address (`shared`);
- any of the offers lacks ERC-7710, read per the offer's own RECORDED
  network — `merchant_catalog.asset_transfer_methods` reflects only the
  `accepts[]` options on that row's recorded network that the pay path
  could settle (#3386, #4389; the same network scoping `pay_to` uses), so an
  offer probed on a network where the
  merchant only accepts EIP-3009 counts as lacking ERC-7710 there even if a
  DIFFERENT network's challenge names it. A pinned budget cannot pay an
  EIP-3009 merchant, per the rule in §8 below;
- the payTo is one of the agent's own addresses: its delegate key, its
  delegate account or its treasury.

The payTo is the merchant's word, not the owner's. A payTo equal to the
delegate key would pin the grant to the EIP-3009 funding leg's recipient,
which the bridge selects before the open budget. The budget would then fund
payments to any merchant. `agent_delegations.merchant_id` is a label, not a
caveat, so the authority is still the signed caveat stack and nothing else.

Two limits are deliberate:
- **Slot sharing.** A merchant-locked budget and a plain budget pinned to the
  same address share one `(agent, token, recipient)` slot. Activating either
  replaces the other; both carry the same on-chain authority.
- **Rotation.** A later payTo rotation never re-points a signed grant. The
  budget stays pinned to the address the owner signed for, and the merchant
  page reports it `stale`.

**Archiving cannot hide a live delegation agent (#1436).** "Removed" is a
promise about spending, so the database enforces the delegation path:
`ARCHIVE_AGENT_SQL` requires `status='revoked'` **and** `NOT EXISTS` any
live row in `agent_delegations`, in one statement. Since #3542 "live" is
`pending`, `active` **and** `replaced` — one shared predicate
(`stillEnabledDelegationSql`, defined beside the payment-path
`spendableDelegationSql` in `infra/repositories/delegation-budgets.ts`)
behind the `revoke-all` target list, the
account-delete guard and the `live_delegation_count` on agent reads — because a
`replaced` row stays redeemable until its own disable lands. Revoking flips
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
the account unlink route (`DELETE /user/accounts/:accountId`) refuses with
`409` while any of the account's agents has a live delegation — `pending`,
`active` or `replaced`, the same `stillEnabledDelegationSql` predicate — or a
recovery sweep that is `prepared` or `submitting`, so an in-flight live
operation cannot lose its account binding. The guard only ever
REFUSES or files a record — it grants nothing, signs nothing, and touches no
chain.

The unlink guard also refuses while an agent re-key is in flight, so the
account binding cannot disappear between re-key stages. This is a database
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

**The credential revoke accepts `pending_approval` (#3544).** The owner's
`POST /agents/:id/revoke` also retires a connect-modal agent still awaiting its
first budget: `REVOKE_AGENT_SQL` matches `status IN ('active', 'paused',
'pending_approval')`. The widen is safe because nothing re-activates a revoked
agent — an audit of every `UPDATE agents` writing `status = 'active'` found
exactly three writers (`RESUME_AGENT_SQL`, requiring `paused`;
`ACTIVATE_AGENT_SQL`, requiring `pending_approval`/`active`; the first-budget
activation, requiring `pending_approval` behind the locked read
`lockOwnedNonRevokedDelegationAgent`), and none matches `revoked`. The revoke
is also where the agent's open connection setup retires: the same transaction
cancels a setup still in `awaiting_connection`, `connected_local` or
`awaiting_wallet_approval`, so a connect flow that has not finished cannot
approve a budget for an agent that no longer exists; a setup that already
carries an approval transaction hash is left for its existing refusal paths —
the cancel does not reclassify evidence the setup state machine wrote. The
setup-side half-apply is closed with it: `applyApprovalState` abandons its
whole transaction when an intended `ACTIVATE_AGENT_SQL` matched zero rows, so
an approval can never commit a setup `active` next to a revoked agent. The
credential's `api_key_hash` is kept, so sweep recovery for a stranded delegate
balance keeps working (the setup-cancel abort path's own
`REVOKE_PENDING_AGENT_SQL` still nulls the key inside that flow; the dashboard
revoke deliberately does not fork toward it, and a regression pin holds the
difference). Authority only narrows: a `pending_approval` agent has no spend
authority to begin with, the widened revoke ends the one thing it could become,
and the refusal contract is typed — 404 for an agent the owner does not have,
409 `error_code: already_revoked` for "already done", 409 `not_revocable` for
any other owned-but-unrevocable status.

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
- The Send dialog's Review screen (#4641) is a **confirmation the user reads
  before the passkey prompt**, not an approval hold: nothing queues, and the
  payment still executes, or reverts on-chain, exactly as before. Copy must not
  imply a second signature or a pending approval — the owner-signed delegation
  is the approval, and the review step only shows what is about to be signed.

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
without an existing signer's signature (invariant 13 unchanged). Since #3825
`GET /user/signers` lists the same material across all of the caller's live
delegation-rail accounts — each passkey (by `key_id`) and owner wallet once,
with the accounts it approves — for Settings → Signers. Its signer material is
`key_id`, owner address and enrollment time only (no P256 coordinates), next to
each approved account's id, address, name and chain; it is scoped to the
authenticated user, and is equally a read.

**Management surface (#1081).** Signer changes are reachable the same two ways:
agent-scoped (`/agents/:id/account-signers/{prepare,submit}`, #888) and
account-scoped (`POST /accounts/hybrid/:address/signers/{prepare,submit}`), the
latter so an account with **zero agents** can enrol its second signer before
anything else exists — which is when the backup-signer recommendation
(#908→#1153) matters most.
**The frontend now uses the account-scoped surface exclusively (#1089):**
`AccountSignersCard` is the single home for backup & recovery, rendered on the
account page's **Security & details** tab (#4097) for any `delegator_hybrid`
account — including one with zero agents — and no longer duplicated on the
agent page. The agent-scoped route
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
case changed; the fallback credential is **disclosed** before any ceremony.
That disclosure was the wallet menu's (#1952's rendering) until #3825 took the
wallet pill out of the top bar; since then each owner-signing flow renders the
shared `PasskeyElsewhereHint` line itself — "This account's passkey may be on
another device" — whenever the passkey path is the one that will sign and no
enrolled passkey is marked on this device (owner decision 2026-10-09). With the
owner wallet connected the EOA signs and no hint shows. This
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
into `no_signer`. The distinct kind changes what the UI *says* — the wallet
pill (in the connect flow's approval step; #3825 removed it from the header)
and the action-area caption name the mismatch instead of asking
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

### 6b. Several accounts behind one passkey (route B, #4024, epic #4022)

Since #4023 (S1) one passkey can own several accounts, each at its own
per-account deploy salt, and since #4024 (S2) the Accounts screen's
**New account** dialog creates one. Owner decision 2026-10-16 ("route B"):
the new account uses the signed-in user's **existing** passkey; there is no
new passkey ceremony. Two consequences belong in this model, and both were
confirmed by the owner with the epic's threat model.

**The route-B residual: one passkey compromise reaches every account that
shares it.** Accounts created from the same passkey share an owner key. Whoever
can produce assertions from that credential can sign for every one of them:
grant a budget, send the funds, change the signer set. Splitting funds across
accounts isolates them from **agents** (an account with no budget delegation
cannot be debited by any agent, whatever Haven's database says) and from a
misconfigured budget on another account. It does **not** isolate them from the
loss or compromise of the passkey itself. Isolating against that needs a
separate signer per account (route A), which is out of v1 scope. The dialog
says the passkey just used becomes the new account's only way to approve; it
does not claim the accounts are independent of that passkey.

**The key choice is the client's; the server checks membership, not an
assertion.** The create-additional request names `source_account_id` and
`key_id`. The server verifies that the source is an account the caller owns
and that `key_id` is one of **that account's** stored passkeys, then copies
that passkey's public coordinates from its own signer-set row. It never takes
key material from the request, and it does **not** receive or verify a
WebAuthn assertion. The authentication is the dashboard session JWT, the
same as every other owner route. The dialog's single
`navigator.credentials.get` is restricted to the source account's credential
ids, so the user picks the key with the device that holds it, and the returned
credential id becomes `key_id`. That assertion is a **choice of key, not a
proof** to Haven. What this permits is bounded: a holder of the session can
only make a key the user **already** holds on one account the sole signer of a
new, empty account the user also owns. No key enters a signer set that was not
already in one of the user's, nothing is funded, and no delegation, agent or
budget is copied (a new account starts with none, and is never the default, so
no agent created without an `account_id` falls back to it). A retried create
carrying the same `idempotency_key` is answered from the caller's OWN first
account before any of these checks run (#4024) — so a lost response is never
re-reported as a cap or source refusal — and a key reused for a different
chain or passkey is refused (409 `IDEMPOTENCY_KEY_REUSED`, with the existing
account's id). So a replay only ever returns one of the caller's OWN accounts
that carries that key, on the same chain and with that same passkey —
normally the first attempt of the same create. (The signup shape stores a key
it is sent too, and never replays it; a create-additional that reused such a
key with that account's passkey would replay that signup account, which is
still the caller's own.) The same answer applies when two attempts with one
key race inside their transactions: the one that loses on the key's unique
index re-reads the committed winner and answers it (or the 409), and its own
counter bump rolls back. Every refusal on
this path carries an `error_code` (`SOURCE_ACCOUNT_NOT_FOUND`,
`SOURCE_HAS_NO_PASSKEY`, `KEY_NOT_ON_SOURCE`, `ACCOUNT_CAP_REACHED`).

**Backups do not carry over.** Only the one named passkey is copied. A backup
passkey or wallet on the source account is not added to the new one, so the
new account starts **single-signer** and §7's recommendation applies to it on
its own: the backup prompt follows funding, per account. Settings → Signers
(#3825) lists each signer once with every account it approves, which is
where a user can see that a backup covers one account and not another.

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

**Per account (#4024).** The recommendation is evaluated per account, because
the signer set is per account: an account created from the New account
dialog copies one passkey and no backups (§6b), so it starts single-signer even
when the account it was created from has a backup.

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
  every other writer that lock serializes (account unlink, re-key open, re-key
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
- **A plain grant cannot replace a live one (#3933).** The activation sweep
  above marks the slot's previous grants `replaced` in the database only; each
  stays enabled on-chain until the owner's Stop lands — redeemable outside
  Haven by the agent's delegate key, or by a sub-budget grantee whose chain
  ends in it. Only the edit flow (grant, then Stop) ever submitted that Stop.
  So since #3933 `build` and `activate` refuse a grant into a (token,
  recipient) slot that holds a live budget — `active` and unexpired,
  `spendableDelegationSql` without its started-window clause — with 409
  `BUDGET_SLOT_OCCUPIED` and the budget to edit (`existing_delegation_hash`,
  plus every live row in `occupying_delegation_hashes`), unless `replaces`
  names exactly the slot's live rows — every one, and nothing else. A
  re-keyed agent's budget is a carry/steady pair, both live in one slot and
  both swept, so naming one half is refused: the set the edit Stops is the
  set activate sweeps. Activate decides under the agent lock, so a client
  cannot get a silent replace by omitting the field, naming part of the slot,
  or racing a second activation. An edit that changes the recipient is a new
  grant into the (empty) target slot — no `replaces`, no sweep — followed by
  the Stop of every row of the old slot; the old budget stays `active`, and
  shown as such, until that Stop lands. A client that names the right set
  and never Stops still leaves the old rows enabled; the server cannot
  enforce the Stop, which is why the finish action exists. The invariant (owner-confirmed, 2026-10-14): once an owner flow
  that replaces a budget completes, at most one unexpired budget delegation
  per slot is enabled on-chain, and a Stop that did not land is shown with a
  way to finish. It is per slot: it does not bound open-plus-pinned or
  shared-payTo authority. Grants left enabled by replaces before #3933 stay
  enabled until the owner stops them; the agent page flags any `replaced`,
  unexpired row with that finish action — except, since #4154, the rows an
  edit flow will Stop while its modal is open (that modal's own
  `revoke_unfinished` screen names them) and, after a finished edit, until
  the reload on close settles; any other close shows the flag at once. Display
  timing only. The owner-facing copy follows the
  rule (#3971): an `unconfirmed` grant no longer warns that a retry adds a
  second budget — the retry re-reads the attempt, and build/activate refuse
  a second live budget in the slot — and the fund-merchant warning counts
  the Stop signatures the edit will ask for (a re-keyed pair is two). Copy
  only; no request, signature or authority path changes.

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

**Since #3888 the 3009 header's nonce is derived, not random** — and neither
half of that adds authority. The delegate's signed header carries
`nonce = keccak256(utf8("haven-x402-payment-nonce:") || utf8(payment_id))`
(`deriveX402PaymentNonce`, SDK edge surface; the signer overwrites the nonce
on the unsigned payload the x402 library prepared, so the typed data it signs
stays the library's own). `payment_id` is already inside the Haven-signed
binding the signer verifies, so the signer gains no new input from Haven, and
the derivation grants no spend capability — it only makes the settlement
ATTRIBUTABLE. The backend's settlement sweep reads the pinned token's
`AuthorizationUsed(delegate, derived nonce)` log (read-only chain
observation, bounded block ranges, fail-closed on any RPC failure) and hands
the transaction it finds to the same on-chain verifier and guarded writer the
the agent-reported path uses; it moves no money and grants nothing. Accepted
residuals (stated on #3888): a party controlling `payment_id` can
force a nonce collision with an earlier authorization from the same delegate
EOA, which makes EIP-3009 refuse the later settlement on-chain — denial of
that ONE payment, not a double spend; and the derived nonce makes payments
publicly linkable to Haven, which the delegate EOA's funding legs already
are. A fixed nonce also closes the #3475 re-pay hazard for new signers: a
resumed payment re-signs the same nonce, so a settled payment is refused as
already used instead of paying twice.

**2026-10-23 (#4319): the settlement record's proof strength is a ladder, and
its weakest rung is still fail-closed.** The receipt-hash attribution (Tier
2) records a settlement WITHOUT a nonce proof — the merchant receipt's
`transaction` — under `HAVEN_EIP3009_RECEIPT_ATTRIBUTION` (default off) and
seven limits, every one refusing closed: fallback-only behind the existing
compare-and-set; exactly one `AuthorizationUsed(delegate, *)` burn in the
candidate's receipt, fed to the same verifier (check 9 included); a burned
nonce that is any sibling's derived nonce refused; a symmetric by-block
ambiguity guard over same-shape siblings funded at or before the candidate
(they must be provably settled before this payment's funding); the candidate
must burn before the delegate's next funding; the refusal stands while this
payment's derived nonce is burned elsewhere (the sweep's stronger proof
outranks the weaker one); and the verdict is persisted
(`merchant_settlement_receipt_verdict`), refused verdicts final. The record
is labelled `merchant_settlement_proof: 'receipt'` and never stamps
`merchant_settlement_nonce_bound`. Nothing here adds authority: the path
reads the chain, verifies a pull, and writes metadata — it moves no money and
cannot re-sign anything (the re-sign gate keys on a recorded hash, which a
refused attribution never writes). Tier 1 (a stored signed header) is the
#3925 standard, ungated.

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
- **The child can be a bearer instrument, and the doc says so.** It is issued
  to `ANY_BENEFICIARY`; the redeemer *caveat* is the constraint that narrows
  it. Since [#1058](https://github.com/d-hinders/Haven-AI/issues/1058) the SDK
  forwards the address-shaped entries of a 402's `extra.facilitatorAddresses`
  into authorize, and the child is then redeemable only by those addresses.
  The child is unpinned, and so a bearer instrument, whenever authorize
  receives no `facilitatorAddresses`: the merchant advertised none; every
  advertised entry was malformed and the SDK dropped it
  (`x402FacilitatorAddresses`); or a direct API caller omitted them, which
  the backend allows (`pinsAdvertised` accepts an empty pin set). Either way
  the real guarantee is the caveat stack, not the recipient: exact amount,
  payee-pinned, ≤600 s expiry. Worst case on a leaked child is "the merchant is
  paid without delivering" for that one quoted amount — the leak-analysis table
  in §3 is unchanged, since redeeming still cannot exceed those bounds.

**The ops console is a third read surface, and it holds no rail authority
(#3507 epic, deploy slice #3517).** `@haven/ops` — a separate app with its
own Vercel project and runbook
([`../operations/ops-console.md`](../operations/ops-console.md)) — reaches a
backend's `/ops/*` routes only. Every route sits behind a bearer-token auth
hook (`middleware/ops-auth.ts`): an ops JWT minted by that backend's GitHub
sign-in, HS256-pinned to the ops audience and this backend's issuer (so a
dashboard JWT, an owner-CLI token or an agent credential never passes), with
the operator's numeric GitHub id re-checked against the allowlist on every
request. The surface is read-and-reveal over the read-only Postgres role —
no route under `/ops` moves funds, signs, redeems, changes a signer,
delegation or credential, or acts as a user; even `POST /ops/reveal` only
reads one allowlisted column and records the read first. It is a
founders-only window, not a delegation-rail participant: no op this document
guards runs through it, and its authority-relevance ends at what its
operator may LOOK at. Deploy wiring and the per-environment checklist live
in the runbook, not here. The app's own browser hardening is an enforcing
Content-Security-Policy whose scripts are gated on a per-request nonce set
by its middleware (#3581; the first static form refused Next's own inline
scripts and the console rendered blank). That is client-side defence for
the token in `sessionStorage` and moves no authority; the rest of this
document was not re-read for it, and `last-verified` is not bumped. The
app's Vercel ignore-build step (#3591; since #3594 a script shared with
the dashboard's Vercel project, each with its own watch file) decides
only *when* the console or the dashboard redeploys, from what changed since
its last deployment. That includes a `preview/*` branch's first preview fetching `dev` from
the repository's public URL, which is read-only and needs no credential. It
moves no authority either, and the same scope note holds. Since #3681 the
console deploys from `dev` only (`git.deploymentEnabled`), so no per-PR
console preview exists, and since #3821 the dashboard's
`git.deploymentEnabled` map also limits which branches deploy. The dashboard's
watch file excludes tests and Playwright baselines. The maps and watch files
decide only whether each project deploys and
builds, move
no authority, and the same scope note holds. The console's CI render
smoke (#3583) only proves, in a browser, that the console renders under that
CSP and that the CSP refuses an un-nonced inline script; it moves no
authority, and the same scope note holds.

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
credential/password/email, account provisioning, transfers, writing saved
contacts, and every delegation signature step: `activate`, `revoke/submit`,
`revoke-all` and `revoke-all/submit`. Contacts are there for a different reason from
the rest: a contact grants nothing on-chain, but it is a name the owner trusts when
paying, so an agent that could write one could swap that name onto its own address
(owner decision, 2026-11-04). The session can still read them. It can create an agent and ask for a budget. It cannot
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

## 10. The delegate key's signing surface (#3272, epic #3284)

The agent's delegate key signs in two places: `@haven_ai/signer` on the user's
machine (the MCP tool `haven_sign` and its x402 siblings), and
`HavenClient.signForData` in `@haven_ai/sdk`, which runs in-process for
`pay()`, the x402 funding leg and erc7710 settlement, including inside the
local `@haven_ai/mcp` server. Until #3272 the signer's `haven_sign` signed
**any** EIP-712 typed data it was handed, apart from an unbound `Delegation`
(#1476) and a bare hash (#3169). On 2026-09-24 it returned a valid signature
over a made-up `Probe` message. The SDK signed whatever the Haven API response
contained after only the #3271 binding check.

**Threat model (epic #3284, owner-confirmed 2026-09-24).**

| Actor | Trusted for the signing decision? |
|---|---|
| The account owner's signers and the on-chain enforcers | Yes: they are the real control |
| The agent / caller of the signer | No (#3272) |
| Haven's API responses and the network path to them | No (#3283) |
| Haven's x402 binding key | No (#3281) |

**The invariant:** whatever Haven serves, the delegate key signs nothing that
acts on the delegate smart account beyond redeeming the agent's budget
delegation within its caveats.

**What is signed, in both places, and nothing else.** One implementation in
`@haven_ai/sdk` (`direct-payment-guard.ts`, `redemption-guard.ts`,
`delegate-account.ts`, `settlement-child.ts`, `userop-binding.ts`), which the
signer imports:

- **A redemption `PackedUserOperation`** (a direct payment, or the x402
  EIP-3009 funding leg), only when all of these hold:
  - it passes the #3271 binding against its hash (the direct payment's
    `payload_hash`, or the funding leg's Haven-declared `payloadHash`);
  - its chain has pinned delegation contracts (Base, Base Sepolia);
  - its sender is this key's OWN delegate account: the counterfactual
    HybridDeleGator for the delegate key, derived offline by CREATE2 and
    pinned to the MetaMask kit;
  - its `callData` is a single `execute` to the DelegationManager calling
    `redeemDelegations` with exactly one permission context holding either a
    single grant made to this account by a different account, or — since
    #3329 — a two-link chain whose leaf is a task-budget child this account
    delegated to itself under that grant, or — since #3330 — a three-link
    chain whose leaf is a sub-budget grant TO this account from a different
    account (the delegating agent A) standing under A's own self-delegated
    parent-child of A's budget; in `SingleDefault` mode,
    canonically encoded at every level;
  - **on an x402 funding leg**, its single execution is a `transfer` of the
    quoted amount of the quoted token to this key's own delegate EOA. That
    address is local, not from Haven. The signer checks it on its x402 arm
    (#3281), against the Haven-signed expected context's asset and amount.
    The SDK's own funding leg (`signForData`, #3375) checks it against the
    402 option being paid, never against the `/x402` response.
- **An erc7710 settlement child `Delegation`**, verified against an
  expectation Haven cannot rewrite: payee, amount, token, chain, and an expiry
  of at most 600 seconds. It must not be a ROOT delegation, and it must be
  delegated by this key's own account. The signer checks it against the
  Haven-signed expected context; the SDK checks it against the merchant's own
  402 (payee, amount, token, chain, advertised facilitators).
- **The EIP-3009 merchant header**, against the recorded binding, and only
  from a binding minted for a funding leg (#4242). The binding records which
  of the two x402 shapes above was signed; a settlement-child binding is
  refused, because no funding leg put that amount in the delegate EOA the
  header spends from. `haven_sign_x402` refuses a settlement child before
  signing it. Since #4248 a settlement-child binding is retired at mint and
  never held, so the signer keeps no payment context for it. And **the sweep home**, against Haven's recovery binding (see
  residual 2).
- **A task-budget child `Delegation` (#3329)** — a self-delegation: delegator
  AND delegate are this key's own delegate account, authority is the agent's
  budget delegation (never ROOT), an `erc20TransferAmount` cap on the expected
  token, a `timestamp` caveat of at most 24 hours, and an `allowedCalldata`
  payee pin exactly when a recipient was requested. Verified by
  `assertOwnTaskChild` (`task-budget-guards.ts`) against the Haven-served
  sign-context, which the guard treats as untrusted input the way it treats
  the settlement child's. It is a different typed-data class from the
  settlement child, verified by a different function: a task child is refused
  by `assertOwnSettlementChild` outright, because that verifier now refuses
  any child whose delegate is its own delegator (a self-delegation is never a
  settlement child, whatever its amount, payee or window), and a settlement
  child is refused by `assertOwnTaskChild`; both directions are pinned by
  tests, including a short-lived self-delegated child that matches a
  settlement expectation in every other field. A self-delegated child can only **narrow** what the
  account may already redeem under its budget, never widen it.
- **A `disableDelegation` `PackedUserOperation` for one of those children
  (#3329)** — the same sender, chain and single-`execute`-to-the-
  DelegationManager rules as a redemption, but the inner call is
  `disableDelegation` of a delegation whose delegator and delegate are both
  this account and whose hash Haven's sign-context for that task budget names
  (`assertOwnTaskBudgetCloseUserOp`) — the guard re-derives the hash from the
  bytes in the UserOp and refuses a mismatch, so the context cannot point it
  at a different delegation.
  Authority-reducing only: it cannot disable the owner's budget delegation
  (a different delegator) or anything not self-granted.
- **The redemption allowlist admits one more chain (#3330):** exactly three
  links — `[sub grant, parent child, budget]`, leaf first — where the leaf is
  a grant made TO this account by the delegating agent's account (a real
  grant from elsewhere, never self), the middle link is the delegating
  agent's SELF-delegation (its delegate and delegator are both its own
  account, the task-child shape class), and the budget link keeps the
  one-link shape (a grant to the delegating agent's account from a different
  account). An empty chain, a chain of four or more links, a three-link chain
  whose leaf is self-delegated (a task child never chains two deep), a
  three-link chain whose middle link is not the delegating agent
  self-delegated, or a budget link whose delegator/delegate do not name the
  delegating agent and its own granter stay refused — every case pinned by
  `redemption-guard.test.ts`. The AND-only caveat property again makes the
  three-link chain AS OR MORE restrictive than the two-hop task chain: every
  caveat of all three hops runs in one redemption, so A's period budget binds
  any spend B makes even within B's own allowance (the chain is the
  enforcement). Alongside it, **a sub-budget child `Delegation` (#3330)** —
  the delegating agent's signed narrowing of its own budget (`A`'s
  parent-child, the self-delegated shape) or the grant to agent B's account —
  is verified by `assertOwnSubBudgetChild` (`sub-budget-guards.ts`): pinned
  Delegation/Caveat types and domain, the period-scoped
  `erc20PeriodTransfer` scope (token, periodAmount, the SAME periodDuration
  and startDate as the parent — a slice of the same window, never a different
  clock), a `timestamp` caveat never outliving the parent budget, an
  `allowedCalldata` recipient pin exactly when the parent pins, and
  `delegator` = this signer's own account with `delegate` = the DECLARED child
  delegate (A's own account on the parent-child row, B's on the grant row).
  It refuses the task-budget hard-cap `erc20TransferAmount` shape, the same
  way the task child refuses the period scope. As with #3329, this is the
  AMENDMENT of the §10 one-delegation-per-redeem invariant — never a silent
  loosening: the allowlist grows from "exactly one or two links" (#3329) to
  "exactly one, two or three" with every link's shape pinned, issuance stays
  owner-governed (decision log 2026-09-27, 2026-10-01: the owner issues each
  sub-budget from the dashboard session, with no owner signature; A's
  delegate key only signs within the owner-approved envelope), and a
  sub-budget child can only **narrow** what its parent's caveats already
  allow — periodAmount ≤ the parent's on the same window, expiry ≤ the
  parent's, recipient pin never unpinned — so the three-link chain is never
  wider than the budget it hangs from. The close path gains the same
  authority-reducing `disableDelegation` UserOp for a sub-budget child
  (`assertOwnSubBudgetCloseUserOp`), byte-shape-identical to the task
  budget's.

  > **Corrected (#3645, 2026-10-05):** the issuance parenthetical above said
  > the owner "co-signs" each sub-budget; the owner's act is a
  > dashboard-session call with no owner signature (decision log
  > 2026-10-01). `last-verified` is not bumped.

- **The x402 buyer tax declaration (#3427)** — a new EIP-712 shape, signed
  in-process by the SDK's `HavenClient` through a builder on the
  `@haven_ai/sdk/edge` entry beside the other shared signing guards
  (`tax-declaration.ts`; `@haven_ai/sdk` does not depend on
  `@haven_ai/signer`, so the signer imports the guard with everything else).
  The declaration is attestation only — it moves no funds, authorises nothing,
  and rides the paid EIP-3009 merchant retry to the SELLER as
  `X-Tax-Declaration: <base64url(JSON)>` (never to Haven, never in the payment
  payload, never on erc7710). The local builder assembles the typed data over
  exactly the §2.1 fields; content arriving with `principalId`,
  `principalAttributionHash` or any unknown field is REFUSED
  (`TAX_DECLARATION_REFUSED`), never stripped and signed — the same
  locally-built-shape discipline as the funding leg, with the chain scoped
  from the accepted payment option's `network`, never from configuration, and
  the provisional domain/types pinned by a fixed JCS-vector test. Because the
  declaration self-attributes to the same delegate EOA that signs the payment
  authorization (wg-tax #5 §2.2 signer-is-payer), it cannot widen what the key
  may do; its only power is the owner's own onboarding data attested under the
  owner's own opt-in. The hosted, keyless `completeX402MerchantCall`
  construction binds neither the resolver nor a delegate key, so it is
  structurally header-free.

The signer's x402 arm (#3281) signs only the first two shapes, however validly
Haven's binding key declared anything else. On `haven_sign`, every refusal on
the shape checks, the settlement child's (malformed children included), is
`TYPED_DATA_NOT_ALLOWED`, or `USEROP_BINDING_MISMATCH` for a funding leg whose
hash does not match, and a settlement network the signer cannot map keeps its
own `SIGNING_ERROR`, which asks for a signer update. `haven_sign_x402`
refuses any settlement-child-shaped payload (`isSettlementChildTypedData`),
malformed or not, with `NO_FUNDING_LEG` before any shape check (after the
expected-context version check). `haven_x402_sign_header` answers a
settlement-child binding with `NO_FUNDING_LEG` while that id is among the
last 64 the process retired (`RETIRED_BINDING_MEMORY`); after eviction or a
restart it gets the unknown-binding refusal. Either way nothing is built
(#4242, #4248). In every case nothing is signed, audited or submitted.
In the SDK, a funding-leg refusal (#3375) throws `HavenTypedDataRefusedError`
before the funding leg is signed or posted to `/sign`. The EIP-3009 merchant
header, minted in-process just before (#1521), is discarded and never returned;
the funding intent stays `pending_signature` until it expires.
The core's `signDelegationTypedData`, `HavenClient.sign(hash)` and the SDK's
exported signing primitives stay verbatim, for embedders; the checks are in
`haven_sign`, `signX402FundingTypedData` and `signForData`.

**Accepted residuals** (owner-accepted, epic #3284):

1. **Payments within the budget caveats.** A fully compromised Haven can still
   prepare payments the caveats allow, because preparing payments is what the
   agent delegated to Haven. For a pinned budget that means only the pinned
   recipient. For an open budget it means any recipient, up to the full period
   budget, every period, until expiry or revocation. The funding-leg recipient
   pin narrows this for the EIP-3009 bridge, on the signer's x402 arm (#3281)
   and on the SDK's own funding leg (#3375): under a compromised Haven, a
   funding leg can move budget only into the agent's own EOA. A correctly
   shaped direct payment (`haven_sign` without an x402 context, or the SDK's
   `pay()`) still pays whatever recipient the budget allows, by design.
2. **Delegate-EOA balances.** The bridge's merchant header and
   `haven_sign_sweep_delegate` sign token authorisations over the delegate
   EOA's own transient balance. With no local account address configured, the
   sweep destination rests on Haven's binding signature alone, so a
   compromised binding key could redirect such a balance. The SDK's
   `sweepDelegate()` has the same shape: it sends the delegate balance to
   `getAgent().accountAddress`, which Haven's API serves (#3375 names it; it
   does not close it). This is bounded by the hot-delegate discipline
   (transient balances, sweep).

**The blast-radius questions #3272 asked, and where each now stands:**

- **The delegate wallet's token balance.** The EIP-3009 bridge funds the
  delegate EOA, so a `TransferWithAuthorization` or USDC `Permit` signed
  through the old oracle could move that balance. A max-value `Permit` would
  also have covered every future funding leg. **Closed for an updated signer,
  on every branch:** neither is a signable shape, so both are refused on the
  unbound branch (#3272) and on the x402 arm even when Haven's binding key
  declared them (#3281). Each case is pinned by the signer's tests
  (`server.test.ts` and `x402-arm-guard.test.ts`).
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
  permission context holding either exactly one delegation — a grant to this
  signer's own account from a different account — or, since #3329, that
  grant with a single self-delegated task-budget child in front of it, or,
  since #3330, the three-link sub-budget chain `[sub grant, parent child,
  budget]` (the leaf a grant TO this account from the delegating agent, the
  middle link that agent's self-delegated narrowing of its own budget), in
  `SingleDefault` mode, with every level canonically encoded. An empty chain,
  a chain of four or more links, a two-link chain whose leaf is not
  delegated by this account to itself, a three-link chain whose leaf is
  self-delegated or whose middle link is not the delegating agent
  self-delegated, a self-granted delegation standing
  alone and a delegation to another account are each refused, and each case
  is pinned by a test. The
  treasury was never exposed beyond the caveats either way: budget, recipient
  pin and expiry are enforced by the DelegationManager on redemption. A
  captured delegate account would still have been able to redeem the budget
  every period until the owner revoked it.
- **ERC-1271.** `isValidSignature` is on the ABI. Whether the account accepts a
  plain owner ECDSA signature over a raw digest, without ERC-7739 wrapping, is
  **not verified in this repository**. **Reduced for an updated signer:** it
  now signs only payloads whose meaning is checked in-package: EIP-712 digests
  in the HybridDeleGator `PackedUserOperation` domain of its own account (the
  Haven-bound x402, header and sweep payloads) and — since #3728 — composed
  EIP-4361 Sign-In-With-X messages for the x402 `sign-in-with-x` extension,
  where the signer itself composes the message from grammar-validated
  challenge fields and the address from the key. It still never signs a
  caller-supplied digest or an arbitrary digest a protocol could present for
  a 1271 check.
- **Installed signers.** A signer installed before #3272 keeps the oracle until
  it is upgraded. Haven cannot gate that: the attack never passes through
  Haven, and the hosted MCP cannot see the signer's handshake. Credential
  rotation does not help, because the new key lands in the same old signer. The
  remedy is the signer upgrade, carried by the release notes
  (`packages/signer/CHANGELOG.md`). How an installed machine performs that
  upgrade — the command every update hint names, and which older signers it
  cannot reach — is maintained in
  [`mcp-runtime-compatibility.md`](../operations/mcp-runtime-compatibility.md)
  § *Client-version signal*.

> **Scope of this section:** written for #3272 and rewritten once for epic
> #3284 (#3283, #3281) against the signer and SDK at those changes; #3375
> (the epic's third slice) then updated the funding-leg pin and the two
> residuals above. The rest of this document was not re-read for it, and
> `last-verified` is not bumped.

> **#3830 (2026-10-09).** The connect modal's other-agents card no longer
> revokes: it lists the owner's not-revoked agents from the connector's report
> with a link to each agent page (owner decision), so the "replaced-agents
> card" path in the #3542 note (archived) is gone. The Remove dialog and Finish
> revoking flows it describes are unchanged. Nothing else here was re-read.

> **#3553 (2026-10-01).** Sub-budget issuance (`POST /agents/:id/sub-budgets`)
> and the owner's signature relay (`POST /agents/:id/sub-budgets/:sub/sign`)
> now refuse a revoked or archived issuing agent with 409 `issuer_retired`,
> before the handler's body checks, and issuance refuses a revoked, archived or
> `pending_approval` receiving agent with 409 `sub_agent_retired`. Opening a
> grant row is refused with the same code when its receiving agent is retired,
> in both the owner relay and the agent's `POST /sub-budgets/:id/submit` (the
> row stays pending; close submits are never gated). A
> half-revoked issuer could previously have new sub-budgets carved from its
> still-active budget, and the relay would open a `pending` row with a
> signature made before revocation. The issuer gate sits in the two owner
> routes and the grant gate in `isGrantReceiverRetired` (called from the relay
> and the agent submit); neither is in `loadOwnedDelegationAgent`, so
> authority-reducing routes keep serving retired agents. `paused` passes, as on the delegation routes. The narrowing
> gate and the relay's signer check are unchanged. The rest of this document
> was not re-read for it, and `last-verified` is not bumped.

> **#3531 (2026-10-01).** This diff touches one file in this document's
> coverage list, `packages/sdk/src/client.ts` — `createIntent()` now also
> copies an optional `recipient: { class: 'previously_paid' | 'new_address' }`
> off the raw `POST /payments` response, the same pass-through treatment its
> existing four fields (`paymentId`, `status`, `expiresAt`, `signData`)
> already get. The field is advisory and history-only (owner decision,
> 2026-10-01): computed server-side from the authenticated agent's OWN
> confirmed `payment_intents` rows to the exact recipient address on the
> exact chain, never from `own_account`/contact/catalog lookups — the #3528
> `SELF_TRANSFER` hint this document's own sections never adopted was
> withdrawn in full for exactly that reason (it let an agent probe guessed
> addresses for owner-account membership). It sits at the TOP LEVEL of the
> response, never inside `sign_data`/`signData` — the one shape `pay()`'s
> `signForData` call and the signer's binding check act on — and a dedicated
> backend test pins `sign_data` byte-identical across both classes. No
> signature, key, delegation graph, caveat enforcer or on-chain redemption
> path changes: `client.ts`'s role here is
> a verbatim copy of a value it neither computes nor validates. The rest of
> this document was not re-read for it, and `last-verified` is not bumped.

> **#3597 (2026-10-02).** This diff touches one file in this document's
> coverage list, `packages/backend/src/middleware/owner-cli.ts` —
> `OWNER_CLI_ALLOWED_ROUTES` gains two entries for the CLI feedback channel:
> `POST /feedback` (writes one row under the caller's own `user_id`; no
> delegation, no agent, no account authority) and `GET
> /accounts/hybrid/{address}/signers` — the FIRST signer-set READ this
> allow-list has ever granted an owner_cli session (`GET
> /agents/{id}/account-signers`, the agent-scoped twin, is NOT on the list).
> It returns the owner's account address, chain_id, `owner_address` and each
> passkey's `key_id`/`x`/`y`/`created_at` — public key material only,
> ownership-scoped by `user_id` (`resolveOwnedHybridAccount`) — nothing
> secret, no signer-set CHANGE. Neither entry grants a SIGNATURE step,
> a key rotation, a signer-set write, a delegation activation or anything
> that moves funds — the `owner-cli-route-census.test.ts` independent-opinion
> check (the `forbidden` pattern list, including the `^/accounts` and
> `signers?` patterns this file's own comment names) still refuses every
> authority-shaped path by construction; the new GET survives it only
> through a named, commented exemption for this one read. No signature, key,
> delegation graph, caveat enforcer or on-chain redemption path changes. The
> rest of this document was not re-read for it, and `last-verified` is not
> bumped.

> **Decision recorded (#4216, 2026-10-21 — third-party kit analytics are OFF
> in both runtimes).** `@metamask/smart-accounts-kit` 1.6.0 posts usage
> analytics to `https://mm-sdk-analytics.api.cx.metamask.io/` from the first
> of its tracked functions that runs (owner decision: turned off). In the
> backend, `src/telemetry/kit-analytics-off.ts` sets
> `process.env.DO_NOT_TRACK = '1'` and is imported FIRST by `src/index.ts`,
> `vitest.setup.ts` and the kit-reaching `scripts/*.ts` — the kit latches its
> decision once, at the first tracked call, so the opt-out must precede that
> latch. In the frontend, `next.config.ts` inlines `DO_NOT_TRACK: '1'` as a
> bundler define, so the client chunk carries the literal `"1"` where the
> kit's `process.env?.DO_NOT_TRACK` read was (checked over `next build`
> output by `packages/frontend/scripts/check-kit-analytics-define.mjs`, which
> fails if the define is removed). Nothing about signing, authority or the
> prepare/submit split moved: the delegations, smart-account calls and
> signatures the kit produces are byte-identical — only its outbound
> telemetry egress is switched off. `lib/delegationPasskeySigner.ts` itself is
> untouched; the dynamic import and `toMetaMaskSmartAccount` call are
> unchanged. Proofs: `src/telemetry/__tests__/kit-analytics-off.test.ts`
> (0 posts with the mechanism, ≥1 without it) and the committed
> `scripts/record-kit-analytics-connections.mjs` net over the backend suite.

> **#4688 (2026-11-05).** This diff touches `packages/mcp-server/src/tools/**`
> and `packages/sdk/src/client.ts` (a comment only) in this document's coverage
> list. `haven_settle_mcp_tool`'s EIP-3009 arm now reports `settled: true` only
> when the merchant-settlement evidence report came back `confirmed`; a
> `retryable`, `refused`, or never-posted report answers `settled: false` with
> `SETTLEMENT_PENDING` / `DELIVERED_UNSETTLED`, a `SETTLEMENT_UNCONFIRMED`
> warning, a null settlement hash, and no `purchase_summary`. Nothing about
> signing, authority, custody or the on-chain redemption path moves: the
> funding signature, the X-PAYMENT header, the delegate allowance and the
> merchant's single-use authorization are byte-identical, and the change only
> stops the tool from CLAIMING a settlement Haven did not verify — it narrows
> what the agent is told, never what it may do. The unverified reason sends the
> agent to `haven_get_payment_status` after the #3888 sweeper's window and
> names `haven_sweep_delegate` only if `merchant_settlement_recorded` is still
> not true then, which is the verify-then-sweep rule this document's §8 already
> states. The rest of this document was not re-read for it, and `last-verified`
> is not bumped.

Historical verification records for this document are kept in the [archive](../archive/re-verification-notes-2026-11.md).

> **#4703 (2026-11-06).** This diff touches
> `packages/frontend/src/components/DelegationSendModal.tsx` in this document's
> coverage list. The change is copy only, on the sent screen's save row: a
> successful save now reads "Saved as <name>" over "Past payments to this
> address now show this name." in its own element. Nothing about signing,
> authority, custody or the prepare/submit split moves — the passkey ceremony,
> the owner-signed delegation and the payment the dialog sends are untouched,
> and the new sentence describes a contact name, not a spend permission. §5's
> copy rules were re-read for it: the line claims no custody, no second
> signature and no pending approval. The rest of this document was not re-read
> for it.

> **#4709 (2026-11-08).** This diff touches `packages/backend/src/routes/user.ts`
> and `packages/backend/src/infra/repositories/dashboard.ts` in this document's
> coverage list. It adds the "Since your last visit" marker (migration 124:
> three nullable `users` columns) and two display-only reads: `POST
> /user/visits` opens one visit entry with a single atomic `UPDATE … RETURNING`
> under the row lock, and `GET /dashboard/since` returns the user's confirmed
> agent payments in `(previous, current]` on the same NET definition and
> `spend.scope` as the 7-day figures. **The marker is never read by a payment
> path.** It records when a person opened the dashboard; it changes no
> delegation, budget, allowance, signer, credential or settlement fact, and it
> grants no authority — the two routes are authenticated reads/writes of the
> caller's own row, tenant-scoped by the JWT subject. The new statement takes
> the existing `DELEGATION_RAIL_JOIN` and `spendNetFactorSql` fragments rather
> than a fourth copy of either, so the rail filter and the #3755 netting are
> the same ones §8 already describes. The rest of this document was not re-read
> for it, and `last-verified` is not bumped.
