/**
 * #2812 — the PAID-MCP COMPLETION capability of the hosted MCP surface, carved
 * out of `tools.ts` (which stays the compatibility facade `index.ts`,
 * `server.ts`, tests and embedders import).
 *
 * Three tools, one owner:
 *
 *   complete   haven_complete_mcp_tool             (decomposed flow: deliver a signed header)
 *   settle     haven_settle_mcp_tool               (fast flow: fund AND deliver in one call)
 *   report     haven_report_settlement_evidence    (#2972: hand Haven a settlement hash the
 *                                                    agent holds out of band, for the erc7710
 *                                                    settlement classification the two tools
 *                                                    above already use — see
 *                                                    `classifySettlementEvidenceReport`)
 *
 * This is the FINAL capability slice of the #2806 chain. It moves the two
 * handlers AND their merchant delivery / context-rehydration helpers —
 * `resolveMerchantCallContext` (+ the `ResolvedMerchantCallContext` shape),
 * `deliverMerchantPayment` and `preflightMcpPaymentHeader` — out of shared
 * support into this module. Those four were the last single-slice (`s2812`)
 * support exports the #2808 ownership map retained "until #2812 moves them";
 * they now live with the only capability that calls them. The cross-slice
 * helpers they depend on (`parseMcpTransport`, `serializeMcpTransport`,
 * `submitSignatureWithExpiryMapping`, `buildAgentGuidance`,
 * `buildPurchaseSummary`, `isPendingApproval`, `runTool`, `HostedToolError`,
 * `paymentWindowExpiredError`) stay in shared support — they are called from
 * more than one capability slice and are imported from here, never copied.
 *
 * The handler bodies moved VERBATIM: names, schemas (`tools/contracts.ts`),
 * success/failure shapes, request-context behaviour and agent guidance are
 * unchanged, and so are the load-bearing behaviours this slice carries — the
 * #2282 fail-closed ordering (merchant-call context resolved BEFORE any
 * funding relay, on both schemes), the #1456 erc7710 sequence inversion
 * (the signature IS the settlement child, no funding leg, no preflight), the
 * #1508 no-funding-leg flag, the #1307 context rehydration, the #1300
 * verify-then-sweep timeout guidance, and the #1310 rail-aware post-purchase
 * summary.
 *
 * This module NEVER SIGNS: no key material, no signer call site, and no
 * EIP-712/EIP-3009 header construction lives here. The funding signature and
 * the X-PAYMENT header are both signed by the local edge signer — Haven
 * relays them but never holds the key.
 *
 * DEPENDENCY RULE (epic #2806): this module imports the #2807 contract and
 * parsing seams and the #2808 shared support, and NEVER another capability
 * module. The permanent tool-ownership and module-boundary guard that makes
 * that rule executable lives in `tools/module-boundaries.test.ts`.
 */
import { randomUUID } from 'node:crypto'
import { deliveryReferenceError } from '@haven_ai/core'
import {
  AgentPaymentFailureCode,
  AgentPaymentNextAction,
  AgentPaymentWarningCode,
  HavenApiError,
  HavenClient,
  HavenInsecureRetryTargetError,
  MerchantEgressRefusedError,
  MerchantEgressResponseCapError,
  type NextStep,
  MerchantTimeoutError,
  X402PaymentHeaderValidationError,
  isZeroSettlementTxHash,
  validateStandardX402PaymentHeader,
  type EvidenceReportOutcome,
  type X402McpTransport,
} from '@haven_ai/sdk'
import type { HostedToolHandlers, HostedToolName } from './contracts.js'
import { parseStrict } from './parsing.js'
import { HostedToolError, egressRefusalBeforeIntent, paymentWindowExpiredError, runTool } from './support/errors.js'
import {
  buildAgentGuidance,
  buildPurchaseSummary,
  catchSettledResettle,
  type HostedHandoff,
  refusalNextStep,
} from './support/guidance.js'
import {
  parseMcpTransport,
  serializeMcpTransport,
  submitSignatureWithExpiryMapping,
  MERCHANT_OUT_OF_GAS_REASON,
} from './support/mcp-context.js'
import { isPendingApproval } from './support/quote-response.js'

/**
 * #1307: resolve merchant_url/tool_name/arguments/mcp_transport for
 * haven_complete_mcp_tool / haven_settle_mcp_tool. Explicit args are the
 * version-skew fallback and win OUTRIGHT when BOTH merchant_url and
 * tool_name are present — never merged with a rehydrated value, so a partial
 * caller-supplied context can't silently combine with stored state for the
 * same call. Omitting either one rehydrates the FULL stored context by
 * payment_id (the #1263 sign-context precedent, applied to the settle leg).
 */
export interface ResolvedMerchantCallContext {
  merchantUrl: string
  toolName: string
  toolArguments: Record<string, unknown>
  mcpTransport: X402McpTransport | undefined
  /**
   * #3781: the catalog row's name, when the purchase came from a catalog
   * entry — null when the caller supplied the context explicitly (an explicit
   * context has no catalog row) or the stored context carries none (a direct
   * haven_pay_mcp_tool purchase). Display tier of the purchase label only.
   */
  catalogName: string | null
}

/** #3101: after an erc7710 settle whose merchant reported a hash — report it if the agent can, else poll. */
function heldHashHandoff(canReport: boolean, paymentId: string, heldHash: string | null | undefined): HostedHandoff {
  return canReport && heldHash
    ? { nextTool: 'haven_report_settlement_evidence', nextArguments: { payment_id: paymentId, settlement_tx_hash: heldHash } }
    : { nextTool: 'haven_get_payment_status', nextArguments: { payment_id: paymentId } }
}

/**
 * #3764 (D1): the next-step handoff the hosted eip3009 tools derive from
 * `completeX402MerchantCall`'s `settlementEvidenceOutcome` — the same three
 * arms #3727's `evidenceHandoff` gives the plain-HTTP outcome report:
 * recorded (or nothing posted) → no tool; retryable →
 * `haven_report_settlement_evidence` with `payment_id` and the hash
 * prefilled; refused → no tool, because re-reporting the same hash
 * re-refuses. Spread at an emission's top level so `lint:next-steps` reads it
 * as named.
 */
function settlementEvidenceHandoff(
  outcome: EvidenceReportOutcome | undefined,
  paymentId: string,
  settlementTxHash: string | null,
): HostedHandoff {
  if (!outcome || outcome.outcome === 'confirmed') {
    return { nextTool: null, nextToolOmittedReason: 'the purchase is settled; no Haven tool follows' }
  }
  if (outcome.outcome === 'retryable') {
    return {
      nextTool: 'haven_report_settlement_evidence',
      nextArguments: {
        payment_id: paymentId,
        // A retryable answer can only follow a hash that was actually posted —
        // well-formed and non-zero, which `settlement_tx_hash` echoes (zero
        // collapses to null at the delivery boundary, but a zero hash never
        // reaches the wire). The schema keeps the field optional: without it
        // the report call is a defined no-op (#3475 follow-up), never a
        // validation refusal in front of an agent.
        ...(settlementTxHash ? { settlement_tx_hash: settlementTxHash } : {}),
      },
    }
  }
  return {
    nextTool: null,
    nextToolOmittedReason:
      'the merchant settlement hash was refused: it does not match this payment on-chain — do not re-report the same hash',
  }
}

/**
 * #3764 (D1): the reason line that goes WITH `settlementEvidenceHandoff` —
 * the recorded arm keeps the settled-purchase prose the eip3009 arm has said
 * since #1308, the retryable one tells the agent the chain was not readable
 * YET (mirror of #3727's `evidenceReason`), and the refused one says the hash
 * is wrong, not that the purchase failed.
 */
function settlementEvidenceReason(outcome: EvidenceReportOutcome | undefined): string {
  if (!outcome || outcome.outcome === 'confirmed') {
    return (
      'Funding and merchant settlement both succeeded. Report the result to the user ' +
      'from agent_summary.purchase_summary; `result` is optional raw merchant evidence, ' +
      'not Haven payment truth. Merchant-issued credentials in `result` are withheld ' +
      'unless this call passed include_merchant_credentials=true — never echo or log one. ' +
      'The summary includes remaining allowance/budget when available.'
    )
  }
  if (outcome.outcome === 'retryable') {
    return (
      'The purchase is complete and the merchant settlement was reported, but Haven could not ' +
      'verify it on-chain just yet (the chain was unreachable or the transaction is not mined); ' +
      'retry haven_report_settlement_evidence with the same hash.'
    )
  }
  return (
    'The purchase itself is complete — report the result to the user via ' +
    'agent_summary.purchase_summary. The merchant settlement hash was refused: it does not match ' +
    'this payment on-chain — do not re-report the same hash.'
  )
}

/**
 * #3102 review: the eip3009 post-funding rejection reads its action from live
 * state. The tool must follow that action — a sweep named beside
 * `retry_original_x402_request` would race a late settlement. Unknown state
 * (the status read failed) keeps the sweep the message names; a state that
 * says retry or poll hands the agent the status read; any other live action is
 * reported with the reason the sweep is not named. (The payment-state mapper
 * in errors.ts omits the tool for `retry_original_x402_request` because that
 * refusal already holds the payment header and the retry is the agent's own
 * HTTP call; here the header was just refused, so the status read is the
 * step that tells the agent whether a retry is even possible.)
 */
function rejectedAfterFundingStep(liveAction: string | undefined, paymentId: string): NextStep {
  if (liveAction === undefined || liveAction === AgentPaymentNextAction.SweepStrandedFunds) {
    return refusalNextStep({ nextAction: AgentPaymentNextAction.SweepStrandedFunds, nextTool: 'haven_sweep_delegate', nextArguments: {} })
  }
  if (liveAction === AgentPaymentNextAction.RetryOriginalX402Request || liveAction === AgentPaymentNextAction.CheckStatusLater) {
    return refusalNextStep({ nextAction: liveAction, nextTool: 'haven_get_payment_status', nextArguments: { payment_id: paymentId } })
  }
  return refusalNextStep({
    nextAction: liveAction as AgentPaymentNextAction,
    nextTool: null,
    nextToolOmittedReason: `Haven reports next_action ${liveAction} for this payment; the sweep in the message applies only if the delegate still holds the funds`,
  })
}

