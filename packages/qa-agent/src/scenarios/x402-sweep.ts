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

import { HavenClient, buildSweepTypedData } from '@haven_ai/sdk'
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

// The x402 funding leg (Safe → delegate) can revert on a stale allowance nonce
// when a prior transfer's nonce increment hasn't propagated to the backend's RPC
// (#692). The backend preflight (#693) makes that a clean no-op — no transfer
// landed — so retrying after a short delay (to let the nonce propagate) is safe
// and cannot double-fund.
const FUNDING_RETRY_ATTEMPTS = 3
const FUNDING_RETRY_DELAY_MS = 6_000
const STALE_NONCE_RE = /stale allowance nonce|allowance transfer would revert/i

async function fetchWithFundingRetry(
  client: HavenClient,
  url: string,
  init: Parameters<HavenClient['fetch']>[1],
): Promise<Awaited<ReturnType<HavenClient['fetch']>>> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= FUNDING_RETRY_ATTEMPTS; attempt++) {
    try {
      return await client.fetch(url, init)
    } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : String(e)
      // Only the stale-nonce funding race is retry-safe; anything else is real.
      if (!STALE_NONCE_RE.test(msg) || attempt === FUNDING_RETRY_ATTEMPTS) throw e
      await new Promise((resolve) => setTimeout(resolve, FUNDING_RETRY_DELAY_MS))
    }
  }
  throw lastErr
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
    const res = await fetchWithFundingRetry(client, mcpUrlOf(ctx), {
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

    // Gasless sweep (#684): the delegate signs an EIP-3009 transferWithAuthorization
    // off-chain and the Haven relayer submits it (pays gas). This works for a
    // gasless delegate (no ETH needed) and matches the production sweep path —
    // unlike sweepDelegate()'s direct ERC-20 transfer, which needs the delegate to
    // hold gas and so can never sweep a Haven delegate.
    let prep
    try {
      prep = await client.prepareSweep()
    } catch (e) {
      return fail(
        `prepareSweep failed (delegate held ${fmt(strandedBefore)} USDC): ` +
          `${e instanceof Error ? e.message : String(e)}`,
      )
    }

    if (prep.nothing_stranded || !prep.authorization) {
      // We saw a balance on our RPC but the backend's read found none — a
      // backend↔harness RPC discrepancy, not a clean recovery.
      return fail(
        `backend reported nothing stranded, but the delegate held ${fmt(strandedBefore)} USDC ` +
          `on ${BASE_SEPOLIA_RPC}`,
      )
    }

    const typed = buildSweepTypedData(prep.authorization)
    const signature = await new ethers.Wallet(ctx.delegateKey).signTypedData(
      typed.domain,
      typed.types as unknown as Record<string, ethers.TypedDataField[]>,
      typed.message,
    )

    let submitted: Awaited<ReturnType<HavenClient['submitSweep']>>
    try {
      submitted = await client.submitSweep(prep.authorization, signature)
    } catch (e) {
      // (#1) A genuine sweep failure: there WAS a stranded balance and the relayer
      // couldn't move it. Report both balances so the cause is unambiguous.
      const after = await readUsdc(provider, ctx.delegateAddress)
      return fail(
        `gasless sweep submit failed (delegate held ${fmt(strandedBefore)} USDC before, ` +
          `${fmt(after)} after): ${e instanceof Error ? e.message : String(e)}`,
      )
    }

    return pass(
      `stranded ${submitted.amount} USDC reclaimed to the Safe via gasless sweep (tx ${submitted.tx_hash})`,
    )
  },
}

function mcpUrlOf(ctx: ScenarioContext): string {
  return `${ctx.cfg.demoMerchantUrl}/mcp`
}
