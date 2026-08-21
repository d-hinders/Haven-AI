---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/rails/delegation-rail.ts
  - packages/backend/src/rails/delegation-contracts.ts
  - packages/backend/src/rails/hybrid-provisioning.ts
  - packages/backend/src/modules/x402/delegation-authorize.ts
  - packages/backend/src/routes/agent-delegations.ts
  - packages/backend/src/routes/x402.ts
  - packages/backend/scripts/check-delegation-contracts.ts
  - packages/backend/scripts/check-bundler.ts
last-verified: "2026-08-22" # #1745: §3's passport-attest procedure LOSES its duplicate-hunt steps — the re-mint is now guarded in code (a re-anchor needs the prior tx's nonce consumed by something else), so cancelling a stuck nonce can no longer release a queued duplicate, and the cancel is self-completing: the burned nonce IS the evidence the sweep needs. A hand-run fee bump is named as the remaining hazard, since it leaves no outbound record. Prior: #1735: §3 gains a FOURTH failure class — a passport attest that broadcasts and does not confirm, which unlike the deploy does not self-heal; numbered operator runbook added, sequenced around the #1745 re-mint race. Prior: #1722: §3 gains a third failure class — a deploy that broadcasts and does not confirm is bounded at 120 s and handed to the #1558 bump worker, NOT relayer exhaustion; §1's gas-payer claims re-read against the code and unchanged. Prior: #1721: §1 and §3 re-read against the code — the relayer-paid factory deploy now has TWO trigger sites (grant activation in routes/agent-delegations.ts and, since #1667, the first erc7710 authorize in modules/x402/delegation-authorize.ts), so the drained-relayer blast radius and the erc7710 "sponsors nothing" line were corrected and the 502/429 surfaces named. §2 credential claims spot-checked (delegationRailBundlerUrl, DELEGATION_RAIL_SPONSORSHIP_POLICY_ID); §§4-5 are policy/incident prose, unchanged. Prior: re-verified for #1355 (payment_id-only signing: payment_required persisted in machine_metadata + re-served by sign-context; grep-checked: no claim here names the sign-call argument shape; sequence/authority claims unaffected)
---

# Delegation rail — vendor & gas operations (#826, epic #821)

Operational contract for the delegation rail's external dependencies: the
bundler/paymaster (Pimlico) and MetaMask's deployed Delegation Framework
contracts + SDK. Since the session rail's retirement (#834) this is the
**only sponsored rail** and the only live bundler/paymaster runbook (the
[session-rail runbook](session-rail-vendor-ops.md) is archived); the security
model lives in
[`delegation-rail-security-model.md`](../security/delegation-rail-security-model.md).

## 1. Who pays gas, and what that buys

A redemption is a sponsored ERC-4337 UserOp from the **delegate Hybrid
account** (owned by the agent key) calling `redeemDelegations`. The paymaster
pays gas; the agent key holds **no ETH and no tokens**; Haven holds **no key**
(watch-only construction, CI-enforced). Sponsorship can only ever pay gas —
it has no value-transfer surface.