export async function resolveMerchantCallContext(
  haven: HavenClient,
  args: Record<string, any>,
): Promise<ResolvedMerchantCallContext> {
  const hasUrl = typeof args.merchant_url === 'string'
  const hasTool = typeof args.tool_name === 'string'
  if (hasUrl && hasTool) {
    return {
      merchantUrl: args.merchant_url,
      toolName: args.tool_name,
      toolArguments: (args.arguments as Record<string, unknown> | undefined) ?? {},
      // #3781: an explicitly-threaded context has no catalog row behind it —
      // the <merchant host> <tool_name> label applies.
      catalogName: null,
      // #2282: parse the transport HERE, where the caller can still act on a
      // refusal, rather than deep inside the merchant call after funding.
      mcpTransport: parseMcpTransport(args.mcp_transport),
    }
  }
  // #1307 review: exactly ONE of the pair present is refused, not silently
  // overridden — an agent that supplied merchant_url expects it to be used,
  // and half-explicit input must never be combined with stored state.
  if (hasUrl !== hasTool) {
    throw new HostedToolError({
      code: 'INVALID_INPUT',
      message:
        'merchant_url and tool_name must be supplied TOGETHER (explicit context) or both ' +
        'omitted (rehydrated from payment_id). Passing only one is refused rather than ' +
        'silently overridden by stored state.',
      statusCode: 400,
      paymentId: args.payment_id,
      status: 'invalid_input',
      phase: 'not_started',
      nextStep: refusalNextStep({ nextAction: AgentPaymentNextAction.RetryWithExplicitContext, nextTool: null, nextToolOmittedReason: 're-call the same tool with the explicit context this message names; no tool can be named until you supply it' }),
      rail: 'x402',
    })
  }
  try {
    const ctx = await haven.getX402MerchantCallContext(args.payment_id)
    return {
      merchantUrl: ctx.merchantUrl,
      toolName: ctx.toolName,
      toolArguments: ctx.arguments,
      // #3781: the catalog tier — present only when the purchase came from a
      // catalog entry (the stored context carries it); absent on a direct
      // haven_pay_mcp_tool purchase.
      catalogName: ctx.catalogName ?? null,
      mcpTransport: parseMcpTransport(
        ctx.mcpTransport ? serializeMcpTransport(ctx.mcpTransport) : undefined,
      ),
    }
  } catch (err) {
    if (err instanceof HavenApiError) {
      if (err.statusCode === 410) {
        throw paymentWindowExpiredError({
          paymentId: args.payment_id,
          status: 'expired',
          phase: 'expired',
          rail: 'x402',
        })
      }
      // 404 (unknown/foreign payment_id) and 409 (no stored context, or not
      // an x402 intent) both land here: the fix is the same either way —
      // re-send the fields explicitly.
      throw new HostedToolError({
        code: AgentPaymentFailureCode.MerchantCallContextUnavailable,
        message:
          `merchant_url/tool_name were omitted and Haven could not rehydrate a stored merchant ` +
          `call context for payment ${args.payment_id} (${err.message}). Re-send merchant_url, ` +
          'tool_name, arguments, and mcp_transport explicitly.',
        statusCode: err.statusCode,
        nextStep: refusalNextStep({ nextAction: AgentPaymentNextAction.RetryWithExplicitContext, nextTool: null, nextToolOmittedReason: 're-call the same tool with the explicit context this message names; no tool can be named until you supply it' }),
        paymentId: args.payment_id,
        rail: 'x402',
      })
    }
    throw err
  }
}

/**
 * #3778: refuse a credential-shaped `delivery_reference` BEFORE anything
 * moves — on haven_settle_mcp_tool this runs before the funding relay, on
 * haven_complete_mcp_tool before the merchant call, so a bad value can never
 * reach the row OR spend. Inline here, not support/: each capability calls it
 * once and the canonical shape rules live in `@haven_ai/core`
 * (`deliveryReferenceError`) — this is only the refusal envelope, so a
 * shared wrapper would be an ownership-map entry for two one-line calls.
 */
function assertDeliveryReference(tool: HostedToolName, args: Record<string, any>): void {
  const value = args.delivery_reference
  if (value === undefined) return
  const reason = deliveryReferenceError(String(value))
  if (!reason) return
  throw new HostedToolError({
    code: 'DELIVERY_REFERENCE_REFUSED',
    statusCode: 400,
    paymentId: typeof args.payment_id === 'string' ? args.payment_id : undefined,
    message: `${tool}: ${reason} Nothing was written and no funding was relayed.`,
  })
}

/**
 * #3771: the Haven-derived purchase label for a settle whose merchant result
 * names no product. #3781 added the FIRST tier: the catalog row's name, when
 * the purchase came from a catalog entry (`haven_prepare_catalog_purchase` —
 * Haven's own data, so it is a Haven-derived label, never merchant content
 * #1349). Without one, the label is `<merchant host> <tool_name>` — both
 * halves are facts the settle call already holds — the merchant URL the call
 * context was resolved against, and the tool that was called. A URL that
 * will not parse (or none) falls back to the tool name alone — still
 * Haven-derived, still non-null, so `purchase_summary.product` never reads
 * null purely because the merchant's payload was thin.
 */
function purchaseFallbackLabel(
  merchantUrl: string | undefined,
  toolName: string,
  catalogName: string | null | undefined = null,
): string {
  if (catalogName) return catalogName
  let host: string | null = null
  try {
    host = merchantUrl ? new URL(merchantUrl).host : null
  } catch {
    host = null
  }
  return host ? `${host} ${toolName}` : toolName
}

/**
 * #3768 — redaction of MERCHANT-ISSUED credentials from the agent-facing
 * `result`.
 *
 * A settled merchant tool result is forwarded to the agent's context, which is
 * untrusted (prompt injection, transcripts, logs). Prod QA 2026-10-08 (payment
 * `79084a5e`, Soundside `create_text`) showed a merchant result carrying two
 * bearer credentials bound to the agent's delegate EOA inside
 * `result.structuredContent` — an `x402_session_token` JWT and a `wallet_link`
 * URL with an embedded JWT — reaching that context verbatim. The default is
 * WITHHOLD (issue #3768, option 1): `deliverMerchantPayment` redacts before
 * the result reaches any handler arm, and the settle/complete tools take an
 * explicit `include_merchant_credentials: true` opt-in that returns the
 * merchant body unredacted. This is a design decision, not a blanket strip of
 * merchant sessions: a merchant session (Bitrefill `X-Access-Token`, #3728) is
 * how an agent avoids paying per call, so the opt-in exists — but it is the
 * agent's explicit act, never the default.
 *
 * What counts as a credential, deliberately conservative and mechanical:
 *
 *  1. A JWT-shaped string (three base64url segments joined by dots) — redacted
 *     by SHAPE, whatever the key is named, including as a substring of a
 *     longer string (a `wallet_link` URL keeps its shape, loses its token).
 *  2. A string value under a credential-NAMED key — `*_token`, `*_link`,
 *     `access_token`, `session` fields (the issue's enumeration), plus the
 *     other bearer spellings (`secret`, `password`, `api_key`,
 *     `authorization`, `bearer`, `credential`) — withheld whole, because an
 *     opaque token a merchant mints is exactly the thing a JWT scan can miss.
 *
 * What is NEVER touched: money fields, `settled`/`delivered` markers,
 * transaction hashes, URLs without embedded JWTs — anything that is not a
 * string under a credential-named key or JWT-shaped. The same recognizer
 * redacts the bounded `JSON.stringify` of the merchant body that the
 * MERCHANT_REJECTED_AFTER_FUNDING refusals echo, so a credential cannot
 * escape through an error message instead of the result.
 */

/** The replacement for a whole withheld credential value. */
export const MERCHANT_CREDENTIAL_WITHHELD = '[merchant credential withheld by Haven]'
/** The replacement for a JWT-shaped segment found inside a longer string. */
export const MERCHANT_JWT_REDACTED = '[merchant JWT redacted]'

/** One base64url JWT segment. 16+ chars keeps real-world non-JWTs (ids, versions) out. */
const JWT_SEGMENT = '[A-Za-z0-9_-]{16,}'
const IS_JWT = new RegExp(`^${JWT_SEGMENT}\\.${JWT_SEGMENT}\\.${JWT_SEGMENT}$`)
const JWT_IN_STRING = new RegExp(`${JWT_SEGMENT}\\.${JWT_SEGMENT}\\.${JWT_SEGMENT}`, 'g')

/**
 * Credential-named keys, matched case-insensitively on a snake_case
 * normalization (so camelCase `sessionToken` reads `session_token` too).
 * `token` requires the exact or underscore form (a bare `token` IS matched,
 * `sort_token`-style keys are too); `link` requires the `_link` suffix — a
 * bare `link` is NOT a credential (a product link is not); `session` matches
 * the issue's "session fields" enumeration.
 */
const CREDENTIAL_KEY = new RegExp(
  [
    '(^|_)(access_?token|refresh_?token|id_?token|session_?token|api_?key|apikey|secret|password|credential|authorization|bearer)(_|$)',
    '(^|_)token$',
    '_link$',
    '(^|_)session(_|$)',
  ].join('|'),
  'i',
)

function isCredentialKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  return CREDENTIAL_KEY.test(normalized)
}

/** Maximum traversal depth — merchant bodies arrive via JSON.parse (acyclic); this is belt-and-braces. */
const REDACTION_MAX_DEPTH = 24

