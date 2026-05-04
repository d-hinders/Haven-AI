# Passkey-Native Safe Onboarding for Haven

## Context

Haven currently requires every user to connect an external EOA (Wagmi/RainbowKit) to deploy a Safe. The frontend deployment in `packages/frontend/src/lib/safe.ts` calls `SafeProxyFactory.createProxyWithNonce` directly with the connected wallet as the gas payer and sole owner. This locks out non-crypto-native users — the entire onboarding success criterion in CLAUDE.md ("a developer can sign up, deploy a Safe, fund it, create an agent, run an x402 payment") is gated behind installing MetaMask, getting xDAI/ETH, and understanding seed phrases.

Adding passkey-native Safe creation removes this barrier completely. A user signs up with email + password, taps Face ID / Touch ID / Windows Hello to enroll an on-chain signer, and a 1/1 Safe is deployed where the WebAuthn passkey signer is the sole owner. No extension, no seed phrase, no EOA. This aligns directly with the "Non-Custodial" and "Agent-First" principles: the user's passkey signs admin actions, the agent EOA continues to spend through the Allowance Module under policy, and Haven never holds unrestricted signing authority.

**Scope clarification:** Passkeys (and EOAs) are used **only for on-chain signing**, not for Haven account authentication. Sign-in to the Haven account stays email + password as it is today. WebAuthn here is strictly an on-chain signer, not an auth factor.

**Backwards compatibility:** Existing accounts whose Safe was deployed with an EOA owner continue to use that EOA for on-chain signing — unchanged. Passkey signing is an additional option for new Safes (and, post-MVP, an addable owner on existing Safes), not a replacement for the EOA path.

### Mental model

```
User passkey signer  →  owns Safe
                     →  signs Safe admin / user actions (deploy, add owner, enable module,
                                                          rotate agent key, manual transfer)

Agent EOA            →  still spends through the Allowance Module (UNCHANGED)
                     →  no passkey prompt, no WebAuthn during agent execution,
                        no Face ID for x402 payments
```

Safe owners (after onboarding):
- Passkey signer contract (sole owner, threshold = 1)
- *(post-MVP)* optional backup EOA, backup passkey, or hardware wallet

Safe modules (unchanged):
- Allowance Module (already integrated for agent spending)

### Decisions confirmed with user

- **Provider:** Safe's native `@safe-global/safe-passkey` only. No Privy, Dynamic, Coinbase Smart Wallet, or other WaaS providers.
- **Chains:** Base (8453) and Gnosis Chain (100). Base uses the RIP-7212 P-256 precompile (Fjord) for cheap verification; Gnosis falls back to a FreshCryptoLib (FCL) Solidity verifier — more gas, but Haven sponsors anyway.
- **Safe topology:** 1/1 with passkey as sole owner for MVP. Backup owners are post-onboarding UX.
- **Fallback auth:** None for POC — passkey-only.
- **Deployment pattern:** **Option A** (relayer submits the tx, passkey signer is the configured owner). Rationale below.
- **Compatibility floor:** Safe contracts ≥ v1.3.0, per Safe's passkey docs.

## Deployment Pattern: Option A (Relayer)

Two patterns exist:

- **Option A — relayer submits, passkey is the configured owner.** Frontend creates the WebAuthn credential, derives the deterministic passkey signer address via `SafeWebAuthnSignerFactory`, predicts the Safe address, and asks Haven's backend to submit the deployment transaction. The Safe is initialized with the passkey signer as its sole owner. No 4337, no UserOps, no `initCode` complexity.
- **Option B — ERC-4337 deployment.** Use a UserOp to deploy the Safe and the passkey signer in one shot. Per Safe's docs, this is constrained because a UserOp can only deploy one CREATE2 contract whose address matches the sender; Safe works around this with `SafeWebAuthnSharedSigner`.

