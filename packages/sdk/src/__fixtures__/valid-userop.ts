/**
 * #3271 / #3283: a structurally valid AND guard-valid `PackedUserOperation`
 * sign_data for tests that only care about the funding-leg / direct-payment
 * control flow, not the exact bytes of a real UserOp.
 *
 * Since #3283 `HavenClient.signForData` runs the direct-payment allowlist
 * (`assertBoundDirectPaymentUserOp`) after the #3271 binding check, so a
 * fixture must be what Haven actually emits: `sender` is the counterfactual
 * delegate account of the client's own delegate key, and `callData` is
 * `execute(DelegationManager, 0, redeemDelegations(...))` redeeming one real
 * delegation. Built by the ONE shared builder
 * (`test-support/direct-userop.ts`, `@haven_ai/sdk/test-support`) rather than
 * a second copy — never loosen the guard to keep a toy fixture green.
 *
 * Not a real, on-chain-recorded payload (that role is
 * `direct-payment-userop.json`) — use this where the test's point is NOT the
 * guard itself.
 */
import { addressFromKey } from '../edge-signing.js'
import { buildBoundDirectUserOp } from '../test-support/direct-userop.js'

/** The delegate key every toy-fixture test file in this package constructs its client with. */
export const DEFAULT_TEST_DELEGATE_KEY = `0x${'01'.repeat(32)}`

export interface ValidUserOpOverrides {
  /** The client's delegate key; the UserOp's `sender` is derived from it. */
  delegateKey?: string
  chainId?: number
}

export interface ValidUserOpSignData {
  hash: `0x${string}`
  signature_scheme: 'eip712_userop'
  typed_data: ReturnType<typeof buildBoundDirectUserOp>['typedData']
}

/** Builds a self-consistent, guard-valid `eip712_userop` sign_data payload for test fixtures. */
export function buildValidUserOpSignData(overrides: ValidUserOpOverrides = {}): ValidUserOpSignData {
  const delegate = addressFromKey(overrides.delegateKey ?? DEFAULT_TEST_DELEGATE_KEY) as `0x${string}`
  const { typedData, payloadHash } = buildBoundDirectUserOp({ delegate, chainId: overrides.chainId ?? 8453 })
  return { hash: payloadHash, signature_scheme: 'eip712_userop', typed_data: typedData }
}