/**
 * Redact merchant-issued credentials from a parsed merchant response body,
 * returning a new structure (inputs are never mutated). JSON primitives pass
 * through untouched; only credential-shaped strings change. When NOTHING in
 * the body redacts, the input is returned by reference — a clean merchant
 * body is forwarded exactly as the #1310 pass-through contract pins it, and
 * only a body that actually carries a credential is rewritten.
 */
export function redactMerchantCredentials(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactCredentialString('', value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= REDACTION_MAX_DEPTH) return value
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const redacted = redactMerchantCredentials(item, depth + 1)
      if (redacted !== item) changed = true
      return redacted
    })
    return changed ? out : value
  }
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const redacted =
      typeof item === 'string' ? redactCredentialString(key, item) : redactMerchantCredentials(item, depth + 1)
    if (redacted !== item) changed = true
    out[key] = redacted
  }
  return changed ? out : value
}

function redactCredentialString(key: string, value: string): string {
  if (IS_JWT.test(value)) return MERCHANT_CREDENTIAL_WITHHELD
  if (key !== '' && isCredentialKey(key)) {
    if (value.length === 0) return value
    return MERCHANT_CREDENTIAL_WITHHELD
  }
  if (JWT_IN_STRING.test(value)) {
    return value.replace(JWT_IN_STRING, MERCHANT_JWT_REDACTED)
  }
  return value
}

/**
 * Deliver the signed X-PAYMENT header to the merchant and shape the result.
 * Shared by haven_complete_mcp_tool (decomposed flow) and haven_settle_mcp_tool
 * (fast flow). Funding has already confirmed before this runs, so a non-2xx
 * merchant response means the delegate holds stranded funds — surface a typed
 * MERCHANT_REJECTED_AFTER_FUNDING (not a soft ok:false) so the agent reconciles
 * via haven_sweep_delegate. The X-PAYMENT header is a signed authorization the
 * edge signer produced — Haven relays it but never holds the key.
 */
/**
 * #2983: the merchant may refuse the paid retry with its OWN
 * `merchant_not_ready` capacity signal (same shape `merchantNotReadyErrorFor`
 * in `support/mcp-context.ts` reads on the quote path) rather than a generic
 * rejection. Best-effort: any other shape (or a non-JSON body) yields `null`,
 * and the caller falls back to the generic refusal message.
 */
function merchantNotReadyBodyFor(
  body: unknown,
): { reasonCode?: string; retryAfterS?: number; settlementsRemaining?: number; failFloor?: number } | null {
  if (!body || typeof body !== 'object' || (body as Record<string, unknown>).error !== 'merchant_not_ready') {
    return null
  }
  const { reason_code, retry_after_s, settlements_remaining, fail_floor } = body as Record<string, unknown>
  return {
    reasonCode: typeof reason_code === 'string' ? reason_code : undefined,
    retryAfterS: typeof retry_after_s === 'number' ? retry_after_s : undefined,
    settlementsRemaining: typeof settlements_remaining === 'number' ? settlements_remaining : undefined,
    failFloor: typeof fail_floor === 'number' ? fail_floor : undefined,
  }
}

