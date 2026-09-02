/**
 * #946 invariant: a **delegation-rail** agent can pay an **EIP-3009-only**
 * merchant, through the two-leg interop bridge, without stranding funds.
 *
 * ## Why this scenario had to exist
 *
 * The reviewer promoted it to an acceptance criterion on #946 rather than
 * leaving it as follow-up, and named the gap exactly: *"today's x402-sweep
 * scenario only exercises the legacy rail."* That was still true — the daily
 * matrix then ran five scenarios, all of them legacy AllowanceModule or
 * erc7710,
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
 * zero. The accepted criterion is *no stranding at or above the 0.01 USDC sweep
 * floor* — sub-floor balances remain visible until later stranded funds bring
 * them to the recovery threshold. This reports the residual either way rather
 * than asserting a bare zero.
 *
 * ## Dust is not the same question as delivery (#2444)
 *
 * The sweep floor answers *"is what is left negligible?"* It does not answer
 * *"has this scenario's own payment been delivered?"* — and for a long time this
 * scenario asked only the first. `buy_vpn/basic` costs 0.001 USDC, which is
 * below the 0.01 USDC floor, so a delegate still holding **the entire, wholly
 * undelivered payment** read as "sub-floor dust" and the scenario declared PASS
 * with the money still in flight. That is a false green about its own invariant,
 * and it also poisoned the neighbour: `x402-delegation-3009-grace-resume` runs
 * next against the *same* delegate EOA, and the late merchant leg landed inside
 * its measurement window (run 33640693154 — "merchant received 0.002 USDC;
 * expected 0.001").
 *
 * So the residual is measured against **two** thresholds, and against a
 * `delegateBefore` baseline so a previous run's leftovers are not attributed
 * here:
 *
 *   - **`caused >= funded` → undelivered.** The scenario's own payment is still
 *     sitting on the delegate. It is not dust at any floor — it is the whole
 *     transaction. Polled to `TIMING.deliveryWaitMs`, because the facilitator
 *     settles asynchronously and outside Haven's view; still there at the
 *     deadline is a failure.
 *   - **`caused >= DUST_FLOOR_ATOMIC` → stranding**, the pre-existing check.
 *
 * `classifyDelegateResidual` is exported so both thresholds can be pinned
 * without a live testnet run: the ordering defect reproduces only when the two
 * scenarios run adjacent against real money, which no unit test can stage.
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
import { merchant402Reason } from '../lib/merchant-402.js'
import { freshPurchaseIdempotencyKey } from '../lib/run-idempotency.js'
import { type Scenario, type ScenarioContext, pass, fail, skip } from './types.js'
import { BASE_SEPOLIA_RPC, SEPOLIA_USDC } from '../lib/chain.js'

// Circle's canonical Base Sepolia USDC (matches the SDK's CHAIN_USDC[84532]).
const USDC_ABI = ['function balanceOf(address) view returns (uint256)'] as const

/** The backend's default sweep floor; residue below it accumulates visibly. */
const DUST_FLOOR_ATOMIC = 10_000n // 0.01 USDC, 6 decimals

/**
 * The evidence row is written when the settlement proof is attached, which
 * happens after the merchant responds — so it is polled, not raced.
 *
 * Mutable purely as a TEST SEAM: the no-evidence-row cases are the ones worth
 * covering, and against real values every one of them would sit out the full
 * wait. Production never writes to this.
 */
/**
 * `deliveryWaitMs` is a BOUND, not a measurement (#2444).
 *
 * It could not be derived from real facilitator settlement latency: Base
 * Sepolia is rate-limited (#2449) and `qa-dev` moves testnet funds, so no live
 * run was available to measure against. It is instead bracketed by two
 * constants already in this harness — it equals this file's `evidenceWaitMs`,
 * and sits under the neighbouring `-grace-resume` scenario's `MONEY_WAIT_MS`
 * (30s) budget for observing the very same on-chain delivery.
 *
 * Know which way it fails. Too SHORT and this fix becomes a new flake source:
 * a perfectly good payment reported as "still in flight". Too long and it adds
 * dead time to a scenario that otherwise completes in seconds. It therefore
 * needs eyes on the first live run it meets — which is what #2444's
 * `operator-verify` checklist exists to collect.
 */
export const TIMING = { evidenceWaitMs: 20_000, pollIntervalMs: 2_000, deliveryWaitMs: 20_000 }

