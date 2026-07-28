/**
 * #946 invariant: a **delegation-rail** agent can pay an **EIP-3009-only**
 * merchant, through the two-leg interop bridge, without stranding funds.
 *
 * ## Why this scenario had to exist
 *
 * The reviewer promoted it to an acceptance criterion on #946 rather than
 * leaving it as follow-up, and named the gap exactly: *"today's x402-sweep
 * scenario only exercises the legacy rail."* That was still true — the daily
 * matrix ran five scenarios, all of them legacy AllowanceModule or erc7710,
 * while the 3009 bridge is the path with real merchant reach and the one that
 * deliberately reintroduces a hot balance. The rail with the most exposure had
 * the least live coverage.
 *
 * ## What it drives
 *
 * The same `HavenClient.fetch` an agent would use — no bridge-specific client
 * code, because there isn't any. The scheme is selected by the standard x402
 * payTo shape (payTo = the agent's own delegate EOA + merchantPayTo = the
 * merchant), which is why the live proof on 2026-07-18 needed zero SDK changes.
 * Haven redeems the budget delegation to fund the delegate EOA, the EOA signs a
 * standard EIP-3009 header, the facilitator settles EOA → merchant.
 *
 * ## The assertion that stops this passing vacuously
 *
 * A purchase succeeding proves almost nothing here: an erc7710-capable merchant
 * would also return a happy result, and the scenario would report green having
 * never touched the bridge. So it reads the payment evidence back and requires
 * the 3009 SHAPE:
 *
 *   - `challenge_payload.settlement_scheme === 'eip3009'` — the branch that ran.
 *   - `settlement_address === the delegate EOA` — Haven's own transfer went to
 *     the FUNDING target, not the merchant. This is the two-leg signature, and
 *     on erc7710 it is the merchant instead.
 *   - `merchant_address !== settlement_address` — the security model requires
 *     the merchant be recorded separately from the funding-transfer address, so
 *     a funding hop can never be read as a merchant payment.
 *
 * Together those are the "two legs, one intent" evidence row the review asked
 * for: a reader can tell funded-and-settled from funded-but-not-settled without
 * inferring it from balances.
 *
 * ## Residuals
 *
 * Exact-amount funding means a settled payment should leave the delegate EOA at
 * zero. The accepted criterion is *no stranding above the 1 USDC sweep floor*
 * (owner decision, 2026-07-18) — sub-floor dust is deliberate, since sweeping it
 * costs more gas than it recovers, but it must stay visible. This reports the
 * residual either way rather than asserting a bare zero.
 */

import { HavenClient } from '@haven_ai/sdk'
import { ethers } from 'ethers'
import { HavenApi, type MachinePaymentReceipt } from '../lib/haven-api.js'
import { type Scenario, type ScenarioContext, pass, fail, skip } from './types.js'

const BASE_SEPOLIA_RPC = 'https://sepolia.base.org'
// Circle's canonical Base Sepolia USDC (matches the SDK's CHAIN_USDC[84532]).
const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const USDC_ABI = ['function balanceOf(address) view returns (uint256)'] as const

/** The backend's default sweep floor; residue below it is dust by design. */
const DUST_FLOOR_ATOMIC = 1_000_000n // 1 USDC, 6 decimals

/**
 * The evidence row is written when the settlement proof is attached, which
 * happens after the merchant responds — so it is polled, not raced.
 *
 * Mutable purely as a TEST SEAM: the no-evidence-row cases are the ones worth
 * covering, and against real values every one of them would sit out the full
 * wait. Production never writes to this.
 */
export const TIMING = { evidenceWaitMs: 20_000, pollIntervalMs: 2_000 }

interface McpToolResult {
  isError?: boolean
  content?: Array<{ text?: string }>
}

const eq = (a?: string | null, b?: string | null): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()

/**
 * Poll for the receipt of THIS payment.
 *
 * Matched on the resource URL and 3009 shape rather than "the newest row",
 * because the newest row for this agent could be a previous run's. A scenario
 * that asserts against the wrong payment is worse than one that fails.
 */
async function waitForReceipt(
  api: HavenApi,
  resourceUrl: string,
  since: number,
): Promise<MachinePaymentReceipt | null> {
  const deadline = Date.now() + TIMING.evidenceWaitMs
  for (;;) {
    const { ok, data } = await api.listReceipts(10)
    if (ok && data.receipts) {
      const match = data.receipts.find(
        (r) =>
          r.resource_url === resourceUrl &&
          r.created_at !== undefined &&
          Date.parse(r.created_at) >= since,
      )
      if (match) return match
    }
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, TIMING.pollIntervalMs))
  }
}