export async function deliverMerchantPayment(
  haven: HavenClient,
  // Parsed haven_complete_mcp_tool / haven_settle_mcp_tool args (Zod-validated).
  args: Record<string, any>,
  // Funding tx hash from haven_submit when known (settle path); the wait falls
  // back to the payment status when omitted (complete path).
  fundingTxHash?: string,
  // #1508: a scheme with NO funding leg (erc7710) must skip the funding wait
  // ENTIRELY. Omitting fundingTxHash above does NOT achieve that — see below.
  options?: { noFundingLeg?: boolean; context?: ResolvedMerchantCallContext },
): Promise<{
  status: number
  ok: boolean
  result: unknown
  settlement_tx_hash: string | null
  /** #2970: what `haven.completeX402MerchantCall`'s evidence report learned, when it made one. */
  evidence_outcome?: EvidenceReportOutcome
  /**
   * #3764: what the SECOND evidence report — the merchant's own EIP-3009
   * settlement, posted after the funding report — learned, when one was made.
   * `undefined` when nothing was posted (no funding leg, no merchant hash, a
   * malformed/zero/equal-to-funding hash).
   */
  settlement_evidence_outcome?: EvidenceReportOutcome
}>{
  // #1307: resolve merchant_url/tool_name/arguments/mcp_transport BEFORE
  // waiting on funding confirmation — a version-skew refusal (no stored
  // context) should surface immediately, not after a pointless wait.
  //
  // #2282: on the settle fast path that is no longer early enough — funding is
  // already relayed by the time this runs — so `haven_settle_mcp_tool` resolves
  // the context itself, pre-funding, and hands the result in. Resolving once
  // and passing it through also keeps the two calls from diverging (the stored
  // context could change, and a second GET is a second chance to disagree).
  // (#3778: the delivery reference is refused in the HANDLERS, which know
  // their own tool name and run before any submit — never here.)
  const context = options?.context ?? (await resolveMerchantCallContext(haven, args))

  // Wait for ≥1 on-chain confirmation of the funding tx BEFORE the merchant
  // verifies the X-PAYMENT header — otherwise its balanceOf(delegate) check
  // races the not-yet-mined funding tx and returns "Payment verification
  // failed". No-op if BASE_RPC_URL isn't configured (chainRpcs unset).
  //
  // #1508: on a no-funding-leg scheme this must not run AT ALL, and passing
  // `undefined` for fundingTxHash is not the same thing — the bug this fixes.
  // `ensureFundingConfirmed` reads GET /payments/:id UNCONDITIONALLY before it
  // ever looks at the hash, and by this point an erc7710 settle has already
  // flipped the intent to 'submitted', which the backend maps to HTTP 409
  // (`agentPaymentStatusHttpCode`). The SDK turns that into a throw, so a
  // payment whose settlement SUCCEEDED was reported to the agent as a failure —
  // deterministically, on every hosted erc7710 call, with the merchant never
  // contacted.
  if (!options?.noFundingLeg) {
    await haven.ensureFundingConfirmed(args.payment_id, fundingTxHash)
  }

  const envelope = {
    jsonrpc: '2.0',
    id: `haven-mcp-${randomUUID()}`,
    method: 'tools/call',
    params: { name: context.toolName, arguments: context.toolArguments },
  }
  let result: Awaited<ReturnType<HavenClient['completeX402MerchantCall']>>
  try {
    result = await haven.completeX402MerchantCall({
      url: context.merchantUrl,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
      },
      paymentId: args.payment_id,
      paymentHeader: args.payment_header,
      mcpTransport: context.mcpTransport,
      // #3778: the validated non-secret delivery pointer — recorded on the
      // evidence row when the merchant accepted, so the owner's receipt and
      // dashboard show a deliverable exists.
      ...(args.delivery_reference
        ? { deliveryReference: args.delivery_reference }
        : {}),
      // #1508: the same flag that skips the funding wait above also has to
      // reach the SDK's completion gate, which is where the real refusal was.
      noFundingLeg: options?.noFundingLeg === true,
    })
  } catch (err) {
    // #1300 review finding: at this point funding is CONFIRMED on-chain, so a
    // merchant that never answers leaves the same money-at-risk state as one
    // that rejects — but a timeout is NOT proof of rejection: the merchant
    // holds a valid EIP-3009 authorization and may settle late. Route it to
    // its own guidance (verify-then-sweep), never the bare 504 and never a
    // blind sweep that could race a late settlement.
    if (err instanceof MerchantTimeoutError) {
      // #3000: same scheme split as #2983's rejection branch, applied to the
      // timeout branch — erc7710 has no funding leg, so there is never a
      // delegate balance to strand or sweep here either. `next_action:
      // check_status_later` is honest on BOTH schemes (the merchant may still
      // settle late), but eip3009 additionally has a real stranded-funds risk
      // the sweep guidance below describes; erc7710 does not, so that
      // guidance is dropped rather than branched around, mirroring the
      // rejection message's "ignore this code's sweep guidance" framing.
      if (options?.noFundingLeg) {
        throw new HostedToolError({
          code: AgentPaymentFailureCode.MerchantUnresponsiveAfterFunding,
          message:
            `The settlement authorization was submitted, but the merchant did not answer the ` +
            `paid retry before the timeout. erc7710 has no funding leg, so there is no delegate ` +
            `balance to sweep — ignore this code's sweep guidance. The merchant held a single-use ` +
            `settlement authorization valid for up to the payment window (typically 300s) and may ` +
            `still redeem it: do NOT retry haven_complete_mcp_tool (it has no erc7710 branch and ` +
            `refuses a submitted intent). Check haven_get_payment_status after that window and ` +
            `re-quote only if it shows no settlement. ${err.message}`,
          statusCode: 504,
          paymentId: args.payment_id,
          status: 'merchant_unresponsive_after_funding',
          // #3011 review: nothing was funded on erc7710 — same phase the
          // erc7710 rejection branch uses.
          phase: 'not_delivered',
          nextStep: refusalNextStep({ nextAction: AgentPaymentNextAction.CheckStatusLater, nextTool: 'haven_get_payment_status', nextArguments: { payment_id: args.payment_id } }),
          rail: 'erc7710',
          suggestedTool: 'haven_get_payment_status',
        })
      }
      throw new HostedToolError({
        code: AgentPaymentFailureCode.MerchantUnresponsiveAfterFunding,
        message:
          `The funding leg is confirmed on-chain, but the merchant did not answer the paid ` +
          `retry before the timeout. The merchant may still settle late. Check ` +
          `haven_get_payment_status and retry haven_complete_mcp_tool ONCE before considering ` +
          `a sweep — sweep only if no settlement appears. ${err.message}`,
        statusCode: 504,
        paymentId: args.payment_id,
        status: 'merchant_unresponsive_after_funding',
        phase: 'funded_but_unsettled',
        // #3102: the first concrete step is the status read the message asks for; the sweep follows it.
        nextStep: refusalNextStep({ nextAction: AgentPaymentNextAction.SweepStrandedFunds, nextTool: 'haven_get_payment_status', nextArguments: { payment_id: args.payment_id } }),
        rail: 'x402',
        suggestedTool: 'haven_get_payment_status',
      })
    }
    // #3747: an egress-policy refusal during PAID delivery. Two distinct
    // states, both carrying the payment id because funding is already
    // confirmed (or erc7710 has no funding leg at all):
    //  - BEFORE any request was sent (a pre-send URL refusal): the merchant
    //    was NOT called — mirror the HavenInsecureRetryTargetError branch.
    //  - MID-FLIGHT (a redirect on the paid POST, a refused redirect hop, or
    //    the response cap crossed while reading): the paid request itself was
    //    already sent and the header MAY have been delivered — this is the
    //    #1300 verify-then-sweep state, routed to the status read FIRST,
    //    NEVER a blind sweep. On erc7710 there is no funding leg, so the
    //    existing no-sweep handling applies: check status later, ignore any
    //    sweep guidance.
    if (err instanceof MerchantEgressRefusedError || err instanceof MerchantEgressResponseCapError) {
      const midFlight = !(err instanceof MerchantEgressRefusedError) || !err.beforeRequest
      const detail = err.message
      if (midFlight && options?.noFundingLeg) {
        throw new HostedToolError({
          code: 'MERCHANT_EGRESS_REFUSED',
          message:
            `The erc7710 paid retry was interrupted by the hosted egress policy after the request was sent: ` +
            `${detail} erc7710 has no funding leg, so there is no delegate balance to strand or sweep — ` +
            `ignore this code's sweep guidance. The merchant may still redeem the settlement authorization ` +
            `within its window: check haven_get_payment_status after that window and re-quote only if it ` +
            `shows no settlement.`,
          statusCode: 400,
          paymentId: args.payment_id,
          status: 'merchant_unresponsive_after_funding',
          phase: 'not_delivered',
          nextStep: refusalNextStep({ nextAction: AgentPaymentNextAction.CheckStatusLater, nextTool: 'haven_get_payment_status', nextArguments: { payment_id: args.payment_id } }),
          rail: 'erc7710',
          suggestedTool: 'haven_get_payment_status',
        })
      }
      if (midFlight) {
        throw new HostedToolError({
          code: 'MERCHANT_EGRESS_REFUSED',
          message:
            `The paid retry was interrupted by the hosted egress policy after the request was sent: ` +
            `${detail} The funding leg is confirmed on-chain and the merchant's answer never arrived ` +
            `complete: the merchant may still settle late. Check haven_get_payment_status and retry ` +
            `haven_complete_mcp_tool ONCE before considering a sweep — sweep only if no settlement appears.`,
          statusCode: 400,
          paymentId: args.payment_id,
          status: 'merchant_unresponsive_after_funding',
          phase: 'funded_but_unsettled',
          nextStep: refusalNextStep({ nextAction: AgentPaymentNextAction.SweepStrandedFunds, nextTool: 'haven_get_payment_status', nextArguments: { payment_id: args.payment_id } }),
          rail: 'x402',
          suggestedTool: 'haven_get_payment_status',
        })
      }
      // Pre-send: the merchant was never called.
      throw new HostedToolError({
        code: 'MERCHANT_EGRESS_REFUSED',
        message: options?.noFundingLeg
          ? `${err.message} No merchant call was made and erc7710 has no funding leg, so nothing ` +
            `moved; re-quote the merchant at its public https URL.`
          : `${err.message} The funding leg is already confirmed on-chain and the merchant was NOT ` +
            `called: retry haven_complete_mcp_tool with the merchant's public https URL as merchant_url, ` +
            `or recover the delegate balance with haven_sweep_delegate.`,
        statusCode: 400,
        paymentId: args.payment_id,
        phase: options?.noFundingLeg ? 'not_delivered' : 'funded_but_unsettled',
        nextStep: options?.noFundingLeg
          ? refusalNextStep({
              nextAction: AgentPaymentNextAction.RetryWithExplicitContext,
              nextTool: null,
              nextToolOmittedReason: 're-quote the merchant at its public https URL; nothing moved',
            })
          : refusalNextStep({
              nextAction: AgentPaymentNextAction.SweepStrandedFunds,
              nextTool: 'haven_sweep_delegate',
              nextArguments: {},
            }),
        rail: options?.noFundingLeg ? 'erc7710' : 'x402',
        suggestedTool: options?.noFundingLeg ? 'haven_quote_mcp_tool' : 'haven_get_payment_status',
      })
    }
    // #3097: the SDK refuses to hand a payment header to a public http://
    // merchant at the deliverPayment seam. quoteMcpToolCall refuses the same
    // URL before any intent, so this fires only for a merchant_url that
    // reached this tool without a quote (the explicit four-argument fallback)
    // — and by now funding is CONFIRMED, so it must not escape as a bare 400
    // with no payment_id and no sweep guidance (haven-reviewer on #3112).
    if (err instanceof HavenInsecureRetryTargetError) {
      throw new HostedToolError({
        code: err.code,
        message: options?.noFundingLeg
          ? `${err.message} No merchant call was made and erc7710 has no funding leg, so nothing ` +
            `moved; re-quote the merchant at its https URL.`
          : `${err.message} The funding leg is already confirmed on-chain and the merchant was NOT ` +
            `called: retry haven_complete_mcp_tool with the merchant's https URL as merchant_url, ` +
            `or recover the delegate balance with haven_sweep_delegate.`,
        statusCode: 400,
        paymentId: args.payment_id,
        phase: options?.noFundingLeg ? 'not_delivered' : 'funded_but_unsettled',
        nextStep: options?.noFundingLeg
          ? refusalNextStep({
              nextAction: AgentPaymentNextAction.RetryWithExplicitContext,
              nextTool: null,
              nextToolOmittedReason: 're-quote the merchant at its https URL; nothing moved',
            })
          : refusalNextStep({
              nextAction: AgentPaymentNextAction.SweepStrandedFunds,
              nextTool: 'haven_sweep_delegate',
              nextArguments: {},
            }),
        rail: options?.noFundingLeg ? 'erc7710' : 'x402',
        suggestedTool: options?.noFundingLeg ? 'haven_quote_mcp_tool' : 'haven_get_payment_status',
      })
    }
    throw err
  }
  if (!result.ok) {
    // #3118 / #3155 review S5: a native-profile merchant refuses IN-BAND under
    // HTTP 2xx (an `isError` payment-required result or `success: false`).
    // The SDK reports `ok: false` with the real status; the refusal thrown
    // here carries 402 (what the merchant said in-band — the same mapping the
    // local retry uses) so no failure object rides an HTTP-200 status, and
    // the message names both.
    const inBandRefusal = result.status >= 200 && result.status < 300
    const merchantStatus = inBandRefusal ? 402 : result.status
    const merchantHttp = inBandRefusal ? `HTTP ${result.status}, refused in-band` : `HTTP ${result.status}`
    let status: Awaited<ReturnType<HavenClient['getPaymentStatus']>> | null = null
    try {
      status = await haven.getPaymentStatus(args.payment_id)
    } catch {
      // Preserve the merchant rejection even if status lookup is unavailable.
    }
    // #2983: `noFundingLeg` (set true ONLY on the erc7710 call sites, above)
    // is the same scheme signal `ensureFundingConfirmed`'s gate reads — reuse
    // it rather than re-deriving "which scheme is this" a second way.
    if (options?.noFundingLeg) {
      // On erc7710 the signature IS the settlement child (#1456): there is no
      // funding leg, so a merchant refusal at this point strands no delegate
      // balance — nothing to sweep. The eip3009
      // guidance below is false here and would tell the agent to "reconcile"
      // a balance that was never created. Say what is true instead.
      // #2987 review: the categorical "nothing moved, re-quote" is only
      // safe when the merchant SAID it did not attempt settlement — the
      // `merchant_not_ready` body. On any other non-2xx the merchant still
      // holds a single-use settlement authorization valid for the window
      // (`maxTimeoutSeconds`, default 300 s) and may have redeemed it before
      // answering (an upstream 502/504 lands here as a response, not a
      // timeout) — telling the agent to re-quote NOW could pay twice. So a
      // generic refusal is verify-then-act, the same discipline
      // MERCHANT_UNRESPONSIVE_AFTER_FUNDING uses; in neither case is there a
      // delegate balance to sweep, and the skill's code-keyed
      // "stop-and-sweep" advice is overridden explicitly in the message.
      const notReady = merchantNotReadyBodyFor(result.body)
      const message = notReady
        ? `Merchant refused to deliver the resource (${merchantHttp}) and reported it ` +
          `cannot settle right now` +
          (notReady.reasonCode ? ` (reason_code: ${notReady.reasonCode})` : '') +
          `. erc7710 has no funding leg and the merchant did not attempt settlement, so no ` +
          `funds moved — the agent's budget is intact. Ignore this code's sweep guidance: there ` +
          `is no delegate balance to sweep. ` +
          // #3834: out of gas does not recover by waiting — name the
          // operator top-up and the floor instead of a retry interval.
          (notReady.reasonCode === MERCHANT_OUT_OF_GAS_REASON
            ? `Its settlement wallet is out of gas` +
              (notReady.settlementsRemaining !== undefined && notReady.failFloor !== undefined
                ? ` (settlements_remaining: ${notReady.settlementsRemaining}, fail_floor: ${notReady.failFloor})`
                : '') +
              `: the merchant's operator must top it up, and until then every retry is refused again. ` +
              `Re-quote once the merchant has been topped up`
            : `Re-quote` +
              (notReady.retryAfterS ? ` after approximately ${notReady.retryAfterS}s` : ' later')) +
          `. Merchant response: ${JSON.stringify(redactMerchantCredentials(result.body)).slice(0, 500)}`
        : `Merchant refused to deliver the resource (${merchantHttp}). erc7710 has no ` +
          `funding leg, so there is no delegate balance to sweep — ignore this code's sweep ` +
          `guidance. Haven has NOT observed a settlement, but the merchant held a single-use ` +
          `settlement authorization valid for up to the payment window (typically 300s) and ` +
          `may have redeemed it before answering: check haven_get_payment_status after that ` +
          `window and re-quote only if it shows no settlement. ` +
          `Merchant response: ${JSON.stringify(redactMerchantCredentials(result.body)).slice(0, 500)}`
      throw new HostedToolError({
        code: AgentPaymentFailureCode.MerchantRejectedAfterFunding,
        message,
        statusCode: merchantStatus,
        paymentId: args.payment_id,
        status: status?.status ?? 'merchant_rejected_after_funding',
        phase: status?.phase ?? 'not_delivered',
        nextStep: notReady
          ? refusalNextStep({
              nextAction: AgentPaymentNextAction.StopAndTellUser,
              nextTool: null,
              nextToolOmittedReason: 'the merchant is not ready to settle; tell the user and re-quote later',
            })
          : refusalNextStep({
              nextAction: AgentPaymentNextAction.CheckStatusLater,
              nextTool: 'haven_get_payment_status',
              nextArguments: { payment_id: args.payment_id },
            }),
        ...(notReady ? {} : { suggestedTool: 'haven_get_payment_status' }),
        rail: status?.rail ?? 'erc7710',
        idempotencyKey: status?.idempotencyKey,
        retryWithNewQuote: true,
      })
    }
    throw new HostedToolError({
      code: AgentPaymentFailureCode.MerchantRejectedAfterFunding,
      message:
        `Merchant rejected the payment after funding (${merchantHttp}). ` +
        `The delegate wallet may hold stranded funds — reconcile with haven_sweep_delegate. ` +
        `Merchant response: ${JSON.stringify(redactMerchantCredentials(result.body)).slice(0, 500)}`,
      statusCode: merchantStatus,
      paymentId: args.payment_id,
      status: status?.status ?? 'merchant_rejected_after_funding',
      phase: status?.phase ?? 'funded_but_unsettled',
      // #3102 review: the action is read from live state, so the tool must
      // follow it — a sweep named beside `retry_original_x402_request` would
      // race a late settlement. Sweep only when the state says sweep; any
      // other state hands the agent the status read the state came from.
      nextStep: rejectedAfterFundingStep(status?.nextAction, args.payment_id),
      rail: status?.rail ?? 'x402',
      idempotencyKey: status?.idempotencyKey,
      suggestedTool: 'haven_sweep_delegate',
    })
  }
  return {
    status: result.status,
    ok: result.ok,
    // #3768: the agent-facing `result` carries merchant-issued credentials
    // REDACTED unless the caller explicitly opted in
    // (`include_merchant_credentials: true` on the settle/complete tool
    // arguments — the flag rides `args` and both handler call sites forward
    // it). Money fields, `settled`/`delivered` and hashes are untouched; the
    // recognizer only rewrites credential-shaped strings. The refusal paths
    // below redact unconditionally — an error echo never delivers a
    // credential the caller paid nothing to receive.
    result:
      args?.include_merchant_credentials === true ? result.body : redactMerchantCredentials(result.body),
    // #2968: the response-level zero-hash ban. `settlementTxHash` here is the
    // MERCHANT's word (the PAYMENT-RESPONSE header, or since #3118 the native
    // MCP profile's `result._meta["x402/payment-response"]`), and the demo merchant's
    // own "delivered, not settled" marker is `0x00…00` — a value shaped like a
    // hash gets rendered like one by every consumer downstream, so a sentinel
    // is collapsed to null at this boundary instead of being handed out as a
    // transaction. `null` says "no transaction known"; the settlement gate
    // (`classifyErc7710Settlement`) already refuses to treat null as proof.
    // Same recognizer #2970 landed in the SDK (`isZeroSettlementTxHash`), so
    // every surface that touches this value accepts and refuses the same set.
    settlement_tx_hash:
      result.settlementTxHash != null && !isZeroSettlementTxHash(result.settlementTxHash)
        ? result.settlementTxHash
        : null,
    evidence_outcome: result.evidenceOutcome,
    settlement_evidence_outcome: result.settlementEvidenceOutcome,
  }
}

