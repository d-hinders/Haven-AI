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
  /** What the agent should do next on error / declined states.
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
      'Signs the payment locally and returns the merchant response. Settlement is either direct account-to-merchant with no funding leg, or a bridge that first redeems the agent\'s budget delegation to fund the delegate wallet for an EIP-3009 authorization. A payment outside the on-chain budget is declined before any money moves; nothing is queued for a human to approve later.',
    nextActionGuidance:
      'Preserve the returned resume_state and resume only on nextAction=retry_original_x402_request. ' +
      'If the response carries phase=insufficient_funds and nextAction=fund_safe_or_raise_allowance, the payment cannot be retried until the account is funded or the agent budget raised — stop and tell the user the shortfall reported on the response.',
  },
  payX402OneShot: {
    summary:
      'Fetch an x402 paid HTTP resource in a single call. Handles the full probe -> pay -> retry round trip and returns the merchant response.',
    selectionGuidance:
      'Prefer this over the quote+pay split when the agent just wants the paid resource and does not need to inspect the price first. If you already have a quote from haven_quote_x402, use haven_pay_x402_quote instead. Do not use for read-only allowance, budget, spend-limit, remaining-amount, reset-period, or what-can-I-spend questions; use the allowance lookup tool instead.',
    behavior:
      'Calls the URL, parses any HTTP 402 x402 challenge, signs the payment locally, then retries the original request with the X-PAYMENT header and returns the merchant response. Settlement is either direct account-to-merchant with no funding leg, or a bridge that first redeems the agent\'s budget delegation to fund the delegate wallet for an EIP-3009 authorization. A payment outside the on-chain budget is declined before any money moves; nothing is queued for a human to approve later. If the resource returns a non-402 status, returns it unchanged without contacting Haven.',
    nextActionGuidance:
      'Preserve the returned resume_state or paymentId and resume only on nextAction=retry_original_x402_request. ' +
      'If the response carries phase=insufficient_funds and nextAction=fund_safe_or_raise_allowance, the payment cannot be retried until the account is funded or the agent budget raised — stop and tell the user the shortfall reported on the response.',
  },
  resumeX402: {
    summary:
      'Resume an x402 payment whose Haven-side authorization already succeeded but whose merchant retry did not complete.',
    behavior:
      'Accepts either resume_state or payment_id, validates the original x402 details against the authorized Haven funding, and retries the merchant request with the X-PAYMENT header. No new Haven payment is created.',
    nextActionGuidance:
      'Only use when get_payment_status returns nextAction=retry_original_x402_request; do not start a new merchant session.',
  },
  // #1328: quoteMpp / payMpp / resumeMpp (the mpp_demo challenge/quote/resume
  // fragments) are retired along with the client surface they described —
  // MACHINE-PAYMENT-CHALLENGE was never produced by anything besides the now
  // deleted `/demo/mpp/*` route. Use the x402 fragments above instead.
  getPaymentStatus: {
    summary:
      'Fetch structured Haven payment status, including phase and nextAction taxonomy for agent recovery.',
    behavior:
      'Accepts a payment intent id and returns the full state taxonomy (phase, nextAction, rail, amount, merchant, resource url, idempotency key, message).',
    nextActionGuidance: '',
  },
  getResumeState: {
    summary:
      'Rehydrate stored x402 resume_state by payment_id.',
    behavior:
      'Returns the x402 context the agent originally received when the payment was authorized, reconstructed from Haven\'s database. This is context only; signing still happens locally when a resume tool is called.',
    nextActionGuidance: '',
  },
  getAgent: {
    summary:
      'Return the authenticated agent identity AND its live spend authority in one call: Haven wallet, delegate, chain, raw status, spend_authority_readiness, and per-token remaining allowance (atomic + human-readable). The recommended first call in a new session to confirm who you are and whether Haven will let you spend right now.',
    selectionGuidance:
      'Use this as the one-shot orientation/bootstrap at the start of a session, or whenever you need to confirm identity together with whether the agent can spend right now. For a detailed per-token breakdown (configured vs spent vs reset window) use haven_get_allowances.',
    behavior:
      'Reads identity plus the live spend-authority snapshot in one shot — the agent\'s active on-chain budget delegation. spend_authority_readiness (readiness is a deprecated alias, same value) is "ready" when at least one token has remaining spend authority, "needs_approval" when the agent is active but has none, and "revoked" when the credential is not active. It covers hosted identity + on-chain spend authority ONLY — the hosted server cannot see the LOCAL signer, so "ready" does not mean the signer can start; verify the signer with a signer tool call or connect --doctor. An over-budget payment is declined before any money moves: there is no approval queue, so ask the owner to grant or raise the budget in Haven rather than waiting for an approval. allowances[] carries remainingAtomic and remainingDisplay per token. Identity fields (id, name, status, safeAddress, delegateAddress, chainId) are unchanged from before.',
    nextActionGuidance: '',
  },
  getAllowances: {
    summary:
      'Return configured and on-chain allowance state for the authenticated agent. On-chain allowance is the real spend gate.',
    selectionGuidance:
      'Use this when the user asks about allowance, budget, spend limit, remaining amount, remaining allowance, remaining budget, daily limit, reset period, what can I spend, or what the agent can still spend.',
    behavior:
      'Returns the per-token spend authority for the account: the active budget delegation (remaining = the period budget, which re-arms natively at the period boundary). An over-budget payment is declined before any money moves; nothing queues. Configured amounts from Haven are returned alongside.',
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
      'Call a named tool on an MCP merchant that requires an x402 payment, handling the full initialize → pay → retry round trip in one call.',
    selectionGuidance:
      'Use this when the agent wants to call a specific tool on an MCP merchant (e.g. Soundside, Coinbase Bazaar) and payment is required. ' +
      'Prefer this over haven_pay_x402 when you know the merchant_url and tool_name — it builds the JSON-RPC envelope internally. ' +
      'Use haven_pay_x402 for arbitrary HTTP resources. ' +
      'Do NOT use for read-only allowance or budget questions — use haven_get_allowances.',
    behavior:
      'Builds the JSON-RPC tools/call envelope, runs the MCP Streamable-HTTP initialize handshake automatically (if the endpoint is MCP-shaped), ' +
      'pays any HTTP 402 x402 challenge against the agent\'s on-chain budget delegation, and retries the request, returning the JSON-RPC result (the actual merchant output) on success. ' +
      'Amounts within the remaining on-chain budget execute automatically; anything outside it is declined before any money moves — follow the response\'s nextAction when present.',
    nextActionGuidance:
      'On a decline, report the reason to the user and ask them to raise the budget in Haven — there is no approval queue to wait on. ' +
      'Use haven_resume_x402_payment once nextAction=retry_original_x402_request.',
  },
  discoverTools: {
    summary:
      'Step 1 of a purchase: discover payable services from Haven\'s curated merchant catalog — names, prices, and which pay tool to use next.',
    selectionGuidance:
      'Use this when the user asks what the agent can buy, pay for, or which paid services exist — or when you need a resource URL for a service the user described. ' +
      'Use verified=verified to show only self-submitted directory entries that passed domain-ownership proof and a live quote probe — never treat those badges as proof of merchant honesty, quality, or reliability. ' +
      'Do NOT use for balance, budget, or spend-limit questions — use haven_get_allowances. ' +
      'Do NOT use to pay — each returned entry names the pay tool to use next.',
    behavior:
      'Use each entry\'s suggested_tool field first — it names the exact next call. ' +
      'Read-only lookup against Haven\'s curated catalog; entries are periodically re-verified against the live merchant and degraded entries are flagged. ' +
      'Use category for a case-insensitive category filter (for example, VPN or vpn), or search for a product name, category, or description term. ' +
      'Returns name, description, price, rail, resource URL, tool_name, tool_arguments, suggested_tool, and the provenance badges source/domain_verified/verified_payable. ' +
      'The catalog price (price_display/price_atomic, marked price_is_indicative) is a last-verified hint, NOT authoritative — the real price comes from the merchant\'s live 402 at pay time. ' +
      'Never creates a payment, signature, or approval.',
    nextActionGuidance:
      'Pick an entry and pay it with the tool named in suggested_tool, passing the entry\'s resource_url, tool_name, and tool_arguments for MCP merchants. Confirm the price from the live pay-tool result (not the catalog), and pass the user\'s cap as max_amount_human in whole tokens ("no more than 1 USDC" → max_amount_human: "1") — never convert it to atomic units by hand.',
  },
  submitCatalogEntry: {
    summary:
      'Submit a merchant\'s payable (x402/MCP) endpoint to Haven\'s Verified Payable Directory for verification and listing.',
    selectionGuidance:
      'Use this when a merchant or seller asks to be listed in the directory, or when you have discovered a payable endpoint and want it registered. ' +
      'The submission is queue-only: it books a spot and returns a verify_token. The seller must then prove control of the domain (a well-known line or DNS TXT record); only after that plus a live quote probe does the entry become listed. ' +
      'Do NOT use to pay — check the returned status with getCatalogSubmissionStatus instead.',
    behavior:
      'Sends the https resource_url to Haven\'s public submission endpoint. The request path makes no outbound request to the merchant. ' +
      'Returns id + verify_token + status; the verify_token is shown exactly once. Ownership proof is always required later and cannot be skipped from the agent side. ' +
      'The website field is a honeypot for bots — leave it unset.',
    nextActionGuidance:
      'Give the verify_token and the well-known instructions (from getCatalogSubmissionStatus) to the merchant so they can publish the proof line, then poll the submission status until it reaches verified_payable or failed.',
  },
  sweep_delegate: {
    summary:
      'Sweep stranded USDC and/or ETH from the delegate wallet back to the originating Safe.',
    selectionGuidance:
      'Use this when the user instructs you to recover stranded funds on the delegate wallet, or when a payment status returns nextAction=sweep_stranded_funds. ' +
      'Do NOT use for normal payments — use haven_pay_x402. ' +
      'Do NOT use to read balances only — use haven_get_allowances.',
    behavior:
      'Reads the delegate EOA\'s on-chain USDC and ETH balances. For each non-zero balance, signs and submits a transfer from the delegate EOA to the originating Safe (hardcoded destination). ' +
      'The delegate key signs locally — Haven never sees it and the backend never constructs signed transactions (CASP/MiCA Red Line #2). ' +
      'Returns tx hashes and recovered amounts. Returns an empty transfers list when nothing is stranded. ' +
      'Each transfer carries confirmation: "confirmed" (a receipt was seen — the funds are in the Safe) or "unconfirmed" ' +
      '(broadcast but not confirmed within 90 seconds — still in the mempool, may still land). The top-level unconfirmed flag is true when any transfer is unconfirmed.',
    nextActionGuidance:
      'If transfers is non-empty, confirm the amounts with the user. ' +
      'Report a transfer as recovered ONLY when its confirmation is "confirmed". ' +
      'For an "unconfirmed" transfer, tell the user it was submitted but not yet confirmed, give them its txHash and explorerUrl to check, and do not re-run the sweep immediately — a re-run after it lands will simply find nothing stranded.',
  },
  send: {
    summary:
      'Send ETH or USDC directly from the agent\'s Haven wallet to a recipient address.',
    selectionGuidance:
      'Use this for plain transfers — refunding a user, paying a freelancer, topping up a co-agent\'s wallet, or moving funds between addresses. ' +
      'Do NOT use for x402 paid endpoints — use haven_pay_x402 instead. ' +
      'Do NOT use for read-only allowance, budget, or what-can-I-spend questions — use haven_get_allowances.',
    behavior:
      'Sends the requested amount by redeeming the agent\'s on-chain budget delegation, account to recipient with no funding leg. ' +
      'Budget, recipient and expiry are enforced on-chain while the transfer is prepared, so a request outside them is declined before any money moves and before the agent is asked to sign — it is never queued for a human to approve later. ' +
      'The agent\'s signing key signs the account\'s typed data; Haven never receives the key.',
    nextActionGuidance:
      'On a decline, report the reason to the user and ask them to grant or raise the budget in Haven — there is nothing to poll and no approval will arrive. ' +
      'After a successful send, poll haven_get_payment_status until nextAction=none.',
  },
} as const satisfies Record<string, ToolDescription>

export type SharedToolKey = keyof typeof toolDescriptions