**Decision: Option A.** Reasons:
1. Haven's backend already imports `@safe-global/protocol-kit` v5.1.0 — relayer infrastructure is essentially already there, just needs an EOA + RPC + a route.
2. Avoids 4337 / bundler / paymaster operational surface for the POC. Haven currently uses neither.
3. Keeps the deployment path symmetric with the existing EOA flow in `packages/frontend/src/lib/safe.ts` — same proxy factory, same singleton, same fallback handler, just a different `owner` argument and a different gas payer.
4. We keep the option to migrate to 4337 later if Haven ever needs UserOp-native flows for agents (which would also unlock alternative paymaster economics).

## Onboarding Flow

Sign-in is always email + password. After authentication the user picks an on-chain signer for their new Safe — passkey (default) or EOA (existing flow).

```
Step 1  Sign up / sign in                 POST /auth/signup or /auth/login    (email + password, existing)
Step 2  Pick signing method               UI choice: "Use Face ID / Touch ID" (default)  OR  "Connect a wallet"
Step 3a Passkey path: create credential   WebAuthn navigator.credentials.create()
        Derive Safe passkey signer        SafeWebAuthnSignerFactory.getSigner(x, y, verifier)
Step 3b EOA path: connect wallet          existing Wagmi/RainbowKit flow
Step 4a Passkey path: deploy Safe         Backend relayer submits createProxyWithNonce, owner = passkey signer
Step 4b EOA path: deploy Safe             EOA submits createProxyWithNonce directly (UNCHANGED)
```

For passkey users, after Step 4a the frontend stores on-chain signer metadata in IndexedDB / localStorage:
```ts
{
  safeAddress: Address,
  chainId: number,
  signerKind: 'passkey',
  passkeyCredentialId: string,    // base64url
  passkeySignerAddress: Address,  // CREATE2-deterministic
  createdAt: number
}
```
This is **on-chain signer metadata, not policy and not auth** — it's what the frontend needs to find and reuse the right WebAuthn credential when the email-authenticated user wants to sign a Safe transaction. Policy stays on-chain (Allowance Module) and in the existing Haven DB tables that govern agents. Authentication continues to flow through the existing JWT issued at email/password login.

EOA users continue to read their signer from the Wagmi connector — no metadata cache needed, same as today.

## Signer Abstraction

The main refactor. Today Haven has two implicit signer types coexisting:
- the connected EOA via Wagmi (used for Safe deployment, manual transfers, admin actions)
- the agent EOA controlled by the Allowance Module (used for x402 / agent payments)

We introduce a discriminated union for the **human** signer only — agent signing is unchanged.

```ts
// packages/frontend/src/lib/signer.ts (new)
export type HavenUserSigner =
  | { type: 'eoa';     address: Address; signer: Eip1193Signer }
  | { type: 'passkey'; address: Address; signer: SafePasskeySigner }
```

Every flow that today reads "connected EOA signs Safe transaction" gets refactored to take a `HavenUserSigner` and pass it through to:

```ts
const protocolKit = await Safe.init({
  provider,
  signer: activeHumanSigner,  // EOA Eip1193 OR SafePasskeySigner
  safeAddress,
})
```

Per Safe's passkey docs the passkey signer is a first-class Protocol Kit signer — it can sign Safe transactions and initialize Core SDK kits exactly like an EOA.

Flows that get refactored to consume `HavenUserSigner`:
- Deploy Safe (Step 4 above)
- Add backup owner *(post-MVP)*
- Enable / disable modules (e.g., Allowance Module)
- Create / update / revoke agent allowance
- Rotate agent key
- Manual outbound transfer
- Change Safe threshold

Flows that **do not change** (agent path):
- Agent x402 payment
- Agent Stripe MPP payment *(future)*
- Allowance-bounded transfers initiated by an agent EOA

## What Changes Per Layer

### Frontend — `packages/frontend/`

- `src/lib/passkey.ts` *(new)*
  - `createPasskey(userHandle)` — calls `navigator.credentials.create()`, returns credentialId + COSE-decoded `(x, y)` coordinates
  - `getPasskey(credentialId)` — calls `navigator.credentials.get()` for assertions
  - COSE → secp256r1 `(x, y)` decoder so coordinates can be passed to the Safe factory