/**
 * #2970: what "settled" means for the erc7710 branch — an on-chain transfer
 * Haven verified, never the merchant's bare HTTP 200. Three outcomes:
 *
 *  - `settled`: the backend confirmed the reported hash (`evidenceOutcome:
 *    { outcome: 'confirmed' }`, from the SAME `reportEvidence` call the 3009
 *    branch makes — see `HavenClient.completeX402MerchantCall`).
 *  - `delivered_unsettled`: the merchant returned no hash, a zero hash, or the
 *    backend refused it as unverifiable (409 `settlement_unverified`, or any
 *    other terminal refusal). Nothing will resolve this by waiting; the
 *    remedy is reporting a real hash.
 *  - `settlement_pending`: the backend could not yet tell (503
 *    `settlement_unobservable`, exhausted its own retry budget) — the chain
 *    was unreachable or the transaction is not mined yet. This one IS worth
 *    asking about again.
 *
 * A zero/missing hash is decided HERE, before trusting `evidenceOutcome` at
 * all: `completeX402MerchantCall` already treats a zero hash as "no hash to
 * report" (`isZeroSettlementTxHash`) and skips the report entirely, so
 * `evidenceOutcome` is `undefined` in that case — indistinguishable, from
 * this function's INPUT alone, from "there was nothing to report for some
 * other reason". Checking the hash directly makes the zero-hash case
 * unconditional rather than depending on that implementation detail staying
 * true.
 */
export function classifyErc7710Settlement(
  settlementTxHash: string | null,
  evidenceOutcome: EvidenceReportOutcome | undefined,
): { outcome: 'settled' } | { outcome: 'delivered_unsettled' } | { outcome: 'settlement_pending' } {
  if (!settlementTxHash || isZeroSettlementTxHash(settlementTxHash)) {
    return { outcome: 'delivered_unsettled' }
  }
  if (evidenceOutcome?.outcome === 'confirmed') return { outcome: 'settled' }
  if (evidenceOutcome?.outcome === 'retryable') return { outcome: 'settlement_pending' }
  // `refused`, or no report was ever made for a hash that IS present and
  // non-zero (should not happen — `completeX402MerchantCall` reports whenever
  // it has a real hash — but fail to the honest answer, not the confident one).
  return { outcome: 'delivered_unsettled' }
}

/**
 * #2972: builds THREE of the `haven_report_settlement_evidence` tool's four
 * possible response shapes — the SAME three outcomes `classifyErc7710Settlement`
 * classifies for the settle/complete gate, built directly from
 * `MerchantCompletion.reportEvidence`'s `EvidenceReportOutcome` rather than
 * derived from a merchant HTTP call (there is none here — the agent is
 * handing Haven a hash it already holds). The fourth shape — no
 * `settlement_tx_hash` supplied at all — is a SUCCESS no-op the handler
 * returns directly, before this function is ever called (#3475 follow-up,
 * the `if (!args.settlement_tx_hash)` branch below).
 *
 * `confirmed` -> settled: true. `retryable` -> SETTLEMENT_PENDING (the chain
 * could not be read yet, or the transaction is not mined — worth reporting
 * again). Everything else (`refused`, at any status code — a 409 mismatch, a
 * 404 for a payment this agent does not own, a validation error) ->
 * DELIVERED_UNSETTLED: a settled no, never a write. `next_tool` is always
 * `haven_get_payment_status` on the two unsettled branches, exactly as the
 * settle/complete gate points there — this tool does not retry itself.
 *
 * #3529: a refusal that carries the backend's relayed `reason` is its OWN
 * arm, keyed on the REASON's presence — never on payment status (on eip3009
 * "confirmed" means the FUNDING leg, so a status-keyed code would also fire
 * on ordinary, correct refusals of mismatched hashes). The backend puts a
 * reason in the evidence 409/503 body only on the eip3009 settlement-report
 * refusal (`SettlementReportRefusal`), which fires on a payment whose
 * funding is already confirmed — so this arm says exactly what Haven knows:
 * the funding leg is confirmed and unchanged, and THIS hash was not accepted
 * for it. New code `SETTLEMENT_NOT_RECORDED` (it is not "delivered,
 * unsettled" — the payment's funding is verified; what failed is the
 * settlement attribution) with the backend's sentence relayed verbatim as
 * `refusal_reason`. A reasonless refusal keeps `DELIVERED_UNSETTLED` and the
 * honest-for-every-case wording: that arm can still be reached by a real
 * mismatch, a foreign payment id, a validation refusal, or an older backend
 * that never relays a reason, and none of those may claim the funding is
 * confirmed.
 */
