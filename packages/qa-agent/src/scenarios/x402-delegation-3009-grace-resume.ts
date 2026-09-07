/**
 * #2159: reproduce the #2145 crash shape against dev without manufacturing a
 * merchant-side shortcut. The funding leg completes, then this scenario does
 * NOT send the merchant retry. The backend must derive the recovery verdict
 * from that absence; the SDK then resumes the original request through its
 * next_action gate.
 *
 * ## The money proof measures what THIS scenario caused (#2444)
 *
 * It shares the delegate EOA, the merchant and the treasury with
 * `x402-delegation-3009`, which runs immediately before it. Comparing absolute
 * before/after balances therefore attributes the neighbour's traffic to this
 * scenario: in run 33640693154 the neighbour's late merchant leg landed inside
 * this window and the proof read "merchant received 0.002 USDC; expected
 * 0.001" — a real failure text about a payment that was entirely correct. The
 * convergence loop then could never converge and burned its full 30s (37s
 * against 8s on the healthy attempt).
 *
 * #2444 fixes the neighbour so it can no longer pass while holding an
 * undelivered leg. This half is the independent guard, because the neighbour
 * can still legitimately FAIL with its payment in flight, and any future
 * scenario sharing the delegate reintroduces the same window. Value that
 * reaches the merchant by DRAINING a balance the delegate already held at
 * baseline was not caused here, so it is subtracted out.
 * `evaluateResumeMoneyProof` is pure and exported so the arithmetic is pinned
 * by unit test rather than by a live run.
 *
 * Be precise about what this does and does not guarantee. On a clean window
 * the delegate does not drain, the subtraction is zero, and the assertion is
 * exactly the strict equality it always was. But the subtraction is arithmetic:
 * it nets a delegate DECREASE against a merchant EXCESS without proving the two
 * are the same transfer, which no balance read can. So it does loosen the
 * proof, for one bounded case — `haven-reviewer` constructed it on this diff:
 * if this scenario's own resumed payment silently failed to reach the merchant
 * while, independently, an equal amount both drained off the delegate and
 * landed at the merchant's exact address inside the same window, the proof
 * would read as settled. Every QA payment on this identity is the same 0.001
 * USDC `buy_vpn/basic`, which makes that numeric coincidence MORE plausible
 * here than it would be with varied amounts, not less.
 *
 * Two things bound it. `ABSORBABLE_NEIGHBOUR_LEGS` caps the subtraction at one
 * neighbour leg, so an arbitrary drain can no longer be netted out silently —
 * a larger one fails the proof instead of being absorbed. And the adjacency it
 * exists for is closed at its source by #2444's other half. Anyone adding a
 * THIRD scenario to this shared delegate identity should re-read this bound
 * before assuming it still holds.
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

/**
 * How much pre-existing delegate drain this proof will absorb, in units of this
 * scenario's own payment.
 *
 * One, because there is exactly one adjacent scenario sharing this delegate EOA
 * (`x402-delegation-3009`, `run.ts`) and it buys the same `buy_vpn/basic` at the
 * same price. Absorbing an UNBOUNDED drain was the generic permissiveness
 * `haven-reviewer` flagged on this diff: it would let any amount that happens to
 * leave the delegate excuse any matching merchant excess. Capping it means a
 * larger, unexplained drain fails the proof rather than disappearing into it.
 */
const ABSORBABLE_NEIGHBOUR_LEGS = 1n

/**
 * The three balance readings this scenario is entitled to claim, with the
 * neighbour's traffic removed (#2444).
 *
 * `delegateDrain` is the pre-existing delegate balance that left during the
 * window. Whatever it was, it is not this scenario's money: this scenario funds
 * the delegate with exactly `amount` and expects that same `amount` to leave
 * again, netting zero. So the merchant credit it may claim is the observed
 * credit MINUS that drain — capped at `ABSORBABLE_NEIGHBOUR_LEGS` legs, so the
 * subtraction stays bounded by the adjacency it was built for.
 *
 * A delegate that ends ABOVE its baseline is the opposite fault and stays a
 * hard failure — that is this scenario's own funding failing to settle, which
 * is precisely what its neighbour was allowed to do.
 */
