import {
  MCP_X402_PAYMENT_RESPONSE_META_KEY,
  encodeMcpSettlementReceipt,
  extractMcpPaymentRequired,
} from './mcp-merchant-transport.js'
import type { McpX402SettlementMeta } from './mcp-merchant-transport.js'
import { parseMerchantSettlement } from './merchant-completion.js'

/**
 * #4120: the ONE post-funding merchant-answer decision, shared by the two
 * paths that retry a merchant with the payment header after Haven's funding
 * leg has already moved USDC:
 *
 * - the HOSTED path, `HavenClient.completeX402MerchantCall` (client.ts) — the
 *   hosted MCP's settle and complete tools call it; and
 * - the LOCAL path, `MerchantCompletion.retryRequest` (merchant-completion.ts)
 *   — `fetch`, `payX402Quote` and `resumeX402Payment` all reach it.
 *
 * Until #4120 each copy derived the in-band challenge, the `_meta` settlement,
 * the settlement hash and the #4062 `plainToolErrorAfterFunding` predicate on
 * its own, and the copies had drifted (quality scan 2026-10-19, candidate C3):
 * 17 commits touched `merchant-completion.ts` since the facade refactor and 15
 * of them also touched `client.ts`. This module is the one copy of that
 * decision. What stays per caller is the PARSING of the tool result (#4120
 * D2, undecided and preserved): the local `readToolResult` content-type gate
 * (JSON or SSE only) and the hosted `surfaceResult` + `JSON.parse` — this
 * function takes whatever the caller parsed, or `undefined` when it read
 * nothing, and decides.
 *
 * **The hash rule is the LOCAL rule (owner decision 2026-10-20, #4120
 * decision 1).** A `PAYMENT-RESPONSE` header's transaction wins when the
 * header carries one; a header WITHOUT a transaction (or an empty header)
 * falls back to the `_meta` settlement's transaction. On the hosted path this
 * is the one intended behaviour change: an `isError` answer carrying a
 * `_meta` settlement is no longer `MERCHANT_REJECTED_AFTER_FUNDING`, and
 * without `isError` the hosted path now carries the `_meta` hash, posts the
 * #3764 second report and gives erc7710 its evidence anchor — the behaviour
 * the local path already had. The backend still verifies every reported hash
 * on-chain before recording it, so this classifies a merchant answer; it
 * does not create an authority.
 *
 * Everything else is behaviour-preserving: the #3118 challenge and
 * `success: false` signals, the #4062 plain-tool-error rule, the receipt
 * re-encoding (`encodeMcpSettlementReceipt`) and its `_meta.<key>` name, and
 * the ordering rule that the receipt is derived before the rejection decision
 * (#4062) all read exactly as their origin copies did.
 */

/** What the caller parsed off the merchant answer — see the module docblock. */
export interface PostFundingMerchantAnswerInput {
  /**
   * The parsed tool result — `mcpToolResultOf(body)` on the hosted path,
   * `readToolResult(response)` (content-type gated) on the local path — or
   * `undefined` when the caller did not read one (local non-2xx / non-JSON
   * answers; the hosted path parses every body).
   */
  toolResult: Record<string, unknown> | undefined
  /** Whether the merchant answered HTTP 2xx. */
  httpOk: boolean
  /** The raw `PAYMENT-RESPONSE` header value, or `undefined` when none was sent. */
  paymentResponseHeader: string | undefined
  /** The `_meta["x402/payment-response"]` settlement (`mcpSettlementFromToolResult`), or `undefined`. */
  metaSettlement: McpX402SettlementMeta | undefined
}

/** The #4120 decision both merchant-completion paths consume. */
export interface PostFundingMerchantAnswer {
  /**
   * The verdict: HTTP-2xx AND no in-band refusal — no payment-required
   * challenge, no `_meta` `success: false`, and not a #4062 plain tool error.
   */
  accepted: boolean
  /**
   * The refusal came from an in-band (HTTP 200) merchant signal rather than
   * the HTTP status. The local path throws `X402_RETRY_REJECTED_STATUS` for
   * an in-band refusal and the merchant's own status otherwise; the hosted
   * path never throws, but keeps the distinction for its evidence ordering.
   */
  inBandRejection: boolean
  /**
   * #4062: an `isError: true` tool result beside NEITHER a payment-required
   * challenge NOR any settlement hash — the merchant neither delivered nor
   * settled, so the funding leg's USDC is stranded on the delegate.
   */
  plainToolErrorAfterFunding: boolean
  /**
   * The LOCAL hash rule (see the module docblock): the header's transaction,
   * falling back to the `_meta` settlement's. `null`/`undefined` when neither
   * form carried a transaction.
   */
  settlementTxHash: string | null | undefined
  /** The receipt payload for the evidence report — the header as sent, or the `_meta` settlement re-encoded. */
  protocolReceiptHeader: string | undefined
  /** Which form the receipt payload came from: the header's name, or the `_meta.<key>` pseudo-name. */
  protocolReceiptHeaderName: string | undefined
}

/**
 * Decide what the merchant's post-funding answer means. Pure: no network, no
 * state — every input is a value the caller already held.
 */
export function decidePostFundingMerchantAnswer(input: PostFundingMerchantAnswerInput): PostFundingMerchantAnswer {
  const inBandChallenge = input.toolResult ? extractMcpPaymentRequired(input.toolResult) : undefined
  const headerReceipt = input.paymentResponseHeader
  // #3155 review S1: the `_meta` settlement is the receipt when there is no
  // header, re-encoded so the one existing decoder reads both forms. An EMPTY
  // header value is falsy and takes the `_meta` name while its raw value
  // still rides the report — the origin copies' exact behaviour, pinned by
  // the #4120 characterization.
  const protocolReceiptHeaderName = headerReceipt
    ? 'PAYMENT-RESPONSE'
    : input.metaSettlement
      ? `_meta.${MCP_X402_PAYMENT_RESPONSE_META_KEY}`
      : undefined
  const protocolReceiptHeader = headerReceipt ?? (input.metaSettlement ? encodeMcpSettlementReceipt(input.metaSettlement) : undefined)
  // #4062: the settlement receipt is read BEFORE the rejection decision — it
  // is what keeps a tool-error answer from being a rejection after funding.
  // #4120 D1: the LOCAL rule — the header's parse, falling back to the `_meta`
  // transaction when the header carried none (or was empty).
  const settlement = parseMerchantSettlement(headerReceipt ?? null)
  const settlementTxHash =
    settlement.settlementTxHash ??
    (typeof input.metaSettlement?.transaction === 'string' ? input.metaSettlement.transaction : undefined)
  // #4062: a PLAIN tool error — `isError: true` with NEITHER a
  // payment-required challenge NOR a settlement receipt — is a refusal. A
  // merchant that answers its paid call with a failed tool result has not
  // delivered, and absent a receipt has not settled either: the funding leg
  // already moved the USDC, so it is stranded on the delegate and must reach
  // the agent as a rejection after funding, never a success. A tool error
  // BESIDE a verified settlement hash is the opposite case: the money moved,
  // so the errored result is delivered as evidence, not refused.
  const plainToolErrorAfterFunding =
    input.toolResult?.isError === true && inBandChallenge === undefined && !settlementTxHash
  const inBandRejection =
    inBandChallenge !== undefined || input.metaSettlement?.success === false || plainToolErrorAfterFunding
  return {
    accepted: input.httpOk && !inBandRejection,
    inBandRejection,
    plainToolErrorAfterFunding,
    settlementTxHash,
    protocolReceiptHeader,
    protocolReceiptHeaderName,
  }
}