- `src/lib/safePasskeySigner.ts` *(new)*
  - Wraps `@safe-global/safe-passkey` to derive the deterministic signer address via `SafeWebAuthnSignerFactory.getSigner(x, y, verifier)`
  - Per-chain verifier address selection: RIP-7212 precompile `0x...0100` for Base, FCL verifier contract address for Gnosis
  - Implements the Protocol Kit signer interface so it slots into `Safe.init({ signer })`

- `src/lib/signer.ts` *(new)*
  - The `HavenUserSigner` discriminated union and helpers (`useActiveSigner()` hook reading from `AuthContext`)

- `src/lib/safe.ts` *(modify)*
  - Split into two paths:
    - `deploySafeWithEoa(...)` — current behavior, walletClient submits and pays
    - `deploySafeWithPasskey(...)` — calls backend relayer endpoint with `{ chainId, ownerAddress: passkeySignerAddress, saltNonce }`, polls for receipt, extracts proxy from `ProxyCreation` event
  - Both call sites converge on the same downstream "Safe deployed" event so the dashboard registration code stays the same

- `src/context/AuthContext.tsx` *(modify)*
  - **No change to login/signup** — those stay email + password
  - Add `enrollPasskeyForSigning()` (post-login action that creates the WebAuthn credential and registers the derived signer with the backend)
  - Track `activeHumanSigner: HavenUserSigner` so downstream components don't branch on EOA vs passkey when calling `Safe.init`

- `src/components/SignerOnboarding/` *(new)*
  - `ChooseSignerCard` — shown after email/password auth, before Safe deploy. Two options: "Use Face ID / Touch ID" (passkey) or "Connect a wallet" (EOA, existing path).
  - `PasskeyEnrollFlow` — runs Steps 3a + 4a
  - The existing wallet-connect Safe deploy flow is reused verbatim for the EOA branch

- `src/lib/chains.ts` *(modify)*
  - Add `passkey` block per chain: `{ verifierAddress, factoryAddress, singletonAddress }`

### Backend — `packages/backend/`

- `src/db/migrations/` *(new migration)*
  - `user_passkeys` table:
    ```
    user_id              uuid    fk users(id)
    credential_id        text    base64url, unique
    public_key_x         bytea
    public_key_y         bytea
    signer_address       text    CREATE2-deterministic, lowercased
    chain_id             int
    safe_address         text    populated after Step 4
    created_at           timestamptz
    ```

- `src/routes/auth.ts` — **no change to login/signup**. Email + password auth and JWT issuance stay exactly as they are.

- `src/routes/passkeys.ts` *(new — on-chain signer enrollment, not auth)*
  - All routes require an existing email/password JWT.
  - `POST /passkeys/enroll/options` — returns a WebAuthn `PublicKeyCredentialCreationOptions` challenge for the authenticated user.
  - `POST /passkeys/enroll/verify` — verifies the attestation, decodes COSE → `(x, y)`, computes the deterministic `signer_address` via `SafeWebAuthnSignerFactory`, stores `(user_id, credential_id, x, y, signer_address, chain_id)` in `user_passkeys`. Returns the signer address so the frontend can deploy a Safe with it.
  - `GET /passkeys` — lists the authenticated user's enrolled passkey signers (so the frontend can pick the right one when a user has multiple devices).

- `src/routes/safe.ts` *(new)*
  - `POST /safe/deploy` — relayer endpoint. Body: `{ chainId, ownerAddress, saltNonce }`. Validates that `ownerAddress` matches the authenticated user's stored `signer_address`. Backend EOA submits `createProxyWithNonce` and returns `{ safeAddress, txHash }`. Updates `user_passkeys.safe_address` on confirmation.
  - Reuses `@safe-global/protocol-kit` so the deployment computation matches the existing client path

- `src/lib/relayer.ts` *(new)*
  - Lightweight wrapper around an ethers signer per chain (Gnosis, Base) reading from `RELAYER_PRIVATE_KEY` env var
  - Just-in-time funding alerts (log a warning when balance drops below configurable threshold)

- `src/middleware/auth.ts` — no change. The middleware doesn't care how the JWT was issued; passkey enrollment routes sit behind the existing JWT.

### SDK — `packages/sdk/`

No changes. The SDK is the agent-facing layer; agents don't authenticate with passkeys.