**Measured cost** (Base Sepolia, #820 + the production-lib smoke 2026-07-10):
direct-EOA redemption 209–307k gas; sponsored delegate-account path
**584k cold** (includes the delegate account's one-time deployment) and
**303k warm** (steady state) at 5–8 s bundler latency. The premium over a UserOp
on the retired session rail was the redemption
indirection; the offset is that budgets refill natively (no schedule
machinery to execute).

**Three gas payers, not one.** The paymaster is the largest line, not the
only one:

- **Paymaster (Pimlico)** — every redemption UserOp: `/payments` on the rail,
  treasury ops (revoke), and the EIP-3009 funding leg below.
- **Haven's relayer** — the delegator/treasury Hybrid's **one-time** factory
  deploy (#860, `ensureHybridDeployed`). Two trigger sites, not one: grant
  activation (`routes/agent-delegations.ts`) and — since #1667 — the **first
  erc7710 authorize** for an account that is still counterfactual
  (`modules/x402/delegation-authorize.ts`). The authorize call exists because
  the erc7710 path has no 3009 funding leg to deploy the account as an
  initCode side effect, and a recipient-pinned agent never can have one (those
  budgets are erc7710-only). A 4337 factory call is permissionless, so this is
  a plain relayer transaction, NOT a sponsored op: it draws relayer gas
  balance. Same alerting as every other relayer chain.

  **Blast radius of a drained relayer**: it blocks **grant activation** *and*
  **the first erc7710 payment of any not-yet-deployed account** — not payments
  in general. Payments on an already-deployed account are unaffected, which is
  what keeps the exposure bounded: the deploy is once per account, ever, and
  `ensureHybridDeployed` short-circuits afterwards on a single `getBytecode`.
  Match the symptom by status code on `POST /x402/authorize`: **502**
  ("Could not deploy the delegate account for erc7710 settlement — retry the
  authorize") when the relayer transaction itself fails, e.g. an empty gas
  balance; **429** when the relayer *budget cap* refuses first
  (`RelayerBudgetExceededError` from the `hybrid_deploy` spend guard, #717 —
  a cap, not a balance, so topping up the relayer will not clear it). The
  affected population — brand-new accounts making their first payment — is
  indistinguishable from onboarding simply not working, so do not
  de-prioritise a drained-relayer alert as grants-only.
- **The merchant / facilitator** — erc7710 x402 settlement, below.
- Owner-initiated **sends** (#1083) and signer changes are also
  paymaster-sponsored account ops — roughly one warm-op cost each; they
  draw the same policy budget as payments.

**x402 sponsorship depends on the settlement scheme (#946).** The scheme is
chosen per payment from the `payTo` shape (or an explicit `settlementScheme`)
and recorded in `machine_metadata.settlement_scheme`:

- **`erc7710`** (default and destination) — Haven sponsors **no gas through
  the paymaster**. Authorize builds a narrowed child delegation and runs no
  bundler estimation; the merchant redeems `[child, budget]` and pays that
  gas. It is not free to Haven on the *first* payment of a counterfactual
  account, though: that authorize pays the one-time factory deploy out of
  **relayer** gas (#1667, above). That cost is a relayer line, not a
  sponsorship line — it is bounded at once per account and it does not scale
  with erc7710 volume.
- **`eip3009`** (interop fallback) — Haven sponsors **one extra redemption
  UserOp per payment**: the funding leg treasury → the agent's delegate EOA.
  Budget roughly one warm redemption (~303k gas) per 3009 x402 call, on top of
  ordinary `/payments` traffic. Merchant-pinned budgets can't use this scheme
  at all (they are erc7710-only), so the exposure scales with open-budget
  agents. Terms in the [security model §8](../security/delegation-rail-security-model.md).

A 3009 authorize spends a sponsored bundler **estimation** even when the
payment is never signed, so #961 enforces the per-agent hourly x402 cap
(`agents.max_x402_per_hour`, default 100) on the delegation branch — it is
sponsorship-cost protection, not just API hygiene, and it bounds a single
agent at 100 estimations/hour. Idempotent replays resume from stored state and
run no estimation, so recovery retries cost nothing.

## 2. Credentials & policies

- `DELEGATION_RAIL_BUNDLER_URL` — SECRET (embeds the API key). REQUIRED and
  fail-closed: the legacy `SESSION_RAIL_BUNDLER_URL` fallback was **removed**
  once both deployed envs migrated (#882), so an unset var throws
  ("delegation rail unavailable") instead of silently borrowing the retired
  rail's credential. The `SESSION_RAIL_*` variables and
  `SCHEDULE_RENEWAL_WEBHOOK_URL` are dead everywhere except the
  `ops:check-bundler` probe (§3). Read in exactly ONE place
  (`delegationRailBundlerUrl`); every error surface passes
  `redactVendorSecrets` (bundler errors echo the URL — the #764 incident).
- `DELEGATION_RAIL_SPONSORSHIP_POLICY_ID` — Pimlico policies bind **per
  request**, not per API key (#738): an unset id means unrestricted
  sponsorship against the key's account. Set it in every deployed env.
- Key rotation: new key in the vendor dashboard → update env → redeploy →
  delete old key (the #738 procedure). One credential, one env var — and
  `ops:check-bundler` reads that same var through the rail's resolver, so the
  probe verifies the rotation rather than a stale copy of it.
- **The URL is chain-scoped by its path** (`…/v2/<chainId>/rpc?...`): one
  deployed environment serves exactly one chain's bundler. The resolver
  refuses a chain the URL does not target (a config error at first use, the
  #1053 guard) — so enabling a second chain means provisioning that chain's
  credential, not just flipping the chain list.

## 3. Failure modes & the degradation contract

**Sponsorship exhaustion / bundler outage degrades to "payments pause" —
never to "policy weakens".** The caveat stack is enforced on-chain at
redemption regardless of who pays gas; when sponsorship declines,
prepare/submit throw and the payment route 502s cleanly with a redacted
error. There is no fallback signer, no retry-with-Haven-funds path, and none
may be added (red line — see the security model).

Blast radius since #946: `/payments` and **3009-mode** x402 pause; **erc7710
x402 keeps working**, because it prepares no sponsored op — the merchant
redeems. A separate outage class is a **drained relayer**, which pauses grant
activation *and* the first erc7710 payment of any not-yet-deployed account
(the delegator deploy, §1 — both trigger sites since #1667), while payments
on already-deployed accounts continue. Symptoms: authorize 502
("Could not deploy the delegate account…") on an empty relayer balance, or
429 when the `hybrid_deploy` budget cap refuses first.

A third, quieter class is a deploy that **broadcasts fine and then does not
confirm** — RPC lag, or a base-fee spike past the doubled headroom the relayer
applies. That is not relayer exhaustion and does not read like it: gas was
available and the transaction is in the mempool. Since
[#1722](https://github.com/d-hinders/Haven-AI/issues/1722) the deploy stops
waiting after 120 s and leaves its outbound record `broadcast` for the bump
worker to adopt and fee-replace, rather than recording a failure for a
transaction that may still mine. The caller sees the same retryable 502 as any
other deploy failure, so operationally this looks like grant activation (or a
first erc7710 authorize) failing and succeeding on retry — check the bump
worker's replacement logs before treating it as a relayer incident.

A fourth class, and the only one that does **not** self-heal: a **passport
attestation that broadcasts and does not confirm**
([#1735](https://github.com/d-hinders/Haven-AI/issues/1735)). The anchor stops
waiting after 120 s and leaves its outbound record `broadcast`, exactly like
the deploy above — but unlike the deploy, the bump worker will **not**
fee-replace it, because a replacement changes the tx hash the anchor's #1043
receipt recovery is keyed off, and a lost hash means Haven re-mints and the
agent ends up with two live credentials. The worker alerts instead:

```
outbound-bump: stuck broadcast from a non-idempotent submitter — NOT replacing it
(its own recovery owns the retry); the relayer nonce lane stays blocked until an
operator intervenes
```

**This blocks the relayer's whole nonce lane on that chain** — every later
deploy, sweep and revoke queues behind it — so it is an incident, not a
warning. Operator response:

1. Read the row's `tx_hash` from the alert and check it on the explorer.
   **Mined** (either status) → the next bump tick closes the record itself from
   the receipt; nothing to do but confirm it cleared.
2. **Still pending** → the lane needs a same-nonce replacement that is NOT
   another attest: send a 0-value self-transfer from the relayer at that nonce
   with bumped fees to cancel it. Once that cancel mines, the stuck attest can
   never mine — its nonce is spent — and issuance recovers **on its own**: the
   next sweep tick sees the burned nonce, declares the old transaction dead and
   anchors a fresh attestation. There is nothing further to do by hand.
3. Do **not** re-broadcast the stored attest calldata by hand — that is the
   duplicate-credential path this whole gate exists to prevent. A hand-run
   *fee bump* is the same hazard wearing a different hat: it leaves no
   `outbound_txs` record, so the guard in step 2 cannot see it. Cancel, never
   bump.

> **Fixed by [#1745](https://github.com/d-hinders/Haven-AI/issues/1745) — this
> procedure used to be more dangerous, and the history is worth keeping.**
> Until #1745, the passport row's own retry was not gated on the outbound
> record: `markFailed` clears `anchoring_started_at` and `listRetryable`'s
> backoff is 60 s at the first attempt, so roughly **180 s** after the original
> broadcast the sweep reclaimed the row, read a `null` receipt — which means
> "pending OR dropped", indistinguishable — presumed dropped, and submitted a
> **fresh attest at the next nonce**. Two consequences this runbook had to
> carry by hand: an operator had to hunt for an already-queued duplicate before
> touching the nonce (because cancelling the stuck one would *release* the
> duplicate to mine), and if the original later mined, the agent held two live
> credentials. **Both are now guarded in code.** The re-mint requires positive
> evidence that the prior transaction can never mine — its nonce consumed by
> something else — so no duplicate is ever queued while the stuck attest is
> live, and cancelling has nothing to release. The steps above are shorter
> because the check they encoded is no longer a human's job.

Step 2's cancel is still a manual action; automating it is a known gap,
deliberately left to an owner decision
(#1743); see [`backend-scaling.md`](backend-scaling.md) § *Single point of
stall*.

Probes:
- `ops:check-bundler` — bundler up + EntryPoint v0.7 + gas oracle. It resolves
  the credential through the rail's own `delegationRailBundlerUrl()`, so a
  green probe **is** evidence about the deployed environment: it exercised the
  same credential and the same chain gate a payment would. Unset credential or
  a non-enabled chain exits 2 (*not configured*) with the rail's own message,
  distinct from exit 1 (*degraded*). `CHECK_BUNDLER_CHAIN_ID` is **required**
  whenever more than one chain is enabled (both 8453 and 84532 since the #908
  mainnet pins) — the probe exits 2 rather than guess, because a Sepolia
  credential answering a mainnet probe would read healthy while proving
  nothing. With a single enabled chain it defaults to that chain.
  (Until 2026-07-25 it read the retired `SESSION_RAIL_BUNDLER_URL` and proved
  nothing about the deployed env — fixed by pointing it at the resolver so the
  probe cannot drift from the rail again.)
- `ops:check-delegation` — every PINNED contract (manager, entry point,
  factory, Hybrid impl, 8 enforcers) is live bytecode on every enabled
  chain. Run on deploy and daily; exit 1 = stop before any rail use.
- `ops:check-mainnet-reconciliation` — the read-only 8453 probe (#1067):
  /health, relayer-monitor liveness + low-water, and (in the prod shell)
  the lingering-delegate scan. The mainnet canary procedure that uses it:
  [`mainnet-canary.md`](mainnet-canary.md).

## 4. Anti-lock-in: fork-and-pin policy + re-evaluation tripwires

**Contracts:** pinned by address in `rails/delegation-contracts.ts` — since
2026-07-27 for BOTH Base Sepolia and Base mainnet (#908; the mainnet pin run
bytecode-compared every contract against the Sepolia set and required the two
chain-scoped immutables in DelegationManager/HybridDeleGatorImpl explained
before pinning) — with audit
provenance. Pins NEVER move on a package upgrade — adding a chain or a new
manager version is a reviewed change with its own verification run.

**SDK (`@metamask/smart-accounts-kit`):** pinned to a known version in
`package.json`. If the package is deprecated, breaks compatibility, or its
license changes: fork the repo at the pinned tag into the org and point the
dependency at the fork — the deployed contracts don't care what SDK built
the calldata. Budget for this is small by design: Haven touches only
delegation building, signing typed-data, and `redeemDelegations` encoding.

**Tripwires — reconsider the vendor posture if any fires:**
1. delegation-framework repo goes quiet (no releases/audits for ~12 months)
   or a critical advisory lands without a fix.
2. An alternative ERC-7710 manager implementation reaches production with
   independent audits (portability option appears).
3. Facilitator adoption signal (CDP `erc7710` support) — tracked in #830;
   raises the value of the whole posture rather than threatening it.
4. MetaMask Agent Wallet's consumer product begins to overlap Haven's B2B
   control-plane lane (positioning, not technical, review).

## 5. Deploy parity (the PR #840 incident)

A backend import satisfied only by workspace hoisting passes every local
gate but crashes the pruned production build at boot — and the platform then
silently serves the LAST healthy build (symptom: new routes 404 while
`/health` shows newer features). Now enforced by
`src/__tests__/dependency-parity.test.ts`: every bare import in backend
`src/**` must be declared in the backend's own `package.json`. When
debugging "route missing on dev", check WHICH build generation is live by
probing a route from each recent merge before suspecting the code.