export const x402Delegation3009: Scenario = {
  name: 'x402-delegation-3009',
  invariant:
    'A delegation-rail agent pays an EIP-3009-only merchant via the funding-leg bridge, ' +
    'with the two legs reconciling to one intent and no stranding above the dust floor.',
  async run(ctx: ScenarioContext) {
    if (!ctx.cfg.demoMerchantUrl) {
      return skip('QA_DEMO_MERCHANT_URL not set — the 3009 bridge needs the dev demo-merchant')
    }
    if (!ctx.cfg.delegationAgentApiKey || !ctx.cfg.delegationDelegateKey) {
      // Not a failure: the rail is a property of the ACCOUNT, so this needs a
      // second seeded identity (a delegation-rail agent with an OPEN budget
      // delegation) that an operator provisions. See docs/operations/agent-qa.md.
      return skip(
        'QA_DELEGATION_AGENT_API_KEY / QA_DELEGATION_DELEGATE_PRIVATE_KEY not set — ' +
          'the 3009 bridge needs a delegation-rail agent with an OPEN (unpinned) budget',
      )
    }

    const delegateAddress = new ethers.Wallet(ctx.cfg.delegationDelegateKey).address
    const client = new HavenClient({
      apiKey: ctx.cfg.delegationAgentApiKey,
      delegateKey: ctx.cfg.delegationDelegateKey,
      baseUrl: ctx.cfg.apiUrl,
      // The funding redemption must confirm before the merchant is retried, or
      // the facilitator's balanceOf(delegate) check sees nothing.
      chainRpcs: { 84532: BASE_SEPOLIA_RPC },
    })
    const api = new HavenApi(ctx.cfg, ctx.cfg.delegationAgentApiKey)
    const provider = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC)
    const fmt = (v: bigint) => ethers.formatUnits(v, 6)

    const mcpUrl = `${ctx.cfg.demoMerchantUrl}/mcp`
    const startedAt = Date.now()

    // buy_vpn basic (0.001 USDC) — the settling product, same as x402-settle.
    // storage_50gb is the merchant's verify-without-settle product and belongs
    // to the sweep scenario, not this one.
    const res = await client.fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'buy_vpn', arguments: { plan: 'basic' } },
      }),
    })

    if (res.status === 402) return fail('still HTTP 402 after payment — 3009 settlement did not complete')
    if (!res.ok) return fail(`merchant returned HTTP ${res.status} after payment`)

    const text = await res.text()
    let result: McpToolResult | undefined
    try {
      result = JSON.parse(text) as McpToolResult
    } catch {
      return fail(`unparseable merchant response: ${text.slice(0, 160)}`)
    }
    if (!result || result.isError) {
      const reason = result?.content?.[0]?.text ?? text
      return fail(`merchant tool returned an error: ${reason.slice(0, 140)}`)
    }

    // ── The payment succeeded. Now prove it was the 3009 bridge. ────────────
    const receipt = await waitForReceipt(api, mcpUrl, startedAt)
    if (!receipt) {
      return fail(
        `merchant accepted the payment but no evidence row appeared for ${mcpUrl} within ` +
          `${TIMING.evidenceWaitMs / 1000}s — the two legs cannot be reconciled to one intent`,
      )
    }

    const scheme = receipt.challenge_payload?.settlement_scheme
    if (scheme !== 'eip3009') {
      // The most important failure this scenario can report: it means the agent
      // took erc7710 (or the scheme was not recorded), so the bridge is
      // UNCOVERED while the daily run looks green.
      return fail(
        `payment settled but settlement_scheme was ${JSON.stringify(scheme) || 'absent'}, not "eip3009" — ` +
          `the 3009 bridge was not exercised (is the demo-merchant advertising erc7710, ` +
          `or is the agent's budget recipient-pinned?)`,
      )
    }

    if (!eq(receipt.settlement_address, delegateAddress)) {
      return fail(
        `settlement_address ${receipt.settlement_address} is not the delegate EOA ${delegateAddress} — ` +
          `on the 3009 bridge Haven's own transfer funds the EOA, so this is not the two-leg shape`,
      )
    }
    if (eq(receipt.merchant_address, receipt.settlement_address)) {
      return fail(
        `merchant_address equals settlement_address (${receipt.merchant_address}) — the funding hop ` +
          `is indistinguishable from a merchant payment, which the security model forbids`,
      )
    }

    // ── Residuals: exact-amount funding should leave nothing behind. ────────
    const usdc = new ethers.Contract(SEPOLIA_USDC, USDC_ABI, provider)
    const residual = (await usdc.balanceOf(delegateAddress)) as bigint
    if (residual >= DUST_FLOOR_ATOMIC) {
      return fail(
        `delegate EOA still holds ${fmt(residual)} USDC after settlement — at or above the ` +
          `${fmt(DUST_FLOOR_ATOMIC)} USDC sweep floor, so this is stranding, not dust`,
      )
    }

    const dust = residual > 0n ? `, ${fmt(residual)} USDC sub-floor dust left by design` : ', 0 residual'
    return pass(
      `delegation-rail agent paid an EIP-3009 merchant via the funding bridge ` +
        `(${receipt.amount_human ?? '?'} USDC, tx ${receipt.tx_hash ?? '?'}; funded ${delegateAddress}, ` +
        `merchant ${receipt.merchant_address})${dust}`,
    )
  },
}
