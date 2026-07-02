---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/lib/execution-rail.ts
  - packages/backend/scripts/check-attestation.ts
  - packages/backend/scripts/check-bundler.ts
last-verified: "2026-07-02"
---

# Session-rail vendor ops — bundler/paymaster runbook (#738)

The session-key rail (epic #733) introduces ONE new operational dependency:
a hosted **bundler + paymaster** (Pimlico for the pilot — one URL serves both).
This runbook is what the team owns for it: the credential, the sponsorship
budgets, the outage playbook, and the standing checks. Everything here is
gas-side only — the paymaster sponsors network fees, never payments, and can
only *decline* to sponsor (non-custody analysis: pilot report §5, CI pins:
`non-custody.invariants.test.ts` invariants 5–10).

## 1. The credential

The bundler URL **is** the secret — hosted bundlers embed the API key in it
(`https://api.pimlico.io/v2/<chainId>/rpc?apikey=…`).

- Lives ONLY in: the deploy platform's env (`SESSION_RAIL_BUNDLER_URL` on the
  Railway backend service) and operators' local `~/.haven/pilot.env`. Never in
  the repo, never in logs, never in chat/tickets. The single production read
  site is CI-pinned (invariant 9).
- **Unset = fail-closed**: without the variable the session rail is
  unavailable and every account stays on the legacy AllowanceModule path.
- **Rotation** (do this on any suspected exposure, and periodically):
  1. Pimlico dashboard → API Keys → create new key → build the new URL.
  2. Update the Railway variable (service redeploys automatically) and your
     local env file.
  3. Verify with `npm run ops:check-bundler -w @haven/backend`.
  4. Delete the old key in the dashboard.
- Environments use **separate keys** (dev vs prod), mirroring the #613
  relayer-isolation policy.

## 2. Sponsorship policies — the per-agent gas budget (#717)

Sponsorship policies are configured in the Pimlico dashboard (Sponsorship
Policies) and are the structural answer to relayer gas abuse: when a policy's
budget is exhausted, the paymaster **declines at sponsorship time** — the
backend's `prepareSessionTransfer` fails, our API returns the 502
`Session-rail authorization failed` error, and **nothing reaches the chain**.
Retryable by design; no drained shared wallet.

Recommended structure (per environment):

| Policy | Scope | Knobs |
|---|---|---|
| `dev-pilot` | Base Sepolia, the pilot Safe(s) | small global cap, e.g. $5/month |
| `prod-tier-standard` | per-sender (= per-Safe) limits | per-user-op max, per-sender monthly cap, start/end dates |
| `prod-tier-high` | same, higher caps | — |

Operator steps when onboarding a migrated account: assign its Safe to a tier
policy (per-sender limits make one policy serve many accounts). Verify the
exhaustion behavior once per policy: set a tiny cap on a test policy, spend
past it, confirm the API answers 502 with the sponsorship decline in
`details` and that a later retry (after the window resets) succeeds.

## 3. Outage playbook — bundler down

Blast radius: **migrated accounts cannot pay** while the bundler/paymaster is
unreachable (authorize fails at prepare, cleanly, nothing half-written).
Unmigrated accounts are unaffected — the legacy rail has no bundler
dependency.

1. **Detect**: `npm run ops:check-bundler -w @haven/backend` (also suitable
   for a cron/uptime probe), plus Pimlico's status page.
2. **Short outage** (minutes): do nothing — authorize errors are clean and
   retryable; agents retry.
3. **Sustained outage**: flip affected accounts back to the legacy rail —
   the on-chain #721 migration is additive, so the AllowanceModule path still
   works on a migrated Safe. Per account:
   ```sql
   UPDATE user_safes SET execution_rail = 'allowance_module'
     WHERE LOWER(safe_address) = LOWER('0x…') AND chain_id = <id>;
   ```
   (Requires the agent to still hold an AllowanceModule allowance during the
   staged-rollout phase — keep allowances configured until Stage 3 retires
   the legacy rail.) Flip back the same way when the vendor recovers.
4. **Vendor exit** (terms change, sustained unreliability): the API surface is
   standard `eth_sendUserOperation` + sponsorship — Alchemy/Biconomy are
   drop-in candidates, self-hosted Alto is the escape hatch (pilot rig doc has
   the comparison). Swapping = new URL in one env var.

## 4. Standing checks

| Check | Command | Cadence |
|---|---|---|
| Bundler/paymaster reachable & serving our entry point | `npm run ops:check-bundler -w @haven/backend` | uptime probe / daily |
| Smart Sessions attestation coverage (enable registry gating the day it appears — #735 decision) | `npm run ops:check-attestation -w @haven/backend` | monthly ops cycle |
| Sponsorship budget consumption vs caps | Pimlico dashboard | weekly during rollout |

## 5. What this rail never does (for reviewers)

The paymaster pays **gas only**; it cannot redirect or originate a payment.
The bundler transports client-signed UserOperations; the session's on-chain
policy is the authority. Haven holds no signing key on this rail (watch-only
owner). All of the above is enforced by CI (#736 invariants), not by this
document.