export function classifySettlementEvidenceReport(
  paymentId: string,
  settlementTxHash: string,
  outcome: EvidenceReportOutcome,
  // #2973 review: the payment's status as Haven READ it after the refusal —
  // a 409 may sit on an already-confirmed intent with a different hash, so
  // the summary must not assert `submitted`. `null` when the read itself
  // failed (a foreign payment 404s here too).
  observedStatus: string | null = null,
): Record<string, unknown> {
  if (outcome.outcome === 'confirmed') {
    return {
      payment_id: paymentId,
      settled: true,
      settlement_tx_hash: settlementTxHash,
      ...buildAgentGuidance({
        nextAction: AgentPaymentNextAction.None,
        // #3101 (decision 3): a done state names no tool and says so.
        nextTool: null,
        nextToolOmittedReason: 'the purchase is settled; no Haven tool follows',
        safeToContinue: true,
        reason:
          'Haven verified this settlement transaction on-chain against the payment and ' +
          'recorded it — the payment now has verified settlement evidence.',
        summary: { payment_id: paymentId, status: 'settled' },
      }),
    }
  }
  // #3529: the reason-bearing refusal. The reason is the backend's own
  // sentence, relayed verbatim — the tool never paraphrases it into a verdict
  // it cannot check (whether the hash was genuinely wrong, or the connected
  // backend predates the relay, is exactly what the agent must decide by
  // polling status, which is why next_tool is unchanged).
  if (outcome.outcome === 'refused' && outcome.reason) {
    return {
      payment_id: paymentId,
      settled: false,
      code: 'SETTLEMENT_NOT_RECORDED',
      refusal_reason: outcome.reason,
      settlement_tx_hash: settlementTxHash,
      ...buildAgentGuidance({
        nextAction: AgentPaymentNextAction.CheckStatusLater,
        nextTool: 'haven_get_payment_status',
        nextArguments: { payment_id: paymentId },
        safeToContinue: true,
        reason:
          // The relayed reasons never end with punctuation (the verifier's
          // sentences are period-free), so the period here is always single.
          'Haven refused this settlement report: ' + outcome.reason + '. The payment itself is ' +
          'unchanged — its funding leg is confirmed, and this transaction was not accepted as ' +
          "its settlement. Reporting the same hash again will not change that; poll next_tool for " +
          "the payment's current state.",
        summary: { payment_id: paymentId, status: observedStatus ?? 'unknown' },
      }),
    }
  }
  const pending = outcome.outcome === 'retryable'
  return {
    payment_id: paymentId,
    settled: false,
    code: pending ? 'SETTLEMENT_PENDING' : 'DELIVERED_UNSETTLED',
    ...(pending ? { retryable: true } : {}),
    settlement_tx_hash: settlementTxHash,
    ...buildAgentGuidance({
      nextAction: AgentPaymentNextAction.CheckStatusLater,
      nextTool: 'haven_get_payment_status',
      nextArguments: { payment_id: paymentId },
      safeToContinue: true,
      reason: pending
        ? 'Haven could not yet verify this transaction on-chain — the RPC was unreachable, or ' +
          'the transaction is not mined yet. Report the same hash again shortly, or poll next_tool.'
        : 'Haven did not record this settlement hash for this payment. Either the transaction does ' +
          'not match this payment on-chain, or the payment could not be found for this agent, or ' +
          'the connected backend does not yet take this kind of settlement report. Reporting it ' +
          'again will not change that; poll next_tool for the current status.',
      summary: { payment_id: paymentId, status: observedStatus ?? 'unknown' },
    }),
  }
}

/**
 * Hosted fast-path preflight (#1398). The status read is agent-scoped and
 * exposes the intent's captured delegate, unlike getAgent() which may have
 * changed after the intent was created. Never include an untrusted header in a
 * thrown error: MCP error payloads and observability consumers serialize it.
 */
export async function preflightMcpPaymentHeader(haven: HavenClient, args: Record<string, any>): Promise<void> {
  const status = await haven.getPaymentStatus(args.payment_id)
  try {
    if (
      status.rail !== 'x402' ||
      !status.merchantAddress ||
      !status.amountAtomic ||
      !status.asset ||
      !status.network ||
      !status.resourceUrl ||
      !status.payerAddress
    ) {
      throw new X402PaymentHeaderValidationError()
    }
    await validateStandardX402PaymentHeader(args.payment_header, {
      merchantTo: status.merchantAddress,
      amountAtomic: status.amountAtomic,
      asset: status.asset,
      network: status.network,
      resourceUrl: status.resourceUrl,
      payer: status.payerAddress,
      chainId: status.chainId,
    })
  } catch (err) {
    if (!(err instanceof X402PaymentHeaderValidationError)) throw err
    throw new HostedToolError({
      code: 'INVALID_PAYMENT_HEADER',
      message:
        'The signed payment header did not match the funded x402 intent. No funding was relayed. ' +
        'Recreate the header with the local signer from this payment_id, then retry.',
      statusCode: 400,
      paymentId: args.payment_id,
      status: 'invalid_payment_header',
      phase: 'not_started',
      nextStep: refusalNextStep({ nextAction: AgentPaymentNextAction.StopAndTellUser, nextTool: null, nextToolOmittedReason: 'the user has to decide before anything is called again; suggested_tool names the tool for after that' }),
      rail: 'x402',
      suggestedTool: 'haven_sign_x402',
    })
  }
}

/**
 * The tools this capability owns, as a tuple so the set is data rather than a
 * comment. `satisfies` pins every entry to a real `HostedToolName`, and
 * `createToolHandlers`' `HostedToolHandlers` annotation refuses a surface
 * where a tool ends up with NO owner (TS2741 names the missing one). The
 * disjointness of this tuple against the other capability tuples and the
 * facade's own literal is asserted in `tools/module-boundaries.test.ts`.
 */
export const PAID_MCP_COMPLETION_TOOLS = [
  'haven_complete_mcp_tool',
  'haven_settle_mcp_tool',
  'haven_report_settlement_evidence',
  // #3770: the delivery-quality report lives beside the other reports —
  // Haven-completed purchases are exactly the flow with no other feedback
  // channel for "paid, but the output was unusable".
  'haven_report_delivery_quality',
] as const satisfies readonly HostedToolName[]

export type PaidMcpCompletionToolName = (typeof PAID_MCP_COMPLETION_TOOLS)[number]

/**
 * This capability's handler contribution to `createToolHandlers`.
 *
 * The return type is keyed on the tuple above, so adding a name there without
 * a handler (or a handler without a name) is a compile error here rather than
 * a runtime registry issue discovered at server boot.
 */
