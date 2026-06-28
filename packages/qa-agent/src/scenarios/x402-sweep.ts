/**
 * #420 invariant: when a merchant **verifies but does not settle**, the funds
 * Haven moved to the delegate are **recoverable** via the delegate sweep.
 *
 * Drives the demo-merchant's verify-without-settle product (set
 * `MERCHANT_SKIP_SETTLE_PRODUCT=storage_50gb`): Haven funds the delegate and the
 * merchant returns success without settling on-chain, leaving the delegate
 * holding the funds. Then `sweepDelegate()` reclaims them to the Safe, which the
 * scenario asserts.
 */

import { HavenClient } from '@haven_ai/sdk'
import { type Scenario, type ScenarioContext, pass, fail, skip } from './types.js'

const BASE_SEPOLIA_RPC = 'https://sepolia.base.org'

interface SweepTransfer {
  asset: string
  amount: string
  amountAtomic: string
  txHash: string
}

export const x402Sweep: Scenario = {
  name: 'x402-sweep-recovery',
  invariant:
    'Funds stranded on the delegate (merchant verified without settling) are reclaimable via sweep.',
  async run(ctx: ScenarioContext) {
    if (!ctx.cfg.demoMerchantUrl) {
      return skip('QA_DEMO_MERCHANT_URL not set — sweep recovery needs the demo-merchant')
    }

    const client = new HavenClient({
      apiKey: ctx.cfg.agentApiKey,
      delegateKey: ctx.delegateKey,
      baseUrl: ctx.cfg.apiUrl,
      chainRpcs: { 84532: BASE_SEPOLIA_RPC },
    })

    // storage_50gb is the merchant's verify-without-settle product: Haven funds
    // the delegate, the merchant verifies but does not settle → funds stranded.
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'buy_cloud_storage', arguments: { tier: '50gb' } },
    })
    const res = await client.fetch(mcpUrlOf(ctx), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body,
    })
    if (!res.ok) return fail(`verify-without-settle call failed: HTTP ${res.status}`)

    // The funds are now stranded on the delegate — reclaim them to the Safe.
    let sweep: { transfers?: SweepTransfer[] }
    try {
      sweep = (await client.sweepDelegate()) as { transfers?: SweepTransfer[] }
    } catch (e) {
      return fail(`sweepDelegate failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    const usdc = sweep.transfers?.find((t) => t.asset === 'USDC' && BigInt(t.amountAtomic || '0') > 0n)
    if (!usdc) {
      return fail(`no USDC reclaimed; sweep transfers: ${JSON.stringify(sweep.transfers ?? [])}`)
    }
    return pass(`stranded ${usdc.amount} USDC reclaimed to the Safe (tx ${usdc.txHash})`)
  },
}

function mcpUrlOf(ctx: ScenarioContext): string {
  return `${ctx.cfg.demoMerchantUrl}/mcp`
}
