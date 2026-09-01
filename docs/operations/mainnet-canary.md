---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/scripts/check-mainnet-reconciliation.ts
  - packages/backend/scripts/check-bundler.ts
  - packages/backend/scripts/check-delegation-contracts.ts
last-verified: "2026-08-24" # #1984: step 3.1 told the operator to flip NEXT_PUBLIC_DELEGATION_ONBOARDING=1 on the prod Vercel scope as the launch switch. That flag is REMOVED — onboarding provisions Hybrid unconditionally — so the step is rewritten to name the backend DELEGATION_RAIL_CHAIN_IDS as the only remaining authority on where the rail serves. The rest of the runbook re-read; no other step referenced the flag. Prior: #1458: §4.2 added — the erc7710 merchant canary, prepared but NOT run; prod baseline measured (eip3009 only, chain 8453) and the pinned Base DelegationManager verified against the kit. The variable change and the mainnet payment are owner steps. Prior: §4.1 run log added — canary completed on the 0.1.20 train; §§1-3 re-read, probe guidance unchanged
---

# Mainnet (8453) canary & reconciliation runbook (#1067)

The dev QA harness is **Base Sepolia only, by design** — it moves shared funds
on a QA delegate, and pointing automation at mainnet would be exactly the
wrong kind of coverage. Nothing in CI will ever exercise chain 8453, so
**first mainnet execution is always first execution**. This runbook is what
replaces automated coverage there: a written canary procedure plus a
read-only reconciliation check. It assumes the reader was NOT in the launch
threads — every step says where to look, not just what to feel.

