# SDK test fixtures

## `direct-payment-userop.json`

A **real** direct-payment (`POST /payments`) EIP-712 signing payload served by
the dev backend on 2026-09-24 (Base Sepolia), plus its `payload_hash` — the
ERC-4337 v0.7 `UserOperation` hash of the same operation — captured together
so `userop-binding.test.ts` (#3271) can prove `assertUserOpTypedDataBinding`
accepts a real payload rather than a hand-built one, and that the hash it
recomputes agrees with viem's own `getUserOperationHash` on the unpacked
`UserOperation`. Public Base Sepolia testnet data; the delegate key that
would have signed it is not included and is not needed — the binding check
never touches a key. Payment id and delegate/account addresses are recorded
in the fixture's `_note` field for provenance.

## `settlement-delegation-payload.json`

A **real** EIP-712 signing payload for an erc7710 x402 settlement child,
generated from the backend rather than written by hand (#1452, epic #1450).

Provenance — regenerate with these exact inputs if the backend's payload
legitimately changes:

```ts
// run from packages/backend
buildSettlementDelegation({
  chainId: 84532,
  delegateAccountAddress: '0x1111111111111111111111111111111111111111',
  budgetDelegation: { delegator: '0x1111…1111', delegate: '0x2222…2222',
                      authority: '0x' + '00'.repeat(32), caveats: [], salt: '0x0',
                      signature: '0x' + 'ab'.repeat(65) },
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia USDC
  amountAtomic: 1000n,
  payTo: '0x3333333333333333333333333333333333333333',
  maxTimeoutSeconds: 300,
  redeemers: ['0x4444444444444444444444444444444444444444'],
}).signingPayload
```

**Why a real payload.** The SDK signs this typed data verbatim, so the test
proves nothing unless the domain and types are the ones the DelegationManager
will actually hash. A hand-written fixture that drifted from the backend would
let a broken signer look correct in CI and fail on-chain at redemption — after
the agent has already told the merchant it paid.

**What keeps it honest.** `packages/backend/src/modules/x402/__tests__/settlement-payload-fixture.test.ts`
regenerates the payload and fails if the domain, types, primaryType or message
key set moved. It lives on the backend side on purpose: the change that would
invalidate this fixture is a backend change, and the SDK cannot import the
backend to notice.

Values that vary per call — the expiry caveat's threshold, the salt — are NOT
asserted, so the guard fires on drift rather than on the clock.
