/**
 * Shared types for the x402 module (#996, epic #980 M4). Extracted verbatim
 * from `routes/x402.ts` — no shape changes.
 */

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
