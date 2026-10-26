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
  'exists for this payment and none is built. On a plain-HTTP merchant, submit the child ' +
  "signature from haven_sign with haven_submit and settlement_scheme 'erc7710', and retry " +
  'the merchant with the payment_header haven_submit returns. On an MCP merchant reached ' +
  'through haven_prepare_catalog_purchase or haven_pay_mcp_tool, call haven_settle_mcp_tool ' +
  'with payment_id and signature and NO payment_header — Haven assembles it at settle. ' +
  'Nothing was signed by this call.'

/**
 * #4248: structured like the other signer refusals (#3001/#3103/#3169): a
 * named code an agent can route on, a `next_action`, and a typed next step.
 * Until #4248 this was a plain `SIGNING_ERROR` carrying its remedy in prose
 * only, which the signer's own instructions ("every signer refusal also
 * carries the next-step family") did not hold for.
 *
 * The step names no tool, and says why instead. `SIGNER_NEXT_STEP_TARGETS`
 * (next-step.ts) declares hosted targets only, and the refusal does not hold
 * the signature argument a `haven_submit` / `haven_settle_mcp_tool` step would
 * need — at the `haven_sign_x402` site nothing was signed yet, so the next
 * call IS that signer call; at the header site the child was already signed by
 * `haven_sign`, so the next call would be the hosted settle, whose argument is
 * the child signature the agent holds and this signer does not keep. Each site
 * therefore states its own remedy: re-sign at the one-shot site, submit the
 * signature already held at the header site. Since #4449 each remedy names
 * BOTH settle routes — `haven_submit` with `settlement_scheme: 'erc7710'` for a
 * plain-HTTP merchant, `haven_settle_mcp_tool` with no `payment_header` for an
 * MCP merchant — because the signer cannot tell the two apart.
 */
export const NO_FUNDING_LEG = 'NO_FUNDING_LEG' as const

/** Where the refusal fired: `haven_x402_sign_header` (`header`) or `haven_sign_x402` (`one_shot`). */
export type NoFundingLegSite = 'header' | 'one_shot'

/** The `next_tool_omitted_reason` per site. The test pins each as a literal, not via this map. */
export const NO_FUNDING_LEG_NEXT_STEP_REASONS: Readonly<Record<NoFundingLegSite, string>> = {
  header:
    "submit the settlement-child signature you already hold from haven_sign to haven_submit with settlement_scheme 'erc7710' — it returns the payment_header — on a plain-HTTP merchant, or to haven_settle_mcp_tool with payment_id and signature and no payment_header on an MCP merchant; do not sign again unless you no longer hold it (haven_sign { payment_id } re-signs the same child), and an erc7710 payment has no EIP-3009 header step",
  one_shot:
    "sign the settlement child with haven_sign { payment_id }, then on a plain-HTTP merchant call haven_submit with that signature and settlement_scheme 'erc7710' — it returns the payment_header — and on an MCP merchant call haven_settle_mcp_tool with payment_id and signature and no payment_header; an erc7710 payment has no EIP-3009 header step",
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
