import { AgentPaymentNextAction, HavenSigningError, type NextStep } from '@haven_ai/sdk/edge'
import { signerRefusalStep } from './next-step.js'

/**
 * #4242: the refusal for an EIP-3009 merchant header requested for an erc7710
 * settlement child. Both refusal sites — `buildX402PaymentHeader` and the
 * early refusal in `haven_sign_x402` — say the same thing.
 */
export const NO_FUNDING_LEG_MESSAGE =
  'This x402 payment is an erc7710 settlement child, which has no funding leg: ' +
  'the merchant is paid through the signed child itself, so no EIP-3009 merchant header ' +
  'exists for this payment and none is built. Submit the child signature from haven_sign ' +
  "with haven_submit and settlement_scheme 'erc7710', and retry the merchant with the " +
  'payment_header haven_submit returns. Nothing was signed by this call.'

/**
 * #4248: structured like the other signer refusals (#3001/#3103/#3169): a
 * named code an agent can route on, a `next_action`, and a typed next step.
 * Until #4248 this was a plain `SIGNING_ERROR` carrying its remedy in prose
 * only, which the signer's own instructions ("every signer refusal also
 * carries the next-step family") did not hold for.
 *
 * The step names no tool. The remedy is a signer call (`haven_sign`) or a
 * hosted call (`haven_submit`) whose arguments — the child signature, the
 * payment id — this refusal does not hold at either site, and a next step
 * never invents arguments. So it says why instead.
 */
export const NO_FUNDING_LEG = 'NO_FUNDING_LEG' as const

export class HavenNoFundingLegRefusedError extends HavenSigningError {
  declare readonly code: typeof NO_FUNDING_LEG
  readonly next_action = AgentPaymentNextAction.SignAndSubmitPayment
  readonly step: NextStep

  constructor() {
    super(NO_FUNDING_LEG_MESSAGE)
    ;(this as { code: string }).code = NO_FUNDING_LEG
    this.name = 'HavenNoFundingLegRefusedError'
    this.step = signerRefusalStep({
      nextAction: AgentPaymentNextAction.SignAndSubmitPayment,
      nextTool: null,
      nextToolOmittedReason:
        "sign the settlement child with haven_sign { payment_id }, then call haven_submit with that signature and settlement_scheme 'erc7710' — it returns the payment_header; an erc7710 payment has no EIP-3009 header step",
    })
  }
}
