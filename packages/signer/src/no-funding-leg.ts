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
 * The step names no tool, and says why instead. `SIGNER_NEXT_STEP_TARGETS`
 * (next-step.ts) declares hosted targets only, so a signer-role step such as
 * `haven_sign` cannot be built at all. At the `haven_sign_x402` site nothing
 * was signed yet, so the next call IS that signer call. At the header site the
 * child was already signed by `haven_sign`, so the next call would be the
 * hosted `haven_submit` — but its argument is the child signature, which the
 * agent holds and this signer does not keep. Each site therefore states its own
 * remedy: re-sign at the one-shot site, submit the signature already held at
 * the header site.
 */
export const NO_FUNDING_LEG = 'NO_FUNDING_LEG' as const

/** Where the refusal fired: `haven_x402_sign_header` (`header`) or `haven_sign_x402` (`one_shot`). */
export type NoFundingLegSite = 'header' | 'one_shot'

/** The `next_tool_omitted_reason` per site. The test pins each as a literal, not via this map. */
export const NO_FUNDING_LEG_NEXT_STEP_REASONS: Readonly<Record<NoFundingLegSite, string>> = {
  header:
    "submit the settlement-child signature you already hold from haven_sign to haven_submit with settlement_scheme 'erc7710' — it returns the payment_header; do not sign again, and an erc7710 payment has no EIP-3009 header step",
  one_shot:
    "sign the settlement child with haven_sign { payment_id }, then call haven_submit with that signature and settlement_scheme 'erc7710' — it returns the payment_header; an erc7710 payment has no EIP-3009 header step",
}

export class HavenNoFundingLegRefusedError extends HavenSigningError {
  declare readonly code: typeof NO_FUNDING_LEG
  readonly next_action = AgentPaymentNextAction.SignAndSubmitPayment
  readonly step: NextStep

  constructor(site: NoFundingLegSite) {
    super(NO_FUNDING_LEG_MESSAGE)
    ;(this as { code: string }).code = NO_FUNDING_LEG
    this.name = 'HavenNoFundingLegRefusedError'
    this.step = signerRefusalStep({
      nextAction: AgentPaymentNextAction.SignAndSubmitPayment,
      nextTool: null,
      nextToolOmittedReason: NO_FUNDING_LEG_NEXT_STEP_REASONS[site],
    })
  }
}
