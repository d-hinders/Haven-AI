/**
 * Reading an x402 challenge off the demo-merchant's MCP transport, shared by
 * the erc7710 legs (#1674 absorbed this out of x402-erc7710-settle).
 *
 * The merchant can carry the challenge two ways: base64 (or plain) JSON in
 * the `PAYMENT-REQUIRED` header, or in-band in the SSE body — where it sits
 * somewhere inside a JSON-RPC envelope, hence the recursive `accepts` hunt
 * rather than a fixed path.
 */

export interface AcceptsEntry {
  scheme?: string
  amount?: string
  payTo?: string
  asset?: string
  network?: string
  maxTimeoutSeconds?: number
  extra?: { assetTransferMethod?: string; facilitatorAddresses?: string[] }
}

export interface PaymentRequired {
  accepts?: AcceptsEntry[]
  resource?: { url?: string }
}

export interface McpToolResult {
  isError?: boolean
  content?: Array<{ text?: string }>
}

export const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
}

export function mcpBody(id: number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'buy_vpn', arguments: { plan: 'basic' } },
  })
}

export function decodeChallenge(headerValue: string | null, bodyText: string): PaymentRequired | null {
  if (headerValue) {
    try {
      return JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8')) as PaymentRequired
    } catch {
      try {
        return JSON.parse(headerValue) as PaymentRequired
      } catch {
        /* fall through to the body */
      }
    }
  }
  // MCP transport can carry the challenge in-band; find the first JSON object
  // with an `accepts` array in the SSE data lines.
  for (const line of bodyText.split('\n')) {
    const idx = line.indexOf('{')
    if (idx === -1) continue
    try {
      const parsed = JSON.parse(line.slice(idx)) as Record<string, unknown>
      const candidate = JSON.stringify(parsed).includes('"accepts"')
        ? (findAccepts(parsed) as PaymentRequired | null)
        : null
      if (candidate) return candidate
    } catch {
      /* not JSON — keep scanning */
    }
  }
  return null
}

export function findAccepts(node: unknown): unknown {
  if (!node || typeof node !== 'object') return null
  const record = node as Record<string, unknown>
  if (Array.isArray(record.accepts)) return record
  for (const value of Object.values(record)) {
    const hit = findAccepts(value)
    if (hit) return hit
  }
  return null
}

/**
 * Scan a paid MCP response for the tool result: served, rejected (with the
 * merchant's own reason), or unparseable.
 */
export function readMcpOutcome(bodyText: string): { served: boolean; rejection?: string } {
  for (const line of bodyText.split('\n')) {
    const idx = line.indexOf('{')
    if (idx === -1) continue
    try {
      const parsed = JSON.parse(line.slice(idx)) as { result?: McpToolResult }
      if (parsed.result?.isError) {
        return { served: false, rejection: parsed.result.content?.[0]?.text ?? '' }
      }
      if (parsed.result) return { served: true }
    } catch {
      /* keep scanning */
    }
  }
  return { served: false }
}
