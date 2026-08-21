/**
 * Legacy AllowanceModule-rail (import-only) x402 authorize orchestration.
 * Extracted verbatim from `routes/x402.ts`'s authorize handler: idempotent
 * replay of pending/confirmed intents, the on-chain allowance + balance-aware
 * coverage decision (#716's exact-amount guard, epic #713), the
 * approval-queue path, and one-shot authorize+execute. Behavior and ordering
 * are unchanged from the pre-#996 route.
 */
import type { FastifyBaseLogger } from 'fastify'
import { RelayerBudgetExceededError } from '../../infra/relayer-spend-guard.js'
import {
  findActiveX402IntentByIdempotencyKey,
  findX402IntentByIdempotencyKey,
  confirmX402Intent,
  failPendingX402Intent,
  recordX402Signature,
  refreshStaleX402Intent,
} from '../../infra/repositories/x402-authorizations.js'
import { findX402ApprovalByIdempotencyKey } from '../../infra/repositories/approval-requests.js'
import { hasTokenAllowanceConfigured } from '../../infra/repositories/agents.js'
import type { AgentContext } from '../../middleware/agentAuth.js'
import { signX402ExpectedContext, x402PayerContextFields, x402PayerWireFields } from '../../infra/chain/x402-binding-signer.js'
import { AgentPaymentNextAction, AgentPaymentPhase, AgentPaymentRail } from '../../domain/agent-payment-taxonomy.js'
import { getExplorerUrl } from '../../domain/chains.js'
import { getFiatValuesForTokenAmount } from '../../infra/fiat-values.js'
import { formatTokenValue } from '../../domain/tokens.js'
import { formatTokenAmount } from '@haven_ai/core'
import {
  getTokenAllowance,
  getTokenBalance,
  getLatestBlockTimeSec,
  computeEffectiveAllowance,
  generateTransferHash,
  recoverSigner,
  executeAllowanceTransfer,
} from '../../rails/allowance-module.js'
import {
  readSharedWatermark,
  waitForFreshAllowanceNonce,
} from '../../rails/allowance-nonce-coordinator.js'
// Evidence recording is mpp-module orchestration (#997) that x402 also needs
// after a successful legacy-rail settlement — a genuine cross-module need,
// so it comes through the module's public entry point (rule 6, not a deep
// import into `modules/mpp/`'s private `evidence.ts`).
import { tryRecordMachinePaymentEvidenceBaseById } from '../mpp/index.js'
import { insertMachineApproval as createMachineApproval } from '../../infra/repositories/approval-requests.js'
import { insertMachineIntent as createPaymentIntent } from '../../infra/repositories/payment-intents.js'
import { type ResolvePaymentTokenResult } from '../../domain/payment-token.js'
import { decideCoverage } from '../../domain/payment-coverage.js'
import { emitFunnelEvent } from '../../infra/repositories/onboarding-funnel.js'
import {
  agentPaymentStatusHttpCode,
  getAgentPaymentStatus,
} from '../payments/index.js'
import {
  agentHourlyX402CapExceeded,
  currentPaymentIntentStatus,
  existingX402IntentMismatch,
  pendingApprovalResponse,
  ZERO_ADDRESS,
} from './helpers.js'
import type { X402ApprovalRow, X402HandlerResult, X402McpCallContextInput } from './types.js'

type ResolvedToken = Extract<ResolvePaymentTokenResult, { ok: true }>

export interface LegacyAuthorizeInput {
  agent: AgentContext
  url: string
  payTo: string
  merchantPayTo?: string
  amountRaw: bigint
  amountHuman: string
  asset: string
  network: string
  description?: string
  category?: string
  idempotencyKey?: string
  signature?: string
  tokenConfig: ResolvedToken['tokenConfig']
  tokenAddress: string
  log?: FastifyBaseLogger
  /** #1307: optional MCP merchant-call context, persisted for settle-leg rehydration. */
  mcpCallContext?: X402McpCallContextInput
}

