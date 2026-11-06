---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/config.ts
  - packages/backend/src/config/ops.ts
  - packages/backend/src/infra/secrets.ts
  - packages/backend/src/infra/chain/x402-binding-signer.ts
  - packages/backend/src/infra/delegate-alert-webhook.ts
  - packages/backend/src/modules/catalog/ownership.ts
  - packages/backend/src/modules/passport/receipt.ts
  - packages/backend/src/routes/agent-connection-setups.ts
  - packages/backend/src/routes/accounting-connections.ts
  - packages/backend/src/rails/delegation-rail.ts
  - packages/backend/src/rails/sweep.ts
  - packages/backend/src/index.ts
  - packages/connect/src/rekey.ts
  - packages/connect/src/storage.ts
  - packages/signer/src/credentials.ts
  - .github/workflows/agent-evals.yml
  - .github/workflows/qa-balances.yml
  - .github/workflows/qa-dev.yml
last-verified: "2026-11-06"
---

# Secret rotation

Every secret Haven stores in Railway, where else a copy lives, and what to do
when one leaks. Written after the 2026-10-21 Railway incident (epic #4484):
Railway disclosed that an attacker read customer environment variables, some of
them decrypted, and could not confirm whether Haven's were among them. The epic
treats every value stored in Railway on or before 2026-10-22 03:32 UTC as
exposed.

This page is the checklist for the next leak. It is not a security program: the
owner's 2026-10-27 decision keeps hardening minimal until Haven leaves the demo
stage. Moving the hot keys to a KMS, provider allowlists and spend caps, and
alerting are deferred and listed on the epic.

**No secret values belong on this page.** Names, addresses and dates only.

## How to read the inventory

- **One row per secret value.** The Variables column lists every Railway
  variable that embeds it, so a rotation updates all of them in one change.
- **Account.** `owner` means the Railway project owner holds the account and
  did the rotation. `shared` means the maintainer team holds it jointly and any
  maintainer with Railway admin can rotate it. `partner` means a partner
  organisation owns it and only they can revoke it. The owner set this split on
  2026-10-27, but #4488 does not name the account per provider, so those rows
  say `shared`; confirm the account before revoking. Partner-owned credentials
  are the accounting provider tokens encrypted under `HAVEN_SECRETS_KEY`: they
  live in the database, not in Railway, and partners revoke them by
  disconnecting (#4537).
- **Rotation.** `Done` names the slice that did it and the date. `Pending`
  names the slice that will.
- **Source.** The names-only Railway inventory, re-read on 2026-11-06: the
  2026-10-27 listing plus the three variables production gained on 2026-10-29
  (marked below). Values were never read.

## Railway inventory

| Secret | Variables (service: environment) | Provider, account | Blast radius | Rotation |
|---|---|---|---|---|
| Dev Postgres password | `POSTGRES_PASSWORD`, `PGPASSWORD`, `DATABASE_URL` (Postgres: dev); `DATABASE_URL` (@haven/backend: dev) | Postgres on Railway, owner | Full read/write on the dev database | Done, #4486 (2026-10-27) |
| Production Postgres password | `POSTGRES_PASSWORD`, `PGPASSWORD`, `DATABASE_URL` (Postgres: production); `DATABASE_URL` (@haven/backend: production) | Postgres on Railway, owner | Full read/write on production | Done, #4486 (2026-10-27) |
| Dev ops read-only password | `OPS_DATABASE_URL` (@haven/backend: dev) | Postgres role `haven_ops_readonly`, owner | Read-only access to the allowlisted ops columns | Done, #4486 (2026-10-29) |
| `JWT_SECRET` (dev) | @haven/backend: dev | Haven, owner | Ends every dashboard session; also signs the accounting OAuth `state` | Done, #4486 (2026-10-29) |
| `JWT_SECRET` (production) | @haven/backend: production | Haven, owner | Ends every dashboard session; also signs the accounting OAuth `state` | Done, #4486 (2026-10-29) |
| `OPS_JWT_SECRET` (dev) | @haven/backend: dev | Haven, owner | Ends every ops-console session; boot refuses if it equals `JWT_SECRET` or is too short | Done, #4486 (2026-10-29) |
| `HAVEN_OPS_TOKEN` (dev) | @haven/backend: dev | Haven, owner | Bearer token for the ops endpoints; the canary and reconciliation script read it from the caller's env | Done, #4486 (2026-10-29) |
| `HAVEN_OPS_TOKEN` (production) | @haven/backend: production | Haven, owner | Bearer token for the ops endpoints; the production canary reads it from the caller's env | Done, #4486 (2026-10-29) |
| `HAVEN_SECRETS_KEY` (dev) | @haven/backend: dev | Haven, owner | Encrypts every accounting provider token in dev; the build knows one key version | Pending, #4537: partners disconnect first, then swap the key and reconnect |
| `HAVEN_SECRETS_KEY` (production) | @haven/backend: production | Haven, owner | Encrypts every accounting provider token in production | No rotation: set 2026-10-29, after the incident, never exposed |
| Dev relayer key | `RELAYER_PRIVATE_KEY` (@haven/backend: dev) | Haven hot key, shared | Gas-only relayer; can send ETH from the relayer address | Done, #4487 (2026-11-04) |
| Production relayer key | `RELAYER_PRIVATE_KEY` (@haven/backend: production) | Haven hot key, shared | Gas-only relayer; can send ETH from the relayer address | Done, #4487 (2026-11-04) |
| Dev x402 binding key | `X402_BINDING_PRIVATE_KEY` (@haven/backend: dev); its address is published as `HAVEN_X402_BINDING_SIGNER` | Haven hot key, shared | Signs x402 binding contexts and sweep authorizations; a stale address breaks every x402 payment and sweep | Done, #4487 (2026-11-04) |
| Production x402 binding key | `X402_BINDING_PRIVATE_KEY` (@haven/backend: production); its address is published as `HAVEN_X402_BINDING_SIGNER` | Haven hot key, shared | Signs x402 binding contexts and sweep authorizations; a stale address breaks every x402 payment and sweep | Done, #4487 (2026-11-04) |
| Dev settlement key | `SETTLEMENT_PRIVATE_KEY` (Demo-merchant: dev) | Haven hot key, shared | Settles x402 payments; holds USDC and gas | Done, #4487 (2026-11-04) |
| Production settlement key | `SETTLEMENT_PRIVATE_KEY` (Demo-merchant: production) | Haven hot key, shared | Settles x402 payments; holds USDC and gas | Done, #4487 (2026-11-04) |
| Dev Alchemy RPC key | `RPC_URL_BASE_SEPOLIA` (@haven/backend: dev) | Alchemy, shared | Paid RPC quota; read-only chain access | Pending, #4488 |
| Dev Infura RPC key | `RPC_URL_BASE_SEPOLIA_FALLBACK` (@haven/backend: dev) | Infura, shared | Fallback RPC quota; a mistake is silent until Alchemy fails | Pending, #4488 |
| Pimlico key | `DELEGATION_RAIL_BUNDLER_URL`, `PILOT_BUNDLER_URL` (@haven/backend: dev); `DELEGATION_RAIL_BUNDLER_URL`, `DELEGATION_RAIL_BUNDLER_URL_84532` (@haven/backend: production) | Pimlico, shared | Bundles and sponsors every delegation-rail payment; with the policy ID, sponsored gas | Pending, #4488 (delete `PILOT_BUNDLER_URL`) |
| Production Alchemy RPC key | `RPC_URL_BASE`, `RPC_URL_BASE_SEPOLIA` (@haven/backend: production) | Alchemy, shared | One key, two URLs; paid RPC quota | Pending, #4488 |
| Production Infura RPC key | `RPC_URL_BASE_FALLBACK` (@haven/backend: production) | Infura, shared | Fallback RPC quota; a mistake is silent until Alchemy fails | Pending, #4488 |
| Alchemy history key | `ALCHEMY_HISTORY_API_KEY` (@haven/backend: production) | Alchemy, shared | History API quota | Pending, #4488 |
| CoinGecko key | `COINGECKO_API_KEY` (@haven/backend: dev and production) | CoinGecko, shared | Price feed quota | Pending, #4488 |
| GnosisScan key | `GNOSISSCAN_API_KEY` (@haven/backend: dev and production) | Etherscan (GnosisScan V2), shared | Explorer API quota for chain 100 | Pending, #4488 |
| Fortnox client secret | `FORTNOX_CLIENT_SECRET` (@haven/backend: dev and production) | Fortnox OAuth app, shared | Can mint tokens for every connected Fortnox account | Pending, #4488 |
| Ops-console GitHub OAuth client secret | `OPS_GITHUB_CLIENT_SECRET` (@haven/backend: dev) | GitHub OAuth app, owner | Can impersonate the ops-console OAuth app | Pending, #4488 |

For a pending provider row, the steps are #4488's: create the new key at the
provider, update every Railway variable that embeds it, redeploy, confirm the
service works, and only then revoke the old key at the provider. For a pending
hot-key row, the steps are #4487's, including the sweep before the binding cut.

### Checked and not secrets

No row, because the value grants nothing on its own:

- **Public addresses:** `HAVEN_X402_BINDING_SIGNER` and `MERCHANT_ADDRESS`. The
  first still has to change with its key, in the same deploy.
- **Identifiers:** `DELEGATION_RAIL_SPONSORSHIP_POLICY_ID` (dangerous only
  together with the Pimlico key), `FORTNOX_CLIENT_ID`, `OPS_GITHUB_CLIENT_ID`,
  `OPS_ALLOWED_GITHUB_IDS`, `AGENT_PASSPORT_SCHEMA_UID_84532`.
- **Public endpoints:** `BASE_RPC_URL` (Base's public endpoint, no key),
  `FRONTEND_URL`, `HAVEN_API_URL`, `HAVEN_HOSTED_MCP_URL`, `BASE_URL`,
  `OPS_PUBLIC_ORIGIN`, `OPS_REDIRECT_ORIGINS`, `FORTNOX_REDIRECT_URI`.
- **Configuration:** `HAVEN_DEPLOY_CHAIN_IDS`, `HAVEN_MARKETPLACE_CHAIN_IDS`,
  `HAVEN_MARKETPLACE_PROSPECTS`, `HAVEN_CONNECTOR_CHANNEL`, `HAVEN_HOSTED`,
  `HAVEN_ACCOUNTING_ENABLED`, `HAVEN_ACCOUNTING_ENTITLEMENT_MODE` (the last two
  reached production on 2026-10-29), `HAVEN_OWNER_COMPANY_DETAILS`,
  `NEXT_PUBLIC_HAVEN_CHAIN_ID`, `SWEEP_MIN_USDC`, `TRUST_PROXY_HOPS`,
  `MERCHANT_REPORT_GRACE_MIN_OVERRIDE`, `MERCHANT_CHAIN_ID`,
  `MERCHANT_ERC7710_DELEGATION_MANAGER`, `MERCHANT_SKIP_SETTLE_PRODUCT`,
  `MERCHANT_X402_ERC7710`, `MERCHANT_X402_SETTLEMENT_METHODS`,
  `MPP_DEMO_RECIPIENT_ADDRESS` (an address, and nothing reads it since #1328),
  `PGDATA`, `PGDATABASE`, `PGHOST`, `PGPORT`, `PGUSER`, `POSTGRES_DB`,
  `POSTGRES_USER`, `SSL_CERT_DAYS`.

## Copies outside Railway

Each copy is its own row. A rotation that stops at Railway leaves the old value
valid wherever it was copied.

| Copy | Where | Mirrors | Rotation |
|---|---|---|---|
| `QA_X402_BINDING_SIGNER` (repository variable and secret) | GitHub Actions | dev `HAVEN_X402_BINDING_SIGNER` | Set both to the new dev address. `qa-dev.yml` reads the variable first; `agent-evals.yml` reads only the variable. |
| `QA_DEV_RELAYER_ADDRESS` (repository variable) | GitHub Actions | dev relayer address | Set it to the new dev relayer address; `qa-balances.yml` pins it. |
| `QA_RPC_URL_BASE_SEPOLIA` (repository secret) | GitHub Actions | dev `RPC_URL_BASE_SEPOLIA` | Set it to the new dev Alchemy URL, or the next `qa-dev` run fails once the old key is revoked. |
| `~/.haven/pilot.env` | maintainers' machines | dev `PILOT_BUNDLER_URL` (the Pimlico key) | Update or delete the line. |
| `.env` and `.env.dev` | maintainers' checkouts, gitignored | any Railway value copied locally | Update or delete the line. |
| `x402_binding_signer` in `signer.json` | every connected agent runtime | `HAVEN_X402_BINDING_SIGNER` | Edit the field and restart the MCP. `connect --rekey` carries the old address forward, and the file value beats the environment. |
| `HAVEN_X402_BINDING_SIGNER` in an MCP config | Claude Code and Codex configs | the same address | Update or remove it so the file value wins. |
| `HAVEN_OPS_TOKEN` in a shell or CI job | canary and reconciliation runners | Railway `HAVEN_OPS_TOKEN` | Update the caller's env; the script reads it from there, not from Railway. |

## Rotation order for the next leak

1. **Freeze.** Note the time, and treat every value stored before it as
   exposed.
2. **Inventory.** List names only, never values:
   `railway variables -e <env> -s <service> --json | jq -r 'keys[]'`. Add any
   new variable to this page.
3. **Rotate in dependency order.** Database passwords, then session and ops
   secrets, then the hot keys, then provider keys. A hot-key rotation has its
   own order: sweep stranded balances before the binding cut.
4. **Update every copy** in the table above in the same change.
5. **Verify.** `/health` and `/health/ops`, a dashboard sign-in, one dev
   payment, and the production canary ([mainnet-canary.md](mainnet-canary.md)).
6. **Revoke the old value at the provider.** Updating Railway alone leaves the
   leaked value valid.
7. **Record.** Comment on the slice issue with the variable name and the date,
   never the value. Bump `last-verified` here.

## Gotchas this incident turned up

- **`HAVEN_X402_BINDING_SIGNER` must change with `X402_BINDING_PRIVATE_KEY`, in
  one deploy.** The explicit address wins over the one derived from the key
  (`packages/backend/src/infra/chain/x402-binding-signer.ts`), so rotating the
  key alone keeps handing out the old address
  (`packages/backend/src/routes/agent-connection-setups.ts`) and every signer
  rejects every binding. Every signer's `signer.json` needs the new address
  (`packages/connect/src/storage.ts`); `connect --rekey` does not update it
  (`packages/connect/src/rekey.ts`), and sweep stops too because the binding key
  signs sweep authorizations (`packages/backend/src/rails/sweep.ts`).
- **The bundler and gas sponsor is Pimlico, not the RPC provider**
  (`packages/backend/src/rails/delegation-rail.ts`). One Pimlico key sits in
  four variables across both environments. The sponsorship policy is attached
  per request, so a new key under the same account keeps the existing policy
  ID. Do not change the policy ID.
- **`HAVEN_SECRETS_KEY` has a single key version**
  (`packages/backend/src/infra/secrets.ts`). A new key at the same version
  cannot decrypt old rows, so disconnect the accounting connections before
  swapping it, then reconnect. Production's key was set after the incident and
  stays.
- **The dev relayer is the dev passport attester.** Only the relayer that
  attested a dev passport can revoke it (`packages/backend/src/index.ts`), so
  the old dev relayer key is kept off Railway in the team's password manager.
  That is the epic's accepted exception to its invariant.
- **`JWT_SECRET` ends every session**, on both environments, and also signs the
  accounting OAuth `state`
  (`packages/backend/src/routes/accounting-connections.ts`). An accounting
  connect in flight at the moment of rotation fails and must restart.
- **Revoke at the provider, not only in Railway.** A key removed from Railway
  is still valid until the provider deletes it.
- **Generate passwords as hex, not base64.** Base64 characters break a URL.
  Save the value once, then paste from the saved copy into both places.
- **A malformed private key can be echoed into the logs** by the library that
  parses it. Treat a bad paste as exposed and discard the key (#4654).

## Backend-read secrets that are not in Railway

These are absent from both listings on 2026-10-27, so there is nothing to
rotate today. If one is set later, it joins the inventory above.

| Variable | Read by | If it is ever set |
|---|---|---|
| `PASSPORT_RECEIPT_SIGNING_KEY` | `packages/backend/src/modules/passport/receipt.ts` | Signs merchant-facing verification receipts. Its address is published for pinning, so rotating it breaks every merchant that pinned the old issuer address. Treat it as a breaking change: publish the new address first. |
| `CATALOG_OWNERSHIP_SECRET` | `packages/backend/src/modules/catalog/ownership.ts` | Computes catalog ownership proofs. Rotating it invalidates proofs already issued. |
| `DELEGATE_ALERT_WEBHOOK_URL` | `packages/backend/src/infra/delegate-alert-webhook.ts` | A webhook URL; the URL is the credential, so treat it as a secret. |
| `BLOCKSCOUT_API_KEY`, `BASESCAN_API_KEY` | `packages/backend/src/config.ts` | Explorer API keys; quota only. |

## Related

- [railway-services.md](railway-services.md) for the services, the Postgres
  access policy and cost.
- [ops-readonly-role.md](ops-readonly-role.md) for the ops read-only role.
- [mainnet-canary.md](mainnet-canary.md) for the production verification after
  a rotation.
- Epic #4484 and slices #4486, #4487, #4488, #4489, #4537.
