/**
 * Shared semantic descriptions for Haven agent payment tools.
 *
 * Two surfaces in this repo expose Haven as a tool: the Claude / OpenAI
 * function-calling tool definitions in `tools.ts` (used for direct SDK
 * integrations) and the MCP server in `packages/mcp` (used by any MCP-speaking
 * agent runtime). The two surfaces use different tool *names* — the SDK's
 * tools are tuned for tool-calling conventions (`make_payment`,
 * `authorize_x402_payment`); the MCP tools follow the MCP `haven_*` naming
 * (`haven_pay_x402_quote`).
 *
 * The underlying *operations* are the same, so the descriptive prose should
 * live in one place. Both surfaces import from this module and compose their
 * own tool descriptions from these semantic fragments. Drift is caught by
 * tests asserting each consumer's description string contains the shared
 * `summary` from this module.
 */

export interface ToolDescription {
  /** One-line summary of the operation. Used as the first sentence of every
   * downstream description and as a stable substring for drift tests. */
  summary: string
  /** Natural-language user intents that should make an agent prefer this
   * tool over adjacent tools. Empty or omitted when the summary is enough. */
  selectionGuidance?: string
  /** Concrete behaviour the tool performs end-to-end, including which
   * non-custodial guarantee applies. */
  behavior: string
  /** What the agent should do next on error / pending-approval states.
   * Empty string if not applicable. */
  nextActionGuidance: string
}

/**
 * Build a single description string from the three fragments. Joined with
 * spaces so consumers can split on the summary substring if they need to.
 */
export function composeDescription(d: ToolDescription): string {
  return [d.summary, d.selectionGuidance, d.behavior, d.nextActionGuidance]
    .filter(Boolean)
    .join(' ')
}