export type ResumeMoneyFault = 'treasury' | 'merchant' | 'delegate'

export interface ResumeMoneyProof {
  settled: boolean
  fault?: ResumeMoneyFault
  treasuryDelta: bigint
  merchantDelta: bigint
  /** Merchant credit attributable to this scenario. */
  causedMerchantDelta: bigint
  /** Pre-existing delegate balance that left during the window (never negative). */
  delegateDrain: bigint
  /** The part of `delegateDrain` this proof is willing to net out. */
  absorbedDrain: bigint
  /** Delegate balance above baseline — this scenario's own unsettled funding. */
  delegateSurplus: bigint
}

export function evaluateResumeMoneyProof(args: {
  amount: bigint
  treasuryBefore: bigint
  treasuryAfter: bigint
  merchantBefore: bigint
  merchantAfter: bigint
  delegateBefore: bigint
  delegateAfter: bigint
}): ResumeMoneyProof {
  const treasuryDelta = args.treasuryBefore - args.treasuryAfter
  const merchantDelta = args.merchantAfter - args.merchantBefore
  const movement = args.delegateBefore - args.delegateAfter
  const delegateDrain = movement > 0n ? movement : 0n
  const delegateSurplus = movement < 0n ? -movement : 0n
  const absorbable = args.amount * ABSORBABLE_NEIGHBOUR_LEGS
  const absorbedDrain = delegateDrain < absorbable ? delegateDrain : absorbable
  const causedMerchantDelta = merchantDelta - absorbedDrain

  const fault: ResumeMoneyFault | undefined =
    treasuryDelta !== args.amount
      ? 'treasury'
      : causedMerchantDelta !== args.amount
        ? 'merchant'
        : delegateSurplus !== 0n
          ? 'delegate'
          : undefined

  return {
    settled: fault === undefined,
    fault,
    treasuryDelta,
    merchantDelta,
    causedMerchantDelta,
    delegateDrain,
    absorbedDrain,
    delegateSurplus,
  }
}

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
      const readProof = () =>
        evaluateResumeMoneyProof({
          amount, treasuryBefore, treasuryAfter, merchantBefore, merchantAfter, delegateBefore, delegateAfter,
        })
      let proof = readProof()
      const moneyDeadline = Date.now() + MONEY_WAIT_MS
      while (!proof.settled && Date.now() < moneyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        ;[treasuryAfter, merchantAfter, delegateAfter] = (await Promise.all([
          usdc.balanceOf(treasury), usdc.balanceOf(option.payTo), usdc.balanceOf(delegate.address),
        ])) as [bigint, bigint, bigint]
        proof = readProof()
      }
      const fmt = (value: bigint) => ethers.formatUnits(value, 6)
      const attribution =
        proof.delegateDrain > 0n
          ? ` (merchant observed ${fmt(proof.merchantDelta)}, less ${fmt(proof.absorbedDrain)} absorbed of the ` +
            `${fmt(proof.delegateDrain)} drained from the delegate's pre-existing balance, which this ` +
            `scenario did not cause)`
          : ''
      if (proof.fault === 'treasury' || proof.fault === 'merchant') {
        return failAfterFunding(
          `resume money proof failed: treasury moved ${fmt(proof.treasuryDelta)} and merchant received ` +
            `${fmt(proof.causedMerchantDelta)} USDC; expected ${fmt(amount)} each${attribution}`,
        )
      }
      if (proof.fault === 'delegate') {
        return failAfterFunding(
          `resume left the delegate unclean: ${fmt(delegateBefore)} → ${fmt(delegateAfter)} USDC ` +
            `(${fmt(proof.delegateSurplus)} USDC of this scenario's own funding did not settle)`,
        )
      }
      return pass(
        `confirmed funding without a merchant retry became retryable, then resume paid ${fmt(amount)} USDC ` +
          `treasury→merchant with the delegate holding no unsettled funding of its own ` +
          `(${fmt(delegateBefore)} → ${fmt(delegateAfter)} USDC)${attribution} (payment ${paymentId})`,
      )
    } catch (error) {
      return failAfterFunding(
        `post-funding recovery failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  },
}
