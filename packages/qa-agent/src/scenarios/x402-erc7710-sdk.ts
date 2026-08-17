/**
 * erc7710 direct settlement THROUGH THE SDK (#1457, epic #1450).
 *
 * WHAT THIS PROVES THAT NO OTHER LEG DOES. `x402-erc7710-settle` drives the
 * RAW API — its own header says the SDK deliberately plays no part — so it
 * pins the merchant-facing contract that external integrators build against,
 * and nothing about the code Haven's own users run. That was accurate until
 * #1452-#1454 gave `HavenClient` an erc7710 path; from then on the gap became
 * invisible, because the raw leg stays green whether or not the SDK works.
 *
 * This leg drives `HavenClient.settleX402Erc7710()` end to end: select the
 * scheme from the merchant's advertisement, authorize with the merchant as
 * payTo, sign the settlement child, settle, retry the merchant, and check the
 * money. Keep BOTH legs — they prove different surfaces.
 *
 * NOT the hosted topology. #1457's acceptance criteria ask for hosted MCP +
 * local signer, which cannot exist until #1456 wires erc7710 through the tool
 * surface. A scenario written against that today would skip forever and read
 * like coverage. When #1456 lands, add the hosted variant beside this one
 * rather than converting it — the SDK path stays worth pinning on its own.
 *
 * THE ASSERTION THAT MATTERS is not a 200. It is that the delegate EOA's
 * balance is unchanged: erc7710 has no funding leg, and a silent reroute to
 * the EIP-3009 bridge would still deliver the goods while moving money through
 * the delegate. That reroute is exactly what this leg exists to fail on.
 */

import { ethers } from 'ethers'
import { HavenClient } from '@haven_ai/sdk'
import { type Scenario, type ScenarioContext, pass, fail, skip } from './types.js'

const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const BASE_SEPOLIA_RPC = 'https://sepolia.base.org'
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)']
const SETTLE_WAIT_MS = 120_000
const POLL_MS = 3_000

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
}

function mcpBody(id: number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'buy_vpn', arguments: { plan: 'basic' } },
  })
}

interface McpToolResult {
  isError?: boolean
  content?: Array<{ text?: string }>
}

