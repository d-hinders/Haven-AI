# Codex Task — Backend Passkey Enrollment + Safe Deploy Relayer

> **Parent design doc:** [`docs/plans/passkey-onboarding.md`](./passkey-onboarding.md). Read it first; this task implements PR #1 from the suggested split — the backend half of the passkey-onboarding feature.
>
> **Suggested branch:** `codex/passkey-backend-routes`, cut from `main`.
>
> **Predecessor:** PR #40 (frontend passkey + WebAuthn helpers) is merged on `main` and provides the client-side patterns this backend must mirror. Read [`packages/frontend/src/lib/safePasskeySigner.ts`](../../packages/frontend/src/lib/safePasskeySigner.ts) — the backend's CREATE2 prediction must produce identical addresses for identical `(x, y, chainId)` inputs.

## Why This Task Exists

The frontend can now create WebAuthn passkeys and derive deterministic Safe passkey signer addresses, but the addresses live only in browser memory. To complete the onboarding flow we need:

1. **Persistence** — somewhere to store `(credential_id, x, y, signer_address, chain_id)` tied to a Haven user, so the dashboard can look up the right credential on re-login and a future device flow can list a user's enrolled signers.
2. **Relayer-paid Safe deployment** — passkey users have no EOA and no gas. Haven's existing relayer EOA (already used for agent transactions, see `RELAYER_PRIVATE_KEY` in `.env.example`) submits the `SafeProxyFactory.createProxyWithNonce` transaction with the user's passkey signer set as the sole owner.