export const toolDescriptions = {
  quoteX402: {
    summary:
      'Inspect an HTTP 402 x402 paid resource without creating a Haven payment, signature, approval, or on-chain transaction.',
    behavior:
      'Probes the merchant directly and parses the 402 response. Pure read-only client behavior — Haven is not contacted.',
    nextActionGuidance:
      'On success the returned quote is the input to haven_pay_x402_quote. Do not call the merchant again — Haven re-uses the captured request when paying.',
  },
  payX402: {
    summary:
      'Pay an inspected x402 quote. The delegate key signs locally; Haven only validates and relays signed, on-chain-constrained payment transactions.',
    selectionGuidance:
      'Do not use this for read-only allowance, budget, spend-limit, remaining-amount, reset-period, or what-can-I-spend questions; use the allowance lookup tool instead.',
    behavior:
      'Signs the EIP-3009 payment from the delegate wallet, asks Haven for a Safe AllowanceModule top-up if needed, and returns the merchant response or a pending-approval state.',
    nextActionGuidance:
      'If approval is needed, preserve the returned resume_state and wait for nextAction=retry_original_x402_request before resuming. ' +
      'If the response carries phase=insufficient_funds and nextAction=fund_safe_or_raise_allowance, the payment cannot be retried until the originating Safe is funded or the agent allowance raised — stop and tell the user the shortfall reported on the response.',
  },
  payX402OneShot: {
    summary:
      'Fetch an x402 paid HTTP resource in a single call. Handles the full probe -> pay -> retry round trip and returns the merchant response.',
    selectionGuidance:
      'Prefer this over the quote+pay split when the agent just wants the paid resource and does not need to inspect the price first. If you already have a quote from haven_quote_x402, use haven_pay_x402_quote instead. Do not use for read-only allowance, budget, spend-limit, remaining-amount, reset-period, or what-can-I-spend questions; use the allowance lookup tool instead.',
    behavior:
      'Calls the URL, parses any HTTP 402 x402 challenge, signs the EIP-3009 payment from the delegate wallet, asks Haven for a Safe AllowanceModule top-up if needed, then retries the original request with the X-PAYMENT header and returns the merchant response. If the resource returns an MPP machine-payment challenge instead of standard x402, the MPP payment path is used automatically. If the resource returns a non-402 status, returns it unchanged without contacting Haven.',
    nextActionGuidance:
      'If approval is needed, preserve the returned resume_state or paymentId and call the resume tool once nextAction=retry_original_x402_request. ' +
      'If the response carries phase=insufficient_funds and nextAction=fund_safe_or_raise_allowance, the payment cannot be retried until the originating Safe is funded or the agent allowance raised — stop and tell the user the shortfall reported on the response.',
  },
  resumeX402: {
    summary:
      'Resume an x402 payment after the Haven wallet owner approved the funding step.',
    behavior:
      'Accepts either resume_state or payment_id, validates the original x402 details against the approved Haven funding, and retries the merchant request with the X-PAYMENT header. No new Haven approval is created.',
    nextActionGuidance:
      'Only use when get_payment_status returns nextAction=retry_original_x402_request; do not start a new merchant session.',
  },
  quoteMpp: {
    summary:
      'Inspect a Haven MPP challenge or paid MPP URL without creating a Haven payment, signature, approval, or on-chain transaction.',
    behavior:
      'Parses an MPP challenge envelope and returns a typed quote with rail tag, amount, asset, and merchant context. Pure read-only — Haven is not contacted.',
    nextActionGuidance:
      'On success the returned quote is the input to haven_pay_mpp_challenge. Do not call the merchant again — Haven re-uses the captured request when paying.',
  },
  payMpp: {
    summary:
      'Pay an inspected MPP challenge. The delegate key signs locally; Haven only validates and relays signed, on-chain-constrained payment transactions.',
    selectionGuidance:
      'Do not use this for read-only allowance, budget, spend-limit, remaining-amount, reset-period, or what-can-I-spend questions; use the allowance lookup tool instead.',
    behavior:
      'Authorizes the payment through Haven within the on-chain allowance, signs the challenge proof, and returns the proof header for retrying the original paid resource.',
    nextActionGuidance:
      'If approval is needed, preserve resume_state or payment_id and wait for nextAction=retry_original_x402_request before resuming.',
  },
  resumeMpp: {
    summary:
      'Resume an MPP payment after the Haven wallet owner approved the funding step.',
    behavior:
      'Accepts either resume_state or payment_id and retries the original paid resource with the MPP proof header. No new Haven approval is created.',
    nextActionGuidance: '',
  },
  getPaymentStatus: {
    summary:
      'Fetch structured Haven payment status, including phase and nextAction taxonomy for agent recovery.',
    behavior:
      'Accepts a payment intent or approval request id and returns the full state taxonomy (phase, nextAction, rail, amount, merchant, resource url, idempotency key, message).',
    nextActionGuidance: '',
  },
  getResumeState: {
    summary:
      'Rehydrate stored x402 or MPP resume_state by payment_id.',
    behavior:
      'Returns the context that the agent originally received in a pending-approval response, reconstructed from Haven\'s database. This is context only; signing still happens locally when a resume tool is called.',
    nextActionGuidance: '',
  },
  getAgent: {
    summary:
      'Return the authenticated agent identity, Haven wallet, delegate address, chain, and status.',
    behavior:
      'Read-only identity lookup. Useful for verifying which on-chain Safe and delegate the credential is bound to.',
    nextActionGuidance: '',
  },
  getAllowances: {
    summary:
      'Return configured and on-chain allowance state for the authenticated agent. On-chain allowance is the real spend gate.',
    selectionGuidance:
      'Use this when the user asks about allowance, budget, spend limit, remaining amount, remaining allowance, remaining budget, daily limit, reset period, what can I spend, or what the agent can still spend.',
    behavior:
      'Reads the Safe AllowanceModule snapshot per token (allowance, spent, remaining, reset window). Configured amounts from Haven are returned alongside the on-chain truth.',
    nextActionGuidance: '',
  },
  listReceipts: {
    summary:
      'List recent machine-payment receipts and evidence for bookkeeping.',
    selectionGuidance:
      'Use this for transaction history, receipts, payment evidence, or bookkeeping; use the allowance tool instead for remaining allowance, budget, spend-limit, or what-can-I-spend questions.',
    behavior:
      'Returns the agent\'s recent machine-payment receipts ordered by recency. Proof header values are not returned.',
    nextActionGuidance: '',
  },
  payMcpTool: {
    summary:
      'Call a named tool on an MCP merchant that requires an x402 payment, handling the full initialize → pay → retry round trip.',
    selectionGuidance:
      'Use this when the agent wants to call a specific tool on an MCP merchant (e.g. Soundside, Coinbase Bazaar) and payment is required. ' +
      'Prefer this over haven_pay_x402 when you know the merchant_url and tool_name — it builds the JSON-RPC envelope internally. ' +
      'Use haven_pay_x402 for arbitrary HTTP resources. ' +
      'Do NOT use for read-only allowance or budget questions — use haven_get_allowances.',
    behavior:
      'Builds the JSON-RPC tools/call envelope, runs the MCP Streamable-HTTP initialize handshake automatically (if the endpoint is MCP-shaped), ' +
      'pays any HTTP 402 x402 challenge through Haven\'s AllowanceModule path, and retries the request. ' +
      'Returns the JSON-RPC result (the actual merchant output) on success. ' +
      'Amounts within the on-chain allowance execute automatically; over-allowance transfers are queued as pending_approval.',
    nextActionGuidance:
      'If pending_approval is returned, preserve payment_id and resume_state. ' +
      'Wait for the wallet owner to approve in Haven, then call haven_resume_x402_payment to retry the merchant request.',
  },
  send: {
    summary:
      'Send ETH or USDC directly from the agent\'s Haven wallet to a recipient address.',
    selectionGuidance:
      'Use this for plain transfers — refunding a user, paying a freelancer, topping up a co-agent\'s wallet, or moving funds between addresses. ' +
      'Do NOT use for x402 paid endpoints (use haven_pay_x402 instead) or MPP merchant payments (use haven_pay_mpp_challenge). ' +
      'Do NOT use for read-only allowance, budget, or what-can-I-spend questions — use haven_get_allowances.',
    behavior:
      'Sends the requested amount through the Safe AllowanceModule. ' +
      'Amounts within the remaining on-chain allowance for the asset execute automatically; ' +
      'amounts that exceed the allowance are queued as pending_approval for the wallet owner to approve in Haven. ' +
      'The agent\'s signing key signs the AllowanceModule transfer hash; Haven never receives the key.',
    nextActionGuidance:
      'If pending_approval is returned, preserve the payment_id and wait for the wallet owner to approve in Haven. ' +
      'Poll haven_get_payment_status until nextAction=none.',
  },
} as const satisfies Record<string, ToolDescription>

export type SharedToolKey = keyof typeof toolDescriptions
