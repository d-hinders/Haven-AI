# Pilot & ops scripts — index

Orientation for the session-key rail (epic #733) pilot and the standing ops
checks. Every script documents itself in its own header; this is the map of
which one to reach for and in what order. All are **testnet-only** and read
secrets from an env file **outside the repo** (e.g. `~/.haven/pilot.env`) —
never commit secrets, never paste bundler URLs or keys anywhere.

## Definition-of-done flow (in order)

The end-to-end proof that a migrated account pays through the production path.
Run after the session-rail code is deployed and `SESSION_RAIL_BUNDLER_URL` is
set on the dev backend.

| Step | Command (workspace) | Does |
|---|---|---|
| 1 | `pilot:rig` (qa-agent) | Land one sponsored UserOp on Base Sepolia — proves bundler + paymaster + SDK choice (#720). |
| 2 | `pilot:provision` (qa-agent) | Upgrade a vanilla Safe → ERC-7579 with ONE owner tx (#721). |
| 3 | `pilot:create-dod-agent` (qa-agent) | Over the dev API: create the dev user, import the pilot Safe, create the agent. Prints the `PILOT_AGENT_*` env lines. |
| 4 | `pilot:enable-agent-session` (qa-agent) | One owner tx enabling a session bound to the agent's delegate key; prints the `permissionId` + the two `UPDATE` SQL lines. |
| 5 | *(operator)* run the two SQL `UPDATE`s in the dev DB (flip the Safe to `session_key`, set `session_permission_id`). |
| 6 | `pilot:dod-payment` (qa-agent) | Authorize → EIP-191 sign → execute via the dev backend's real API. Refuses to pay on the legacy scheme. Prints the Basescan tx — the #739 DoD. |

## Rail behavior proofs (standalone)

| Command (workspace) | Proves |
|---|---|
| `pilot:policies` (qa-agent) | The six-case on-chain enforcement suite: allowlist, per-tx cap, cumulative limit, expiry, revoke — each stopped both directions (#722). |
| `pilot:compare` (qa-agent) | Session rail vs legacy relayer rail: latency, gas, and the concurrency probe (#723). |
| `pilot:rotate-live` (backend) | Atomic session rotation on-chain (remove old + enable new in one owner tx) + the schedule/refill proof (#734). |
| `pilot:schedule-live` (backend) | Pre-signed budget schedule (#769): N time-locked sessions in ONE owner signature, then the cross-period payment proof with zero further signatures. DB wiring runs over the dev API (#798) — zero manual SQL; agent resolved by delegate address. |
| `pilot:delegation-rail-smoke` (backend) | #826: the PRODUCTION delegation-rail lib end-to-end — watch-only prepare, client-side agent signature, sponsored submit; cold + warm gas metrics. Needs the spike treasury env. |
| `pilot:delegation-payment-smoke` (backend) | #829: prepare (production lib) → sign with the SDK's `signUserOpTypedDataForDelegation` → submit. Proves the SDK signature validates ON-CHAIN in `validateUserOp` — a wrong typed-data domain would revert. |
| `pilot:x402-7710-buyer` (qa-agent) | ERC-7710 direct settlement: a smart account pays the merchant with no delegate funding leg (#452). Needs the demo merchant running with the erc7710 rail. |
| `pilot:delegation-spike` (qa-agent) | Spike #820 (epic #821 gate G1): the #818 matrix on Hybrid DeleGator — period-budget caveats, observed zero-signature refill, recipient modes, revoke, sponsored redemption. Needs `PILOT_7710_DELEGATOR_PRIVATE_KEY` (throwaway) + a USDC-funded Hybrid. |
| `pilot:provision-hybrid` (qa-agent) | #825: provisions Hybrid accounts through the production API (EOA + programmatic-P256 passkey variants, counterfactual), verifies API/local address determinism, then deploys with ONE sponsored UserOp. |

## Standing ops checks (cadence)

| Command (backend) | Cadence | Watches |
|---|---|---|
| `ops:check-bundler` | daily / uptime probe | Bundler + paymaster reachable and serving EntryPoint v0.7 (#738). |
| `ops:check-attestation` | monthly (also a weekly CI job, #779) | Smart Sessions ERC-7484 coverage — enable registry gating when it appears (#735). |
| `ops:check-delegate-balances` | on demand | Lingering / dust delegate balances (the #714 monitor, on demand). |
| `db:schema-smoke` | CI (every backend PR) | Migrations apply + curated money-path queries `PREPARE` against a real Postgres (#773). |

## Env

The DoD flow reads `~/.haven/pilot.env`: `PILOT_OWNER_PRIVATE_KEY`,
`PILOT_SAFE_ADDRESS`, `PILOT_BUNDLER_URL` (secret), `PILOT_API_URL`,
`PILOT_DEV_EMAIL` / `PILOT_DEV_PASSWORD`, `PILOT_ALLOWED_RECIPIENT`, and the
`PILOT_AGENT_*` values printed by `pilot:create-dod-agent`. Re-`source` the
file after any script prints new lines to add. Full vendor/credential handling:
[`docs/operations/session-rail-vendor-ops.md`](../../../../docs/operations/session-rail-vendor-ops.md).
