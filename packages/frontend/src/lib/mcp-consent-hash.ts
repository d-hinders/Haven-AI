/**
 * Frontend mirror of packages/mcp/src/consent.ts → computeConsentHash.
 *
 * Computes the same 16-hex-char consent hash that the MCP server uses so the
 * frontend can embed HAVEN_MCP_ACK=<hash> directly in the generated config
 * snippets. This eliminates the terminal `--ack` step: the user reviews and
 * accepts the agent's tools and allowances in the UI (which is the real
 * consent moment) and the hash is pre-embedded so the server starts without
 * prompting.
 *
 * IMPORTANT: keep this in sync with packages/mcp/src/consent.ts.
 *
 * Hash inputs (all available at credential-creation time):
 *   - api_key prefix (first 12 chars)
 *   - api_url
 *   - agent_id
 *   - safe_address (lowercased)
 *   - delegate_address (lowercased)
 *   - chain_id
 *   - sorted canonical tool name list (all 11 registered tools — static)
 *   - sorted canonical allowance list  (from budget_summary snapshot)
 *
 * The hash invalidates whenever tools, allowances, or credential identity
 * change — same invalidation semantics as the sidecar-file approach.
 */

import type { AgentCredentialJson } from './agent-credential'

/**
 * All tool names registered by the MCP server. Keep in sync with
 * packages/mcp/src/tools.ts → HavenMcpToolName.
 */
const MCP_TOOL_NAMES = [
  'haven_quote_x402',
  'haven_pay_x402_quote',
  'haven_resume_x402_payment',
  'haven_quote_mpp',
  'haven_pay_mpp_challenge',
  'haven_resume_mpp_payment',
  'haven_get_payment_status',
  'haven_get_resume_state',
  'haven_get_agent',
  'haven_get_allowances',
  'haven_list_receipts',
] as const

async function sha256Hex(message: string): Promise<string> {
  const data = new TextEncoder().encode(message)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Compute the MCP consent hash for the given credential.
 *
 * Mirrors consent.ts → computeConsentHash. Uses Web Crypto (available in
 * all modern browsers and Node.js 15+) so no extra dependencies are needed.
 */
export async function computeMcpConsentHash(cred: AgentCredentialJson): Promise<string> {
  const toolCanonical = [...MCP_TOOL_NAMES].sort().join(',')

  const allowanceCanonical = [...cred.budget_summary]
    .map((a) => {
      // reset_period_min: 0 means no reset in Haven policy; treat as null in
      // the canonical string to match the server's null → 'none' mapping.
      const resetStr = a.reset_period_min === 0 ? 'none' : String(a.reset_period_min)
      return `${a.token}:${a.amount}:${resetStr}`
    })
    .sort()
    .join('|')

  const identity = [
    cred.api_key.slice(0, 12),
    cred.api_url ?? '',
    cred.agent_id,
    cred.safe_address.toLowerCase(),
    cred.delegate_address.toLowerCase(),
    cred.chain_id,
  ].join('|')

  const message = `${identity}\n${toolCanonical}\n${allowanceCanonical}`
  const hex = await sha256Hex(message)
  return hex.slice(0, 16)
}
