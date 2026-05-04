# Codex Task — `HavenUserSigner` Abstraction + Relayer-Paid Safe Execution

> **Parent design doc:** [`docs/plans/passkey-onboarding.md`](./passkey-onboarding.md). PR #3 in the suggested split.
>
> **Suggested branch:** `codex/passkey-signer-abstraction`, cut from `main`.
>
> **Predecessors merged on `main`:**
> - PR #40 — frontend passkey + WebAuthn helpers (`packages/frontend/src/lib/passkey.ts`, `safePasskeySigner.ts`)
> - PR #42 — backend `user_passkeys` schema + `/passkeys` enrollment + `/safe/deploy` relayer route
>
> Read both before starting. Their shape and conventions are the reference for this work.

## Why This Task Exists

After PR #42 merged, a passkey user can sign up, enroll a passkey, and have a Safe deployed where the passkey signer contract is the sole owner. But they cannot **operate** the Safe yet:

1. **Signing** — every Safe admin call site in the frontend (manual transfer, enable Allowance Module, create/revoke agent allowance, change threshold) reads the connected EOA from Wagmi's `useWalletClient()` and signs with `walletClient.signTypedData`. There is no path for "the signer is a passkey-backed contract."
2. **Execution** — `Safe.execTransaction` requires gas. EOA users pay it themselves. Passkey users have no EOA — so the backend relayer (already used for `/safe/deploy`) must also submit `execTransaction`.

