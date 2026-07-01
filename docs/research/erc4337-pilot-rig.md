---
owner: "@d-hinders"
status: research
covers:
  - packages/qa-agent/src/pilot/**
last-verified: "2026-07-01"
---

# ERC-4337 pilot rig — bundler, paymaster & SDK decisions (#720)

Decision note for the first slice of the ADR #719 Stage 1 pilot: the
infrastructure choices behind `packages/qa-agent/src/pilot/`, and the operator
runbook for the live half of #720 (landing one sponsored UserOp on Base
Sepolia). Everything here is **testnet-only and experimental** — no production
code path touches it.

## What the rig proves

`npm run pilot:rig -w packages/qa-agent` takes a throwaway owner key, derives a
counterfactual **Safe in ERC-7579 mode** (the Safe7579 launchpad wires the
adapter in at deploy time), signs one 0-value self-call as a UserOp, and has a
bundler land it with **paymaster-sponsored gas** — the account holds no ETH,
mirroring Haven's gasless model. First run also deploys the account. That
single transaction validates every rig choice below at once.

## Decisions

### Client SDK: `permissionless` + `viem` (in `qa-agent` only)

| Option | Verdict |
|---|---|
| **`permissionless` 0.3.x (chosen)** | First-class `toSafeSmartAccount` with ERC-7579 launchpad mode; Pimlico-maintained; the most-used 4337 client library. |
| Rhinestone `module-sdk` | Not needed for the rig; **expected for #722** (Smart Sessions install/policy encoding) — it composes with `permissionless`, so this choice doesn't foreclose it. |
| Hand-rolled UserOps over `ethers` | Maximum control, but re-implements signing/gas/packing that `permissionless` already gets right; wrong trade for a spike. |

**ethers interop:** the repo is an `ethers` codebase; `permissionless` requires
`viem`. For the pilot this is contained — the `src/pilot/` files are a viem-only
island inside the private `qa-agent` package, and nothing imports across the
boundary. Whether the production SDK grows a viem dependency (or wraps UserOp
construction behind the backend) is a **Stage 2 question for the pilot report
(#724)**, deliberately not decided here.

### Bundler + paymaster: Pimlico for the pilot

| Option | Trade-off |
|---|---|
| **Pimlico (chosen for pilot)** | One URL serves bundler + paymaster + gas-price oracle; testnet sponsorship on the free tier; best Safe/7579 documentation. Lock-in risk is low — the API is standard `eth_sendUserOperation` + sponsorship, and the rig keeps the URL as config. |
| Alchemy / Biconomy | Comparable hosted offerings; separate paymaster configuration; no pilot-relevant advantage over Pimlico. Re-evaluate at Stage 2 when volume pricing matters. |
| Self-hosted (e.g. Alto) | No vendor dependency, full control — and a new service to operate. Wrong cost/benefit for a pilot; documented as the escape hatch if vendor terms change. |

**The bundler URL is a credential** (hosted bundlers embed the API key in it).
It lives in an env file outside the repository, exactly like the `QA_*`
secrets. Never commit it.

### Canonical addresses (env-overridable defaults)

| Contract | Default | Note |
|---|---|---|
| Safe7579 adapter | `0x7579EE8307284F293B1927136486880611F20002` | Deterministic cross-chain deployment |
| Safe7579 launchpad | `0x7579011aB74c46090561ea277Ba79D510c6C00ff` | Used for counterfactual 7579 setup |
| Registry attester (Rhinestone) | `0x000000333034E9f539ce08819E12c1b8Cb29084d` | `attestersThreshold: 1` |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | From `viem/account-abstraction` |

The first operator run is the live verification of these addresses on Base
Sepolia — if account creation fails, re-check them against the Rhinestone and
Safe7579 docs **before** debugging anything else, then override via env
(`PILOT_SAFE7579_ADAPTER`, `PILOT_ERC7579_LAUNCHPAD`, `PILOT_ATTESTER`).

## Operator runbook (the live half of #720)

1. Create a Pimlico account (free tier) and copy the Base Sepolia API URL —
   this is the secret `PILOT_BUNDLER_URL`.
2. Generate a **throwaway** owner key (never a production, QA-harness, or
   funded key):
   `node -e "const{ethers}=require('ethers');const w=ethers.Wallet.createRandom();console.log(w.address,w.privateKey)"`
3. Keep the env outside the repo, e.g. `/secure/path/pilot.env`:

   ```bash
   PILOT_OWNER_PRIVATE_KEY=0x…   # throwaway
   PILOT_BUNDLER_URL=https://api.pimlico.io/v2/84532/rpc?apikey=…   # secret
   # optional: PILOT_RPC_URL, PILOT_SALT_NONCE, PILOT_SAFE7579_ADAPTER, …
   ```

4. Run it:

   ```bash
   set -a; source /secure/path/pilot.env; set +a
   npm run pilot:rig -w packages/qa-agent
   ```

5. Success = the script prints the Basescan links for the sponsored tx and the
   deployed pilot Safe. Paste both into #720 and close it.

Exit codes mirror the QA harness: `2` = missing/invalid env, `1` = run failure.

## Scope boundaries

- **No Haven flow is wired in**: no SDK, no backend, no QA-harness identity —
  the deterministic money-flow signal (`qa-dev.yml`) is untouched.
- **Base Sepolia only.** Gnosis (v1.3.0 singleton) is explicitly out of scope
  until the pilot report (#724) assesses it.
- Next slices build on this rig: #721 (provision the pilot QA Safe with one
  owner tx), #722 (Smart Sessions policies + enforcement tests), #723 (gasless
  payment E2E + rail comparison), #724 (report + go/no-go).

## #721 — the one-owner-tx migration recipe

`npm run pilot:provision -w packages/qa-agent` is the migration story: it
deploys a **vanilla Safe v1.4.1** (the exact shape Haven deploys for customers
today), then upgrades it to ERC-7579 with **one owner-signed
`execTransaction`** — a MultiSendCallOnly batch of, in dependency order:

1. `safe.enableModule(safe7579Adapter)` — the adapter may execute via the
   Safe's module path;
2. `safe.setFallbackHandler(safe7579Adapter)` — EntryPoint/7579 calls route to
   the adapter;
3. `safe7579.initializeAccount(validators, executors, fallbacks, hooks,
   registryInit)` — called *by the Safe* (inner MultiSend calls run with
   `msg.sender = safe`), installing the **Smart Sessions validator** with no
   initial sessions (#722 adds them) and trusting the Rhinestone attester on
   the ERC-7484 registry (threshold 1).

Post-migration the script verifies the upgrade is **additive**: `accountId()`
answers via the new fallback handler, `isModuleInstalled(1, SmartSessions)`
is true — and a plain owner `execTransaction` still executes, proving the
classic Safe path is untouched. This batch, unchanged, is the per-account
Stage 2 migration payload.

**ABI pinning caveat (the drift lesson again):** the deployed canonical
adapter is the **v1.0.2 artifact** — `initializeAccount` takes five arrays and
a two-field `ModuleInit {module, initData}`. The repo's `main` branch has
diverged (single `ModuleInit[]` with a `moduleType` field). The ABI in
`provision-lib.ts` is pinned to the deployed v1.0.2 tag; do not "refresh" it
from `main` without confirming what the canonical address actually runs.
Smart Sessions / registry / attester addresses are imported from
`@rhinestone/module-sdk` (package-pinned, not hand-copied).

Operator run: same env as the rig minus the bundler —
`PILOT_OWNER_PRIVATE_KEY` (throwaway, **funded with faucet ETH**: the owner
pays for the deploy and the one owner tx, exactly like a migrating customer)
plus optional `PILOT_RPC_URL` / `PILOT_SALT_NONCE`. Success evidence (Safe +
migration-tx Basescan links) closes #721.

## #722 — Haven's policy shape as Smart Sessions (+ enforcement suite)

`npm run pilot:policies -w packages/qa-agent` answers the pilot's core
question: does Smart Sessions express Haven's policy roadmap, and do the rules
actually **stop** violations on-chain? The suite runs six cases against the
provisioned pilot Safe — each policy proven in both directions (a rule that
doesn't stop is not a rule):

| # | Case | Expected |
|---|---|---|
| 1 | within caps → allowlisted recipient | executes |
| 2 | non-allowlisted recipient | rejected at validation |
| 3 | over the per-tx cap | rejected |
| 4 | cumulative spend past the session limit | rejected (after two passes) |
| 5 | session outside its validity window | rejected |
| 6 | owner-revoked session | rejected |

### The mapping (what fit)

| Haven policy | Smart Sessions expression |
|---|---|
| recipient allowlist | UniversalActionPolicy ParamRule `EQUAL` on `to` (USDC.transfer, offset 0) |
| per-tx cap | ParamRule `LESS_THAN_OR_EQUAL` on `amount` (offset 32) |
| cumulative spending limit | same rule with `isLimited` + `usage.limit` (sums across uses) |
| time bound / expiry | TimeFramePolicy as a userOp policy |
| revoke / kill switch | owner tx `getRemoveSessionAction(permissionId)` |
| session key binding | OwnableValidator (threshold 1, the "delegate" key) |

### Honest findings (feed the #724 report)

- **No native refill.** Haven's reset-period (allowance refills every N
  minutes) has no direct policy — `usage.limit` is a lifetime cumulative for
  the session. Closest mappings: **session rotation** (short `validUntil` +
  periodic re-enable, an owner or executor action) or a custom policy
  contract (own Solidity — the thing we've avoided). This is the biggest gap
  and a #724 decision.
- **One recipient per session.** ParamRules AND together, so a session
  expresses a single allowed recipient; an N-address allowlist needs N
  sessions or a custom policy. Fine for x402-style per-merchant scoping,
  clumsy for a general contact allowlist.
- **Paymaster must be permitted per session** (`permitERC4337Paymaster`) —
  easy to miss; without it every sponsored UserOp fails validation.
- **Byte-offset param addressing** (0, 32, …) is verified by the live run;
  the unit tests pin structure and encoding, not on-chain semantics.

### Operator run

Same env as before plus `PILOT_SESSION_PRIVATE_KEY` (throwaway session key)
and `PILOT_SAFE_ADDRESS` (from the `pilot:provision` output), and the pilot
Safe funded with **≥ 0.15 test-USDC** (the two pass cases spend ~0.12 to the
owner address; rejected cases move nothing). Paste the printed case table
into #722 to close it.

## #723 — payment E2E + rail comparison

`npm run pilot:compare -w packages/qa-agent` produces the #723 deliverable: one
Markdown table, both rails, same metrics — median latency, average gas per
payment, and the **concurrency probe** (three simultaneous payments).

- **Session rail (always measured):** three sequential policy-bound payments
  (0.01 USDC each) from the pilot Safe, then three **concurrent** payments with
  consecutive pre-assigned 2D nonces — bundlers can include all three, which is
  exactly what the single-EOA relayer cannot do today (#718/#692). Spends 0.06
  test-USDC to the owner address.
- **Relayer rail (opt-in):** `PILOT_COMPARE_RELAYER=1` + the `QA_*` env runs
  the same shape through the existing AllowanceModule rail via the SDK against
  the dev backend (3 + 3 × 0.1 USDC). **Off by default** — it uses the shared
  QA identity and consumes its allowance, so the deterministic `qa-dev` signal
  is never touched accidentally. Expect the concurrent phase to surface the
  nonce serialization (retries or failures) — that divergence *is* the data.
- Every confirmed payment emits a **rail-agnostic evidence JSON line**
  mirroring the backend's `machine-payment-evidence` columns (`rail`,
  `tx_hash`, `chain_id`, `payer_address`, `settlement_address`, …) — proving
  the ledger shape works unchanged whichever rail executed.

### Paymaster budgets — the structural #717 answer

On the pilot's Pimlico rig, sponsorship is governed by **sponsorship policies**
configured on the dashboard: per-policy spend caps, per-user (per-sender)
limits, and time windows. When a policy's budget is exhausted the paymaster
**declines at sponsorship time** — `prepareUserOperation` fails before
anything reaches the chain, and no gas is spent. That maps 1:1 to the #717
ask (per-agent gas budgets + rate limits): one sponsorship policy per agent
(or per tier), with the decline surfacing as a clean, retryable client error
instead of a drained relayer. Vendor-specific mechanics; the equivalent knobs
exist at Alchemy/Biconomy, and a self-hosted paymaster would own them
directly — a Stage 2 line item for the #724 report.

## References

- ADR: issue #719 (session-key policy layer)
- Safe7579: https://docs.safe.global/advanced/erc-7579/7579-safe
- Safe7579 v1.0.2 interface (deployed artifact): https://github.com/rhinestonewtf/safe7579/blob/v1.0.2/src/ISafe7579.sol
- Smart Sessions: https://docs.rhinestone.dev/module-sdk/modules/smart-sessions
- permissionless.js: https://docs.pimlico.io/permissionless
- ERC-4337 EntryPoint v0.7 / ERC-7579 / ERC-7484 (registry attesters)