/**
 * How the delegate's post-settlement balance should be read (#2444).
 *
 * Pure and exported on purpose. The defect this encodes — a payment equal to
 * the scenario's own amount being waved through as sub-floor dust — only
 * reproduces end to end when this scenario and its `-grace-resume` neighbour
 * run adjacent against a live testnet. A unit test cannot stage that, but it
 * can pin the predicate that let it happen.
 *
 * `caused` is measured against the pre-payment baseline, so residue a previous
 * run stranded on the shared delegate EOA is not charged to this payment. A
 * baseline that *fell* (a neighbour's older balance was swept or delivered
 * during the window) clamps to zero rather than going negative.
 *
 * `funded` is the treasury delta — the amount the caveat-enforced redemption
 * actually moved — not `amount_human` from the evidence row, so the threshold
 * is the money that moved rather than the money Haven recorded.
 */
export interface ResidualVerdict {
  /** Delegate balance attributable to THIS payment. */
  caused: bigint
  /** This scenario's own payment has not left the delegate. Never dust. */
  undelivered: boolean
  /** At or above the sweep floor — stranding, whoever caused it. */
  stranded: boolean
  /** Below the floor and not this payment: rounding residue, reported not failed. */
  dust: boolean
}

export function classifyDelegateResidual(args: {
  residual: bigint
  baseline: bigint
  funded: bigint
}): ResidualVerdict {
  const raw = args.residual - args.baseline
  const caused = raw > 0n ? raw : 0n
  const undelivered = args.funded > 0n && caused >= args.funded
  const stranded = caused >= DUST_FLOOR_ATOMIC
  return { caused, undelivered, stranded, dust: caused > 0n && !undelivered && !stranded }
}

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
    // The delegate EOA is SHARED with the neighbouring scenarios, so anything
    // already on it belongs to an earlier payment. Without this baseline the
    // residual check below charges someone else's leftovers to this run (#2444).
    // Read as a pair, like every other paired balance read in these scenarios.
    const [treasuryBefore, delegateBefore] = (await Promise.all([
      usdc.balanceOf(treasury), usdc.balanceOf(delegateAddress),
    ])) as [bigint, bigint]

    // buy_vpn basic (0.001 USDC) — the settling product.
    // storage_50gb is the merchant's verify-without-settle product and belongs
    // to the sweep scenario, not this one.
    const res = await client.fetch(
      mcpUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'buy_vpn', arguments: { plan: 'basic' } },
        }),
      },
      // A distinct purchase, not a retry of a previous one (#1520). Without
      // this the SDK's 5-minute idempotency bucket collapses the workflow's
      // second attempt into the first — replaying an already-spent payment.
      { idempotencyKey: freshPurchaseIdempotencyKey('x402-delegation-3009') },
    )

    if (res.status === 402) {
      return fail(
        `still HTTP 402 after payment — 3009 settlement did not complete${await merchant402Reason(res)}`,
      )
    }
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
    // The merchant's 200 says the facilitator ACCEPTED the header; it does not
    // say the transfer has landed, and Haven never observes the merchant-side
    // settlement tx. So an undelivered leg is polled out rather than being
    // waved through as dust — see the header comment (#2444).
    const funded = treasuryBefore - treasuryAfter
    let residual = (await usdc.balanceOf(delegateAddress)) as bigint
    let verdict = classifyDelegateResidual({ residual, baseline: delegateBefore, funded })
    const deliveryDeadline = Date.now() + TIMING.deliveryWaitMs
    while (verdict.undelivered && Date.now() < deliveryDeadline) {
      await new Promise((resolve) => setTimeout(resolve, TIMING.pollIntervalMs))
      residual = (await usdc.balanceOf(delegateAddress)) as bigint
      verdict = classifyDelegateResidual({ residual, baseline: delegateBefore, funded })
    }

    if (verdict.undelivered) {
      return fail(
        `delegate EOA still holds ${fmt(verdict.caused)} USDC of this payment's own ${fmt(funded)} USDC ` +
          `after ${TIMING.deliveryWaitMs / 1000}s — the merchant leg has not settled, so the payment is ` +
          `still in flight. This is not sub-floor dust: it is the whole transaction, and passing here ` +
          `lets the late leg land inside the next scenario's measurement window (#2444)`,
      )
    }
    if (verdict.stranded) {
      return fail(
        `delegate EOA still holds ${fmt(verdict.caused)} USDC after settlement — at or above the ` +
          `${fmt(DUST_FLOOR_ATOMIC)} USDC sweep floor, so this is stranding, not dust`,
      )
    }

    const dust = verdict.dust
      ? `, ${fmt(verdict.caused)} USDC sub-floor dust left by design`
      : ', 0 residual'
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
