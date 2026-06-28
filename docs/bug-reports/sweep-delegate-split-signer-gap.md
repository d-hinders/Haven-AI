---
owner: "@d-hinders"
status: current
covers: []  # narrative — no direct code mirror
last-verified: "2026-06-28"
---

# Feedback Report: `haven_sweep_delegate` Is Broken in the Split-Signer Architecture

**Date:** 2026-06-16  
**Trigger:** Stranded 0.04 USDC on delegate EOA `0x94A3F25B8F14A70802CCC73D5F4D7E5eaF132549` (Base) after an expired x402 payment  
**Expected:** Call hosted `mcp__haven__haven_sweep_delegate`, funds move back to Safe  
**Actual:** `"delegateKey is required for sweepDelegate."` — tool is completely broken in this setup

---

## What Happened Step by Step

### Step 1 — Called the hosted sweep tool

After confirming the delegate had stranded USDC (from the expired Soundside payment), the natural next step was to call `mcp__haven__haven_sweep_delegate` — the tool Haven exposes for exactly this situation. The tool description says:

> "Sweep stranded USDC and/or ETH from the delegate wallet back to the originating Safe. Use this when the user instructs you to recover stranded funds on the delegate wallet…"

Called it with no arguments (it takes none). Immediate failure:

```json
{
  "success": false,
  "code": "SIGNING_ERROR",
  "message": "delegateKey is required for sweepDelegate."
}
```

### Step 2 — Investigated why the hosted tool fails

Traced the error to `packages/sdk/src/client.ts`:

```typescript
async sweepDelegate(): Promise<SweepResult> {
  if (!this.delegateKey) {
    throw new HavenSigningError('delegateKey is required for sweepDelegate.')
  }
  // ...
  const wallet = createWallet(this.delegateKey, provider)
  const tx = await usdcContract.transfer(safeAddress, usdcBalance)
  // ...
}
```

`sweepDelegate()` requires `delegateKey` to be present in the `HavenClient` instance. It uses it to create an ethers.js wallet that signs and broadcasts a raw ERC20 `transfer()` transaction directly.

Then looked at how the hosted MCP server creates its `HavenClient`:

```typescript
// packages/mcp-server/src/server.ts
export function createHostedHavenClient(options: HostedClientOptions): HavenClient {
  const client = new HavenClient({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    // Intentionally NO delegateKey. See custody invariant in
    // docs/architecture/06-hosted-mcp-connect-flow.md.
  })

  if (client.delegateAddress !== undefined) {
    throw new Error(
      'Hosted Haven MCP server must be keyless: a delegate key was present on the client. ' +
        'The hosted server constructs and relays only — the edge signs.',
    )
  }

  return client
}
```

The hosted server is **intentionally keyless**. This is the correct security model — the delegate key must never leave the agent's machine. But `sweepDelegate()` was written assuming the key is in the client, which contradicts the split-signer architecture that Haven's own hosted MCP setup uses.

### Step 3 — Concluded the hosted tool cannot work as-is

The architecture mismatch is fundamental:

| | `sweepDelegate()` in SDK | Split-signer x402 flow |
|---|---|---|
| Who holds the key? | `HavenClient` (in process with the caller) | Local edge signer only |
| How are txs signed? | Ethers wallet created directly in `sweepDelegate()` | Hosted server prepares → local signer signs → hosted server broadcasts |
| Works in hosted MCP? | ❌ No — client has no key | ✅ Yes — key never leaves the local machine |

`sweepDelegate()` was designed for a non-split, single-process use case (SDK embedded directly with the key). The hosted MCP server cannot call it.

### Step 4 — Checked whether the local signer had a sweep tool

The local signer (`mcp__haven-signer__`) only exposes:
- `haven_sign` — signs Haven payload hashes
- `haven_x402_sign_header` — builds EIP-3009 merchant payment headers

No sweep tool existed. There was no mechanism at all to sweep stranded funds from the delegate in the hosted split-signer setup.

### Step 5 — Concluded I had to add the functionality myself

Since the hosted tool doesn't work and the local signer has no sweep capability, and the user needed the 0.04 USDC recovered, I concluded I needed to either:

**Option A:** Add a `haven_sweep_delegate` tool to the local signer source (`packages/signer/src/`), rebuild it, and copy the new dist into `~/.haven/signer-runtime/`. This follows the same pattern as the x402 signing tools — the key stays local, the signer does the work.

**Option B:** Write a one-shot Node.js script that reads the signer credential file directly and uses viem to transfer USDC from the delegate to the Safe.

I implemented Option A first (modifying the signer source), then fell back to Option B (a script at `/tmp/haven-sweep.mjs`) because the MCP tool registry for the current Claude Code session was already negotiated at startup and wouldn't pick up the new tool without a restart.

### Step 6 — Hit the gas problem