Without this PR, the frontend onboarding UI (PR #4) has nowhere to send enrollment data and no way to deploy a Safe for a passkey user. With it, every backend dependency for end-to-end passkey signup is in place.

## What Counts as Done

A reviewer can:

1. Run the new migration locally (`npm run dev --workspace @haven/backend`) and see a `user_passkeys` table created with the columns specified below.
2. Sign up via the existing email/password flow, hit `POST /passkeys` with a fixture body, and observe a row created with the deterministic `signer_address` that matches what `predictSafePasskeySignerAddress` from the frontend would return for the same `(x, y, chain_id)`.
3. Hit `POST /safe/deploy` and observe (a) the relayer EOA submits `createProxyWithNonce` to the chain's Safe Proxy Factory, (b) the deployed Safe has the passkey signer contract as its sole owner, (c) the response returns `{ safe_address, tx_hash }`, and (d) the `user_passkeys.safe_address` column is populated.
4. Run `npm test --workspace @haven/backend` — new unit tests pass, existing tests untouched.

## Scope — Inside

- **New migration:** `packages/backend/src/db/migrations/003_user_passkeys.ts` — `user_passkeys` table.
- **New file:** `packages/backend/src/lib/passkey-signer.ts` — backend port of the frontend's CREATE2 prediction, plus the v0.2.1 proxy creation code constant.
- **New file:** `packages/backend/src/routes/passkeys.ts` — `POST /passkeys`, `GET /passkeys`.
- **New file:** `packages/backend/src/routes/safe-deploy.ts` — `POST /safe/deploy` (relayer-submitted Safe deployment for passkey users).
- **New file:** `packages/backend/src/lib/relayer.ts` — minimal per-chain relayer wrapper around the existing `RELAYER_PRIVATE_KEY` (factor any inline relayer code that already exists in `routes/payments.ts` or `routes/self-sign-payments.ts` only if it's a clean cut — otherwise just write a fresh wrapper).
- **Modify:** `packages/backend/src/lib/chains.ts` — add a `passkey: { verifier: string }` block to each `ChainConfig`, mirroring what was done in the frontend.
- **Modify:** `packages/backend/src/db/migrations/index.ts` — register the new migration.
- **Modify:** `packages/backend/src/index.ts` — register the two new route modules with prefixes `/passkeys` and `/safe`.
- **New tests:** `packages/backend/src/routes/__tests__/passkeys.test.ts`, `safe-deploy.test.ts`, plus a unit test file for `passkey-signer.ts`.

## Scope — Outside (Do Not Touch)

- `packages/backend/src/routes/auth.ts` — email/password auth and JWT issuance stay as they are.
- `packages/backend/src/routes/safe-details.ts` — the existing `/safe` namespace handles read-only Safe detail lookups; do not collapse the new `/safe/deploy` into it. Use `app.register(safeDeployRoutes, { prefix: '/safe' })` so both modules co-exist on the same prefix, or pick a separate prefix like `/safe-deploy` if Fastify's route conflict detection complains.
- `packages/frontend/` — entirely.
- `packages/sdk/` — entirely.
- The agent / x402 / Allowance Module flows — do not refactor existing payment relayer code unless there's a clean shared abstraction. If in doubt, copy the few lines you need into the new `lib/relayer.ts` and leave existing routes alone.

If you find yourself touching anything in the "outside" list, stop and flag it.

## Database Migration — `003_user_passkeys.ts`

Follow the existing pattern in `packages/backend/src/db/migrations/001_self_sign_agents.ts`. Do not use a separate `down` method — this codebase only does forward migrations (`up` only).

```sql
CREATE TABLE IF NOT EXISTS user_passkeys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id   TEXT NOT NULL,                  -- base64url, no padding
  public_key_x    BYTEA NOT NULL,                 -- 32 bytes
  public_key_y    BYTEA NOT NULL,                 -- 32 bytes
  signer_address  VARCHAR(42) NOT NULL,           -- CREATE2-deterministic, lowercased
  chain_id        INTEGER NOT NULL,
  safe_address    VARCHAR(42),                    -- populated after /safe/deploy succeeds
  raw_attestation BYTEA,                          -- optional, kept for future attestation verification
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (credential_id),
  UNIQUE (user_id, chain_id)                      -- one passkey per user per chain for MVP
);

CREATE INDEX IF NOT EXISTS idx_user_passkeys_user_id ON user_passkeys(user_id);
CREATE INDEX IF NOT EXISTS idx_user_passkeys_signer_address ON user_passkeys(signer_address);
```

The `(user_id, chain_id)` uniqueness is intentional MVP scope — multi-device per chain is post-MVP and would require dropping this constraint and adding device labels. Don't preemptively design for it.

Register the migration in `migrations/index.ts` after `selfSignPaymentIntents`.

## File — `packages/backend/src/lib/passkey-signer.ts`

This is the backend mirror of `packages/frontend/src/lib/safePasskeySigner.ts`. The two implementations must produce **bit-identical signer addresses** for the same `(x, y, chainId)`, because the frontend predicts the address before deployment and the backend independently re-derives it for validation.

### Exports

```ts
export interface SafePasskeyConfig {
  factoryAddress: string      // SafeWebAuthnSignerFactory, checksummed
  verifierAddress: string     // RIP-7212 precompile or FCL verifier, lowercased
  singletonAddress: string    // SafeWebAuthnSignerSingleton, checksummed
}

/**
 * Pure CREATE2 prediction. Mirrors the frontend implementation in
 * packages/frontend/src/lib/safePasskeySigner.ts. Both must agree.
 */
export function predictSafePasskeySignerAddress(args: {
  x: `0x${string}`            // 32-byte hex
  y: `0x${string}`            // 32-byte hex
  chainId: number
}): string                    // checksummed address

export function getSafePasskeyConfig(chainId: number): SafePasskeyConfig
```

### Implementation notes

- Use `ethers` (already a backend dep), specifically `ethers.getCreate2Address`, `ethers.keccak256`, `ethers.solidityPacked`, and `ethers.AbiCoder.defaultAbiCoder().encode(...)`.
- **Copy the exact v0.2.1 proxy creation code constant** from `packages/frontend/src/lib/safePasskeySigner.ts` — same hex string, same comment about why it's inlined. Adding a new shared workspace package is out of scope for this PR; the duplication is intentional and documented.
- Constructor arg encoding: `(address singleton, uint256 x, uint256 y, uint176 verifiers)` — exactly matching the frontend. The frontend uses `uint176` (not `uint256`) for `verifiers`; do the same here for byte-identical encoding. There's a comment in the frontend explaining why; copy that comment.
- Salt is `bytes32(0)` (`ethers.ZeroHash`).
- **Singleton address derivation:** `ethers.getCreateAddress({ from: factoryAddress, nonce: 1 })`. The factory's constructor deploys the singleton as its only child contract, so nonce `1` is correct.
- **Factory address lookup:** the frontend uses `@safe-global/safe-modules-deployments`. You can either add that package to the backend's deps and use the same lookup, OR hardcode the factory address per chain in `chains.ts` alongside the verifier (preferred for the backend — fewer moving parts, and the factory address is stable). Document whichever you pick with a comment.

### Verification

The CREATE2 prediction has already been live-validated against Base mainnet and Gnosis mainnet in the frontend tests (commit `49ffeee`). For the backend port, prove parity by adding a unit test that takes the same fixed `(x, y)` pair as the frontend test and asserts the same outputs:

| chainId | Expected signer address |
|---|---|
| 8453 (Base) | `0xe54122F41f7ADF87fB6d5Ab36BAe42FC2AAc882C` |
| 100 (Gnosis) | `0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2` |

For the fixed key pair `x = 0x11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff`, `y = 0xffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100`. If your backend implementation predicts different addresses, **the encoding is wrong** — fix it before moving on. This parity is the linchpin of the whole feature.

## File — `packages/backend/src/lib/chains.ts` (modify)

Add to the `ChainConfig` interface:

```ts
passkey: {
  /** P-256 verifier the Safe passkey signer will call. */
  verifier: string                    // lowercased address
  /** SafeWebAuthnSignerFactory deployment for this chain. */
  factoryAddress: string              // checksummed
}
```

Per-chain values (mirror the frontend's `chains.ts`, plus the factory addresses):

| Chain | `passkey.verifier` | `passkey.factoryAddress` |
|---|---|---|
| Base (8453) | `0x0000000000000000000000000000000000000100` | look up via `@safe-global/safe-modules-deployments` or copy from a manual lookup against Base mainnet |
| Gnosis (100) | `0x445a0683e494ea0c5af3e83c5159fbe47cf9e765` | same lookup approach |

If you choose the npm-package route for factory lookup, install `@safe-global/safe-modules-deployments` (the backend doesn't have it yet) and call `getSafeWebAuthnSignerFactoryDeployment({ network: chainId.toString() })` once at module load. If you choose the hardcoded route, paste the addresses with a comment indicating where they came from. Either is fine.

## File — `packages/backend/src/lib/relayer.ts`

```ts
import { JsonRpcProvider, Wallet } from 'ethers'
import { config } from '../config.js'
import { getChainConfig } from './chains.js'

/**
 * Returns a signer connected to the given chain's RPC, funded by RELAYER_PRIVATE_KEY.
 * The signer is reused across calls for the same chainId (cached).
 */
export function getRelayer(chainId: number): Wallet
```

Implementation notes:
- One `Wallet` per chainId, cached in a module-level `Map<number, Wallet>`.
- Provider URL: `getChainConfig(chainId).rpcUrl`.
- Reads `RELAYER_PRIVATE_KEY` from `config.ts`. If you need to add it to `config.ts`, do so following the existing pattern.
- Add a balance check helper:
  ```ts
  export async function warnIfRelayerLow(chainId: number, minBalanceWei: bigint): Promise<void>
  ```
  that logs a warning via `app.log.warn(...)` (or `console.warn` if you don't want to thread the Fastify logger). Don't throw — low balance is operational, not a request-level error. Default `minBalanceWei` to `parseEther('0.01')` for now.

If `routes/payments.ts` or `routes/self-sign-payments.ts` already constructs a relayer wallet inline, **leave them alone**. Refactoring shared relayer infrastructure into one module is out of scope for this PR; the duplication can be cleaned up later in a dedicated chore.

## Routes — `packages/backend/src/routes/passkeys.ts`

All routes here are passkey-signer enrollment **for already-authenticated users**. Apply the existing `authMiddleware` via `app.addHook('onRequest', authMiddleware)` exactly as in `routes/user-safes.ts`.

### `POST /passkeys`

Register a new passkey signer. Body:

```ts
interface RegisterPasskeyBody {
  credential_id: string         // base64url, no padding
  public_key_x: string          // 32-byte hex, 0x-prefixed
  public_key_y: string          // 32-byte hex, 0x-prefixed
  chain_id: number
  raw_attestation_object?: string  // optional, base64url-encoded
}
```

Response (201):
```ts
{
  id: string,                   // uuid
  signer_address: string,       // server-derived, the source of truth
  chain_id: number,
  credential_id: string,
}
```

Validation:
- `chain_id` is one of the supported chains (use `isSupportedChain` from `lib/chains.ts`).
- `public_key_x` and `public_key_y` are exactly 32 bytes each (66-char hex including `0x`).
- `credential_id` is non-empty, base64url alphabet, length ≤ 1024 chars.
- `raw_attestation_object`, if present, is valid base64url.

Behavior:
- Compute `signer_address = predictSafePasskeySignerAddress({ x, y, chainId })` server-side. **Never trust a client-supplied signer address** — always derive it.
- Insert into `user_passkeys` with `signer_address` lowercased.
- On `(user_id, chain_id)` conflict (user already has a passkey for this chain), return `409` with `{ error: 'A passkey is already registered for this chain' }`.
- On `(credential_id)` conflict, return `409` with `{ error: 'This credential is already registered' }`.
- Note explicitly in a code comment that **attestation is not cryptographically verified for the POC**. The risk model: a user enrolling a public key they don't control will lose access to their own future Safe; no other user's funds are affected.

### `GET /passkeys`

List the authenticated user's enrolled passkey signers.

Response (200):
```ts
{
  passkeys: Array<{
    id: string,
    credential_id: string,
    signer_address: string,
    chain_id: number,
    safe_address: string | null,
    created_at: string,
  }>
}
```

Order by `created_at ASC`. No pagination needed for MVP.

## Routes — `packages/backend/src/routes/safe-deploy.ts`

### `POST /safe/deploy`

Deploy a 1/1 Safe on the requested chain, owned by the authenticated user's enrolled passkey signer for that chain. Relayer pays gas.

Body:
```ts
interface DeploySafeBody {
  chain_id: number
  salt_nonce?: string           // optional decimal string; defaults to a random uint256
}
```

Response (201):
```ts
{
  safe_address: string,         // checksummed
  tx_hash: string,
  chain_id: number,
}
```

Behavior:
1. Look up the user's passkey for `chain_id`. If none, return `404` with `{ error: 'No passkey enrolled for this chain' }`.
2. Re-derive `signer_address` from the stored `(public_key_x, public_key_y, chain_id)` and assert it matches the stored `signer_address`. (Defense in depth: catches DB tampering and migration bugs.)
3. Construct the Safe `setup` initializer matching the frontend's `deploySafe` (see `packages/frontend/src/lib/safe.ts`):
   - `_owners: [signer_address]`
   - `_threshold: 1`
   - `to: 0x0`, `data: 0x`, `paymentToken: 0x0`, `payment: 0`, `paymentReceiver: 0x0`
   - `fallbackHandler: getChainConfig(chain_id).contracts.fallbackHandler`
4. Generate `salt_nonce` if not provided: `BigInt(Math.floor(Math.random() * 1_000_000_000))`. (For now — replace with a stronger source post-MVP.)
5. Call `SafeProxyFactory.createProxyWithNonce(singleton, initializer, saltNonce)` via the relayer wallet for that chain. Wait for the receipt. Extract the deployed proxy address from the `ProxyCreation` event.
6. Update `user_passkeys.safe_address` for this `(user_id, chain_id)` row.
7. **Do not** auto-add the Safe to the `user_safes` table from this route. The frontend will do that via the existing `POST /user/safes` endpoint after a successful deploy. Keeping the deploy route narrow makes failure modes easier to reason about.
8. Return the response.

Edge cases:
- Relayer balance below threshold: log a warning, but proceed. If the tx fails for `insufficient funds`, surface a `503` with `{ error: 'Relayer is temporarily unfunded; please try again later' }`.
- A Safe is already deployed for this `(user_id, chain_id)` (i.e., `safe_address` is non-null in `user_passkeys`): return `409` with `{ error: 'A Safe is already deployed for this passkey' }`. The frontend can re-fetch via `GET /passkeys`.
- The CREATE2 address for `(singleton, initializer, saltNonce, factory)` already has bytecode (someone else front-ran the deployment with the same salt): catch the revert and return a `503` so the client retries with a new salt. Vanishingly unlikely with random salts but worth handling.

### Implementation reference

Look at `packages/frontend/src/lib/safe.ts` for the exact `setup` ABI and `createProxyWithNonce` ABI. Use the same selectors. The backend already has `@safe-global/protocol-kit` v5.1.0; you can either use the Protocol Kit's `Safe.init` + `createSafeDeploymentTransaction` flow or hand-roll the call with the Safe Proxy Factory ABI via `ethers.Contract`. Hand-rolling is probably simpler for this single endpoint and avoids pulling in the Protocol Kit's signer abstraction.

## Route Registration

In `packages/backend/src/index.ts`, after the existing `register` calls:

```ts
await app.register(passkeyRoutes, { prefix: '/passkeys' })
await app.register(safeDeployRoutes, { prefix: '/safe' })
```

Note: `/safe` is already used by `safeDetailRoutes`. Fastify allows multiple route modules on the same prefix as long as their paths don't collide. `safeDetailRoutes` registers `GET /safe/:address/details` (or similar); `safeDeployRoutes` will register `POST /safe/deploy`. If Fastify complains about a conflict, switch the new module to `prefix: '/safe-deploy'` and document the choice.

## Tests

Use the existing test patterns in `packages/backend/src/routes/__tests__/`. Vitest is wired with the same setup as the frontend.

### `passkey-signer.test.ts`

1. **Fixture parity with the frontend** — for the fixed key pair listed in the verification section above, assert `predictSafePasskeySignerAddress` returns `0xe54122F41f7ADF87fB6d5Ab36BAe42FC2AAc882C` for Base and `0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2` for Gnosis. **This is the most important test in the PR.** If it fails, the encoding is wrong.
2. **Determinism** — same inputs return the same address.
3. **Throws on unsupported chain.**

### `passkeys.test.ts`

Mock the DB pool (existing tests already do this via `vi.mock('../../db.js', ...)` — follow that pattern). Cover:

1. `POST /passkeys` happy path — server derives `signer_address`, inserts, returns 201.
2. `POST /passkeys` rejects bad `chain_id`.
3. `POST /passkeys` rejects malformed `public_key_x` (e.g., 31 bytes, missing `0x` prefix).
4. `POST /passkeys` returns 409 on `(user_id, chain_id)` conflict.
5. `POST /passkeys` returns 409 on `credential_id` conflict.
6. `POST /passkeys` requires JWT — no auth → 401.
7. `GET /passkeys` returns the authenticated user's passkeys, ordered by `created_at`.

### `safe-deploy.test.ts`

Mock the DB pool and the relayer wallet. Cover:

1. `POST /safe/deploy` happy path — relayer is called with the right ABI args, returns 201 with `safe_address` extracted from the receipt's `ProxyCreation` event, and updates `user_passkeys.safe_address`.
2. Returns 404 if the user has no passkey for the requested chain.
3. Returns 409 if the user already has a Safe deployed for this chain.
4. Returns 503 if the relayer wallet has insufficient funds (mock the contract call to reject with the relevant ethers error code).
5. Re-derives `signer_address` and bails (500 with a generic error) if the stored value doesn't match the freshly computed one — this is the defense-in-depth check.

You don't need to spin up a real chain for these — mocking `ethers.Contract` calls is enough. The CREATE2-prediction parity test in `passkey-signer.test.ts` is what proves correctness against the real chains.

## Verification Checklist (Local)

- [ ] `npm install` from repo root succeeds; lockfile committed.
- [ ] Database migration runs cleanly: drop the local DB, restart the backend, observe `user_passkeys` table created with correct columns and indexes.
- [ ] `npm test --workspace @haven/backend` passes — new tests plus all existing tests.
- [ ] `npm run build --workspace @haven/backend` succeeds.
- [ ] Manual smoke test:
  - Sign up via the existing email/password flow, capture the JWT.
  - `curl -X POST http://localhost:3001/passkeys` with the JWT and a fixture body using the same `(x, y)` pair as the parity test. Confirm the returned `signer_address` matches the pinned Base/Gnosis fixtures depending on `chain_id`.
  - `curl -X POST http://localhost:3001/safe/deploy` with `chain_id: 100` (Gnosis Chiado is preferred for actual deployment if you have it; mainnet works too if the relayer is funded). Confirm a Safe is deployed and the `user_passkeys.safe_address` row is populated.
  - On Gnosisscan, confirm the deployed Safe's owner is exactly the predicted passkey signer address.
- [ ] No changes to `routes/auth.ts`, frontend, SDK, or existing payment routes.

## PR Hygiene

- Branch from `main`, name `codex/passkey-backend-routes`.
- Suggested commit split: (a) migration + chain config, (b) `passkey-signer.ts` + parity test, (c) relayer wrapper, (d) `passkeys.ts` route + tests, (e) `safe-deploy.ts` route + tests, (f) route registration in `index.ts`. Squash-merge will collapse them.
- PR description should explicitly say "no UI / no AuthContext / no frontend changes" and link this spec.
- Call out the v0.2.1 proxy bytecode constant duplication as a follow-up cleanup candidate (extract to a shared workspace package once a third consumer appears).

## Out-of-Scope Reminders

If during implementation you find yourself wanting to:

- Verify the WebAuthn attestation cryptographically — **don't, for this PR.** Document the trust model in a code comment and move on.
- Refactor the existing relayer code in `routes/payments.ts` / `routes/self-sign-payments.ts` — **don't.** Copy what you need into `lib/relayer.ts`; cleanup later.
- Add the deployed Safe to `user_safes` automatically — **don't.** The frontend will call `POST /user/safes` separately.
- Support multiple passkeys per user per chain (device list) — **don't.** Post-MVP, would require schema changes.
- Add 4337 / UserOp deployment as an alternative — **don't.** The parent plan explicitly chose Option A (relayer); revisiting that is a separate design discussion.

If any of these feel necessary mid-implementation, stop and post a comment on the PR rather than expanding scope.

## Reference Material

- Parent plan: [`docs/plans/passkey-onboarding.md`](./passkey-onboarding.md)
- Predecessor PR (frontend helpers, merged): https://github.com/d-hinders/Haven-AI/pull/40
- Frontend signer to mirror: `packages/frontend/src/lib/safePasskeySigner.ts`
- Existing migration pattern: `packages/backend/src/db/migrations/001_self_sign_agents.ts`
- Existing route + auth pattern: `packages/backend/src/routes/user-safes.ts`
- Frontend Safe deploy ABI reference: `packages/frontend/src/lib/safe.ts`
- Safe passkey docs: https://docs.safe.global/advanced/passkeys/passkeys-safe
- Safe Proxy Factory ABI: https://github.com/safe-global/safe-smart-account/blob/main/contracts/proxies/SafeProxyFactory.sol
