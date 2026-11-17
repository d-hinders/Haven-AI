/**
 * #4851: the CDP settle path — the merchant's own checks, then Coinbase's
 * facilitator, with the chain as the judge of every failure.
 *
 * #4890: moved from inside `createX402PaymentProcessor`
 * (`packages/demo-merchant-mcp/src/x402.ts`) as free functions over an injected
 * `CdpSettlementConfig`, so the demo merchant and the paywall proxy settle the
 * same way. Logging stays `console.error` / `console.warn` with the same
 * `[x402] CDP …` messages.
 */
import { getAddress, type Address, type Hex } from 'viem'
import { VerifyError, type PaymentPayload, type PaymentRequired, type PaymentRequirements } from '@x402/core/types'
import { CDP_CALL_TIMEOUT_MS, withCdpTimeout, type CdpSettlementConfig } from './cdp.js'
import {
  AuthorizationAlreadyUsedError,
  PaymentError,
  TX_HASH_RE,
  assertCdpWindowSearchable,
  assertPaymentOptionMatches,
  assertResourceMatches,
  cdpVerificationRefused,
  describeError,
  parseExactEvmPayload,
  selectQuotedPaymentOption,
  verifyAuthorization,
  type Eip3009Authorization,
  type PaymentAsset,
} from './payment-checks.js'

/**
 * #4851: a payment for a `cdp` product. Every check this merchant makes
 * about its OWN quote — the quoted option, the resource, the recipient, the
 * amount, the signature and the validity window — runs here, before
 * Coinbase's facilitator is called at all. (The extensions echo and x402
 * version are checked before the dispatch, by the caller.)
 *
 * One exception to the window: an EXPIRED authorization is not refused yet.
 * A settle that timed out may have landed after all, and a buyer retrying
 * the same header after `validBefore` must be served if the chain says the
 * money moved. `settleThroughCdp` reads the chain first and refuses the
 * expired header only when it is unused.
 */
export async function verifyCdpAuthorization(params: {
  payload: PaymentPayload
  paymentRequired: PaymentRequired
  merchantAddress: Address
  expectedAmount: bigint
  asset: PaymentAsset
}): Promise<{
  authorization: Eip3009Authorization
  signature: Hex
  quoted: PaymentRequirements
  expired: boolean
}> {
  const { authorization, signature } = parseExactEvmPayload(params.payload.payload)
  const quoted = selectQuotedPaymentOption(params.payload.accepted, params.paymentRequired)
  assertPaymentOptionMatches(
    params.payload.accepted,
    quoted,
    params.merchantAddress,
    params.expectedAmount,
    'eip3009',
    params.asset,
  )
  assertResourceMatches(params.payload, params.paymentRequired)
  const { expired } = await verifyAuthorization(
    authorization,
    signature,
    params.merchantAddress,
    params.expectedAmount,
    params.asset,
    { allowExpired: true },
  )
  // Review of #4851: refuse, before any chain read or CDP call, a window the
  // recovery search could not cover in full — see the constant.
  assertCdpWindowSearchable(authorization)
  return { authorization, signature, quoted, expired }
}

/**
 * #4851: settle through Coinbase's facilitator, with the chain as the judge
 * of every failure. No facilitator error string is matched: whatever went
 * wrong — a refusal, a timeout, a network error — the merchant reads USDC's
 * `authorizationState` itself.
 *  - used → the money moved, or the nonce was consumed some other way;
 *    `recoverUsedAuthorization` tells the two apart from USDC's events and
 *    serves the buyer only in the first case (or when it cannot tell).
 *  - not used → nothing has moved yet. The buyer is told to retry the same
 *    header, which runs this check again.
 * A refusal AT VERIFICATION (which includes Coinbase's sanctions and risk
 * screening) is final — nothing settled, nothing delivered, no retry —
 * unless the chain already shows the authorization used (an earlier settle
 * that landed); then the events decide, as above.
 */
export async function settleThroughCdp(p: {
  cdp: CdpSettlementConfig
  payload: PaymentPayload
  requirements: PaymentRequirements
  authorization: Eip3009Authorization
  expired: boolean
}): Promise<Hex> {
  const payer = getAddress(p.authorization.from)
  const nonce = p.authorization.nonce as Hex
  const timeoutMs = p.cdp.timeoutMs ?? CDP_CALL_TIMEOUT_MS

  // Chain first: a retried header whose earlier settle landed — inside or
  // after its validity window — is served here, without asking CDP again.
  if (await readAuthorizationUsed(p.cdp, payer, nonce)) return recoverUsedAuthorization(p)
  if (p.expired) throw new PaymentError('Payment authorization has expired')

  let verification
  try {
    verification = await withCdpTimeout('verify', timeoutMs, () => p.cdp.facilitator.verify(p.payload, p.requirements))
  } catch (err) {
    if (err instanceof VerifyError) return refuseVerificationUnlessPaid(p, err.invalidReason, err.invalidMessage)
    console.error('[x402] CDP verify did not answer — nothing settled', { payer, nonce, error: describeError(err) })
    throw new PaymentError(
      "Coinbase's facilitator did not answer the verification. Nothing settled — retry the same payment header.",
      'facilitator_retryable',
    )
  }
  if (!verification.isValid) {
    return refuseVerificationUnlessPaid(p, verification.invalidReason, verification.invalidMessage)
  }

  let failure: string
  try {
    const settlement = await withCdpTimeout('settle', timeoutMs, () => p.cdp.facilitator.settle(p.payload, p.requirements))
    if (settlement.success && TX_HASH_RE.test(settlement.transaction)) return settlement.transaction as Hex
    failure = `settle answered success=${String(settlement.success)}${settlement.errorReason ? ` (${settlement.errorReason})` : ''}`
  } catch (err) {
    failure = describeError(err)
  }

  // Any settle failure: the chain decides. A timeout can land later; a
  // refusal can follow a broadcast. Only an unused authorization is retried.
  let used: boolean
  try {
    used = await p.cdp.chain.authorizationUsed(payer, nonce)
  } catch (err) {
    console.error('[x402] CDP settle failed and the chain could not be read', { payer, nonce, failure, error: describeError(err) })
    throw new PaymentError(
      "Coinbase's facilitator did not confirm the settlement and the chain could not be read. Retry the same " +
        'payment header: it is checked against the chain again, so it settles at most once.',
      'facilitator_retryable',
    )
  }
  if (used) return recoverUsedAuthorization(p)
  console.error('[x402] CDP settle failed; authorization unused so far', { payer, nonce, failure })
  throw new PaymentError(
    "Coinbase's facilitator did not confirm the settlement, and the chain shows the authorization unused: " +
      'nothing has moved yet. Retry the SAME payment header — it is checked against the chain again — and do ' +
      'not sign a new one.',
    'facilitator_retryable',
  )
}

