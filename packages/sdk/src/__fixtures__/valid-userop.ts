/**
 * #3271 / #3283 / #3375: a structurally valid AND guard-valid x402 funding-leg
 * `PackedUserOperation` sign_data for tests that only care about the funding
 * leg's control flow, not the exact bytes of a real UserOp.
 *
 * `HavenClient.signForData` runs the #3271 binding, the direct-payment
 * allowlist (#3283) and, on a funding leg, the recipient pin (#3375), so a
 * fixture must be what Haven actually emits: `sender` is the counterfactual
 * delegate account of the client's own delegate key, and the single execution
 * is `transfer(<delegate EOA>, amount)` of the 402 option's token. Built by the
 * ONE shared builder (`test-support/direct-userop.ts`,
 * `@haven_ai/sdk/test-support`) rather than a second copy — never loosen the
 * guard to keep a toy fixture green. Direct-payment (`pay()`) tests build their
 * third-party shape with `buildBoundDirectUserOp` directly.
 *
 * Not a real, on-chain-recorded payload (that role is
 * `direct-payment-userop.json`).
 */
import { addressFromKey } from '../edge-signing.js'
import { buildFundingLegUserOp } from '../test-support/direct-userop.js'

/** The delegate key every toy-fixture test file in this package constructs its client with. */
export const DEFAULT_TEST_DELEGATE_KEY = `0x${'01'.repeat(32)}`

export interface ValidUserOpSignData {
  hash: `0x${string}`
  signature_scheme: 'eip712_userop'
  typed_data: ReturnType<typeof buildFundingLegUserOp>['typedData']
}

export interface FundingLegSignDataOptions {
  /** The 402 option's token — the funding leg's `transfer` target. */
  asset: string
  /** The 402 option's atomic amount — what the leg moves. */
  amount: string
  /** The client's delegate key: the account AND the transfer's recipient derive from it. */
  delegateKey?: string
}

/**
 * #3375: a guard-valid x402 FUNDING LEG `eip712_userop` sign_data — the
 * direct-payment shape whose single execution is `transfer(<delegate EOA>,
 * amount)` of `asset`, exactly as the backend builds it. Since #3375
 * `HavenClient`'s funding leg also runs the #3281 recipient pin against the
 * 402 option, so a funding-leg test must pass ITS option's `asset`/`amount`
 * here; a transfer to anyone but the delegate is refused.
 */
export function buildFundingLegSignData(options: FundingLegSignDataOptions): ValidUserOpSignData {
  const delegate = addressFromKey(options.delegateKey ?? DEFAULT_TEST_DELEGATE_KEY) as `0x${string}`
  const { typedData, payloadHash } = buildFundingLegUserOp({
    delegate,
    asset: options.asset as `0x${string}`,
    amount: options.amount,
    chainId: 8453,
  })
  return { hash: payloadHash, signature_scheme: 'eip712_userop', typed_data: typedData }
}
