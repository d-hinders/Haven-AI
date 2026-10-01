/**
 * Merchant-locked budget, pinned-first selection (#3505, from #3331).
 *
 * A budget issued with `merchant_slug` is pinned by the SERVER to that
 * merchant's verified payTo. When an agent also holds an open budget for the
 * same token, a purchase from that merchant must spend the PINNED delegation
 * and leave the open one alone. Nothing in the suite proved that, and a
 * selection bug that drains the open budget while the pinned one sits full
 * would still settle every payment.
 *
 * So: a throwaway identity (open grant from provisioning), a second grant built
 * with `merchant_slug: 'haven-demo-store'` and activated with the owner key
 * client-side, then ONE settling purchase (NordShield VPN Basic, `buy_vpn`
 * basic) by erc7710. Asserted:
 *   1. the merchant qualifies at run time (`GET /merchants/:slug` funding:
 *      verified payTo, erc7710) and its live 402 names that same payTo — a
 *      merchant that does not qualify is a FAILURE with its cause, never a
 *      skip, because a skipped leg reads as coverage;
 *   2. the exact USDC Transfer treasury -> payTo, from the observer's logs;
 *   3. read by delegation HASH (`readOnchainBudget` is by symbol and cannot
 *      tell two USDC grants apart), the pinned delegation's live remaining
 *      dropped by exactly the amount and the open one did not move.
 *
 * Product: a SETTLING one, never CloudNest 50 GB (the verify-without-settle
 * fixture) — see x402-catalog-guided-purchase.
 */

import { ethers } from 'ethers'
import {
  BASE_SEPOLIA_CHAIN_ID,
  SEPOLIA_USDC,
  describeObserverRpc,
  observerProvider,
  proveUsdcTransferSince,
} from '../lib/chain.js'
import { readOnchainDelegationBudget } from '../lib/delegation-budget.js'
import { merchant402Reason } from '../lib/merchant-402.js'
import { MCP_HEADERS, decodeChallenge, mcpBody, readMcpOutcome } from '../lib/merchant-mcp.js'
import {
  payViaDelegation,
  signTyped,
  withThrowawayIdentity,
  type ThrowawayIdentity,
  type TypedData,
} from '../lib/throwaway-identity.js'
import { fail, pass, skip, type Scenario, type ScenarioContext, type ScenarioResult } from './types.js'

const CHAIN_ID = BASE_SEPOLIA_CHAIN_ID
const MERCHANT_SLUG = 'haven-demo-store'
const BUDGET_ATOMIC = '10000'
/** Covers one demo-merchant purchase (<= 0.0015) with margin; the rest strands on the throwaway. */
const FUND_HUMAN = '0.003'
export const TIMING = { transferWaitMs: 90_000, pollIntervalMs: 3_000, deployVisibleWaitMs: 30_000, catchUpBlocks: 2 }

interface FundingTarget {
  chain_id?: number
  pay_to?: string | null
  pay_to_status?: string
  erc7710?: boolean
}

export const merchantLockedBudget: Scenario = {
  name: 'merchant-locked-budget',
  invariant:
    'A merchant-locked budget is spent before the open budget for the same token: the pinned delegation ' +
    "drops by exactly the purchase amount, the open one does not move, and the USDC Transfer reaches the merchant's verified payTo.",
  async run(ctx: ScenarioContext) {
    const { demoMerchantUrl, delegationAgentApiKey, delegationDelegateKey } = ctx.cfg
    if (!demoMerchantUrl) {
      return skip('QA_DEMO_MERCHANT_URL not set — the merchant-locked leg buys from the dev demo-merchant')
    }
    if (!delegationAgentApiKey || !delegationDelegateKey) {
      return skip(
        'QA_DELEGATION_AGENT_API_KEY / QA_DELEGATION_DELEGATE_PRIVATE_KEY not set — ' +
          'the merchant-locked leg needs the standing identity only as its funding source',
      )
    }
    return withThrowawayIdentity(
      ctx.cfg.apiUrl,
      { chainId: CHAIN_ID, budgetAtomic: BUDGET_ATOMIC, label: 'merchant-lock' },
      (identity) => runMerchantLocked(ctx.cfg.apiUrl, identity, {
        demoMerchantUrl, apiKey: delegationAgentApiKey, delegateKey: delegationDelegateKey,
      }),
    )
  },
}

async function api<T extends Record<string, unknown>>(
  base: string,
  auth: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json().catch(() => ({}))) as T }
}