The sweep script confirmed 40,000 atomic USDC on the delegate, then failed:

```
gas required exceeds allowance (0)
```

The delegate EOA has no ETH to pay for gas. This is a second structural gap:

- The AllowanceModule flow (`executeAllowanceTransfer`) funds USDC from Safe → delegate, paid for by the Haven relayer on behalf of the Safe.
- The delegate itself **never receives ETH** in the normal Haven payment flow.
- Any raw ERC20 `transfer()` from the delegate requires ETH gas, which it doesn't have.

The stranded funds cannot be swept by a raw ERC20 transfer without first sending ETH to the delegate — which in itself requires either user action or a separate funded account.

---

## Root Cause Summary

### Gap 1 — `sweepDelegate()` in SDK was written for a non-split architecture

`HavenClient.sweepDelegate()` holds a full ethers.js wallet inside the SDK and signs raw ERC20 transactions directly. This worked fine when the SDK was used locally (CLI or embedded), but it is incompatible with the hosted MCP server which is intentionally keyless.

The hosted `haven_sweep_delegate` tool calls `haven.sweepDelegate()` which immediately throws because there's no key.

**What should exist instead:** The same construct-and-relay pattern Haven already uses for x402 payments:
1. Hosted server determines what to sweep (balances, amounts, target Safe)
2. Hosted server constructs the unsigned ERC20 transfer payload and returns it to the agent
3. Agent passes it to the local signer to sign
4. Hosted server (or agent) broadcasts the signed tx

OR — simpler — a `haven_sweep_delegate` tool added directly to the local signer package, which already holds the key and can do the signing inline.

### Gap 2 — Delegate EOA is never funded with ETH for gas

The Haven payment flow puts USDC on the delegate via `AllowanceModule.executeAllowanceTransfer`. This is a Safe module transaction paid for by the relayer. The delegate itself never accumulates ETH.

When funds strand on the delegate (expired x402, failed merchant retry, etc.), a raw ERC20 sweep requires the delegate to have ETH for gas — which it structurally never has.

**Options for Haven to fix this:**
1. **Use EIP-3009 `transferWithAuthorization`**: USDC on Base natively supports this. The delegate signs the transfer authorization offline; a Haven relayer with ETH submits the transaction and pays gas. Funds return to the Safe gaslessly from the delegate's perspective.
2. **Use a paymaster / account abstraction**: Submit the ERC20 transfer via a paymaster that sponsors gas, so the delegate's ETH balance is irrelevant.
3. **Include a small ETH stipend** when funding the delegate via AllowanceModule: Before each x402 payment, send a tiny ETH amount (e.g., 0.0001 ETH) to the delegate to cover potential sweep gas. This is the simplest approach but adds an extra tx to every x402 flow.
4. **Use the Safe's `execTransaction` directly**: Have the Safe call `USDC.transfer(safe, balance)` from the Safe's own address, not from the delegate. This bypasses the need for delegate ETH entirely — but requires a Safe owner signature.

---

## Corrected Implementation Spec (authoritative)

> This supersedes the speculative options above. It folds in review feedback on the
> first-draft plan. The non-negotiable invariants: **the API key is identity + rate
> limit, the delegate signature is authority, and the relayer is only a gas payer.**
> The relayer never holds an allowance and is never a spender, so a relayer
> compromise cannot drain anything. The submit endpoint accepts exactly one
> operation shape and re-derives every field server-side before spending gas.

### Mechanism: gasless USDC sweep via EIP-3009 `transferWithAuthorization`

Base USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) natively supports EIP-3009 —
the same primitive the x402 merchant leg already uses. The delegate signs an
**off-chain** EIP-712 `TransferWithAuthorization` (no ETH needed on the delegate);
the Haven relayer submits the on-chain tx and pays gas.

- **Use `transferWithAuthorization`, not `receiveWithAuthorization`.** `receive*`
  constrains `msg.sender == to` (the Safe), which the relayer is not. `transfer*`
  is front-runnable, but for a sweep that is **benign** — any submitter just moves
  funds delegate→Safe, the desired outcome. This is intentional; do not "harden" it
  into `receive*`.
- **ETH is out of scope for the gasless path.** EIP-3009 is USDC-only. The hosted
  sweep recovers USDC and must *say so* when stranded ETH is also present (no silent
  partial success). Gasless ETH needs a paymaster/AA design — deferred. The
  local-key SDK `sweepDelegate()` still sweeps both ETH and USDC for embedded use.

### EIP-712 domain (single source of truth)

Defined once in `packages/sdk/src/sweep.ts` and consumed by both signer and backend:

```
domain  = { name: "USD Coin", version: "2", chainId: 8453,
            verifyingContract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 }
types   = { TransferWithAuthorization: [from,to,value,validAfter,validBefore,nonce(bytes32)] }
message = { from: delegate, to: safe, value: <snapshot balance>,
            validAfter: 0, validBefore: now+300s, nonce: <random bytes32> }
```

