/**
 * #2159: reproduce the #2145 crash shape against dev without manufacturing a
 * merchant-side shortcut. The funding leg completes, then this scenario does
 * NOT send the merchant retry. The backend must derive the recovery verdict
 * from that absence; the SDK then resumes the original request through its
 * next_action gate.
 */

import { HavenClient, buildSweepTypedData, signUserOpTypedDataForDelegation } from '@haven_ai/sdk'
import { ethers } from 'ethers'
import { HavenApi } from '../lib/haven-api.js'
import { BASE_SEPOLIA_RPC, SEPOLIA_USDC } from '../lib/chain.js'
import { decodeChallenge, MCP_HEADERS, mcpBody, readMcpOutcome } from '../lib/merchant-mcp.js'
import { freshPurchaseIdempotencyKey } from '../lib/run-idempotency.js'
import { type Scenario, type ScenarioContext, fail, pass, skip } from './types.js'

const USDC_ABI = ['function balanceOf(address) view returns (uint256)'] as const
const STATUS_WAIT_MS = 45_000
const MONEY_WAIT_MS = 30_000
const POLL_MS = 1_000

async function sweepAfterFailure(
  client: HavenClient,
  delegateKey: string,
  provider: ethers.Provider,
  delegate: string,
): Promise<string> {
  const usdc = new ethers.Contract(SEPOLIA_USDC, USDC_ABI, provider)
  try {
    const before = (await usdc.balanceOf(delegate)) as bigint
    if (before === 0n) return 'delegate already empty'
    const prepared = await client.prepareSweep()
    if (prepared.below_min || prepared.nothing_stranded || !prepared.authorization) {
      return `cleanup could not sweep ${ethers.formatUnits(before, 6)} USDC (${prepared.below_min ? 'below sweep floor' : 'no authorization'})`
    }
    const typed = buildSweepTypedData(prepared.authorization)
    const signature = await new ethers.Wallet(delegateKey).signTypedData(
      typed.domain,
      typed.types as unknown as Record<string, ethers.TypedDataField[]>,
      typed.message,
    )
    await client.submitSweep(prepared.authorization, signature)
    const after = (await usdc.balanceOf(delegate)) as bigint
    return after === 0n
      ? `cleanup swept ${ethers.formatUnits(before, 6)} USDC`
      : `cleanup left ${ethers.formatUnits(after, 6)} USDC from ${ethers.formatUnits(before, 6)} USDC`
  } catch (error) {
    return `cleanup sweep failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

export const x402Delegation3009GraceResume: Scenario = {
  name: 'x402-delegation-3009-grace-resume',
  invariant:
    'A confirmed EIP-3009 funding leg with no merchant retry becomes retryable after the dev-only grace, then resumes the original x402 request without leaving delegate funds stranded.',
  async run(ctx: ScenarioContext) {
    if (!ctx.cfg.demoMerchantUrl) {
      return skip('QA_DEMO_MERCHANT_URL not set — the crash/resume leg needs the dev demo-merchant')
    }
    if (!ctx.cfg.delegationAgentApiKey || !ctx.cfg.delegationDelegateKey) {
      return skip(
        'QA_DELEGATION_AGENT_API_KEY / QA_DELEGATION_DELEGATE_PRIVATE_KEY not set — ' +
          'the crash/resume leg needs the delegation-rail identity',
      )
    }

    const api = new HavenApi(ctx.cfg, ctx.cfg.delegationAgentApiKey)
    const client = new HavenClient({
      apiKey: ctx.cfg.delegationAgentApiKey,
      delegateKey: ctx.cfg.delegationDelegateKey,
      baseUrl: ctx.cfg.apiUrl,
      chainRpcs: { 84532: BASE_SEPOLIA_RPC },
    })
    const delegate = new ethers.Wallet(ctx.cfg.delegationDelegateKey)
    const provider = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC)
    const usdc = new ethers.Contract(SEPOLIA_USDC, USDC_ABI, provider)
    const mcpUrl = `${ctx.cfg.demoMerchantUrl}/mcp`
    const initialBody = mcpBody(1)
    const failAfterFunding = async (message: string) => {
      const cleanup = await sweepAfterFailure(client, ctx.cfg.delegationDelegateKey!, provider, delegate.address)
      return fail(`${message}; ${cleanup}`)
    }

    // Get the ordinary, settling VPN challenge. Unlike the sweep scenario this
    // must never target the verify-without-settle CloudNest fixture: the absent
    // merchant retry is the client crash we are proving, not merchant behavior.
    const challengeResponse = await fetch(mcpUrl, {
      method: 'POST', headers: MCP_HEADERS, body: initialBody,
    })
    const challengeText = await challengeResponse.text()
    const challenge = decodeChallenge(challengeResponse.headers.get('PAYMENT-REQUIRED'), challengeText)
    if (!challenge?.accepts?.length) return fail(`no x402 challenge from the merchant (HTTP ${challengeResponse.status})`)
    const option = challenge.accepts.find((entry) => entry.extra?.assetTransferMethod !== 'erc7710')
    if (!option?.payTo || !option.amount) {
      return skip('demo-merchant offers no EIP-3009 x402 option — the crash shape is unreachable')
    }
    const amount = BigInt(option.amount)
    if (amount <= 0n) return fail(`invalid EIP-3009 amount in merchant challenge: ${option.amount}`)

    const agent = await api.getAgent()
    const treasury = agent.data.safe_address
    if (!treasury) return fail('could not read the agent account from GET /machine-payments/agent')
    const [treasuryBefore, merchantBefore, delegateBefore] = (await Promise.all([
      usdc.balanceOf(treasury), usdc.balanceOf(option.payTo), usdc.balanceOf(delegate.address),
    ])) as [bigint, bigint, bigint]

    const idempotencyKey = freshPurchaseIdempotencyKey('x402-delegation-3009-grace-resume')
    const authorized = await api.authorizeX402({
      url: challenge.resource?.url ?? mcpUrl,
      payTo: delegate.address,
      merchantPayTo: option.payTo,
      settlementScheme: 'eip3009',
      amount: option.amount,
      asset: option.asset ?? SEPOLIA_USDC,
      network: option.network ?? 'eip155:84532',
      maxTimeoutSeconds: option.maxTimeoutSeconds,
      idempotencyKey,
    })
    const paymentId = authorized.data.payment_id
    const typedData = authorized.data.sign_data?.typed_data
    if (!authorized.ok || !paymentId || !typedData || authorized.data.sign_data?.signature_scheme !== 'eip712_userop') {
      return fail(`authorize did not return a delegation-rail funding payload (HTTP ${authorized.status}): ${JSON.stringify(authorized.data).slice(0, 180)}`)
    }
    const signature = await signUserOpTypedDataForDelegation(ctx.cfg.delegationDelegateKey, typedData as never)
    const funded = await api.signPayment(paymentId, signature)
    if (!funded.ok) return fail(`funding leg failed (HTTP ${funded.status}): ${(funded.data.details ?? funded.data.error ?? '').slice(0, 180)}`)

    try {
      const fundingStatus = await api.pollUntilSettled(paymentId)
      if (fundingStatus.status !== 'confirmed' || !fundingStatus.tx_hash) {
        return failAfterFunding(`funding leg ended ${fundingStatus.status}, not confirmed (tx ${fundingStatus.tx_hash ?? 'none'})`)
      }

      // Intentionally do NOT retry the merchant here. The following read must
      // be the server-derived recovery state, never a client-written signal.
      const deadline = Date.now() + STATUS_WAIT_MS
      let recovery = await api.getMachinePaymentStatus(paymentId)
      while (
        recovery.ok &&
        recovery.data.next_action !== 'retry_original_x402_request' &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        recovery = await api.getMachinePaymentStatus(paymentId)
      }
      if (
        !recovery.ok ||
        recovery.data.phase !== 'funded_but_unsettled' ||
        recovery.data.next_action !== 'retry_original_x402_request'
      ) {
        return failAfterFunding(
          `status after confirmed funding was ${JSON.stringify(recovery.data)} — expected funded_but_unsettled / ` +
            'retry_original_x402_request (ensure MERCHANT_REPORT_GRACE_MIN_OVERRIDE=0 on Base Sepolia dev)',
        )
      }

      const resumed = await client.resumeX402Payment({
        paymentId,
        url: mcpUrl,
        idempotencyKey,
        init: { method: 'POST', headers: MCP_HEADERS, body: initialBody },
      })
      const resumedText = await resumed.text()
      const outcome = readMcpOutcome(resumedText)
      if (!resumed.ok || resumed.status === 402 || outcome.rejection !== undefined || !outcome.served) {
        return failAfterFunding(
          `resumed merchant request did not complete (HTTP ${resumed.status}): ${(outcome.rejection ?? resumedText).slice(0, 180)}`,
        )
      }

      let [treasuryAfter, merchantAfter, delegateAfter] = (await Promise.all([
        usdc.balanceOf(treasury), usdc.balanceOf(option.payTo), usdc.balanceOf(delegate.address),
      ])) as [bigint, bigint, bigint]
      const moneyDeadline = Date.now() + MONEY_WAIT_MS
      while (
        (treasuryBefore - treasuryAfter !== amount || merchantAfter - merchantBefore !== amount || delegateAfter !== delegateBefore) &&
        Date.now() < moneyDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        ;[treasuryAfter, merchantAfter, delegateAfter] = (await Promise.all([
          usdc.balanceOf(treasury), usdc.balanceOf(option.payTo), usdc.balanceOf(delegate.address),
        ])) as [bigint, bigint, bigint]
      }
      const fmt = (value: bigint) => ethers.formatUnits(value, 6)
      if (treasuryBefore - treasuryAfter !== amount || merchantAfter - merchantBefore !== amount) {
        return failAfterFunding(
          `resume money proof failed: treasury moved ${fmt(treasuryBefore - treasuryAfter)} and merchant received ` +
            `${fmt(merchantAfter - merchantBefore)} USDC; expected ${fmt(amount)} each`,
        )
      }
      if (delegateAfter !== delegateBefore) {
        return failAfterFunding(`resume left the delegate unclean: ${fmt(delegateBefore)} → ${fmt(delegateAfter)} USDC`)
      }
      return pass(
        `confirmed funding without a merchant retry became retryable, then resume paid ${fmt(amount)} USDC ` +
          `treasury→merchant with the delegate restored to its ${fmt(delegateAfter)} USDC baseline (payment ${paymentId})`,
      )
    } catch (error) {
      return failAfterFunding(
        `post-funding recovery failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  },
}