## Chain-Specific Configuration

| | Base (8453) | Gnosis (100) |
|---|---|---|
| Safe contracts | already in `chains.ts` | already in `chains.ts` |
| `SafeWebAuthnSignerFactory` | from `@safe-global/safe-modules-deployments` | same |
| P-256 verifier | RIP-7212 precompile at `0x0000...0100` | FreshCryptoLib (FCL) Solidity verifier — use Safe's canonical deployment |
| Gas per passkey verification (signature) | ~3,450 gas | ~200K-300K gas |
| Sponsored by | Haven relayer | Haven relayer |

The Safe `SafeWebAuthnSignerFactory.getSigner(x, y, verifier)` call is identical across chains — only the `verifier` argument differs.

## Verification Plan

1. **Local dev**, Chrome desktop with virtual authenticator:
   - Sign up with email + password (existing flow), then enroll a passkey signer; observe backend `user_passkeys` row created with `signer_address`
   - Backend relayer deploys Safe on Base Sepolia and Gnosis Chiado with the passkey signer as the sole owner
   - Confirm on-chain owner of the Safe == `signer_address` (matches CREATE2 prediction)
   - Confirm `user_passkeys.safe_address` is populated post-deploy
2. **Re-login flow:** sign out, sign back in via email + password, dashboard loads correct Safe by `chainId`, frontend resolves the user's passkey credential and offers Face ID for signing
3. **Admin action (passkey):** trigger a manual outbound transfer; confirm Face ID prompt, signature verified on-chain by the passkey signer contract via ERC-1271
4. **Admin action (EOA — backwards compat):** as an existing EOA-owner user, trigger the same manual outbound transfer; confirm the Wagmi connector signs and submits, **no passkey prompt is shown anywhere**, and the path is identical to today
5. **Agent path unchanged:** create an agent with a 5-USDC daily limit, run a scripted x402 call. **No passkey prompt.** Confirm Allowance Module enforces budget and the agent EOA paid via the module.
6. **Cross-platform:** repeat onboarding on Safari iOS (Touch ID / Face ID), Chrome Android (fingerprint), Windows Chrome (Windows Hello). Document any differences (mostly attestation format quirks).
7. **Gas accounting:** log gas for passkey-signed admin txs on both chains. Confirm Gnosis FCL fallback is acceptable for sponsored cost; if not, adjust Haven's policy on which admin actions to relay vs ask user to fund.

## Sources

- [Safe and Passkeys](https://docs.safe.global/advanced/passkeys/passkeys-safe)
- [Safe React passkey tutorial](https://docs.safe.global/advanced/passkeys/tutorials/react)
- [Safe Passkeys Signer SDK reference](https://docs.safe.global/sdk/signers/passkeys)
- [`@safe-global/safe-passkey` (npm)](https://www.npmjs.com/package/@safe-global/safe-passkey)
- [safe-modules / passkey contracts (GitHub)](https://github.com/safe-global/safe-modules/tree/main/modules/passkey)
- [RIP-7212 explainer (Alchemy)](https://www.alchemy.com/blog/what-is-rip-7212)
- [OP Stack precompiles (RIP-7212 in Fjord)](https://specs.optimism.io/protocol/precompiles.html)

---

## Suggested PR Split

The next step is to break this into separately-deliverable PRs, each on its own branch:

1. **Backend relayer + `user_passkeys` schema** — migration, relayer wrapper, `/safe/deploy` route. Unblocks everything else server-side.
2. **Frontend passkey signer + WebAuthn helpers** — `passkey.ts`, `safePasskeySigner.ts`, chain config additions. Pure library code, no UI.
3. **`HavenUserSigner` abstraction + refactor of existing EOA call sites** — introduces the union type and threads it through every Safe admin flow. No behavior change for current users.
4. **Onboarding UI + auth wiring** — `ChooseSignerCard`, `PasskeyEnrollFlow`, `enrollPasskeyForSigning()` in `AuthContext`, end-to-end passkey-path Safe deploy.
5. **Chain config for Gnosis FCL verifier** — concrete verifier address, gas tuning, possible relayer cost guardrails.