/**
 * Review of #4851: a verification refusal is final only if the money has
 * not moved. An earlier settle that timed out may still land, and the
 * facilitator then refuses the same authorization as already used. One more
 * chain read keeps "do not retry" from reaching a buyer who paid.
 */
export async function refuseVerificationUnlessPaid(
  p: { cdp: CdpSettlementConfig; authorization: Eip3009Authorization },
  invalidReason: string | undefined,
  invalidMessage: string | undefined,
): Promise<never> {
  const payer = getAddress(p.authorization.from)
  const nonce = p.authorization.nonce as Hex
  let used = false
  try {
    used = await p.cdp.chain.authorizationUsed(payer, nonce)
  } catch (err) {
    console.error('[x402] CDP refused at verification; the chain could not be re-read', {
      payer,
      nonce,
      error: describeError(err),
    })
  }
  if (used) return recoverUsedAuthorization(p)
  throw cdpVerificationRefused(invalidReason, invalidMessage)
}

export async function readAuthorizationUsed(cdp: CdpSettlementConfig, payer: Address, nonce: Hex): Promise<boolean> {
  try {
    return await cdp.chain.authorizationUsed(payer, nonce)
  } catch (err) {
    console.error('[x402] CDP pre-settle chain read failed', { payer, nonce, error: describeError(err) })
    throw new PaymentError(
      'The merchant could not read the chain before settling. Nothing settled — retry the same payment header.',
      'facilitator_retryable',
    )
  }
}

/**
 * The authorization is used on-chain. `authorizationState` says the same for
 * a payment, a CANCELLED authorization and a nonce spent by another
 * authorization, so USDC's `AuthorizationUsed` event inside this
 * authorization's own validity window decides (`findAuthorizationOutcome`):
 * - found, and its transaction paid this merchant the price → served, with
 *   that transaction as the reference;
 * - found, paying anything else, or the whole window empty → refused: this
 *   payment cannot have landed outside its window, so nothing was paid here;
 * - the search failed (a read error or, #4890, the `SETTLE_RESOLVE_MS` bound),
 *   or the window was too long to search in full → served with no reference.
 *   A buyer whose money may have moved is never refused, and this is the
 *   answer the own-key path gives to any used nonce (#1519).
 */
export async function recoverUsedAuthorization(p: {
  cdp: CdpSettlementConfig
  authorization: Eip3009Authorization
}): Promise<never> {
  const payer = getAddress(p.authorization.from)
  const nonce = p.authorization.nonce as Hex
  let outcome: Awaited<ReturnType<CdpSettlementConfig['chain']['findAuthorizationOutcome']>> = null
  try {
    outcome = await p.cdp.chain.findAuthorizationOutcome({
      authorizer: payer,
      nonce,
      to: getAddress(p.authorization.to),
      value: BigInt(p.authorization.value),
      validAfter: BigInt(p.authorization.validAfter),
      validBefore: BigInt(p.authorization.validBefore),
    })
  } catch (err) {
    console.warn('[x402] CDP: authorization used, but its transaction could not be found', {
      payer,
      nonce,
      error: describeError(err),
    })
  }
  if (outcome?.kind === 'not_in_window') {
    throw new PaymentError(
      `Authorization ${nonce} is marked used on-chain, but no transfer for it happened inside its validity ` +
        'window: it was cancelled, or its nonce was spent by another authorization. Nothing was paid here; ' +
        'nothing is delivered.',
      'facilitator_refused',
    )
  }
  if (outcome?.kind === 'used_elsewhere') {
    throw new PaymentError(
      `Authorization ${nonce} was spent on a different transfer (${outcome.txHash}), not on a payment to this ` +
        'merchant. Nothing was paid here; nothing is delivered.',
      'facilitator_refused',
    )
  }
  throw new AuthorizationAlreadyUsedError(
    `Payment authorization ${nonce} has already settled on-chain for ${payer}. Do not resubmit it.`,
    outcome?.kind === 'settled' ? outcome.txHash : undefined,
  )
}
