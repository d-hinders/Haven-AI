/**
 * #420 invariant: a within-budget **x402 call settles** end-to-end through the
 * merchant round-trip.
 *
 * Drives the dev demo-merchant (an MCP-over-x402 server) with the SDK's
 * `HavenClient.fetch`, which does the whole dance: MCP handshake → 402 → fund the
 * delegate from the Safe (AllowanceModule) → sign the EIP-3009 authorization with
 * the delegate key → retry with the payment → the merchant settles on-chain.
 * Asserts the purchase succeeds (a non-error MCP tool result), i.e. money moved
 * and the merchant accepted it.
 */

import { HavenClient } from '@haven_ai/sdk'
import { type Scenario, type ScenarioContext, pass, fail, skip } from './types.js'

const BASE_SEPOLIA_RPC = 'https://sepolia.base.org'

interface McpToolResult {
  isError?: boolean
  content?: Array<{ text?: string }>
}

export const x402Settle: Scenario = {
  name: 'x402-settle',
  invariant: 'A within-budget x402 call settles end-to-end through the merchant round-trip.',
  async run(ctx: ScenarioContext) {
    if (!ctx.cfg.demoMerchantUrl) {
      return skip('QA_DEMO_MERCHANT_URL not set — x402 settle needs the dev demo-merchant')
    }

    const client = new HavenClient({
      apiKey: ctx.cfg.agentApiKey,
      delegateKey: ctx.delegateKey,
      baseUrl: ctx.cfg.apiUrl,
      // Wait for the AllowanceModule funding tx to confirm before retrying the
      // merchant, so its balanceOf(delegate) sees the funds.
      chainRpcs: { 84532: BASE_SEPOLIA_RPC },
    })

    const mcpUrl = `${ctx.cfg.demoMerchantUrl}/mcp`
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      // Cheapest product (0.0005 USDC) — comfortably within the QA allowance.
      params: { name: 'buy_cloud_storage', arguments: { tier: '50gb' } },
    })

    const res = await client.fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body,
    })

    if (res.status === 402) return fail('still HTTP 402 after payment — settlement did not complete')
    if (!res.ok) return fail(`merchant returned HTTP ${res.status} after payment`)

    const text = await res.text()
    let result: McpToolResult | undefined
    try {
      // HavenClient.fetch already unwraps the MCP JSON-RPC envelope, so the body
      // is the tool result itself ({ content, isError? }).
      result = JSON.parse(text) as McpToolResult
    } catch {
      return fail(`unparseable merchant response: ${text.slice(0, 160)}`)
    }
    if (!result || result.isError) {
      const reason = result?.content?.[0]?.text ?? text
      return fail(`merchant tool returned an error: ${reason.slice(0, 140)}`)
    }

    const confirmation = (result.content?.[0]?.text ?? 'purchased').replace(/\s+/g, ' ').trim().slice(0, 80)
    return pass(`x402 paid + settled via merchant: ${confirmation}`)
  },
}