export const x402Erc7710Sdk: Scenario = {
  name: 'x402-erc7710-sdk',
  invariant:
    'A delegation-rail agent pays a 7710 merchant through HavenClient with no funding leg: ' +
    'treasury debited exactly, merchant credited exactly, delegate EOA untouched.',
  async run(ctx: ScenarioContext) {
    if (!ctx.cfg.demoMerchantUrl) {
      return skip('QA_DEMO_MERCHANT_URL not set — the SDK erc7710 leg needs the dev demo-merchant')
    }
    if (!ctx.cfg.delegationAgentApiKey || !ctx.cfg.delegationDelegateKey) {
      return skip(
        'delegation-rail QA identity unset — set QA_DELEGATION_AGENT_API_KEY + ' +
          'QA_DELEGATION_DELEGATE_PRIVATE_KEY (see docs/operations/agent-qa.md)',
      )
    }

    const mcpUrl = `${ctx.cfg.demoMerchantUrl}/mcp`
    const haven = new HavenClient({
      baseUrl: ctx.cfg.apiUrl,
      apiKey: ctx.cfg.delegationAgentApiKey,
      delegateKey: ctx.cfg.delegationDelegateKey,
    })
    const delegate = new ethers.Wallet(ctx.cfg.delegationDelegateKey)
    const rpc = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC)
    const usdc = new ethers.Contract(SEPOLIA_USDC, ERC20_ABI, rpc)

    // ── 1. The merchant's 402, and its erc7710 advertisement ─────────────────
    const challengeRes = await fetch(mcpUrl, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: mcpBody(1),
    })
    if (challengeRes.status !== 402) {
      return fail(`merchant did not answer 402 (got ${challengeRes.status})`)
    }
    const challenge = JSON.parse(await challengeRes.text()) as {
      accepts?: Array<{ payTo?: string; amount?: string; extra?: Record<string, unknown> }>
      resource?: { url?: string }
    }
    const entry = challenge.accepts?.find((a) => a.extra?.assetTransferMethod === 'erc7710')
    if (!entry) {
      // Under the #1066 completeness gate this skip FAILS the run — deliberately:
      // once the rail exists, a 3009-only merchant means the dev env regressed.
      return skip(
        'demo-merchant does not advertise erc7710 — set MERCHANT_X402_ERC7710=1 + ' +
          'MERCHANT_ERC7710_DELEGATION_MANAGER on the dev merchant (see dev-environment.md)',
      )
    }
    const merchant = entry.payTo
    const amountAtomic = BigInt(entry.amount ?? '0')
    if (!merchant || amountAtomic <= 0n) {
      return fail(`unusable erc7710 accepts entry: ${JSON.stringify(entry).slice(0, 160)}`)
    }

    // ── 2. Baselines, including the one the whole leg turns on ───────────────
    const agent = await haven.getAgent()
    const treasury = agent.safeAddress
    if (!treasury) return fail("could not read the agent's account address")
    if (agent.executionRail !== 'delegation') {
      return skip(`QA delegation identity is on the '${agent.executionRail}' rail, not delegation`)
    }
    const [treasuryBefore, merchantBefore, delegateBefore] = (await Promise.all([
      usdc.balanceOf(treasury),
      usdc.balanceOf(merchant),
      usdc.balanceOf(delegate.address),
    ])) as [bigint, bigint, bigint]

    // ── 3. The SDK does the whole dance: select → authorize → sign → settle ──
    let settlement
    try {
      settlement = await haven.settleX402Erc7710(challenge as never, {
        resourceUrl: challenge.resource?.url ?? mcpUrl,
      })
    } catch (err) {
      return fail(`settleX402Erc7710 failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    // A silent reroute to the 3009 bridge is the regression this leg exists to
    // catch, so the scheme is asserted rather than inferred from success.
    if (settlement.merchantPayTo.toLowerCase() !== merchant.toLowerCase()) {
      return fail(
        `settlement targeted ${settlement.merchantPayTo}, not the merchant ${merchant} — ` +
          'the payTo shape selects the scheme, so this means the funding leg was taken',
      )
    }

    // ── 4. Merchant retry with the backend-assembled header ──────────────────
    const paid = await fetch(mcpUrl, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'X-PAYMENT': settlement.paymentHeader },
      body: mcpBody(2),
    })
    if (paid.status === 402) return fail('merchant still returned 402 with the erc7710 header')
    const paidText = await paid.text()
    let served = false
    for (const line of paidText.split('\n')) {
      const idx = line.indexOf('{')
      if (idx === -1) continue
      try {
        const parsed = JSON.parse(line.slice(idx)) as { result?: McpToolResult }
        if (parsed.result?.isError) {
          return fail(
            `merchant rejected the erc7710 payment: ${(parsed.result.content?.[0]?.text ?? '').slice(0, 160)}`,
          )
        }
        if (parsed.result) served = true
      } catch {
        /* keep scanning */
      }
    }
    if (!served) return fail(`merchant response unparseable: ${paidText.slice(0, 160)}`)

    // ── 5. The money proof ───────────────────────────────────────────────────
    const deadline = Date.now() + SETTLE_WAIT_MS
    let treasuryAfter = treasuryBefore
    let merchantAfter = merchantBefore
    for (;;) {
      ;[treasuryAfter, merchantAfter] = (await Promise.all([
        usdc.balanceOf(treasury),
        usdc.balanceOf(merchant),
      ])) as [bigint, bigint]
      if (treasuryAfter !== treasuryBefore || Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    const delegateAfter = (await usdc.balanceOf(delegate.address)) as bigint
    const fmt = (v: bigint) => ethers.formatUnits(v, 6)

    if (treasuryBefore - treasuryAfter !== amountAtomic) {
      return fail(
        `treasury moved ${fmt(treasuryBefore - treasuryAfter)} USDC, expected exactly ` +
          `${fmt(amountAtomic)} — the budget delegation was not the settlement source`,
      )
    }
    if (merchantAfter - merchantBefore !== amountAtomic) {
      return fail(
        `merchant received ${fmt(merchantAfter - merchantBefore)} USDC, expected exactly ${fmt(amountAtomic)}`,
      )
    }
    // THE assertion. A 3009 reroute would still deliver the goods and still
    // debit the treasury — it would just move the money through the delegate.
    if (delegateAfter !== delegateBefore) {
      return fail(
        `delegate EOA balance changed ${fmt(delegateBefore)} → ${fmt(delegateAfter)} — ` +
          'erc7710 has no funding leg, so this means the payment took the EIP-3009 bridge',
      )
    }

    return pass(
      `erc7710 via HavenClient: treasury ${fmt(treasuryBefore)} → ${fmt(treasuryAfter)} paid the ` +
        `merchant exactly ${fmt(amountAtomic)} USDC; delegate EOA untouched (${fmt(delegateAfter)}); ` +
        `payment ${settlement.paymentId}`,
    )
  },
}