export async function runLegacyAuthorize(input: LegacyAuthorizeInput): Promise<X402HandlerResult> {
  const {
    agent, url, payTo, merchantPayTo, amountRaw, amountHuman, asset, network,
    description, category, idempotencyKey, signature, tokenConfig, tokenAddress, log,
    mcpCallContext,
  } = input

  if (idempotencyKey) {
    const existing = await findX402IntentByIdempotencyKey(agent.id, idempotencyKey)
    if (existing?.status === 'confirmed' && existing.tx_hash) {
      return {
        code: 200,
        body: {
          success: true,
          payment_id: existing.id,
          status: existing.status,
          tx_hash: existing.tx_hash,
          chain_id: existing.chain_id ?? agent.chain_id,
          safe_address: existing.safe_address,
          payer: existing.safe_address,
          token: existing.token_symbol,
          amount: existing.amount_human,
          to: existing.to_address,
          merchant_to: existing.x402_merchant_address,
          resource_url: existing.x402_resource_url,
          explorer_url: getExplorerUrl(existing.chain_id ?? agent.chain_id, 'tx', existing.tx_hash),
        },
      }
    }
    if (existing?.status === 'pending_signature' || existing?.status === 'expired') {
      const mismatch = existingX402IntentMismatch(existing as unknown as Record<string, unknown>, {
        resourceUrl: url,
        fundingTo: payTo,
        merchantTo: merchantPayTo?.toLowerCase() ?? payTo.toLowerCase(),
        amountRaw: amountRaw.toString(),
        tokenAddress,
        network,
      })
      if (mismatch) {
        return {
          code: 409,
          body: {
            payment_id: existing.id,
            status: existing.status,
            error: `idempotencyKey already belongs to a different x402 ${mismatch}`,
          },
        }
      }
      let existingHash = existing.sign_hash
      let existingNonce = existing.allowance_nonce
      let existingExpiresAt = existing.expires_at
      let existingStatus = existing.status
      const refreshedAllowance = await getTokenAllowance(
        agent.chain_id,
        agent.safe_address,
        agent.delegate_address,
        existing.token_address,
      )

      if (BigInt(refreshedAllowance.nonce) !== BigInt(existing.allowance_nonce)) {
        existingNonce = refreshedAllowance.nonce
        existingHash = await generateTransferHash(
          agent.chain_id,
          agent.safe_address,
          existing.token_address,
          existing.to_address,
          BigInt(existing.amount_raw),
          ZERO_ADDRESS,
          0n,
          refreshedAllowance.nonce,
        )
      }

      const refreshed = await refreshStaleX402Intent({
        allowanceNonce: existingNonce,
        signHash: existingHash,
        intentId: existing.id,
        agentId: agent.id,
      })
      if (refreshed) {
        existingHash = refreshed.sign_hash
        existingNonce = refreshed.allowance_nonce
        existingExpiresAt = refreshed.expires_at
        existingStatus = refreshed.status
      } else if (existing.status === 'expired' || BigInt(refreshedAllowance.nonce) !== BigInt(existing.allowance_nonce)) {
        const status = await currentPaymentIntentStatus(existing.id, agent)
        return {
          code: 409,
          body: {
            payment_id: existing.id,
            status,
            error: `x402 payment is ${status}, expected pending_signature`,
          },
        }
      }

      const x402ExpectedAuth = await signX402ExpectedContext({
        paymentId: existing.id,
        payloadHash: existingHash,
        // Pre-extraction this row was untyped; an x402 intent always stores
        // its resource URL, so the assertion changes nothing at runtime.
        resourceUrl: existing.x402_resource_url as string,
        merchantTo: existing.x402_merchant_address ?? existing.to_address,
        amount: existing.amount_raw,
        asset: existing.token_address,
        network,
        expiresAt: existingExpiresAt,
        // #1690: gated payer identity — {} until X402_EMIT_PAYER_CONTEXT=1.
        ...x402PayerContextFields(agent),
      })

      return {
        code: 200,
        body: {
          payment_id: existing.id,
          status: existingStatus,
          expires_at: existingExpiresAt,
          chain_id: existing.chain_id ?? agent.chain_id,
          safe_address: existing.safe_address,
          payer: existing.safe_address,
          token: existing.token_symbol,
          amount: existing.amount_human,
          to: existing.to_address,
          merchant_to: existing.x402_merchant_address,
          resource_url: existing.x402_resource_url,
          x402_expected_auth: x402ExpectedAuth,
          // #1690: gated payer identity on the wire, paired with the context above.
          ...x402PayerWireFields(agent),
          sign_data: {
            hash: existingHash,
            components: {
              safe: existing.safe_address,
              token: existing.token_address,
              to: existing.to_address,
              amount: existing.amount_raw,
              payment_token: ZERO_ADDRESS,
              payment: '0',
              nonce: existingNonce,
            },
            instructions:
              'Sign the hash with your delegate private key using raw ECDSA (not eth_sign). ' +
              'Then POST /payments/' + existing.id + '/sign with { signature } to execute.',
          },
        },
      }
    }
    if (existing) {
      return {
        code: 409,
        body: {
          payment_id: existing.id,
          status: existing.status,
          error: 'x402 payment already in progress',
        },
      }
    }

    const existingApproval = await findX402ApprovalByIdempotencyKey(agent.id, idempotencyKey)
    if (existingApproval) {
      const status = await getAgentPaymentStatus(agent, existingApproval.id)
      if (!status) {
        return { code: 409, body: { error: 'x402 approval already exists but could not be loaded' } }
      }
      return { code: agentPaymentStatusHttpCode(status), body: status }
    }
  }

  // 4. Policy check: agent must have this token in the on-chain allowance config
  const allowanceConfigured = await hasTokenAllowanceConfigured(agent.id, tokenAddress)
  if (!allowanceConfigured) {
    return { code: 403, body: { error: `Agent is not configured for ${tokenConfig.symbol} payments` } }
  }

  // 5. Rate limiting: max x402 payments per hour (#961: shared helper)
  const exceededCap = await agentHourlyX402CapExceeded(agent.id)
  if (exceededCap !== null) {
    return {
      code: 429,
      body: { error: `Rate limit exceeded: max ${exceededCap} x402 payments per hour`, retry_after_seconds: 60 },
    }
  }

  // 6. On-chain allowance check + auto-queue when over the remaining allowance
  let onChainAllowance
  let chainTimeSec: number
  let sharedWatermark: number | null
  try {
    // The watermark rides along with the on-chain reads (#1196) rather than
    // going out serially afterwards: it is a single indexed lookup against
    // reads that take orders of magnitude longer, so concurrently it is free.
    ;[onChainAllowance, chainTimeSec, sharedWatermark] = await Promise.all([
      getTokenAllowance(
        agent.chain_id,
        agent.safe_address,
        agent.delegate_address,
        tokenAddress,
      ),
      getLatestBlockTimeSec(agent.chain_id),
      readSharedWatermark(
        agent.chain_id,
        agent.safe_address,
        agent.delegate_address,
        tokenAddress,
      ),
    ])
  } catch (err) {
    return {
      code: 502,
      body: { error: 'Failed to read on-chain allowance', details: err instanceof Error ? err.message : String(err) },
    }
  }

  const effective = computeEffectiveAllowance(onChainAllowance, chainTimeSec)

  // Pre-flight: read the delegate's on-chain balance for this token before
  // doing anything that creates state. Even with a full Safe AllowanceModule
  // top-up the merchant payment cannot settle unless the delegate ends up
  // holding the amount, so the real coverage is
  // `delegateBalance + remainingAllowance`. If that's short, return a
  // structured `insufficient_funds` failure with no payment intent or
  // approval row — there is no approval the wallet owner could grant that
  // would make this payment succeed; the originating Safe needs more funds
  // or the agent's per-token allowance needs to be raised.
  //
  // Note: the existing over-budget branch below treats `amount > remaining`
  // as approval-required. That assumes the delegate's existing balance is
  // zero. The pre-flight short-circuits the unrecoverable case but does
  // not change the approval-required path — small overages still queue.
  let delegateBalance: bigint
  try {
    delegateBalance = await getTokenBalance(
      agent.chain_id,
      agent.delegate_address,
      tokenAddress,
    )
  } catch (err) {
    return {
      code: 502,
      body: { error: 'Failed to read delegate token balance', details: err instanceof Error ? err.message : String(err) },
    }
  }

  // Balance-aware coverage decision (see lib/payment-coverage.decideCoverage):
  // x402's delegate can hold liquid funds from the hot-wallet leg, so a small
  // overage the balance covers still queues; only amounts beyond
  // delegateBalance + remaining are unfunded.
  const decision = decideCoverage('balance-aware', {
    amount: amountRaw,
    remaining: effective.remaining,
    delegateBalance,
  })

  if (decision.kind === 'insufficient') {
    const shortfallRaw = decision.shortfall
    const totalCoverage = decision.totalCoverage
    const balanceHuman = formatTokenAmount(delegateBalance, tokenConfig.decimals)
    const remainingHuman = formatTokenAmount(effective.remaining, tokenConfig.decimals)
    const coverageHuman = formatTokenAmount(totalCoverage, tokenConfig.decimals)
    const shortfallHuman = formatTokenAmount(shortfallRaw, tokenConfig.decimals)
    return {
      code: 422,
      body: {
        error:
          `Insufficient funds to pay ${amountHuman} ${tokenConfig.symbol}: ` +
          `delegate balance ${balanceHuman} + remaining allowance ${remainingHuman} ` +
          `= ${coverageHuman} ${tokenConfig.symbol}, short by ${shortfallHuman}. ` +
          'Fund the Safe or raise the agent allowance and retry.',
        error_code: 'insufficient_funds',
        phase: AgentPaymentPhase.InsufficientFunds,
        next_action: AgentPaymentNextAction.FundSafeOrRaiseAllowance,
        rail: AgentPaymentRail.X402,
        chain_id: agent.chain_id,
        token: tokenConfig.symbol,
        asset: tokenAddress,
        network,
        amount: amountHuman,
        amount_atomic: amountRaw.toString(),
        delegate_balance: balanceHuman,
        delegate_balance_atomic: delegateBalance.toString(),
        remaining_allowance: remainingHuman,
        remaining_allowance_atomic: effective.remaining.toString(),
        shortfall: shortfallHuman,
        shortfall_atomic: shortfallRaw.toString(),
        resource_url: url,
        merchant_address: merchantPayTo?.toLowerCase() ?? null,
        // Intentionally not echoing the agent's delegate or safe address here.
        // The agent holds both via its credential, and the delegate EOA is
        // the only entity that briefly holds liquid funds during the x402
        // hot-wallet leg — leaking it through a structured pre-flight error
        // (which agent runtimes may log, persist, or relay) is unnecessary
        // surveillance surface for no agent benefit.
      },
    }
  }

  if (decision.kind === 'queue') {
    const remainingHuman = formatTokenAmount(effective.remaining, tokenConfig.decimals)
    const merchantPart = merchantPayTo ? ` to merchant ${merchantPayTo}` : ''
    const approvalReason = `x402 payment for ${url}${merchantPart}${category ? ` (${category})` : ''} — exceeds remaining allowance (${amountHuman} ${tokenConfig.symbol} requested, ${remainingHuman} available)`
    const metadata = {
      protocol: 'x402',
      network,
      category: category ?? null,
      description: description ?? null,
    }

    // Shared approval-row writer (infra/repositories/approval-requests.js's
    // insertMachineApproval, called directly by modules/mpp/ too — #997)
    // so the column set, ON CONFLICT target, and 'pending'/24h semantics stay
    // identical to the MPP path. For x402, source/payment_rail are 'x402' and
    // there is no challenge — dedupe is on the idempotency key.
    let approval: X402ApprovalRow | null = await createMachineApproval({
      agent,
      rail: 'x402',
      payTo,
      tokenSymbol: tokenConfig.symbol,
      tokenAddress,
      amountRaw,
      amountHuman,
      reason: approvalReason,
      resourceUrl: url,
      merchantAddress: merchantPayTo ?? null,
      challengeId: null,
      idempotencyKey: idempotencyKey ?? null,
      metadata,
    })
    if (!approval && idempotencyKey) {
      approval = await findX402ApprovalByIdempotencyKey(agent.id, idempotencyKey)
    }
    if (!approval) {
      return { code: 409, body: { error: 'x402 approval already exists but could not be loaded' } }
    }
    if (approval.status !== 'pending') {
      const status = await getAgentPaymentStatus(agent, approval.id)
      if (!status) {
        return { code: 409, body: { error: 'x402 approval already exists but could not be loaded' } }
      }
      return { code: agentPaymentStatusHttpCode(status), body: status }
    }
    return {
      code: 202,
      body: pendingApprovalResponse(approval, remainingHuman, {
        url,
        merchantPayTo: merchantPayTo?.toLowerCase() ?? null,
        chainId: agent.chain_id,
        amountAtomic: amountRaw.toString(),
        asset,
        network,
        description,
        idempotencyKey,
      }),
    }
  }

  // 7. Generate transfer hash on-chain.
  //
  // For standard x402, `payTo` can be the agent-owned delegate EOA because
  // the protocol's merchant-facing payment header is settled from an EOA.
  // Proactively avoid the stale-nonce race (#692): if a prior transfer for this
  // delegate just incremented the nonce, wait until that increment is visible
  // before signing, so the sign_hash never targets an already-consumed nonce.
  // Best-effort with a timeout fallback — the preflight + retry still cover it.
  // Runs AFTER the coverage decision (#1209): the insufficient and queue
  // branches sign nothing, so the bounded wait only runs when a hash will
  // actually be built. The nonce's only consumer is generateTransferHash.
  onChainAllowance.nonce = await waitForFreshAllowanceNonce(
    agent.chain_id,
    agent.safe_address,
    agent.delegate_address,
    tokenAddress,
    onChainAllowance.nonce,
    async () =>
      (
        await getTokenAllowance(
          agent.chain_id,
          agent.safe_address,
          agent.delegate_address,
          tokenAddress,
        )
      ).nonce,
    { sharedWatermark },
  )

  // Haven does not control that EOA or its private key. This transfer is only
  // a Safe AllowanceModule top-up authorized by the agent signature and
  // constrained by the user's on-chain allowance; the backend merely relays it.
  let signHash: string
  try {
    signHash = await generateTransferHash(
      agent.chain_id,
      agent.safe_address,
      tokenAddress,
      payTo,
      amountRaw,
      ZERO_ADDRESS,
      0n,
      onChainAllowance.nonce,
    )
  } catch (err) {
    return {
      code: 502,
      body: { error: 'Failed to generate transfer hash', details: err instanceof Error ? err.message : String(err) },
    }
  }

  // 10. Store intent via the shared writer (see createPaymentIntent) so the
  // column set / status / expiry stay identical to the MPP core. x402 dedupes
  // on x402_idempotency_key; source/payment_rail are 'x402' and there is no
  // challenge.
  let intent = await createPaymentIntent({
    agent,
    rail: 'x402',
    payTo,
    tokenSymbol: tokenConfig.symbol,
    tokenAddress,
    amountRaw,
    amountHuman,
    allowanceNonce: onChainAllowance.nonce,
    signHash,
    resourceUrl: url,
    category: category ?? null,
    merchantAddress: merchantPayTo ?? null,
    challengeId: null,
    idempotencyKey: idempotencyKey ?? null,
    metadata: {
      protocol: 'x402',
      network,
      category: category ?? null,
      description: description ?? null,
      // #1307: same merchant-call-context persistence as the delegation rail.
      mcp_call_context: mcpCallContext ?? null,
    },
    conflictTarget: 'x402_idempotency_key',
  })
  if (!intent && idempotencyKey) {
    intent = await findActiveX402IntentByIdempotencyKey(agent.id, idempotencyKey)
  }
  if (!intent) {
    return { code: 409, body: { error: 'x402 payment already exists but could not be loaded' } }
  }

  // Exact-amount funding invariant (#716, epic #713): the funding transfer
  // must move EXACTLY the intent's recorded amount — never the request's.
  // On an idempotency replay the intent is reloaded from the DB, and without
  // this guard a replay carrying a different `amount` would execute the
  // request's number while the record says otherwise (padding/mutation
  // sneaking past the ledger). Fail closed on any mismatch.
  if (BigInt(intent.amount_raw) !== amountRaw) {
    return {
      code: 409,
      body: {
        payment_id: intent.id,
        error:
          'Amount does not match the existing payment for this idempotency key — ' +
          `stored ${intent.amount_raw}, requested ${amountRaw.toString()}`,
      },
    }
  }

  // 11. If signature provided, execute immediately (one-shot mode)
  if (signature) {
    // Verify signature
    let recoveredAddress: string
    try {
      recoveredAddress = recoverSigner(signHash, signature)
    } catch (err) {
      return {
        code: 400,
        body: { error: 'Invalid signature format', details: err instanceof Error ? err.message : String(err) },
      }
    }

    if (recoveredAddress.toLowerCase() !== agent.delegate_address.toLowerCase()) {
      return {
        code: 403,
        body: {
          error: 'Signature does not match delegate address',
          expected: agent.delegate_address,
          recovered: recoveredAddress,
        },
      }
    }

    // Record the signature first (pending_signature → signed), then execute on-chain.
    // We do NOT set status='submitted' until we have a txHash in hand — if the process
    // crashes between a premature 'submitted' write and the RPC call, the intent would be
    // permanently stuck (idempotency check blocks retry on any status not in
    // ('failed','expired')). Instead we keep the record in 'pending_signature' until
    // execution succeeds, then flip it to 'confirmed' in one atomic write.
    const signatureRecorded = await recordX402Signature(signature, intent.id, agent.id)
    if (!signatureRecorded) {
      const status = await currentPaymentIntentStatus(intent.id, agent)
      return {
        code: 409,
        body: { payment_id: intent.id, status, error: 'Payment intent changed before execution' },
      }
    }

    // Execute on-chain
    try {
      const { txHash } = await executeAllowanceTransfer(
        agent.chain_id,
        agent.safe_address,
        tokenAddress,
        payTo.toLowerCase(),
        amountRaw,
        ZERO_ADDRESS,
        0n,
        agent.delegate_address,
        signature,
        { agentId: agent.id, userId: agent.user_id },
      )

      const fiatValues = await getFiatValuesForTokenAmount(
        tokenConfig.symbol,
        amountHuman,
      )

      const confirmed = await confirmX402Intent({
        txHash,
        intentId: intent.id,
        usdValue: fiatValues.usd,
        eurValue: fiatValues.eur,
        agentId: agent.id,
      })

      if (!confirmed) {
        const status = await currentPaymentIntentStatus(intent.id, agent)
        return {
          code: 409,
          body: { payment_id: intent.id, status, error: 'Payment intent changed after on-chain execution' },
        }
      }

      await tryRecordMachinePaymentEvidenceBaseById(intent.id, agent.id, log)
      emitFunnelEvent(agent.user_id, 'first_payment_settled', { payment_id: intent.id, rail: 'x402' })

      return {
        code: 201,
        body: {
          success: true,
          payment_id: intent.id,
          status: 'confirmed',
          tx_hash: txHash,
          chain_id: agent.chain_id,
          safe_address: agent.safe_address,
          payer: agent.safe_address,
          token: tokenConfig.symbol,
          amount: amountHuman,
          to: payTo.toLowerCase(),
          merchant_to: merchantPayTo?.toLowerCase() ?? null,
          resource_url: url,
          explorer_url: getExplorerUrl(agent.chain_id, 'tx', txHash),
        },
      }
    } catch (err) {
      // #717: over-budget = refused before submission — 429, intent stays
      // pending for retry.
      if (err instanceof RelayerBudgetExceededError) {
        return { code: 429, body: { payment_id: intent.id, status: intent.status, error: err.message } }
      }
      const errorMsg = err instanceof Error ? err.message : String(err)
      await failPendingX402Intent(errorMsg, intent.id, agent.id)
      return {
        code: 502,
        body: {
          success: false,
          payment_id: intent.id,
          status: 'failed',
          error: 'On-chain execution failed',
          details: errorMsg,
        },
      }
    }
  }

  const x402ExpectedAuth = await signX402ExpectedContext({
    paymentId: intent.id,
    payloadHash: signHash,
    resourceUrl: url,
    merchantTo: merchantPayTo?.toLowerCase() ?? payTo.toLowerCase(),
    amount: amountRaw.toString(),
    asset: tokenAddress,
    network,
    expiresAt: intent.expires_at,
    // #1690: gated payer identity — {} until X402_EMIT_PAYER_CONTEXT=1.
    ...x402PayerContextFields(agent),
  })

  // 12. No signature — return intent for client-side signing
  return {
    code: 201,
    body: {
      payment_id: intent.id,
      status: 'pending_signature',
      expires_at: intent.expires_at,
      chain_id: agent.chain_id,
      safe_address: agent.safe_address,
      payer: agent.safe_address,
      token: tokenConfig.symbol,
      amount: amountHuman,
      to: payTo.toLowerCase(),
      merchant_to: merchantPayTo?.toLowerCase() ?? null,
      resource_url: url,
      x402_expected_auth: x402ExpectedAuth,
      // #1690: gated payer identity on the wire, paired with the context above.
      ...x402PayerWireFields(agent),
      sign_data: {
        hash: signHash,
        components: {
          safe: agent.safe_address,
          token: tokenAddress,
          to: payTo.toLowerCase(),
          amount: amountRaw.toString(),
          payment_token: ZERO_ADDRESS,
          payment: '0',
          nonce: onChainAllowance.nonce,
        },
        instructions:
          'Sign the hash with your delegate private key using raw ECDSA (not eth_sign). ' +
          'Then POST /payments/' + intent.id + '/sign with { signature } to execute, ' +
          'or re-call POST /x402/authorize with the signature field included for one-shot execution.',
      },
    },
  }
}
