---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/scripts/check-mainnet-reconciliation.ts
  - packages/backend/scripts/check-bundler.ts
  - packages/backend/scripts/check-delegation-contracts.ts
last-verified: "2026-08-09" # §1.1: the pruned prod container lacks tsx — npx variant recorded (found live during #908 pre-flight)
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
   fix the Railway **prod** env before continuing. The env var lives in
   Railway, and the prod container is a PRUNED build — `tsx` is not
   installed there (found the hard way, 2026-08-09), so plain
   `npm run ops:check-bundler` fails with `tsx: not found` in the shell.
   Either run it in the Railway prod shell via npx:

   ```bash
   cd /app && CHECK_BUNDLER_CHAIN_ID=8453 npx -y tsx packages/backend/scripts/check-bundler.ts
   ```

   …or locally with the prod value exported without echoing
   (`read -rs DELEGATION_RAIL_BUNDLER_URL && export …`, run, then `unset`).

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

1. **Flip the launch switch, then provision.** Since the #908 prep, the CODE
   serves delegation onboarding on Base mainnet (`DELEGATION_ONBOARDING_CHAIN_IDS`
   in the frontend, mirroring the backend's `DELEGATION_RAIL_CHAIN_IDS`) — the
   remaining gate is `NEXT_PUBLIC_DELEGATION_ONBOARDING=1` on the **prod**
   Vercel scope, which is deliberately the operator's last move (it needs a
   redeploy to inline). Set it, then **provision** a fresh account on
   **Base mainnet** through the production app (passkey onboarding — this now
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
