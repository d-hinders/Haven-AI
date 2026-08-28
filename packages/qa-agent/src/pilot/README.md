# Pilot scripts — `packages/qa-agent/src/pilot/`

Hand-run, **testnet-only** proof scripts for the delegation rail. Every script
documents itself in its own header; this file says which one to reach for and
what the set as a whole is and is not.

Secrets come from an env file **outside the repo** (e.g. `~/.haven/pilot.env`).
Never commit secrets; never paste bundler URLs or keys anywhere.

## The scripts

| Command (from repo root) | Proves | Needs |
|---|---|---|
| `npm run pilot:provision-hybrid -w packages/qa-agent` | #825: provisions Hybrid DeleGator accounts through the production API (EOA + programmatic-P256 passkey variants, counterfactual), verifies API/local address determinism, then deploys with ONE sponsored UserOp — no ETH anywhere. | `PILOT_RPC_URL` |
| `npm run pilot:delegation-spike -w packages/qa-agent` | Spike #820 (epic #821 gate G1): the #818 matrix on Hybrid DeleGator — period-budget caveats, observed zero-signature refill at the period boundary, recipient modes, revoke, sponsored redemption. | `PILOT_RPC_URL`, `SPIKE_DELEGATE_KEY` (throwaway), a USDC-funded Hybrid |
| `npm run pilot:x402-7710-buyer -w packages/qa-agent` | #452: ERC-7710 direct settlement — a smart account pays the merchant with **no delegate funding leg** and no transient hot balance. | `PILOT_CHAIN`, `PILOT_RPC_URL`, the demo merchant running with the erc7710 rail |

Backend-side pilot and ops scripts (`pilot:*`, `ops:*` in
`packages/backend/package.json`) are **not indexed here**. That is deliberate —
see *Why this file is short* below.

## What was deleted, and why (#2087, epic #1440)

Twelve scripts and four of their helpers drove the two **retired** rails and
were removed, along with their `pilot:*` entries. Owner decision 2026-08-27:
delete rather than archive — git holds the history, and a directory nothing
typechecks meaningfully and nothing runs is where broken scripts go to look
alive.

- **Safe / AllowanceModule rail** (retired #1986, modules deleted #1987):
  `provision-pilot-safe.ts` (`POST /user/safes` — 410 since #1984),
  `create-dod-agent.ts` (Safe import + a non-empty `allowances` array —
  400 since #2020), `dod-payment.ts`.
- **Session rail** (retired #834): `enable-agent-session.ts`,
  `session-policies.ts`, `session-rail.ts`, `policy-scenarios.ts`,
  `rig-hello-userop.ts` (a **Safe7579** hello-world — the retired account
  shape; `provision-hybrid.ts` is the live rail's equivalent sponsored-UserOp
  proof).
- **`compare-rails.ts`** + `compare-lib.ts`: it compared the AllowanceModule
  rail against the session rail. Both subjects are gone, so there is nothing
  left to compare.
- **Orphaned helpers**, deleted because nothing surviving imported them:
  `config.ts`, `provision-lib.ts`, and their tests. All three remaining
  scripts read `process.env` directly.

## Why this file is short — and what it does NOT promise

The previous version of this README indexed both `packages/qa-agent`'s and
`packages/backend`'s pilot scripts. When #2087 checked, **ten of the commands
it listed no longer existed** — seven from the deletions above, and three
(`pilot:rotate-live`, `pilot:schedule-live`, `ops:check-attestation`) that had
already been removed from `packages/backend/package.json` by earlier session-rail
work without anyone updating this file.

A second copy of two `package.json` files drifts from both. So this README now
covers **only its own directory**, and the authoritative list of backend
scripts is `packages/backend/package.json`.

### These scripts are not covered by any gate. That is a decision, not an oversight

`tsc --noEmit` **does** see this directory (`packages/qa-agent/tsconfig.json`
includes `src`, verified by injecting a type error — it was caught). What no
static check can see is the failure mode these scripts actually had: a `fetch`
to a route that has started answering **HTTP 410** is type-correct forever.
`create-dod-agent.ts` typechecked cleanly for weeks while being completely
unrunnable.

The only check that would have caught it is running them, and that needs funded
testnet keys, a live backend, a bundler and a paymaster — disproportionate for
hand-run proof scripts, and it would put vendor credentials in CI.

**So: not covered, by decision.** The consequence is explicit — *the next rail
retirement will not be told about this directory either*. Whoever runs one
should grep `src/pilot/**` for the routes and primitives being retired, the way
#2087 did. If that ever stops being acceptable, the fix is a smoke job, not a
wider typecheck scope; the typecheck scope is already wide enough and was never
the gap.