Without this PR, passkey users get stuck on the dashboard immediately after signup. The frontend onboarding UI (PR #4) therefore cannot ship.

This PR is the abstraction layer that makes the signer interchangeable plus the backend route that lets passkey-signed transactions actually execute. **No UI changes** — that's PR #4.

## What Counts as Done

A reviewer can:

1. As an existing EOA-owner user (no migration steps), perform every existing Safe admin action — manual outbound transfer, create/edit/revoke agent allowance, dashboard onboarding deploy. **Behavior must be byte-identical to before this PR**: same wallet popup, same gas paid by the EOA, same tx hash format, same UX.
2. Programmatically (no UI yet) construct a `HavenUserSigner` of either kind:
   ```ts
   const eoaSigner: HavenUserSigner = { type: 'eoa', address, walletClient }
   const passkeySigner: HavenUserSigner = {
     type: 'passkey',
     address: signerContractAddress,
     credentialId,
     publicKey: { x, y },
     chainId,
   }
   ```
   and pass either through any signing call site without branching at the call site.
3. With a passkey signer, call `executeSafeTx(...)` and observe the request hit `POST /safe/exec` on the backend, the relayer wallet submits `execTransaction` paying gas, and the response returns the on-chain tx hash.
4. Run `npm test --workspace @haven/backend` and `npm test --workspace @haven/frontend` — new tests pass, all existing tests pass.

## Scope — Inside

### Backend
- **New file:** `packages/backend/src/routes/safe-exec.ts` — `POST /safe/exec` relayer-submitted `Safe.execTransaction`.
- **Modify:** `packages/backend/src/index.ts` — register route (mount under `/safe`, same prefix as `/safe/deploy`).
- **New tests:** `packages/backend/src/routes/__tests__/safe-exec.test.ts`.

### Frontend
- **New file:** `packages/frontend/src/lib/signer.ts` — the `HavenUserSigner` discriminated union, factory helpers, and the `useActiveSigner()` hook.
- **New file:** `packages/frontend/src/lib/passkey-sign.ts` — produces a Safe-compatible ERC-1271 contract signature from a WebAuthn assertion. Uses `getPasskeyAssertion` from existing `lib/passkey.ts`.
- **Modify:** `packages/frontend/src/lib/safe.ts` — split `deploySafe` into two internal functions (`deploySafeWithEoa`, `deploySafeWithPasskey`) and dispatch on signer type. The exported `deploySafe` keeps its name but takes a `HavenUserSigner` instead of `WalletClient + owner`.
- **Modify:** `packages/frontend/src/lib/safe-tx.ts` — `signSafeTx` and `executeSafeTx` take a `HavenUserSigner`. Internal logic branches: EOA path is the existing `signTypedData` / `writeContract`; passkey path produces a contract signature and submits via `POST /safe/exec`.
- **Modify:** `packages/frontend/src/hooks/useSendTransaction.ts` — pulls `HavenUserSigner` from the new `useActiveSigner()` hook instead of `useWalletClient`. Signature of `send(...)` is unchanged from the consumer's perspective.
- **Modify:** Each component that today calls `useWalletClient()` and passes `walletClient` into `safe-tx.ts` helpers:
  - `packages/frontend/src/components/AgentPanel.tsx`
  - `packages/frontend/src/components/ApprovalQueue.tsx`
  - `packages/frontend/src/components/CreateAgentModal.tsx`
  - `packages/frontend/src/components/EditAgentModal.tsx`
  - `packages/frontend/src/app/onboarding/OnboardingClient.tsx`
  - `packages/frontend/src/app/(authenticated)/accounts/AccountsOverviewClient.tsx`
  Each one swaps `useWalletClient()` → `useActiveSigner()` and passes the `HavenUserSigner` through. **No other component logic changes.**
- **Modify:** `packages/frontend/src/lib/api.ts` — add a typed method for `POST /safe/exec` (mirror the existing pattern; if there's no shared API client, add a small fetch wrapper).
- **New tests:**
  - `packages/frontend/src/lib/__tests__/signer.test.ts` — discriminated union helpers.
  - `packages/frontend/src/lib/__tests__/passkey-sign.test.ts` — ERC-1271 contract signature encoding (deterministic test against fixture WebAuthn assertion bytes).

## Scope — Outside (Do Not Touch)

- **`packages/frontend/src/context/AuthContext.tsx`** — `useActiveSigner()` reads from Wagmi (for EOA) and from the existing localStorage device metadata written by future PR #4 (for passkey). Do not modify `AuthContext` to track signer state. If you need a place to read passkey metadata, expose a small free function in `lib/signer.ts` that reads localStorage directly. Keeping `AuthContext` untouched leaves PR #4 free to wire it up cleanly.
- **`packages/backend/src/routes/safe-deploy.ts`** — keep as-is. Don't try to merge `/safe/deploy` and `/safe/exec` into a shared abstraction yet.
- **`packages/backend/src/routes/passkeys.ts`** — keep as-is.
- **`packages/backend/src/routes/auth.ts`** — keep as-is.
- **`packages/frontend/src/lib/allowance-module.ts`** — this file builds Safe transactions but does not sign or execute. Don't touch it; the call sites that consume it route through `safe-tx.ts`, which is where the signer plumbing lives.
- **Any UI / styling / copy.** This PR is invisible to users. If you find yourself changing JSX text, a button label, or a className, stop.
- **The agent / x402 / Allowance Module *runtime* paths.** Agents pay through the Allowance Module with their own delegate EOA — that path does not involve `HavenUserSigner` at all. Don't refactor it.

If you find yourself touching anything in the "outside" list, stop and flag it.

## Backend — `POST /safe/exec`

### Route

```ts
interface ExecSafeBody {
  chain_id: number
  safe_address: string                              // checksummed
  to: string
  value: string                                     // decimal-string uint256
  data: string                                      // 0x-prefixed hex
  operation: 0 | 1                                  // 0 = CALL, 1 = DELEGATECALL
  safe_tx_gas: string                               // decimal-string uint256
  base_gas: string                                  // decimal-string uint256
  gas_price: string                                 // decimal-string uint256
  gas_token: string                                 // checksummed (or 0x0)
  refund_receiver: string                           // checksummed (or 0x0)
  nonce: string                                     // decimal-string uint256
  signatures: string                                // 0x-prefixed hex; encoded Safe signature(s)
}
```

Response (201):
```ts
{
  tx_hash: string,
  chain_id: number,
}
```

### Behavior

1. JWT-auth required (`app.addHook('onRequest', authMiddleware)`).
2. Validate `chain_id` via `isSupportedChain`.
3. Validate that `safe_address` belongs to the authenticated user — look up `user_passkeys WHERE user_id = $1 AND safe_address = $2 AND chain_id = $3`. If no match, return 403 `{ error: 'Safe is not associated with the authenticated user' }`. (For the POC, only passkey-owned Safes can use this endpoint. EOA-owned Safes don't need it because the EOA pays gas itself.)
4. Construct the relayer wallet for the chain via `getRelayer(chain_id)`.
5. Build the Safe contract with the v1.3.0 ABI (`execTransaction(...)` selector — see frontend `safe-tx.ts` for the exact ABI to copy).
6. Call `safe.execTransaction(...)` with the body params. Wait for the receipt.
7. On success: return `{ tx_hash, chain_id }`.
8. On `insufficient funds`: return 503 `{ error: 'Relayer is temporarily unfunded; please try again later' }` (mirror `/safe/deploy` behavior).
9. On any other revert: return 502 `{ error: 'Safe execution reverted on-chain' }` and include the underlying reason in `request.log.error`. **Do not echo the revert reason in the response** — it can leak internals.

### Implementation notes

- Reuse `lib/relayer.ts` and `lib/chains.ts` from PR #42; do not duplicate.
- Use `ethers.Contract` with a hand-rolled v1.3.0 Safe ABI (just the one `execTransaction` function). No Protocol Kit needed for the backend.
- **Do not validate the signature here.** The on-chain `execTransaction` call will revert if the signature is bad; let it. Validating off-chain would mean re-implementing Safe's signature scheme, and any divergence would be a footgun.
- Defense in depth: run the same `predictSafePasskeySignerAddress` check from `/safe/deploy` to ensure the stored `signer_address` still matches `(public_key_x, public_key_y, chain_id)`. If not, log error + 500 (same handling as `/safe/deploy`).

### Tests

Mirror the structure of `safe-deploy.test.ts`:

1. **Happy path** — valid body, mocked DB returns a passkey row matching the requested Safe, mocked `Contract.execTransaction` resolves with a `{ hash, wait }`. Assert 201 + `tx_hash`.
2. **Wrong Safe** — DB returns no row → 403.
3. **Insufficient relayer funds** — `Contract.execTransaction` rejects with a message containing `'insufficient funds'` → 503.
4. **Generic revert** — rejects with `'execution reverted: GS013'` (Safe's "signature verification failed" code) → 502, response body does NOT include `'GS013'`.
5. **Auth required** — no JWT → 401.

## Frontend — `lib/signer.ts`

```ts
import type { Address, WalletClient } from 'viem'

export type HavenUserSigner =
  | EoaSigner
  | PasskeySigner

export interface EoaSigner {
  type: 'eoa'
  address: Address
  walletClient: WalletClient
}

export interface PasskeySigner {
  type: 'passkey'
  address: Address                                  // signer contract address (CREATE2-deterministic)
  credentialId: string                              // base64url
  publicKey: { x: `0x${string}`; y: `0x${string}` }
  chainId: number
}

/**
 * Read the active human signer for the dashboard's currently-selected Safe.
 *
 * Resolution order:
 *   1. If localStorage has passkey signer metadata for the current safeAddress + chainId,
 *      return a PasskeySigner.
 *   2. If Wagmi has a connected EOA, return an EoaSigner.
 *   3. Otherwise return null (caller should prompt for connection / passkey enrollment).
 */
export function useActiveSigner(args: {
  safeAddress?: Address
  chainId?: number
}): HavenUserSigner | null
```

### Implementation notes

- The `useActiveSigner` hook is a React hook; place it in `lib/signer.ts` despite the convention of hooks living in `hooks/`. The colocation makes the abstraction self-contained and the file is small.
- `useWalletClient` and `useAccount` from Wagmi are already used throughout the codebase — use them here.
- Passkey metadata lookup: read `localStorage.getItem(\`haven_passkey_${safeAddress.toLowerCase()}_${chainId}\`)`. Return `null` if absent or malformed JSON. The write side lives in PR #4 — for this PR, you can assume the value exists when needed and just read it.
- Do not memoize aggressively; React Query / Wagmi already do it for `walletClient`. The hook should re-evaluate when `safeAddress`, `chainId`, or the connected EOA changes.

### Tests (`signer.test.ts`)

1. **Returns `EoaSigner`** when Wagmi has a connected wallet and no passkey metadata exists. Mock `useWalletClient` and `useAccount`.
2. **Returns `PasskeySigner`** when localStorage has matching passkey metadata for the requested `safeAddress + chainId`. Mock `localStorage`.
3. **Returns `null`** when neither is available.
4. **Prefers passkey** when both are available (passkey metadata wins — matches the mental model "passkey owns this Safe; the EOA is incidental").

## Frontend — `lib/passkey-sign.ts`

This file produces a **Safe-compatible ERC-1271 contract signature** from a WebAuthn assertion.

### Exports

```ts
export async function signSafeHashWithPasskey(args: {
  signer: PasskeySigner
  safeTxHash: `0x${string}`                         // 32-byte EIP-712 hash
}): Promise<{
  /** Encoded as Safe expects for a contract owner — see notes below. */
  signature: `0x${string}`
}>
```

### Implementation notes

- Call `getPasskeyAssertion({ challenge: safeTxHash bytes, allowCredentialIds: [signer.credentialId], rpId: ... })` from existing `lib/passkey.ts`.
- The assertion gives you `signatureDER`, `authenticatorData`, `clientDataJSON`. Encode them as the SafeWebAuthnSignerSingleton's `isValidSignature` expects:
  ```
  abi.encode(
    bytes32 r,                                      // DER signature
    bytes32 s,                                      // authenticatorData
    bytes32 v                                       // clientDataJSON
  )
  ```
  Actually the encoding is `abi.encode(bytes signatureDER, bytes authenticatorData, bytes clientDataJSON)`. Check `@safe-global/safe-passkey/contracts/SafeWebAuthnSignerSingleton.sol` for the exact `abi.decode` it does.
- Wrap that inner blob in Safe's "contract signature" outer format. Safe v1.3.0's `checkSignatures` expects, for a contract owner:
  ```
  // 65-byte slot per signer:
  // r = bytes32(uint256(signerAddress))           // left-padded
  // s = bytes32(offsetToDynamicData)              // offset within the signatures blob
  // v = 0                                         // marker for "contract signature"
  // ...then at offsetToDynamicData:
  // bytes4 length || bytes signatureBytes
  ```
  You're producing a single-owner signature, so:
  ```
  outer = concat(
    pad(signerAddress, 32),                         // r
    pad(0x41, 32),                                  // s = 65 (start of dynamic data)
    0x00,                                           // v
    uint32(innerBlob.length),                       // length prefix
    innerBlob,
  )
  ```
  Where `innerBlob = abi.encode(signatureDER, authenticatorData, clientDataJSON)`.
- **Test this against a fixture.** Use a hand-built WebAuthn assertion (fake bytes) to verify the encoding produces the expected output. Pin the result. The fixture won't be on-chain-validated until PR #4 + manual smoke test, but the encoding shape is checkable in unit tests.

### Reference

- Safe v1.3.0 `checkSignatures` source: https://github.com/safe-global/safe-smart-account/blob/v1.3.0/contracts/Safe.sol#L284
- `SafeWebAuthnSignerSingleton.isValidSignature`: https://github.com/safe-global/safe-modules/blob/main/modules/passkey/contracts/SafeWebAuthnSignerSingleton.sol
- The `@safe-global/safe-passkey` npm package's TypeScript helpers may have a ready-made wrapper. If so, use it instead of hand-rolling — but verify the encoding matches the on-chain singleton before pinning.

### Tests (`passkey-sign.test.ts`)

1. **Output shape** — given a fixture `(signatureDER, authenticatorData, clientDataJSON)` and a fixture signer address, assert the output matches a pinned hex string. Generate the pinned value once with the implementation and document.
2. **Throws `PasskeyCancelledError`** when `getPasskeyAssertion` rejects with cancellation. (Re-uses the existing error class from `lib/passkey.ts`.)

## Frontend — `lib/safe.ts` (modify)

Refactor `deploySafe` to dispatch on `HavenUserSigner`:

```ts
export async function deploySafe(
  signer: HavenUserSigner,
  publicClient: PublicClient,
  chainId: number = 100,
  onProgress?: (stage: DeployStage, data?: { txHash?: Hash }) => void,
): Promise<{ safeAddress: Address; txHash: Hash }>
```

Internally:
- `signer.type === 'eoa'` — call the existing logic (renamed `deploySafeWithEoa`). The owner is `signer.address`. The `walletClient.writeContract` call is unchanged.
- `signer.type === 'passkey'` — POST to `/safe/deploy` (the route from PR #42), poll for the response, and call `onProgress('confirming', { txHash })` once. The owner is the passkey signer contract address — but the **backend already derives this**, so the request body is just `{ chain_id, salt_nonce? }`. The response gives `{ safe_address, tx_hash }`.

The returned shape `{ safeAddress, txHash }` is the same in both cases. Existing call sites only need to swap `(walletClient, publicClient, owner, chainId)` → `(signer, publicClient, chainId)`.

## Frontend — `lib/safe-tx.ts` (modify)

Update `signSafeTx` and `executeSafeTx`:

```ts
export async function signSafeTx(
  signer: HavenUserSigner,
  safeAddress: Address,
  chainId: number,
  safeTx: SafeTxParams,
  nonce: bigint,
): Promise<{ signature: `0x${string}` }>

export async function executeSafeTx(
  signer: HavenUserSigner,
  safeAddress: Address,
  chainId: number,
  safeTx: SafeTxParams,
  nonce: bigint,
  signature: `0x${string}`,
): Promise<{ txHash: Hash }>
```

### Behavior

`signSafeTx`:
- EOA: existing `walletClient.signTypedData` flow. Output is the 65-byte EOA signature.
- Passkey: compute the EIP-712 `safeTxHash` with `hashTypedData(...)` (the existing util), then call `signSafeHashWithPasskey({ signer, safeTxHash })`. Output is the contract signature blob.

`executeSafeTx`:
- EOA: existing `walletClient.writeContract` call.
- Passkey: POST to `POST /safe/exec` with the full body shape from the backend section. Returns the response's `tx_hash`.

`proposeSafeTx` (multi-sig flow) is out of scope — leave it alone. The passkey/relayer path bypasses the Safe Transaction Service entirely for now.

## Frontend — `hooks/useSendTransaction.ts` (modify)

The current hook reads `useWalletClient()`. Replace with:

```ts
const signer = useActiveSigner({ safeAddress, chainId })
```

The hook's external `send(...)` API stays the same. Internally, every call into `safe-tx.ts` passes `signer` instead of `walletClient`.

If `signer === null`, return the error state `'Wallet not connected'` (or, post-PR #4, `'No signer available'` — fine to leave the message as-is for now since no UX surface depends on it yet).

## Frontend — Component Refactors

Six components consume `useWalletClient` today and pass `walletClient` into `safe-tx.ts` helpers. For each:

1. Replace `const { data: walletClient } = useWalletClient()` with `const signer = useActiveSigner({ safeAddress, chainId })`.
2. Replace `useAccount` → consume `signer.address` if needed (or keep `useAccount` for display purposes; it's fine to leave it).
3. Replace `walletClient` arg → `signer` arg in every call into `safe-tx.ts`.
4. Replace the null check `!walletClient` with `!signer`.

Files:
- `packages/frontend/src/components/AgentPanel.tsx`
- `packages/frontend/src/components/ApprovalQueue.tsx`
- `packages/frontend/src/components/CreateAgentModal.tsx`
- `packages/frontend/src/components/EditAgentModal.tsx`
- `packages/frontend/src/app/onboarding/OnboardingClient.tsx`
- `packages/frontend/src/app/(authenticated)/accounts/AccountsOverviewClient.tsx`

**Do not change any other logic in these files** — error handling, side effects, state machines, JSX, all stay identical. The only diff per file should be: import swap, hook swap, and arg renames.

## Verification Checklist (Local)

Before opening the PR:

- [ ] `npm run lint --workspace @haven/frontend` passes.
- [ ] `npm test --workspace @haven/frontend` passes — new tests + all existing tests, no flakes.
- [ ] `npm test --workspace @haven/backend` passes — including the new `safe-exec.test.ts`.
- [ ] `npm run build --workspace @haven/frontend` and `--workspace @haven/backend` both succeed.
- [ ] **Manual EOA regression test in dev server** — sign in as an existing EOA-owner test user, perform: deploy a new Safe, send an outbound transfer, create an agent allowance, edit it, revoke it. Each one must show the same wallet popup as before this PR. **No passkey prompt should ever appear in this run.**
- [ ] Manual passkey path is **not** verifiable yet without UI — that's PR #4. Confirm by reading the diff that nothing in this PR exposes passkey signing to existing users.

## PR Hygiene

- Branch from `main`, name `codex/passkey-signer-abstraction`.
- Suggested commit split:
  1. Backend `/safe/exec` route + tests
  2. Frontend `lib/signer.ts` + tests
  3. Frontend `lib/passkey-sign.ts` + tests
  4. Frontend `lib/safe.ts` refactor (additive — `deploySafe` now takes `HavenUserSigner`)
  5. Frontend `lib/safe-tx.ts` refactor
  6. Frontend `useSendTransaction` hook + component call-site updates
  7. (Optional) `lib/api.ts` updates
- PR description should explicitly say "no UI changes; existing EOA users see no behavior change; passkey path is wired but not yet exposed in UI (that's PR #4)".

## Out-of-Scope Reminders

If during implementation you find yourself wanting to:

- **Migrate `safe-tx.ts` to use Protocol Kit (`@safe-global/protocol-kit`)** — don't. The current raw-viem implementation works fine; rewriting it is a separate refactor and would balloon this PR. The passkey path can co-exist with the raw EOA path.
- **Add UI for choosing a signer** — don't. PR #4.
- **Add passkey enrollment endpoints / flows** — already done in PR #42. Don't reimplement.
- **Refactor `AuthContext` to track signer state** — don't. Keep it free for PR #4.
- **Validate Safe signatures off-chain** — don't. The Safe contract reverts on bad signatures; trust it.
- **Refactor existing payment / x402 / Allowance Module runtime code** — don't. Agent payments don't touch `HavenUserSigner` at all.
- **Add a `proposeSafeTx` (Safe Transaction Service) path for passkeys** — don't. Threshold is 1/1 for passkey Safes, so off-chain proposal isn't needed. Future feature.

If any of these feel necessary mid-implementation, stop and post a comment on the PR rather than expanding scope.

## Reference Material

- Parent plan: [`docs/plans/passkey-onboarding.md`](./passkey-onboarding.md)
- PR #40 (frontend WebAuthn helpers, merged): https://github.com/d-hinders/Haven-AI/pull/40 — uses `passkey.ts`, `safePasskeySigner.ts`
- PR #42 (backend routes, merged): https://github.com/d-hinders/Haven-AI/pull/42 — uses `lib/relayer.ts`, `lib/passkey-signer.ts`, the `user_passkeys` table, and the relayer-paid `/safe/deploy` route. **Mirror this PR's shape and conventions** for `/safe/exec`.
- Existing signing surface: `packages/frontend/src/lib/safe-tx.ts` (raw viem)
- Safe v1.3.0 `execTransaction` and `checkSignatures`: https://github.com/safe-global/safe-smart-account/blob/v1.3.0/contracts/Safe.sol
- Safe passkey signer singleton: https://github.com/safe-global/safe-modules/blob/main/modules/passkey/contracts/SafeWebAuthnSignerSingleton.sol
- Safe contract-owner signature format: https://docs.safe.global/advanced/smart-account-signatures