export function createPaidMcpCompletionHandlers(
  haven: HavenClient,
): HostedToolHandlers<PaidMcpCompletionToolName> {
  return {
    haven_complete_mcp_tool: async (input) =>
      runTool(async () => {
        // #2353's switch: parseStrict, like every other strict tool's handler —
        // the transport-level registration refuses an undeclared key for MCP
        // callers, and this is the second line for an embedder that imports
        // `createToolHandlers` directly, where no MCP SDK validation runs.
        // Both layers read their refusal text from STRICT_INPUT_TOOLS.
        const args = parseStrict('haven_complete_mcp_tool', input)
        // #3778: a credential-shaped delivery_reference is refused BEFORE the
        // merchant call — nothing written, nothing called.
        assertDeliveryReference('haven_complete_mcp_tool', args)
        // #2970 review: pick explicit fields rather than spreading
        // `deliverMerchantPayment`'s result verbatim — that result also
        // carries `evidence_outcome` (which can be `{outcome:'refused',
        // statusCode:0}` on a transport failure) on BOTH schemes, and this
        // tool's contract (`COMPLETE_MCP_TOOL_DESCRIPTION`) never documented
        // it. Drop it here rather than document a field nothing downstream
        // needs — `haven_settle_mcp_tool`'s erc7710 branch already turns the
        // same evidence outcome into `code`/`settled`/agent guidance, and
        // `haven_complete_mcp_tool` has no erc7710 branch of its own to
        // classify (see `deliverMerchantPayment`'s `noFundingLeg` gate — a
        // `submitted` erc7710 intent 409s here today, pre-existing).
        const delivered = await deliverMerchantPayment(haven, args)
        // #3764 (D1): the funding outcome above is still dropped, but the
        // merchant SETTLEMENT report's outcome IS mapped — the same three
        // arms #3727's `evidenceHandoff` gives the plain-HTTP outcome report.
        // On erc7710 (no funding leg) `settlement_evidence_outcome` is always
        // undefined, so the recorded arm is a no-op and this stays byte-for-
        // byte the pre-#3764 answer; on eip3009 a retryable report names the
        // report tool with the hash prefilled, and a refused one names no
        // tool with the reason.
        if (delivered.settlement_evidence_outcome && delivered.settlement_evidence_outcome.outcome !== 'confirmed') {
          return {
            status: delivered.status,
            ok: delivered.ok,
            result: delivered.result,
            settlement_tx_hash: delivered.settlement_tx_hash,
            ...buildAgentGuidance({
              nextAction: AgentPaymentNextAction.None,
              ...settlementEvidenceHandoff(
                delivered.settlement_evidence_outcome,
                args.payment_id,
                delivered.settlement_tx_hash,
              ),
              safeToContinue: true,
              reason: settlementEvidenceReason(delivered.settlement_evidence_outcome),
              summary: { payment_id: args.payment_id, status: 'settled' },
            }),
          }
        }
        return {
          status: delivered.status,
          ok: delivered.ok,
          result: delivered.result,
          settlement_tx_hash: delivered.settlement_tx_hash,
        }
      }),

    haven_settle_mcp_tool: async (input) =>
      runTool(async () => {
        const args = parseStrict('haven_settle_mcp_tool', input)
        // #3778: a credential-shaped delivery_reference is refused BEFORE the
        // funding relay — a bad value can never reach the row or move money.
        assertDeliveryReference('haven_settle_mcp_tool', args)
        // ── #2282: the merchant-call context is resolved BEFORE anything is
        // submitted, on BOTH schemes. ──
        //
        // This tool's whole purpose is "fund AND deliver in one call", so it
        // relays the funding signature itself. The context needed for the
        // delivery half used to be resolved inside `deliverMerchantPayment`,
        // i.e. after that relay: an intent created by `haven_pay_x402_quote`
        // has no stored context (that tool receives only the raw 402 — a
        // PaymentRequired carries a resource URL but no MCP tool name and no
        // arguments, so there is nothing to store), and the caller learned so
        // only once the funding was confirmed on-chain. The check was correct
        // and it ran after the thing it would have prevented, leaving a
        // `funded_but_unsettled` intent that this tool can no longer finish —
        // a settle retry with explicit context relays funding again and gets
        // `expected pending_signature`, which reads like "your context was
        // fine". Recovery meant switching to `haven_complete_mcp_tool`.
        //
        // Resolved here, the same refusal lands while the intent is still
        // `pending_signature` and nothing has been spent, so the caller retries
        // THIS tool with explicit merchant_url/tool_name/arguments and it
        // simply works. The failure stops stranding value instead of being
        // reported sooner. Same reasoning as the erc7710 branch below: there
        // the submit burns the settlement child, which is not recoverable by
        // re-signing either.
        const merchantContext = await resolveMerchantCallContext(haven, args)
        // #3747: the egress policy also runs HERE — before the funding
        // signature relay and before the erc7710 submit (both schemes resolve
        // at this site; erc7710 has no funding leg, so refusing pre-submit is
        // equally before-spend). The stored-context rehydration path was
        // already validated at quote time, so re-asserting is a no-op there;
        // an EXPLICITLY supplied merchant_url has never been checked by this
        // point and the first transport-side check would otherwise land only
        // after `ensureFundingConfirmed` — the exact funded-but-undeliverable
        // outcome the issue criterion forbids.
        if (haven.merchantEgress) {
          try {
            haven.merchantEgress.assertUrl(merchantContext.merchantUrl)
          } catch (err) {
            throw egressRefusalBeforeIntent(err, 'merchant_url')
          }
        }
        // Fast path: fund (relay the signature) then deliver the merchant header
        // in one hosted call. The signature and X-PAYMENT header are both signed
        // by the local edge signer — Haven relays them but never holds the key.
        //
        // This MUST precede submitSignature: a malformed or substituted merchant
        // header is never a reason to fund the delegate balance. It is an
        // integrity preflight, not a merchant/facilitator verification or a
        // replacement for the local signer's expected-context binding.
        // #1456: erc7710 direct settlement inverts this whole sequence, so it
        // branches HERE rather than deeper — an earlier attempt put the branch
        // inside deliverMerchantPayment and the signature had already been
        // relayed as a FUNDING signature by then.
        //
        // On this scheme the signature IS the settlement child, not a funding
        // authorization: it goes to POST /x402/:id/settle, which returns the
        // merchant header Haven assembles. There is no funding leg to relay and
        // no agent-supplied header to preflight — the absence of
        // `payment_header` is what tells the two schemes apart, because the
        // 3009 path always carries one built by the local signer.
        if (!args.payment_header) {
          const submitted = await haven
            .submitX402Erc7710(args.payment_id, args.signature)
            .catch(catchSettledResettle)
          // #3423: a second settle of a payment that already settled answers
          // with the original settlement as a done state (the #3417 helper),
          // and the merchant is NOT called again.
          if (typeof submitted !== 'string') return submitted.settledReplay
          const paymentHeader = submitted
          const merchant7710 = await deliverMerchantPayment(
            haven,
            { ...args, payment_header: paymentHeader },
            // No funding tx to confirm — passing one would make the delivery
            // helper wait for a transaction that will never exist.
            undefined,
            // #1508: and `undefined` alone is NOT enough. The helper still read
            // the payment status unconditionally, which is a 409 here because
            // the settle above already moved the intent to 'submitted'. Say
            // "there is no funding leg" explicitly instead of implying it.
            { noFundingLeg: true, context: merchantContext },
          )
          const summary7710 = await haven.getPostPurchaseAllowanceSummary(args.payment_id)
          // #2970: "settled" means Haven VERIFIED the settlement on-chain, not
          // that the merchant answered 2xx — by this point a non-2xx merchant
          // response has already thrown (MERCHANT_REJECTED_AFTER_FUNDING,
          // above in `deliverMerchantPayment`), so `merchant7710.ok` is always
          // true here and was never the right signal for "settled" in the
          // first place. See `classifyErc7710Settlement`.
          const gate = classifyErc7710Settlement(
            merchant7710.settlement_tx_hash,
            merchant7710.evidence_outcome,
          )
          if (gate.outcome === 'settled') {
            // #3423 item 4: erc7710 settle used to omit
            // `agent_summary.purchase_summary` — only the EIP-3009 branch
            // built one, but the skill's "Reporting after a purchase"
            // section tells every agent to report from it. `hasFundingLeg:
            // false` is load-bearing here (see the guidance.ts doc comment):
            // without it, `buildPurchaseSummary` would back-fill
            // `funding_tx_hash` from `summary7710.payment?.txHash`, which on
            // this scheme is the SETTLEMENT hash, not a funding one.
            const purchaseSummary = buildPurchaseSummary({
              payment: summary7710.payment,
              merchantResult: merchant7710.result,
              fundingTxHash: null,
              settlementTxHash: merchant7710.settlement_tx_hash,
              allowance: summary7710.allowance,
              hasFundingLeg: false,
              // #3771: the merchant's product_name wins; this is only the gap
              // filler when the result carries none. #3781: the catalog row's
              // name is the first tier of that filler when the purchase came
              // from a catalog entry.
              fallbackProduct: purchaseFallbackLabel(
                merchantContext.merchantUrl,
                merchantContext.toolName,
                merchantContext.catalogName,
              ),
            })
            return {
              payment_id: args.payment_id,
              settlement_scheme: 'erc7710',
              funding_tx_hash: null,
              settled: true,
              // #2968: the delivery half of the vocabulary rides on the settled
              // arm too — settled:true implies the merchant handed over the
              // goods, and the qa-agent scenarios assert the two fields AGREE
              // (settled:true without delivered:true is the #2968 contradiction
              // in reverse). Absence of `code` remains the settled marker.
              delivered: true,
              settlement_tx_hash: merchant7710.settlement_tx_hash,
              result: merchant7710.result,
              allowance: summary7710.allowance,
              ...buildAgentGuidance({
                // Same terminal value the 3009 success path uses (#1308) — one
                // vocabulary, not a parallel one per scheme.
                nextAction: AgentPaymentNextAction.None,
                // #3101 (decision 3): a done state names no tool and says so.
                nextTool: null,
                nextToolOmittedReason: 'the purchase is settled; no Haven tool follows',
                safeToContinue: true,
                reason:
                  'Settled directly from the treasury through the budget delegation — no funding ' +
                  'leg, so the delegate wallet never held these funds and there is nothing to sweep. ' +
                  'Report the result to the user from agent_summary.purchase_summary. Merchant-issued ' +
                  'credentials in `result` are withheld unless this call passed ' +
                  'include_merchant_credentials=true — never echo or log one.',
                summary: {
                  payment_id: args.payment_id,
                  status: summary7710.payment?.status ?? 'settled',
                  // #3423 review round 1 (F1): additive, not a replacement —
                  // `product` stayed the field this summary carried before
                  // this fix, and `purchase_summary` is new alongside it.
                  // #3497 item 2: `product` now reports the MERCHANT's product
                  // name when the delivered result carries one (the same
                  // source `purchase_summary.product` reads), falling back to
                  // the tool name — the tool name is what called the merchant,
                  // not what the user bought.
                  product: purchaseSummary.product ?? merchantContext.toolName,
                  purchase_summary: purchaseSummary,
                },
                warnings: summary7710.warnings,
              }),
            }
          }
          const pending = gate.outcome === 'settlement_pending'
          // #2968: the unconfirmed settlement is the most important fact in
          // this response, so it does not ride silently — a machine-readable
          // warning travels with it, carrying the intent's expiry so the agent
          // can say how long "later" still means. After that instant the
          // settlement can no longer land at all.
          const expiresAt =
            typeof summary7710.payment?.expiresAt === 'string' && summary7710.payment.expiresAt.length > 0
              ? summary7710.payment.expiresAt
              : null
          const settlementUnconfirmedWarning = {
            code: AgentPaymentWarningCode.SettlementUnconfirmed,
            message:
              `No on-chain confirmation for payment ${args.payment_id}: the merchant delivered, ` +
              'but Haven holds no verified settlement evidence. ' +
              (expiresAt
                ? `Check haven_get_payment_status again before this payment expires at ${expiresAt}. `
                : 'Check haven_get_payment_status again later. ') +
              'Report the delivered goods to the user, but do not report the payment as settled.',
          }
          // #2972: on the pending branch the agent demonstrably holds the
          // merchant's real hash (it is echoed right here), so the machine-
          // readable remedy is to hand it back through
          // `haven_report_settlement_evidence` once the chain is readable —
          // not merely to poll. DELIVERED_UNSETTLED keeps the status poll as
          // next_tool: the hash was missing, zero, or already refused, and
          // the sweep is the remaining passive path.
          const heldHash = merchant7710.settlement_tx_hash
          // #3101 review: the merchant's string must be the SHAPE the report
          // tool declares (0x + 64 hex), not merely non-zero — otherwise the
          // typed handoff's strict validator refuses it and the agent is left
          // with no next_tool after money moved. A malformed hash falls
          // through to the status poll, which is what the agent can still do.
          const canReport =
            pending &&
            typeof heldHash === 'string' &&
            /^0x[0-9a-fA-F]{64}$/.test(heldHash) &&
            !isZeroSettlementTxHash(heldHash)
          return {
            payment_id: args.payment_id,
            settlement_scheme: 'erc7710',
            funding_tx_hash: null,
            settled: false,
            code: pending ? 'SETTLEMENT_PENDING' : 'DELIVERED_UNSETTLED',
            delivered: true,
            ...(pending ? { retryable: true } : {}),
            settlement_tx_hash: merchant7710.settlement_tx_hash,
            result: merchant7710.result,
            allowance: summary7710.allowance,
            ...buildAgentGuidance({
              nextAction: AgentPaymentNextAction.CheckStatusLater,
              ...heldHashHandoff(canReport, args.payment_id, heldHash),
              safeToContinue: true,
              reason: pending
                ? 'The merchant delivered the result and reported a settlement transaction, but ' +
                  'Haven could not yet verify it on-chain (the RPC was unreachable, or the ' +
                  'transaction is not mined yet). This is worth checking again — call next_tool ' +
                  'with next_arguments shortly (it hands the same settlement_tx_hash back to ' +
                  'Haven for verification); haven_get_payment_status shows the current status.'
                : 'The merchant delivered the result, but Haven has no verified on-chain settlement ' +
                  'evidence for this payment — the reported settlement hash was missing, zero, or ' +
                  "could not be verified. Haven's settlement sweep may still attribute it within " +
                  'about two minutes; poll next_tool once more after that. If you hold a real ' +
                  'settlement transaction hash from the merchant, haven_report_settlement_evidence ' +
                  'hands it to Haven for verification. If it still shows no evidence, tell the ' +
                  'user the goods were delivered but Haven holds no verified settlement evidence ' +
                  'for this payment.',
              summary: {
                payment_id: args.payment_id,
                status: summary7710.payment?.status ?? (pending ? 'settlement_pending' : 'delivered_unsettled'),
                product: args.tool_name,
                ...(expiresAt ? { expires_at: expiresAt } : {}),
              },
              warnings: [...summary7710.warnings, settlementUnconfirmedWarning],
            }),
          }
        }

        await preflightMcpPaymentHeader(haven, args)
        const funding = await submitSignatureWithExpiryMapping(haven, args.payment_id, args.signature)
        if (funding.status !== 'confirmed') {
          // Funding did not confirm. Do not deliver the merchant header —
          // return the funding status so the agent can act. Echo payment_id so
          // the agent can cross-reference the payment
          // (haven_get_payment_status / haven_list_receipts) without re-deriving it.
          const fundingPending = isPendingApproval(funding.status)
          return {
            payment_id: args.payment_id,
            funding_status: funding.status,
            funding_tx_hash: funding.txHash ?? null,
            settled: false,
            // #1308 review: the two non-confirmed states have DIFFERENT next
            // actions. `fundingPending` is the retained fail-closed branch for
            // a status no live rail emits any more (see `isPendingApproval`) —
            // it stops the agent; a transient funding state is a poll.
            ...buildAgentGuidance({
              nextAction: fundingPending
                ? AgentPaymentNextAction.StopAndTellUser
                : AgentPaymentNextAction.CheckStatusLater,
              nextTool: 'haven_get_payment_status',
              nextArguments: { payment_id: args.payment_id },
              safeToContinue: !fundingPending,
              reason: fundingPending
                ? 'Funding did not complete and is not payable. Tell the user; do not re-sign or re-settle, and do not wait for an approval — none is queued.'
                : 'Funding is not confirmed yet. Poll next_tool, then finish settlement with haven_complete_mcp_tool once confirmed.',
              summary: { payment_id: args.payment_id, status: funding.status },
            }),
          }
        }
        const merchant = await deliverMerchantPayment(haven, args, funding.txHash, {
          context: merchantContext,
        })
        // #1310: rail-aware remaining-budget summary so the agent can report
        // spend without a separate haven_get_agent/haven_get_allowances round
        // trip. A failed read NEVER converts this settled success into a
        // failure — it degrades to a null block plus a warning, folded into
        // the SAME warnings[] buildAgentGuidance already emits.
        // Reuse the payment-status read the allowance helper already performs;
        // reporting must not add a second status round trip or race it.
        const { allowance, warnings, payment } = await haven.getPostPurchaseAllowanceSummary(args.payment_id)
        const purchaseSummary = buildPurchaseSummary({
          payment,
          merchantResult: merchant.result,
          fundingTxHash: funding.txHash ?? null,
          settlementTxHash: merchant.settlement_tx_hash,
          allowance,
          // #3771: same gap filler as the erc7710 settled arm — the merchant's
          // own product_name still wins when the result carries one. #3781:
          // the catalog row's name is the filler's first tier.
          fallbackProduct: purchaseFallbackLabel(
            merchantContext.merchantUrl,
            merchantContext.toolName,
            merchantContext.catalogName,
          ),
        })
        // Pick explicit fields — don't spread the raw HTTP status/ok, which would
        // collide with the funding/payment-status meaning an agent expects here.
        // Echo payment_id so the agent can reconcile this settled payment against
        // haven_list_receipts / haven_get_payment_status without retaining it from
        // the haven_pay_mcp_tool step.
        return {
          payment_id: args.payment_id,
          funding_tx_hash: funding.txHash ?? null,
          settled: true,
          result: merchant.result,
          settlement_tx_hash: merchant.settlement_tx_hash,
          allowance,
          // #1308: done — nothing left but reporting.
          ...buildAgentGuidance({
            nextAction: AgentPaymentNextAction.None,
            // #3764 (D1): the settlement-evidence report's outcome maps the
            // same three arms #3727's `evidenceHandoff` gives the plain-HTTP
            // outcome report — recorded (or nothing posted) keeps "no tool
            // follows", a retryable report names the report tool with the
            // hash prefilled, a refused one names no tool and says why.
            ...settlementEvidenceHandoff(
              merchant.settlement_evidence_outcome,
              args.payment_id,
              merchant.settlement_tx_hash,
            ),
            safeToContinue: true,
            reason: settlementEvidenceReason(merchant.settlement_evidence_outcome),
            summary: {
              payment_id: args.payment_id,
              status: 'settled',
              // #3497 item 2: the merchant's product name when the delivered
              // result carries one, falling back to the tool name — same
              // fallback as the erc7710 settled arm above. `tool_name` is
              // always present on this path (resolveMerchantCallContext
              // requires it), so `product` is never undefined here.
              product: purchaseSummary.product ?? merchantContext.toolName,
              purchase_summary: purchaseSummary,
            },
            warnings,
          }),
        }
      }),

    // #2972: report a settlement hash the agent holds out of band — see the
    // module header and `classifySettlementEvidenceReport`. Agent-authenticated,
    // own payments only: `HavenClient.reportSettlementEvidence` posts to the
    // SAME backend route (`POST /machine-payments/evidence`) the settle/
    // complete gate above already calls, scoped `WHERE agent_id = $` there —
    // a foreign payment_id 404s and is classified DELIVERED_UNSETTLED, never
    // written. The zero hash never reaches that call at all: the SDK refuses
    // it client-side (`HavenZeroSettlementHashError`), which `runTool`'s
    // generic `HavenError` branch turns into a `ToolFailure` carrying `code:
    // "ZERO_SETTLEMENT_HASH"` — no separate catch needed here.
    haven_report_settlement_evidence: async (input) =>
      runTool(async () => {
        const args = parseStrict('haven_report_settlement_evidence', input)
        // #3475 follow-up (review round 1, S3): `settlement_tx_hash` is
        // optional on the SCHEMA so haven_report_x402_outcome can name this
        // tool with only payment_id prefilled, before it knows whether the
        // merchant returned a hash at all. A call that never supplies one is
        // a SUCCESS no-op, not a refusal — an agent following next_tool /
        // next_arguments VERBATIM (the contract every hosted tool promises)
        // must never get an error for doing exactly that. Zero backend
        // calls: nothing to check or record without a hash.
        if (!args.settlement_tx_hash) {
          // #3475 follow-up review round 2 (both reviewers): state only what
          // is known. This tool is ALSO the named remedy for an erc7710
          // payment `awaiting_settlement_evidence` / `delivered_unverified`
          // — a no-hash call there means the agent has not yet received one
          // from the merchant, not that the purchase is complete. Nothing
          // was checked or recorded is the only thing every payment_id this
          // tool accepts can honestly say.
          return {
            payment_id: args.payment_id,
            recorded: false,
            ...buildAgentGuidance({
              nextAction: AgentPaymentNextAction.None,
              nextTool: null,
              nextToolOmittedReason: 'no settlement hash was supplied; nothing was checked or recorded',
              safeToContinue: true,
              reason:
                'No settlement_tx_hash was supplied, so nothing was checked or recorded — Haven made ' +
                'no network call. If you receive the merchant settlement transaction, call again with ' +
                'settlement_tx_hash to record it.',
              summary: { payment_id: args.payment_id, status: 'not_recorded' },
            }),
          }
        }
        const outcome = await haven.reportSettlementEvidence(
          args.payment_id,
          args.settlement_tx_hash,
        )
        if (outcome.outcome === 'confirmed') {
          return classifySettlementEvidenceReport(args.payment_id, args.settlement_tx_hash, outcome)
        }
        // Refused or pending: read the status Haven actually holds rather than
        // asserting one. A foreign/non-existent payment 404s on this read as
        // well — reported as `unknown`, which is the truth from this agent's
        // side.
        let observedStatus: string | null = null
        try {
          observedStatus = (await haven.getPaymentStatus(args.payment_id)).status
        } catch {
          observedStatus = null
        }
        return classifySettlementEvidenceReport(
          args.payment_id,
          args.settlement_tx_hash,
          outcome,
          observedStatus,
        )
      }),

    // #3770: the delivery-quality report. Evidence-only by contract — the
    // handler relays the agent's verdict and nothing else; the backend
    // scopes it to this agent (another agent's payment is 404), refuses an
    // unsettled payment (409), and never touches the payment itself.
    haven_report_delivery_quality: async (input) =>
      runTool(async () => {
        const args = parseStrict('haven_report_delivery_quality', input)
        const report = await haven.reportDeliveryQuality({
          paymentId: args.payment_id,
          quality: args.quality,
          ...(args.note !== undefined ? { note: args.note } : {}),
        })
        return {
          payment_id: report.payment_id,
          quality: report.quality,
          ...(report.note !== null ? { note: report.note } : {}),
          updated_at: report.updated_at,
        }
      }),
  }
}
