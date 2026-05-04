# Codex Task — Frontend Passkey Signer + WebAuthn Helpers

> **Parent design doc:** [`docs/plans/passkey-onboarding.md`](./passkey-onboarding.md). Read it first; this task implements the frontend library layer described there (PR #2 in the suggested split, plus the small chain-config additions from PR #5).
>
> **Suggested branch:** `claude/passkey-frontend-helpers` (cut from `main`, not from `claude/passkey-solutions-research-PPBc4`).

## Why This Task Exists

Haven's onboarding currently requires a connected EOA. We're adding passkey-native Safe ownership using `@safe-global/safe-passkey`. That feature has four moving parts: (a) WebAuthn ceremony in the browser, (b) a deterministic on-chain signer contract derived from the passkey's public key, (c) a relayer-paid Safe deploy that wires that signer in as the sole owner, and (d) UI plus an `AuthContext` refactor to drive the flow.

This task owns **only (a) and (b)** — the pure library layer. No callers, no UI, no backend, no integration with `safe.ts`. That isolation is the point: this PR is mergeable on its own, doesn't touch any existing flow, and gives downstream PRs (#3 abstraction, #4 UI, the backend relayer in PR #1) a stable surface to build on.

## What Counts as Done

A reviewer pulling this branch can:

1. Open the dev server, run `navigator` calls in DevTools, and successfully create + retrieve a passkey via the new helpers.
2. Run `npm test --workspace @haven/frontend` and see new unit tests pass — including COSE-decoding tests against fixed byte fixtures (no real authenticator required, since jsdom can't do WebAuthn).
3. Import `getSafePasskeySignerAddress({ x, y, chainId })` and get back a deterministic checksummed address that matches what `SafeWebAuthnSignerFactory.getSigner(...)` would compute on-chain for both Base (8453) and Gnosis (100).
4. See zero changes to existing flows — `safe.ts`, `AuthContext.tsx`, components, and routing must remain untouched.

## Scope — Inside

- **New file:** `packages/frontend/src/lib/passkey.ts` — WebAuthn ceremony helpers + COSE decoder.
- **New file:** `packages/frontend/src/lib/safePasskeySigner.ts` — derives the Safe passkey signer contract address from `(x, y, verifier)` via `SafeWebAuthnSignerFactory`.
- **Modify:** `packages/frontend/src/lib/chains.ts` — add a `passkey` block to each `FrontendChainConfig`.
- **New tests:** `packages/frontend/src/lib/__tests__/passkey.test.ts` and `safePasskeySigner.test.ts`.
- **`package.json`:** add the dependencies listed below.

## Scope — Outside (Do Not Touch)

- `packages/frontend/src/lib/safe.ts` — left alone for PR #3.
- `packages/frontend/src/context/AuthContext.tsx` — left alone for PR #4.
- Any UI component or page.
- The backend (`packages/backend/`) and SDK (`packages/sdk/`).
- The connected-wallet / Wagmi / RainbowKit code paths.

If you find yourself editing any of the above, stop and flag it.

## Dependencies to Add

In `packages/frontend/package.json`:

```jsonc
{
  "dependencies": {
    "@safe-global/safe-passkey": "^0.2.0",
    "@safe-global/safe-modules-deployments": "^2.2.5"
  }
}
```

Run `npm install` from the repo root (this is an npm workspaces monorepo). Pin to whatever the latest minor of each package is at install time; commit the lockfile change. Do **not** add `@safe-global/protocol-kit` here — it lives in the backend.

## File 1 — `packages/frontend/src/lib/passkey.ts`

This file owns the browser-side WebAuthn ceremony and the COSE → secp256r1 `(x, y)` decoder.

### Exports

```ts
export interface PasskeyCreationResult {
  credentialId: string         // base64url, no padding
  publicKey: { x: `0x${string}`; y: `0x${string}` } // 32-byte hex strings, 0x-prefixed
  rawAttestationObject: ArrayBuffer  // kept for backend verification later
  rawClientDataJSON: ArrayBuffer
}

export interface PasskeyAssertion {
  credentialId: string
  signatureDER: `0x${string}`
  authenticatorData: `0x${string}`
  clientDataJSON: `0x${string}`
}

export async function createPasskey(opts: {
  rpId?: string                // defaults to window.location.hostname
  rpName?: string              // defaults to "Haven"
  userId: Uint8Array           // 16-32 bytes, stable per Haven user
  userName: string             // user.email
  userDisplayName: string
}): Promise<PasskeyCreationResult>

export async function getPasskeyAssertion(opts: {
  rpId?: string
  challenge: Uint8Array
  allowCredentialIds?: string[]   // base64url
}): Promise<PasskeyAssertion>

/**
 * Decode a COSE_Key (RFC 8152) for an EC2 key on the secp256r1 (P-256) curve
 * into 32-byte x/y coordinates. Throws if the key isn't EC2 / P-256.
 */
export function decodeCoseP256PublicKey(coseKey: Uint8Array): {
  x: `0x${string}`
  y: `0x${string}`
}

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string
export function base64UrlDecode(s: string): Uint8Array
```

### Implementation notes

- **`createPasskey`:**
  - Algorithm: only request `-7` (ES256 / secp256r1). Reject other algs.
  - `authenticatorSelection`: `{ residentKey: 'required', userVerification: 'required' }`. Platform authenticator preferred but not required (`authenticatorAttachment: 'platform'` *only if you can do so without breaking cross-platform usage* — verify in Safari first).
  - `attestation: 'none'` for now; the backend in PR #1 will not verify attestations during enrollment.
  - Parse the returned `attestationObject` (CBOR-encoded). You'll need a small CBOR decoder. Use [`cbor-x`](https://www.npmjs.com/package/cbor-x) (already MIT, small footprint) **or** write a minimal CBOR decoder if you don't want a dep — your call. If you add `cbor-x`, list it as a dep in `package.json`.
  - From the `authData` field of the attestation object, extract the `credentialPublicKey` COSE blob and pass it through `decodeCoseP256PublicKey`.
  - `credentialId` returned to caller is base64url-encoded for ergonomics; the raw `ArrayBuffer` is preserved on the result struct so a future backend route can do strict attestation verification.

- **`decodeCoseP256PublicKey`:**
  - COSE EC2 P-256 key has these CBOR map entries (integer keys):
    - `1` (kty) = `2` (EC2)
    - `3` (alg) = `-7` (ES256)
    - `-1` (crv) = `1` (P-256)
    - `-2` (x) = 32-byte string
    - `-3` (y) = 32-byte string
  - Validate all four; throw a descriptive error if anything is off.
  - Pad x/y to exactly 32 bytes (some encoders strip leading zero bytes — do not trust input length).
  - Return as `0x`-prefixed hex.

- **`getPasskeyAssertion`:**
  - Wraps `navigator.credentials.get`.
  - Converts the WebAuthn DER signature, `authenticatorData`, and `clientDataJSON` to hex strings for downstream consumption.
  - Does not verify the signature locally — that's an on-chain concern via the Safe passkey signer contract.

- **base64url helpers:** no padding, `+/` → `-_`. Don't pull in a dependency for this — it's eight lines.

- **Edge cases to handle gracefully:**
  - `navigator.credentials` undefined (older browsers / non-secure context) → throw a typed error: `class PasskeyUnsupportedError extends Error`.
  - User cancels the prompt (`NotAllowedError`) → re-throw as `class PasskeyCancelledError extends Error`.
  - Both error classes exported from `passkey.ts`.

## File 2 — `packages/frontend/src/lib/safePasskeySigner.ts`

This file maps a `(x, y, chainId)` triple to the deterministic Safe passkey signer contract address on that chain.

### Exports

```ts
export interface SafePasskeyConfig {
  factoryAddress: Address          // SafeWebAuthnSignerFactory
  verifierAddress: Address         // RIP-7212 precompile or FCL verifier
  singletonAddress: Address        // SafeWebAuthnSignerSingleton (proxy implementation)
}

/**
 * Pure CREATE2 prediction. Does NOT make network calls.
 * Mirrors what `SafeWebAuthnSignerFactory.getSigner(x, y, verifier)` returns
 * on-chain (and what `createSigner(...)` would deploy).
 */
export function predictSafePasskeySignerAddress(args: {
  x: `0x${string}`
  y: `0x${string}`
  chainId: number
}): Address

export function getSafePasskeyConfig(chainId: number): SafePasskeyConfig
```

### Implementation notes

- The Safe passkey signer is deployed via a minimal CREATE2 proxy whose salt is `keccak256(abi.encode(x, y, verifier))` and whose initcode is the standard ERC-1167 minimal-proxy bytecode targeting `singletonAddress`. Compute the address with viem's `getContractAddress({ opcode: 'CREATE2', from: factoryAddress, salt, bytecodeHash })`.
- **Source the addresses from `@safe-global/safe-modules-deployments`** rather than hard-coding them in this file. Use that package's `getSafeWebAuthnSignerFactoryDeployment({ network: chainId.toString() })`. If the deployment package doesn't have an entry for a chain, throw a clear error. The exception is the verifier address — see the chain config note below.
- Cross-check your CREATE2 prediction against a known fixture in tests (see test plan).
- Keep the file pure: no React, no async, no fetch.

## File 3 — `packages/frontend/src/lib/chains.ts` (modify)

Extend `FrontendChainConfig` and the two existing configs:

```ts
export interface FrontendChainConfig {
  // ...existing...
  passkey: {
    /** P-256 verifier the Safe passkey signer will call. */
    verifier: Address
  }
}
```

Per-chain `verifier` values:

| Chain | Address | Notes |
|---|---|---|
| Base (8453) | `0x0000000000000000000000000000000000000100` | RIP-7212 precompile (live since Fjord) |
| Gnosis (100) | `0x445a0683e494ea0c5af3e83c5159fbe47cf9e765` | Daimo / FreshCryptoLib P-256 verifier (Safe's canonical Gnosis deployment) |

**Important:** verify the Gnosis verifier address against `@safe-global/safe-modules-deployments` at install time before committing. If the package exposes a `getSafeP256VerifierDeployment` (or similarly named) entry, prefer reading from it programmatically instead of hard-coding. If not, hard-code with the table above and add a `// TODO: source from safe-modules-deployments when available` comment.

Do not change any other field on `FrontendChainConfig`.

## Tests

All tests live under `packages/frontend/src/lib/__tests__/`. Vitest is already wired up (`globals: true`, jsdom, see `packages/frontend/vitest.config.ts`). Follow the existing style in `__tests__/api.test.ts`.

### `passkey.test.ts`

Focus on the deterministic, pure parts. Do **not** try to test `createPasskey` end-to-end — jsdom has no WebAuthn.

Required cases:

1. **`decodeCoseP256PublicKey` happy path** — feed in a hand-crafted CBOR-encoded EC2/P-256 key with known x/y, assert returned hex matches.
2. **Strips/preserves leading zeros correctly** — feed in a key whose `x` byte string is 31 bytes (a leading zero was stripped by the encoder) and assert the returned hex is exactly 32 bytes (`0x00...`).
3. **Rejects non-EC2 kty** — `kty=1` (OKP) → throws.
4. **Rejects non-P-256 curve** — `crv=2` (P-384) → throws.
5. **Rejects non-ES256 alg** — `alg=-8` (EdDSA) → throws.
6. **base64url round-trip** — `decode(encode(bytes)) === bytes` for 0/1/16/32/45-byte inputs (the 45-byte case forces non-trivial padding).
7. **`PasskeyUnsupportedError` thrown when `navigator.credentials` is undefined** — stub `globalThis.navigator` and call `createPasskey`.

### `safePasskeySigner.test.ts`

1. **Address determinism** — calling `predictSafePasskeySignerAddress` twice with the same `(x, y, chainId)` returns the same address.
2. **Chain isolation** — same `(x, y)` on Base vs. Gnosis returns *different* addresses (because the verifier address — and possibly the factory — differs).
3. **Fixture match** — for one fixed `(x, y)` pair on Base, assert the predicted address equals a value you computed once and pinned. To generate the fixture, you can either:
   - Run the prediction once locally, copy the output, paste it as the expected value (acceptable — it's a regression test for the math, not a cross-implementation check), or
   - Better: spin up an anvil fork of Base, call `SafeWebAuthnSignerFactory.getSigner(x, y, verifier)`, paste the result. Document which method you used in a comment.
4. **`getSafePasskeyConfig` throws on unsupported chain** — `getSafePasskeyConfig(1)` throws.

## Verification Checklist (Local)

Before opening the PR, run all of these and paste output (or "passed") into the PR description:

- [ ] `npm install` from repo root succeeds; lockfile committed.
- [ ] `npm run lint --workspace @haven/frontend` passes.
- [ ] `npm test --workspace @haven/frontend` passes — both new test files plus all existing tests.
- [ ] `npm run build --workspace @haven/frontend` succeeds (catches any missing types or dynamic-import issues with the Safe passkey package).
- [ ] In the dev server (`npm run dev --workspace @haven/frontend`), open DevTools and run:
  ```js
  const { createPasskey } = await import('/src/lib/passkey.ts');
  const result = await createPasskey({
    userId: crypto.getRandomValues(new Uint8Array(16)),
    userName: 'codex@example.com',
    userDisplayName: 'Codex Tester',
  });
  console.log(result.credentialId, result.publicKey);
  ```
  Confirm Face ID / Touch ID prompt appears (or virtual-authenticator prompt in Chrome DevTools), and `result.publicKey.x` / `.y` are 0x-prefixed 32-byte hex strings.
- [ ] In the same console:
  ```js
  const { predictSafePasskeySignerAddress } = await import('/src/lib/safePasskeySigner.ts');
  console.log(predictSafePasskeySignerAddress({ x: result.publicKey.x, y: result.publicKey.y, chainId: 8453 }));
  console.log(predictSafePasskeySignerAddress({ x: result.publicKey.x, y: result.publicKey.y, chainId: 100 }));
  ```
  Confirm two distinct, checksummed addresses come back.

## PR Hygiene

- Branch from `main`, name `claude/passkey-frontend-helpers`.
- Commits: one for deps + lockfile, one for `passkey.ts` + tests, one for `safePasskeySigner.ts` + tests, one for `chains.ts` extension. Squash-merge will collapse them.
- PR description should link the parent doc and call out **what is intentionally not done yet** (UI, AuthContext changes, deploy integration) so reviewers don't ask.

## Out-of-Scope Reminders

If during implementation you discover the work touches `safe.ts`, `AuthContext`, or any UI component, **stop and post a comment on the PR** describing the dependency rather than expanding scope. The signer abstraction (`HavenUserSigner` discriminated union) and the actual deploy wiring are deliberately deferred to PR #3 / PR #4.

## Reference Material

- Parent plan: [`docs/plans/passkey-onboarding.md`](./passkey-onboarding.md)
- Safe passkey docs: https://docs.safe.global/advanced/passkeys/passkeys-safe
- Safe React passkey tutorial (most directly relevant prior art): https://docs.safe.global/advanced/passkeys/tutorials/react
- Safe passkey signer SDK reference: https://docs.safe.global/sdk/signers/passkeys
- `@safe-global/safe-passkey` source: https://github.com/safe-global/safe-modules/tree/main/modules/passkey
- COSE for WebAuthn: RFC 8152 §13.1 (EC2 keys) and W3C WebAuthn §6.5.2 (`credentialPublicKey`)
- RIP-7212 precompile: https://www.alchemy.com/blog/what-is-rip-7212