async function runMerchantLocked(
  base: string,
  identity: ThrowawayIdentity,
  standing: { demoMerchantUrl: string; apiKey: string; delegateKey: string },
): Promise<ScenarioResult> {
  // ── 1. The merchant must qualify NOW — a failure, never a skip ────────────
  const detail = await api<{ funding?: FundingTarget[]; error?: string }>(
    base, identity.agentApiKey, 'GET', `/merchants/${MERCHANT_SLUG}`,
  )
  if (detail.status !== 200) {
    return fail(`GET /merchants/${MERCHANT_SLUG} failed (${detail.status}): ${detail.json.error ?? ''} — the merchant-locked leg cannot run`)
  }
  const target = (detail.json.funding ?? []).find((t) => t.chain_id === CHAIN_ID)
  if (!target || !target.pay_to || target.pay_to_status !== 'verified' || target.erc7710 !== true) {
    return fail(
      `${MERCHANT_SLUG} does not qualify for a merchant-locked budget on chain ${CHAIN_ID}: funding target ` +
        `${JSON.stringify(target ?? null)} (needs a verified payTo and erc7710). This leg is not skipped — ` +
        'a skip would read as coverage; re-probe the merchant (its payTo / erc7710 offer) first',
    )
  }
  const payTo = target.pay_to

  // ── 2. The pinned grant, owner-signed client-side ─────────────────────────
  const built = await api<{
    delegation_hash?: string
    signing_payload?: TypedData
    error?: string
  }>(base, identity.token, 'POST', `/agents/${identity.agentId}/delegations/build`, {
    token_address: SEPOLIA_USDC,
    budget_atomic: BUDGET_ATOMIC,
    period_seconds: 86_400,
    merchant_slug: MERCHANT_SLUG,
  })
  const pinnedHash = built.json.delegation_hash
  const pinnedPayload = built.json.signing_payload
  if (built.status !== 201 || !pinnedHash || !pinnedPayload) {
    return fail(`merchant-locked grant build failed (${built.status}): ${built.json.error ?? ''}`)
  }
  if (pinnedHash.toLowerCase() === identity.grantHash.toLowerCase()) {
    return fail('the merchant-locked build returned the open grant — the pinned-vs-open selection would not be real')
  }
  const activated = await api<{ error?: string }>(
    base, identity.token, 'POST', `/agents/${identity.agentId}/delegations/${pinnedHash}/activate`,
    { signature: await signTyped(identity.owner, pinnedPayload) },
  )
  if (activated.status !== 200) {
    return fail(`merchant-locked grant activate failed (${activated.status}): ${activated.json.error ?? ''}`)
  }

  // ── 3. Both budgets read by hash BEFORE the purchase ──────────────────────
  const pinnedBefore = await readOnchainDelegationBudget(CHAIN_ID, pinnedHash, pinnedPayload.message, BUDGET_ATOMIC)
  if ('error' in pinnedBefore) return fail(`pinned grant live-read failed: ${pinnedBefore.error}`)
  const openBefore = await readOnchainDelegationBudget(CHAIN_ID, identity.grantHash, identity.grantDelegation, BUDGET_ATOMIC)
  if ('error' in openBefore) return fail(`open grant live-read failed: ${openBefore.error}`)

  // ── 4. Fund the throwaway treasury, then the 402 challenge ────────────────
  const funded = await payViaDelegation(base, standing.apiKey, standing.delegateKey, identity.accountAddress, FUND_HUMAN)
  if (!funded.ok) return fail(`funding the throwaway treasury failed: ${funded.error}`)

  const mcpUrl = `${standing.demoMerchantUrl}/mcp`
  const challengeRes = await fetch(mcpUrl, { method: 'POST', headers: MCP_HEADERS, body: mcpBody(1) })
  const challenge = decodeChallenge(challengeRes.headers.get('PAYMENT-REQUIRED'), await challengeRes.text())
  if (!challenge?.accepts?.length) return fail(`no x402 challenge from the merchant (HTTP ${challengeRes.status})`)
  const entry = challenge.accepts.find((e) => e.extra?.assetTransferMethod === 'erc7710')
  if (!entry) {
    return fail(
      'the demo merchant no longer advertises erc7710 on its live 402, though the catalog lists it as ' +
        'erc7710-capable — a merchant-locked budget could not be spent here (not skipped: see the leg header)',
    )
  }
  const amount = BigInt(entry.amount ?? '0')
  if (!entry.payTo || amount <= 0n) return fail(`unusable erc7710 accepts entry: ${JSON.stringify(entry).slice(0, 160)}`)
  if (entry.payTo.toLowerCase() !== payTo.toLowerCase()) {
    return fail(`the live 402 payTo ${entry.payTo} differs from ${MERCHANT_SLUG}'s verified payTo ${payTo}`)
  }

  const fromBlock = await observerProvider().getBlockNumber()

  // ── 5. Authorize (pinned-first selection), sign, settle, merchant retry ───
  const auth = await api<{
    payment_id?: string
    sign_data?: { signature_scheme?: string; typed_data?: TypedData }
    error?: string
  }>(base, identity.agentApiKey, 'POST', '/x402/authorize', {
    url: challenge.resource?.url ?? mcpUrl,
    payTo: entry.payTo,
    amount: amount.toString(),
    asset: entry.asset ?? SEPOLIA_USDC,
    network: entry.network ?? 'base-sepolia',
    maxTimeoutSeconds: entry.maxTimeoutSeconds,
    facilitatorAddresses: entry.extra?.facilitatorAddresses?.length ? entry.extra.facilitatorAddresses : undefined,
    paymentRequired: challenge,
  })
  const signData = auth.json.sign_data
  if (auth.status >= 300 || !auth.json.payment_id || signData?.signature_scheme !== 'eip712_delegation' || !signData.typed_data) {
    return fail(`authorize did not return an erc7710 child (${auth.status}): ${JSON.stringify(auth.json).slice(0, 200)}`)
  }
  // Authorize deployed the counterfactual delegate account on the BACKEND's
  // node (#1667). The merchant simulates the redemption on ITS node and checks
  // the child's signature by EIP-1271 only once the account has code there; a
  // node a block behind answers InvalidEOASignature (0x3db6791c). Poll the
  // observer for the code (#2445 pattern), then a couple of blocks of margin,
  // before the paid retry — so a lag fails here, named, not as a merchant error.
  if (!identity.delegateAccountAddress) {
    return fail('grant build returned no delegate_account_address — cannot confirm the deploy is visible before the paid retry')
  }
  const provider = observerProvider()
  const deployDeadline = Date.now() + TIMING.deployVisibleWaitMs
  for (const account of [identity.delegateAccountAddress, identity.accountAddress]) {
    for (;;) {
      if ((await provider.getCode(account)) !== '0x') break
      if (Date.now() >= deployDeadline) {
        return fail(
          `authorize returned 200 but the observer node [${describeObserverRpc()}] still reports no code at ${account} ` +
            `after ${TIMING.deployVisibleWaitMs / 1000}s — the observer node has not caught up with the deploy, so the ` +
            'paid retry was not sent (a merchant node this far behind would answer InvalidEOASignature, not a payment defect)',
        )
      }
      await new Promise((resolve) => setTimeout(resolve, TIMING.pollIntervalMs))
    }
  }
  const startBlock = await provider.getBlockNumber()
  while ((await provider.getBlockNumber()) < startBlock + TIMING.catchUpBlocks && Date.now() < deployDeadline) {
    await new Promise((resolve) => setTimeout(resolve, TIMING.pollIntervalMs))
  }

  const settle = await api<{ payment_header?: string; error?: string }>(
    base, identity.agentApiKey, 'POST', `/x402/${auth.json.payment_id}/settle`,
    { signature: await signTyped(identity.delegate, signData.typed_data) },
  )
  if (settle.status !== 200 || !settle.json.payment_header) {
    return fail(`settle failed (${settle.status}): ${JSON.stringify(settle.json).slice(0, 200)}`)
  }
  const paid = await fetch(mcpUrl, {
    method: 'POST',
    headers: { ...MCP_HEADERS, 'PAYMENT-SIGNATURE': settle.json.payment_header },
    body: mcpBody(2),
  })
  if (paid.status === 402) return fail(`merchant still returned 402 with the erc7710 header${await merchant402Reason(paid)}`)
  const outcome = readMcpOutcome(await paid.text())
  if (outcome.rejection !== undefined) return fail(`merchant rejected the payment: ${outcome.rejection.slice(0, 160)}`)
  if (!outcome.served) return fail('merchant response unparseable')

  // ── 6. The exact Transfer, then the two delegations by hash ───────────────
  const transfer = await proveUsdcTransferSince(
    { from: identity.accountAddress, to: payTo, amount },
    { fromBlock, timeoutMs: TIMING.transferWaitMs, intervalMs: TIMING.pollIntervalMs },
  )
  if (!transfer.ok) return fail(`no exact treasury→merchant Transfer: ${transfer.error}`)

  const pinnedAfter = await readOnchainDelegationBudget(CHAIN_ID, pinnedHash, pinnedPayload.message, BUDGET_ATOMIC)
  if ('error' in pinnedAfter) return fail(`pinned grant live-read after the purchase failed: ${pinnedAfter.error}`)
  const openAfter = await readOnchainDelegationBudget(CHAIN_ID, identity.grantHash, identity.grantDelegation, BUDGET_ATOMIC)
  if ('error' in openAfter) return fail(`open grant live-read after the purchase failed: ${openAfter.error}`)

  const pinnedDrop = pinnedBefore.remaining - pinnedAfter.remaining
  const openDrop = openBefore.remaining - openAfter.remaining
  if (openDrop !== 0n) {
    return fail(
      `the OPEN delegation ${identity.grantHash} dropped by ${openDrop} (pinned dropped by ${pinnedDrop}) — ` +
        `the purchase from ${MERCHANT_SLUG} spent the open budget instead of the merchant-locked one`,
    )
  }
  if (pinnedDrop !== amount) {
    return fail(
      `the pinned delegation ${pinnedHash} dropped by ${pinnedDrop}, expected exactly ${amount} ` +
        `(before ${pinnedBefore.remaining}, after ${pinnedAfter.remaining})`,
    )
  }

  return pass(
    `purchase of ${ethers.formatUnits(amount, 6)} USDC from ${MERCHANT_SLUG} paid treasury→${payTo} (tx ${transfer.txHash}); ` +
      `pinned delegation ${pinnedHash} dropped by exactly ${amount}, open delegation ${identity.grantHash} unchanged at ${openAfter.remaining}`,
  )
}