Non-negotiable framing: the canary uses **real money**. Every amount below is
deliberately small, and nothing here is a soak test — the canary answers
"does the rail work on 8453 at all", after which widening happens in the
order under [Widening](#widening), never before.

## 1. Pre-flight (before ANY mainnet payment)

Run all of these from your laptop; none needs prod credentials beyond the
prod API URL.

1. **Bundler credential targets 8453.**
   `DELEGATION_RAIL_BUNDLER_URL` is chain-scoped by its URL path
   (`…/v2/8453/rpc?...`) — a Sepolia credential cannot serve mainnet, and the
   runtime assertion (#1053) only fires when someone tries to pay. Check it
   BEFORE the first payment:

   ```bash
   CHECK_BUNDLER_CHAIN_ID=8453 npm run ops:check-bundler -w packages/backend
   ```

   Exit 0 required. Exit 2 = not configured (wrong or missing credential);
   fix the Railway **prod** env before continuing.

   **The prod container cannot run this script** (found the hard way,
   2026-08-09, twice): the pruned build has no `tsx` AND does not ship
   `packages/backend/scripts/` at all. In the Railway prod shell, use the
   inline-Node equivalent instead — same three checks (chain-scoped URL
   assertion, v0.7 entry point, gas oracle), never prints the URL:

   ```bash
   node --input-type=module -e '
   const url = process.env.DELEGATION_RAIL_BUNDLER_URL
   if (!url) { console.error("exit 2: DELEGATION_RAIL_BUNDLER_URL is not configured"); process.exit(2) }
   if (/\/v2\/\d+\//.test(url) && !url.includes("/v2/8453/")) {
     console.error("exit 2: credential targets a DIFFERENT chain than 8453"); process.exit(2)
   }
   const rpc = async (m) => { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: [] }), signal: AbortSignal.timeout(15000) }); const b = await r.json(); if (b.error) throw new Error(m + ": " + (b.error.message ?? "rpc error")); return b.result }
   const EP07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032"
   let ok = true
   try { const eps = await rpc("eth_supportedEntryPoints"); const h = eps.some(e => e.toLowerCase() === EP07.toLowerCase()); console.log("bundler:   up — v0.7 " + (h ? "OK" : "MISSING")); if (!h) ok = false }
   catch (e) { console.log("bundler:   DOWN (" + String(e.message).slice(0,80) + ")"); ok = false }
   try { const p = await rpc("pimlico_getUserOperationGasPrice"); console.log("paymaster: up (fast " + (p?.fast?.maxFeePerGas ?? "?") + ")") }
   catch (e) { console.log("paymaster: FAILED (" + String(e.message).slice(0,80) + ")"); ok = false }
   if (ok) console.log("healthy for 8453"); else { console.log("degraded"); process.exit(1) }
   '
   ```

   From a laptop the real script works as written above — export the prod
   value without echoing (`read -rs DELEGATION_RAIL_BUNDLER_URL && export …`,
   run, then `unset`).

2. **Sponsorship policy bound and capped.** In the Pimlico dashboard, confirm
   `DELEGATION_RAIL_SPONSORSHIP_POLICY_ID` (prod env) names a policy that is
   **Enabled** with the launch caps (global monthly USD + per-user + per-op
   caps — the #908 launch set). An unset id means unrestricted sponsorship
   against the API key (#738) — that is a stop-the-launch finding.

3. **Contract pins are live bytecode on 8453.**

   ```bash
   npm run ops:check-delegation -w packages/backend
   ```

   All pins must verify on BOTH enabled chains (24/24 as of #908).

4. **Relayer funded + monitors alive + no reconciliation debt.**

   ```bash
   HAVEN_API_URL=<prod backend URL> npm run ops:check-mainnet-reconciliation -w packages/backend
   ```

   This is the read-only reconciliation check (see §4). It must exit 0.

## 2. Signer floor (the #908 gate, stated for THIS canary)

The canary treasury MUST have **≥2 enrolled signers** before it holds real
money. This is a RUNBOOK requirement, not a code gate: since #1153 the code
never refuses a single-signer account — `modules/accounts/mainnet-gate.ts`
now only answers `needsBackupSignerRecommendation` — so the operator running
this checklist is the enforcement. Verify the signer count on the account
page before funding; the account itself only guarantees ≥1 on-chain.

**Record in the launch notes which path the canary took:** two signers
(expected — enrol the backup passkey/wallet from the account page before
funding), or a recorded single-signer exception (why, who decided, when —
`single_signer_waiver_at` survives as history, #1153). A single-signer
canary is acceptable only because the canary's funds are bounded below; it
is NOT the posture for external users.

## 3. The canary itself

One agent, one small open budget, one erc7710 payment, end to end. Mirror of
the `x402-erc7710-settle` QA leg's assertions, executed by hand on 8453.

1. **Provision.** There is no launch switch left to flip. Under #908 this
   step was `NEXT_PUBLIC_DELEGATION_ONBOARDING=1` on the **prod** Vercel
   scope, ANDed with a frontend chain set; #1984 retires the Safe rail, so
   onboarding provisions a Hybrid delegation-rail account unconditionally on
   every supported chain and both the flag and the set are gone. Where the
   rail actually serves is the backend's `DELEGATION_RAIL_CHAIN_IDS`
   (`rails/delegation-contracts.ts`). **Provision** a fresh account on
   **Base mainnet** through the production app (passkey onboarding — this
   creates a Hybrid, zero tx), enrol the second signer, and note the treasury
   address. Fund it with a small amount of Base USDC (≤ 5 USDC).
2. **Create one agent** with an **open** USDC budget of ≤ 1 USDC/day and
   activate the grant (this relayer-deploys the treasury — verify the deploy
   tx on Basescan and that the relayer paid it).
3. **One payment.** Pay a known erc7710-capable counterparty a small amount
   (≤ 0.10 USDC) via the x402 authorize → settle flow, or an owner-side
   direct payment if no mainnet erc7710 merchant exists yet — in that case a
   `POST /payments` within budget is the canary payment instead, and the
   erc7710 half repeats when a counterparty exists.
4. **Assert, on Basescan + the API — the same invariants the QA leg pins:**
   - the treasury balance decreased by EXACTLY the payment amount, and the
     recipient increased by the same;
   - the **delegate EOA balance is unchanged** (no funding leg on erc7710);
   - the intent reached `submitted`/`confirmed` with
     `settlement_scheme: 'erc7710'` and the merchant as recipient;
   - a second, over-budget attempt is refused (403/on-chain revert — never
     silently queued: the delegation rail has no approval queue).
5. **Revoke** the canary grant afterwards and verify a subsequent payment is
   refused with 403 "no active budget delegation" (the lifecycle leg's
   contract, by hand).
6. **Re-run the reconciliation check** (§4) — it must exit 0 after the
   canary too.

## 4. The read-only reconciliation check

```bash
HAVEN_API_URL=<prod backend URL> npm run ops:check-mainnet-reconciliation -w packages/backend
```

Read-only, keyless, moves nothing. It verifies:

- `/health` is ok;
- the **relayer-balance monitor is alive** (the cached 8453 entry's
  `checkedAt` is < 2 h old — the monitor is hourly, so staler means the
  monitor is dead even if the balance looked fine when it last ran);
- the 8453 **relayer is above its low-water mark**;
- **no delegate is `lingering`** — this half needs `DATABASE_URL` (SELECTs +
  RPC reads only) and therefore runs in the **Railway prod backend shell**;
  from a laptop the script says so and skips it. A lingering delegate is a
  funded delegate with no fresh in-flight payment: reconciliation debt the
  gasless sweep exists to clear — investigate before widening anything.

The delegate-balance monitor itself WARNs hourly in prod logs (leader-locked,
#714); the check above is the pull-based complement an operator can run on
demand.

## 4.1 Run log — canary COMPLETED 2026-08-10

Every §3 leg executed and proven on Base mainnet (8453), account
`0x79238f83333777a43f387024ffc71dda83eaae19` (Hybrid), delegate EOA
`0xff372e7866e727c8cbabde4565795fffa1e793fa`, budget 1.0 USDC/day open:

| Leg | Proof |
|---|---|
| Direct payment (#1254 end-to-end) | 0.01 USDC confirmed, tx `0x3c86…5e8f` — typed data signed locally, no AA24 |
| x402, own merchant (CloudNest 0.0005) | funding `0x627a260f5fd02d889cea6127bcaccf92c0a992b366b6e3f15e290f4166a535e0`, settlement `0xe1cd8519496543d147328fdffeba2bd8f90d81852d9d4945864df6cc26eb03e4`, invoice FAK-2026-1786370258 paid |
| x402, external merchant (Soundside 0.02) | funding `0xc93f43f5e4d0ccf563ff8799cd1781529403fe2b6b139e2402ea41b851f0d0ec`, settlement `0x82a7d7f7af109a57a01b665a74f5e670be67e3cbb0e9c4f52b826795ca6e03f6`, goods delivered |
| Over-budget refusal | 2 USDC > remaining → `ERC20PeriodTransferEnforcer:transfer-amount-exceeded` reverted at PREPARE (simulation), nothing signed, no queue |
| Revoke | dashboard Stop (one signature) → next payment 403 `Agent has no active budget delegation`, `readiness: needs_approval`, empty budget view |
| Reconciliation (§4) | delegate residual exactly 2000 atomic = the two pre-fix Anchor fundings (`0x955ba720…`, `0x4fe50221…`, both 0.001); today's purchases left zero residual. The 0.002 stayed below the 1 USDC sweep floor (#700) in effect for this historical run; #2293 lowers the production floor to 0.01 for future recovery |

The x402 legs ran the **byte-free handoff** (#1263: the agent relayed only
`payment_id`; the signer fetched the payload itself) on the 0.1.20-alpha.0
train, which also carries the fixes this canary surfaced: #1254 (direct-path
typed_data), #1255 (`typed_data_b64` transport), #1256 (EIP-3009 forward
margin — the header showed ~10 min forward validity against the merchant's
300 s requirement). Outstanding non-blocker: an Anchor re-test on the
decomposed HTTP flow (its two failures predate #1256). The #1269 below-minimum
sweep mapping was promoted after this historical run; #2293 now lowers the
production recovery floor to 0.01.

## 4.2 The erc7710 merchant canary (#1458) — NOT YET RUN

A **separate** canary from §3's. That one proved a delegation-rail agent can
pay on mainnet at all; this one proves the **erc7710 settlement scheme** works
against the production demo merchant, where the money moves treasury→merchant
directly and no delegate ever holds it.

**Two steps here are the owner's, not an agent's:** changing production Railway
variables, and completing a real Base-mainnet payment. Everything else below is
prepared so those two are short.

### Baseline, measured 2026-08-15 (AC 1 — done)

`GET https://enthusiastic-blessing-production-171f.up.railway.app/.well-known/haven-demo-merchant`

```json
{ "settlement_methods": ["eip3009"], "chain_id": 8453 }
```

So prod advertises **EIP-3009 only** today. Nothing to roll back from yet, and
no agent can currently reach erc7710 in production regardless of client
support. (The issue filer could not reach this endpoint; it responds fine.)

### The variable change (owner)

On the **prod** demo-merchant Railway service:

```
MERCHANT_X402_SETTLEMENT_METHODS=eip3009,erc7710
MERCHANT_ERC7710_DELEGATION_MANAGER=0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3
```

**EIP-3009 stays first, deliberately.** Generic x402 clients infer the scheme
from `accepts[0]`, and `packages/demo-merchant-mcp/src/erc7710.test.ts` pins
that ordering. Haven's own clients no longer depend on it (#1453 reads
`assetTransferMethod` instead of taking the first entry), but the merchant
serves more than Haven.

**The manager address is the pinned one**, from
`packages/backend/src/rails/delegation-contracts.ts` (8453 block) — verified
2026-08-15 to equal what `@metamask/smart-accounts-kit` reports for 8453. Do
not copy it from MetaMask's published deployments page: the address is
version-specific to the kit, and a mismatch fails *every* Haven-agent payment
with `Payment delegationManager is not the delegation manager trusted by this
merchant`. If the pin and the kit ever disagree, that is
`rails/delegation-policy.ts`'s cross-check failing and it must be resolved
before this canary, not worked around here.

Code deploys automatically on merge to `main`; **variables do not**. This is a
deliberate Railway change.

### Verify the advertisement before paying

```bash
curl -s https://enthusiastic-blessing-production-171f.up.railway.app/.well-known/haven-demo-merchant | jq .settlement_methods
```

Then take a real 402 and confirm the erc7710 entry carries
`extra.facilitatorAddresses`, and that the settlement key named there is
**gas-funded on mainnet** — it is the redeemer, and an unfunded one turns a
correct delegation into a payment nobody can complete.

### The canary payment (owner)

Tiny value, matching §3's discipline. A green configuration is **not** the
acceptance bar — a settled payment is. Record here: tx hash, treasury delta,
merchant delta, and the delegate EOA balance **before and after**.

That last one is the whole point of the scheme: a silent reroute to the
EIP-3009 bridge would still deliver the goods and still debit the treasury
correctly, and would only be visible in the delegate's balance.

### Rollback

Set `MERCHANT_X402_SETTLEMENT_METHODS=eip3009` and leave
`MERCHANT_ERC7710_DELEGATION_MANAGER` in place — without erc7710 in the
effective method list the merchant advertises 3009 only, and the manager
variable is inert. No code change, no redeploy needed beyond the variable
restart.

### What is proven elsewhere, so this canary does not have to re-prove it

- The settlement mechanics, nightly on Base Sepolia (`x402-erc7710-settle`).
- The SDK path, live on 2026-08-15 (tx `0x101e26dc…`: treasury −0.001, merchant
  +0.001, delegate untouched at 0) and continuously by `x402-erc7710-sdk`.
- The local signer's independent caveat verification (#1455).

What this canary adds that none of those can: **mainnet**, the production
merchant's own configuration, and real funds.

## 5. Widening

Only after the canary passes in full, in this order — each step gated on the
previous holding for its stated window:

1. **Canary soak** — leave the canary agent live at ≤ 1 USDC/day for one
   refill boundary (24 h) and verify the native refill happened (a
   within-budget payment succeeds on day 2 with no new signature).
2. **Team accounts** — internal users, budgets ≤ 10 USDC/day, one week.
   Reconciliation check clean daily (it takes one command).
3. **First external users** — invite-only, budgets capped at the launch
   policy's per-user maximum. Require ≥2 signers per invited account as
   launch policy — check it manually; since #1153 no code refuses a
   single-signer account, so this list is where the requirement lives.
4. **General availability** — a separate go/no-go with the owner; not this
   runbook's call.

Any lingering delegate, monitor death, or policy-cap breach during a step
pauses widening at that step until explained.

## 6. Rollback

**Per-agent:** revoke the agent's grants from the dashboard (budget card →
Stop) or `POST /agents/:id/delegations/:hash/revoke` + submit. Revocation is
an **owner-signed sponsored treasury op** — "quickly" means: one signature
per grant, landing at bundler speed (seconds to ~a minute per op on 8453).
It is NOT instant and NOT batch: N active grants = N signatures. The
account-level kill in an emergency is faster in effect: the owner can also
**remove the compromised signer** (account page → Remove) — a removed key's
delegations die with it (EIP-1271), which revokes everything that key could
redeem in one op.

**Rail-level:** if the rail itself must stop, disabling the Pimlico policy
pauses ALL sponsored operations (payments AND revokes still needing gas
sponsorship — so do per-agent revokes FIRST, then disable). Independent of
Haven entirely: the public exit tool (`docs/exit/README.md`) enumerates and
disables delegations against the pinned DelegationManager with nothing but
the owner's signer.

**Evidence discipline:** whatever triggered the rollback, capture the
reconciliation-check output and the relevant Basescan links in the incident
notes before memories fade.