A domain that mismatches the on-chain token's `DOMAIN_SEPARATOR` makes the relayer
tx revert. The off-chain `verifyTypedData` on submit catches signer/field mismatch
but **not** an on-chain domain mismatch — so the Base USDC domain is hardcoded
(known-good) and asserted by the existing x402 EIP-3009 path that already settles
against this token.

### Backend-signed authorization binding (mirror of the x402 expected-context)

The backend signs the sweep authorization context with the **same binding key**
the x402 flow uses (`X402_BINDING_PRIVATE_KEY`; signer trusts
`HAVEN_X402_BINDING_SIGNER`), but under a **distinct message namespace**
(`Haven sweep authorization v1` / `kind: haven.sweep.authorization`) so an x402
binding can never be replayed as a sweep binding. The local signer re-derives the
message from the authorization fields, checks it matches, checks the signer is the
trusted Haven address, and verifies the signature — so even a malicious hosted
server cannot get the delegate to sign a transfer to an attacker address.

### Flow

```
1. Agent calls hosted haven_sweep_delegate (keyless, API-key authenticated)
2. Hosted server → POST /machine-payments/sweep/prepare
   Backend: resolve delegate/Safe/chain from the agent; read delegate USDC balance.
     - balance == 0 → { nothing_stranded: true }   (no row, no signing)
     - balance  > 0 → build authorization (to = registered Safe, value = balance,
                       validBefore = now+300s, random nonce); persist row
                       (status 'prepared', unique nonce); sign expected binding;
                       return { authorization, expected_auth, sign_instructions }
3. Hosted tool returns signature_required + authorization + expected_auth
4. Agent → local signer haven_sign_sweep_delegate(authorization, expected_auth)
     Signer: assert from == delegate, to == credential Safe, token/chain canonical,
     verify expected binding, sign EIP-712, verify recovery == delegate → signature
5. Agent → hosted haven_sweep_delegate (resume) → POST /machine-payments/sweep/submit
   Backend (re-derive everything; trust nothing from the client payload):
     - look up the 'prepared' row by nonce (must exist, not expired, not used)
     - rebuild expected authorization from server state; reject if the client's
       to/value/token/chain/nonce differ from what was prepared
     - verifyTypedData → recovered == registered delegate (else 403)
     - re-read balance; require balance >= value (else 409 balance_changed)
     - relayer submits USDC.transferWithAuthorization(...bytes signature); pay gas
     - mark row 'submitted' + tx_hash (idempotent on nonce); resolve any open
       merchant_retry_rejected_after_payment reconciliation event for the agent
     - return { tx_hash, amount, explorer_url }
```

This mirrors `haven_quote_x402 → haven_sign → haven_x402_sign_header` and keeps the
delegate key entirely on the edge.

### Files

| File | Change |
|---|---|
| `packages/sdk/src/sweep.ts` *(new)* | EIP-712 domain/types builder, `buildSweepAuthorizationMessage()` binding string, sweep authorization/result types. Single source of truth shared by signer + backend. |
| `packages/sdk/src/types.ts`, `index.ts` | Export new sweep types/helpers. |
| `packages/sdk/src/client.ts` | Add `prepareSweep()` + `submitSweep()` (hosted split). Keep local-key `sweepDelegate()` for embedded use. |
| `packages/signer/src/core.ts` | Replace the broadcasting `sweepDelegate()` (it violated the signer's no-network-I/O invariant and needed delegate ETH) with `signSweepAuthorization()` — pure EIP-712 signing + binding verification. |
| `packages/signer/src/tools.ts` | Replace `haven_sweep_delegate` with `haven_sign_sweep_delegate` (sign-only, keyless-relay compatible). |
| `packages/backend/src/db/migrations/022_delegate_sweeps.ts` *(new)* | `delegate_sweeps` table; unique nonce; tracks prepare→submit. |
| `packages/backend/src/lib/sweep.ts` *(new)* | Build authorization, sign expected binding, relayer `transferWithAuthorization` submit. |
| `packages/backend/src/routes/machine-payments.ts` | `POST /sweep/prepare`, `POST /sweep/submit`. |
| `packages/mcp-server/src/tools.ts` | Rewrite `haven_sweep_delegate` to orchestrate prepare → `signature_required`, plus the submit/resume step. Stays keyless. |
| UI/copy | Primary UX says "Recover funds to your Haven wallet," not delegate/Safe/MiCA jargon. |

---

## Current State

- 0.04 USDC remains stranded on delegate EOA `0x94A3F25B8F14A70802CCC73D5F4D7E5eaF132549` on Base, with no ETH for gas.
- The gasless EIP-3009 sweep above recovers it without funding the delegate. Implementation in progress per the spec.
