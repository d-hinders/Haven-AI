/**
 * Shared types for the x402 module (#996, epic #980 M4). Extracted verbatim
 * from `routes/x402.ts` — no shape changes.
 */

/**
 * #1307: the merchant MCP-tool call context a `haven_pay_mcp_tool` quote was
 * made against — recorded at intent-creation time so the settle/complete leg
 * can rehydrate it by `payment_id` instead of the agent re-threading it. This
 * is convenience metadata for retrying the MERCHANT's own JSON-RPC call, not
 * payment authority: a wrong value fails the outbound HTTP call, it cannot
 * redirect funds (the signed payment context is verified independently).
 */
export interface X402McpCallContextInput {
  merchantUrl: string
  toolName: string
  arguments?: Record<string, unknown>
  mcpTransport?: { handshakeRequired: boolean; source: 'path' | 'bazaar' }
}

export interface X402AuthorizeBody {
  url: string
  payTo: string
  merchantPayTo?: string
  amount: string          // atomic units
  asset: string           // token contract address
  network: string         // CAIP-2 chain ID or x402 network name
  description?: string
  maxTimeoutSeconds?: number
  category?: string       // api_access, data, compute
  idempotencyKey?: string
  signature?: string      // delegate signature (optional — enables one-shot authorize+execute)
  /**
   * #946: explicit settlement-scheme request on the delegation rail
   * ('erc7710' | 'eip3009'). Optional — the payTo shape (merchant vs the
   * agent's own delegate EOA) already selects the scheme; when present this
   * is validated against that shape so a confused client fails loudly
   * instead of getting the wrong flow.
   */
  settlementScheme?: string
  /**
   * #1058: the erc7710 challenge entry's `extra.facilitatorAddresses`,
   * forwarded VERBATIM. Pins the settlement child's redeemer caveat and is
   * echoed in the v2 X-PAYMENT header's accepted entry.
   */
  facilitatorAddresses?: string[]
  /** #1307: optional MCP merchant-call context, stored for settle-leg rehydration. */
  mcpCallContext?: X402McpCallContextInput
}

export interface X402ApprovalRow {
  id: string
  status: string
  token_symbol: string
  amount_human: string
  expires_at: string
  machine_challenge_id: string | null
}

/** A route-serializable {statusCode, body} pair — orchestration returns this instead of touching `reply` directly. */
export interface X402HandlerResult {
  code: number
  body: unknown
}
