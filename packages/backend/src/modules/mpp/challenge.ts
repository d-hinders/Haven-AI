/**
 * `mpp_demo` challenge verification (#997). An AUTHORIZATION boundary, not
 * mere shape validation — it pins the demo's exact price, exact USDC address,
 * exact chain and a non-expired window, so a caller cannot pay less than the
 * challenge demanded or replay an expired one. Extracted verbatim from
 * `routes/machine-payments.ts`'s `validateMppDemoChallenge`. See
 * `routes/__tests__/demo-mpp.test.ts` and the `authorize` rejection-path
 * tests in `routes/__tests__/machine-payments.test.ts` for the
 * characterization pins (#997) and the mutation proof this boundary must
 * hold against.
 */
import type { MachinePaymentChallengeBody } from './types.js'

export function validateMppDemoChallenge(challenge: MachinePaymentChallengeBody): string | null {
  if (!challenge || typeof challenge !== 'object') return 'challenge is required'
  if (challenge.rail !== 'mpp_demo') return 'Only mpp_demo challenges are supported'
  if (!challenge.challengeId || typeof challenge.challengeId !== 'string') return 'challengeId is required'
  if (!challenge.resource || typeof challenge.resource !== 'string') return 'resource is required'
  if (challenge.network?.chainId !== 8453 || challenge.network?.name !== 'base') {
    return 'MPP demo payments must use Base'
  }
  if (
    challenge.asset?.symbol !== 'USDC' ||
    challenge.asset?.decimals !== 6 ||
    challenge.asset?.address?.toLowerCase() !== '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
  ) {
    return 'MPP demo payments must use Base USDC'
  }
  if (challenge.amount?.atomic !== '10000' || challenge.amount?.display !== '0.01') {
    return 'MPP demo payments are fixed at 0.01 USDC'
  }
  if (!challenge.expiresAt || typeof challenge.expiresAt !== 'string') {
    return 'expiresAt must be a valid ISO timestamp'
  }
  const expiresAtMs = new Date(challenge.expiresAt).getTime()
  if (!Number.isFinite(expiresAtMs)) {
    return 'expiresAt must be a valid ISO timestamp'
  }
  if (expiresAtMs <= Date.now()) {
    return 'MPP demo challenge has expired'
  }
  return null
}
