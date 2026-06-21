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
      'Return the authenticated agent identity AND its live spend authority in one call: Haven wallet, delegate, chain, raw status, a readiness signal, and per-token remaining allowance (atomic + human-readable). The recommended first call in a new session to confirm who you are and whether you can pay right now.',
    selectionGuidance:
      'Use this as the one-shot orientation/bootstrap at the start of a session, or whenever you need to confirm identity together with whether the agent can spend right now. For a detailed per-token breakdown (configured vs spent vs reset window) use haven_get_allowances.',
    behavior:
      'Reads identity plus the on-chain AllowanceModule snapshot in one shot. readiness is "ready" when at least one token has remaining on-chain allowance, "needs_approval" when the agent is active but has no remaining allowance to auto-spend (payments will be queued for the wallet owner to approve in Haven), and "revoked" when the credential is not active. allowances[] carries remainingAtomic and remainingDisplay per token. Identity fields (id, name, status, safeAddress, delegateAddress, chainId) are unchanged from before.',
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
  verifyReceipt: {
    summary:
      'Verify a payment receipt offline — confirm the agent authorised the transfer.',
    selectionGuidance:
      'Use this to check a receipt you already hold; it needs no network and does not trust Haven. Use the history tool to fetch receipts in the first place.',
    behavior:
      'Recovers the signer from the receipt authorisation and confirms it matches the agent delegate. Returns verified true/false with the recovered signer or a reason. Pure and local — no backend call.',
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
      'If pending_approval is returned, preserve payment_id and resume_state and wait for the wallet owner to approve in Haven. ' +
      'Use haven_resume_x402_payment once nextAction=retry_original_x402_request.',
  },
  discoverTools: {
    summary:
      'Discover payable services from Haven\'s curated merchant catalog — names, prices, and which pay tool to use.',
    selectionGuidance:
      'Use this when the user asks what the agent can buy, pay for, or which paid services exist — or when you need a resource URL for a service the user described. ' +
      'Do NOT use for balance, budget, or spend-limit questions — use haven_get_allowances. ' +
      'Do NOT use to pay — each returned entry names the pay tool to use next.',
    behavior:
      'Read-only lookup against Haven\'s curated catalog. Entries are periodically re-verified against the live merchant; degraded entries are flagged. ' +
      'Returns name, description, price, rail, resource URL, and a suggested_tool field naming the exact Haven pay tool for that entry. ' +
      'The catalog price (price_display/price_atomic, marked price_is_indicative) is a last-verified hint, NOT authoritative — the real price comes from the merchant\'s live 402 at pay time. ' +
      'Never creates a payment, signature, or approval.',
    nextActionGuidance:
      'Pick an entry and pay it with the tool named in suggested_tool, passing the entry\'s resource_url (and tool_name for MCP merchants). Confirm the price from the live pay-tool result (not the catalog), and pass max_amount when the user has a cap.',
  },
  sweep_delegate: {
    summary:
      'Sweep stranded USDC and/or ETH from the delegate wallet back to the originating Safe.',
    selectionGuidance:
      'Use this when the user instructs you to recover stranded funds on the delegate wallet, or when a payment status returns nextAction=sweep_stranded_funds. ' +
      'Do NOT use for normal payments — use haven_pay_x402 or haven_pay_mpp_challenge. ' +
      'Do NOT use to read balances only — use haven_get_allowances.',
    behavior:
      'Reads the delegate EOA\'s on-chain USDC and ETH balances. For each non-zero balance, signs and submits a transfer from the delegate EOA to the originating Safe (hardcoded destination). ' +
      'The delegate key signs locally — Haven never sees it and the backend never constructs signed transactions (CASP/MiCA Red Line #2). ' +
      'Returns tx hashes and recovered amounts. Returns an empty transfers list when nothing is stranded.',
    nextActionGuidance:
      'If transfers is non-empty, confirm the amounts with the user. No further action required — funds are on their way back to the Safe.',
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
