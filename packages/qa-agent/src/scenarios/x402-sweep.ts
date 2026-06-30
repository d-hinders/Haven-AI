/**
 * #420 invariant: when a merchant **verifies but does not settle**, the funds
 * Haven moved to the delegate are **recoverable** via the delegate sweep.
 *
 * Drives the demo-merchant's verify-without-settle product (set
 * `MERCHANT_SKIP_SETTLE_PRODUCT=storage_50gb`): Haven funds the delegate and the
 * merchant returns success without settling on-chain, leaving the delegate
 * holding the funds. Then `sweepDelegate()` reclaims them to the Safe.
 *
 * Reliability (#684, follow-up to #603): the funding tx (Safe → delegate) and the
 * RPC the sweep reads can be out of sync, so a bare `transfers: []` is ambiguous.
 * This scenario therefore (1) **waits for the stranded balance** to become visible
 * before sweeping — absorbing cross-RPC propagation lag — and (2) **classifies**
 * the outcome: no stranded balance → `skip` (merchant likely settled / misconfig),
 * a stranded balance the sweep failed to reclaim → `fail` with both balances.
 */

import { HavenClient } from '@haven_ai/sdk'
import { ethers } from 'ethers'
import { type Scenario, type ScenarioContext, pass, fail, skip } from './types.js'

const BASE_SEPOLIA_RPC = 'https://sepolia.base.org'
// Circle's canonical Base Sepolia USDC (matches the SDK's CHAIN_USDC[84532]).
const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const USDC_ABI = ['function balanceOf(address) view returns (uint256)'] as const

// Wait for the Safe → delegate funding tx to become visible on the RPC before
// deciding nothing was stranded. Absorbs cross-RPC propagation lag (#603/#684).
const STRAND_WAIT_MS = 20_000
const POLL_INTERVAL_MS = 2_000

interface SweepTransfer {
  asset: string
  amount: string
  amountAtomic: string
  txHash: string
}

async function readUsdc(provider: ethers.Provider, address: string): Promise<bigint> {
  const usdc = new ethers.Contract(SEPOLIA_USDC, USDC_ABI, provider)
  return (await usdc.balanceOf(address)) as bigint
}

/** Poll the delegate's USDC balance until it's stranded (> 0) or the wait elapses. */
async function waitForStrandedUsdc(provider: ethers.Provider, delegate: string): Promise<bigint> {
  const deadline = Date.now() + STRAND_WAIT_MS
  let balance = await readUsdc(provider, delegate)
  while (balance === 0n && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    balance = await readUsdc(provider, delegate)
  }
  return balance
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
    const provider = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC)
    const fmt = (v: bigint) => ethers.formatUnits(v, 6)

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

    // (#2) Wait for the stranded balance to become visible before sweeping. This
    // both absorbs the funding-tx propagation lag and tells us whether a balance
    // was produced at all.
    const strandedBefore = await waitForStrandedUsdc(provider, ctx.delegateAddress)
    if (strandedBefore === 0n) {
      // (#1) Distinguish "no stranded balance produced" from a real sweep failure.
      // A merchant that settled (or `MERCHANT_SKIP_SETTLE_PRODUCT` unset) is an
      // unmet precondition, not a sweep regression — skip rather than fail.
      return skip(
        `no stranded balance on the delegate after ${STRAND_WAIT_MS / 1000}s — the merchant ` +
          `likely settled instead of verify-without-settle (check ` +
          `MERCHANT_SKIP_SETTLE_PRODUCT=storage_50gb on the demo-merchant)`,
      )
    }

    // The funds are stranded on the delegate — reclaim them to the Safe.
    let sweep: { transfers?: SweepTransfer[] }
    try {
      sweep = (await client.sweepDelegate()) as { transfers?: SweepTransfer[] }
    } catch (e) {
      return fail(
        `sweepDelegate threw (delegate held ${fmt(strandedBefore)} USDC): ` +
          `${e instanceof Error ? e.message : String(e)}`,
      )
    }

    const reclaimed = sweep.transfers?.find(
      (t) => t.asset === 'USDC' && BigInt(t.amountAtomic || '0') > 0n,
    )
    if (!reclaimed) {
      // (#1) A genuine sweep failure: there WAS a stranded balance and the sweep
      // didn't move it. Report both balances so the cause is unambiguous.
      const after = await readUsdc(provider, ctx.delegateAddress)
      return fail(
        `sweep failed to reclaim an existing balance: delegate held ${fmt(strandedBefore)} USDC ` +
          `before sweep, ${fmt(after)} after; sweep transfers: ${JSON.stringify(sweep.transfers ?? [])}`,
      )
    }
    return pass(`stranded ${reclaimed.amount} USDC reclaimed to the Safe (tx ${reclaimed.txHash})`)
  },
}

function mcpUrlOf(ctx: ScenarioContext): string {
  return `${ctx.cfg.demoMerchantUrl}/mcp`
}
