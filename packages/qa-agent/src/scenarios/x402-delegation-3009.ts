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
 *   - `settlement_scheme === 'eip3009'` — the branch that ran (from the intent,
 *     joined into the evidence row; challenge_payload is the raw 402 body).
 *   - `settlement_address === the delegate EOA` — Haven's own transfer went to
 *     the FUNDING target, not the merchant. This is the two-leg signature, and
 *     on erc7710 it is the merchant instead.
 *   - `merchant_address !== settlement_address` — the security model requires
 *     the merchant be recorded separately from the funding-transfer address, so
 *     a funding hop can never be read as a merchant payment.
 *
 * ## Three signals, not one — and the evidence row is only one of them
 *
 * An earlier version of this comment claimed the evidence row alone lets a
 * reader tell funded-and-settled from funded-but-not-settled "without inferring
 * it from balances", which the code immediately below it contradicted by
 * reading a balance. The honest split:
 *
 *   - **The evidence row** proves WHICH SCHEME funded this, and that the
 *     funding target and the merchant were recorded as distinct addresses.
 *   - **The merchant's HTTP status** proves whether it SETTLED. The evidence
 *     row cannot: Haven never observes a merchant-side settlement tx on either
 *     rail, since the facilitator settles outside Haven's view.
 *   - **The two balance reads** prove the money actually moved — the treasury
 *     went down by the amount, and nothing above the dust floor stayed on the
 *     delegate EOA.
 *
 * All three are needed. Any one of them alone can be satisfied by a payment
 * that did something other than what this scenario claims to cover.
 *
 * ## Balances
 *
 * The treasury must DECREASE by the paid amount — #946's acceptance criteria
 * name budget decrement explicitly, and the address checks above would happily
 * pass for a funding hop that never actually spent the delegation. This is the
 * cheapest honest proxy: the caveat-enforced redemption is what moves treasury
 * USDC, so a treasury that did not move means the budget was not metered.
 *
 * Exact-amount funding then means a settled payment leaves the delegate EOA at
 * zero. The accepted criterion is *no stranding above the 1 USDC sweep floor*
 * (owner decision, 2026-07-18) — sub-floor dust is deliberate, since sweeping it
 * costs more gas than it recovers, but it must stay visible. This reports the
 * residual either way rather than asserting a bare zero.
 *
 * ## What this scenario does NOT cover
 *
 * The verify-without-settle → sweep half of the bridge. That is
 * `x402-delegation-3009-sweep`, a separate scenario — the two need different
 * merchant products and assert different outcomes, and folding them together
 * would produce a test that passes when either half works.
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

/** Receipt ids that already existed, so a later row can be identified as new. */
export async function receiptBaseline(api: HavenApi): Promise<Set<string>> {
  const { ok, data } = await api.listReceipts(25)
  const ids = new Set<string>()
  if (ok && data.receipts) {
    for (const r of data.receipts) if (r.payment_id) ids.add(r.payment_id)
  }
  return ids
}

/**
 * Poll for the receipt of THIS payment.
 *
 * Identified as "a row for this resource whose id was not in the baseline",
 * deliberately NOT by timestamp. An earlier version compared the row's
 * server-generated `created_at` against the runner's own `Date.now()`, which
 * makes the scenario depend on two clocks agreeing: a runner running a few
 * seconds ahead of the backend would reject every genuinely-fresh row and
 * report "no evidence row appeared", sending an operator to debug the bridge
 * when the real fault is NTP. Set membership has no such failure mode.
 *
 * It must not be "the newest row" either — that would let a previous run's
 * payment satisfy this run's assertions.
 */
async function waitForReceipt(
  api: HavenApi,
  resourceUrl: string,
  baseline: Set<string>,
): Promise<MachinePaymentReceipt | null> {
  const deadline = Date.now() + TIMING.evidenceWaitMs
  for (;;) {
    const { ok, data } = await api.listReceipts(25)
    if (ok && data.receipts) {
      const match = data.receipts.find(
        (r) => r.resource_url === resourceUrl && !!r.payment_id && !baseline.has(r.payment_id),
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
    const usdc = new ethers.Contract(SEPOLIA_USDC, USDC_ABI, provider)

    // Captured BEFORE the payment: the receipt ids that already exist, and the
    // treasury balance the redemption must reduce. Both are baselines, so
    // neither depends on the runner's clock agreeing with the backend's.
    const baseline = await receiptBaseline(api)
    const agentInfo = await api.getAgent()
    const treasury = agentInfo.data.safe_address
    if (!treasury) {
      return fail('could not read the agent\'s account address from GET /machine-payments/agent')
    }
    const treasuryBefore = (await usdc.balanceOf(treasury)) as bigint

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
    const receipt = await waitForReceipt(api, mcpUrl, baseline)
    if (!receipt) {
      return fail(
        `merchant accepted the payment but no NEW evidence row appeared for ${mcpUrl} within ` +
          `${TIMING.evidenceWaitMs / 1000}s — the funding leg cannot be tied to this payment`,
      )
    }

    const scheme = receipt.settlement_scheme
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

    // ── The budget was actually metered (#946 AC: "budget correctly decremented").
    // The address checks above would pass just as happily for a funding hop that
    // never spent the delegation. Treasury USDC only moves through the
    // caveat-enforced redemption, so a treasury that did not move means the
    // budget was not metered.
    const treasuryAfter = (await usdc.balanceOf(treasury)) as bigint
    if (treasuryAfter >= treasuryBefore) {
      return fail(
        `treasury ${treasury} did not decrease (${fmt(treasuryBefore)} → ${fmt(treasuryAfter)} USDC) — ` +
          `the funding leg was recorded but the budget delegation was not metered`,
      )
    }

    // ── Residuals: exact-amount funding should leave nothing behind. ────────
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
        // `tx_hash` is the FUNDING redemption's hash, always. Haven never records
        // a merchant-side settlement tx on either rail — the facilitator settles
        // outside its view — so labelling it plainly "tx" would invite the wrong
        // reading.
        `(${receipt.amount_human ?? '?'} USDC, funding tx ${receipt.tx_hash ?? '?'}; ` +
        `treasury ${fmt(treasuryBefore)} → ${fmt(treasuryAfter)}, funded ${delegateAddress}, ` +
        `merchant ${receipt.merchant_address})${dust}`,
    )
  },
}
