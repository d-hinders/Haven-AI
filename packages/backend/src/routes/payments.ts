import { FastifyInstance } from 'fastify'
import { ethers } from 'ethers'
import pool from '../db.js'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import { moneyPathRateLimit } from '../middleware/rate-limit.js'
import { AgentPaymentNextAction, AgentPaymentPhase } from '../lib/agent-payment-taxonomy.js'
import { getChain, getExplorerUrl } from '../lib/chains.js'
import { getFiatValuesForTokenAmount } from '../lib/fiat-values.js'
import { isAddress as isValidAddress } from '@haven_ai/core'
import {
  getTokenAllowance,
  getLatestBlockTimeSec,
  computeEffectiveAllowance,
  generateTransferHash,
  recoverSigner,
  executeAllowanceTransfer,
} from '../lib/allowance-module.js'
import { tryRecordMachinePaymentEvidenceBaseById } from '../lib/machine-payment-evidence.js'
import {
  deserializeUserOp,
  loadExecutionRailState,
  redactVendorSecrets,
  resolveExecutionRail,
  serializeUserOp,
} from '../lib/execution-rail.js'
import {
  prepareDelegationPayment,
  submitDelegationPayment,
} from '../lib/delegation-authorization.js'
import { getAgentPaymentResumeState } from '../lib/agent-payment-status.js'
import { getPaymentReceipt, verifyPaymentReceipt } from '../lib/receipt.js'
import { quoteFee } from '../lib/fee/fee-module.js'
import { emitFunnelEvent } from '../lib/onboarding-funnel.js'
import { decideCoverage } from '../lib/payment-coverage.js'

/**
 * Surface the platform fee on a payment result so it's never silently collected
 * (#386 acceptance). Dark while the fee module is disabled — `amount` is "0" and
 * `applied` is false — but the field is always present so agents see it the
 * moment fees go live.
 */
function buildResponseFee(intent: PaymentIntentRow) {
  let gross = 0n
  try { gross = BigInt(intent.amount_raw) } catch { gross = 0n }
  const quote = quoteFee({
    paymentId: intent.id,
    rail: 'direct',
    grossAtomic: gross,
    token: intent.token_symbol,
    userId: intent.user_id,
  })
  const tokenConfig = resolveToken(intent.chain_id, intent.token_symbol)
  return {
    amount: quote.feeAtomic === 0n ? '0' : ethers.formatUnits(quote.feeAtomic, tokenConfig?.decimals ?? 18),
    token: quote.feeToken,
    basis_points: quote.basisPoints,
    applied: !quote.isZero,
  }
}

// ── Constants ─────────────────────────────────────────────────────

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
// ── Types ─────────────────────────────────────────────────────────

interface CreatePaymentBody {
  token: string    // e.g. "USDC.e", "xDAI", "EURe"
  amount: string   // human-readable, e.g. "25.50"
  to: string       // recipient address
}

interface SignPaymentBody {
  signature: string // 0x-prefixed ECDSA signature (65 bytes)
}

interface PaymentIntentRow {
  id: string
  agent_id: string
  user_id: string
  safe_address: string
  chain_id: number
  token_symbol: string
  token_address: string
  to_address: string
  amount_raw: string
  amount_human: string
  delegate_address: string
  allowance_nonce: number
  sign_hash: string
  signature: string | null
  tx_hash: string | null
  status: string
  error_message: string | null
  created_at: string
  signed_at: string | null
  submitted_at: string | null
  confirmed_at: string | null
  expires_at: string
  /** Execution rail pinned at authorize time; null = legacy AllowanceModule (#745). */
  execution_rail?: string | null
  /** Smart Sessions permissionId pinned at authorize time. */
  session_permission_id?: string | null
  /** Serialized prepared UserOperation for session-rail intents. */
  session_user_op?: unknown
  /** Which delegation authorized a delegation-rail intent (#829). */
  delegation_hash?: string | null
  /** Serialized prepared redemption UserOperation for delegation intents. */
  prepared_user_op?: unknown
}

// ── Helpers ───────────────────────────────────────────────────────

/** Resolve a token symbol to its config for a specific chain. */
function resolveToken(chainId: number, symbol: string) {
  const chain = getChain(chainId)
  const tokens = chain.tokens
  const upper = symbol.toUpperCase().replace('.', '')
  if (tokens[upper]) return tokens[upper]
  for (const cfg of Object.values(tokens)) {
    if (cfg.symbol.toLowerCase() === symbol.toLowerCase()) return cfg
  }
  return null
}

// ── Routes ────────────────────────────────────────────────────────

export default async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', agentAuthMiddleware)

  // ── POST / — Create payment intent ──────────────────────

  app.post<{ Body: CreatePaymentBody }>('/', { config: moneyPathRateLimit }, async (request, reply) => {
    const agent = request.agent as AgentContext
    const { token, amount, to } = request.body

    // 1. Validate inputs
    if (!token || typeof token !== 'string') {
      return reply.code(400).send({ error: 'Token symbol is required' })
    }
    if (!amount || typeof amount !== 'string' || isNaN(Number(amount)) || Number(amount) <= 0) {
      return reply.code(400).send({ error: 'Amount must be a positive number' })
    }
    if (!to || !isValidAddress(to)) {
      return reply.code(400).send({ error: 'Valid recipient address is required' })
    }

    // 2. Resolve token for agent's chain
    const chain = getChain(agent.chain_id)
    const tokenConfig = resolveToken(agent.chain_id, token)
    if (!tokenConfig) {
      return reply.code(400).send({
        error: `Unsupported token: ${token}`,
        supported: Object.values(chain.tokens).map((t) => t.symbol),
      })
    }

    // Token address for AllowanceModule (native = zero address)
    const tokenAddress = tokenConfig.address ?? ZERO_ADDRESS

    // 3. Convert human amount to raw units
    let amountRaw: bigint
    try {
      amountRaw = ethers.parseUnits(amount, tokenConfig.decimals)
    } catch {
      return reply.code(400).send({ error: `Invalid amount for ${tokenConfig.symbol}` })
    }

    if (amountRaw <= 0n) {
      return reply.code(400).send({ error: 'Amount must be greater than zero' })
    }

    // 4. Resolve the execution rail first — the token-configuration gate is
    // rail-specific.
    //
    // ── Session-key rail (#745) — fail-closed; see lib/execution-rail.ts.
    // Only a Safe explicitly marked migrated, whose agent has an enabled
    // session, on an allowlisted chain, leaves the legacy path below.
    const railState = await loadExecutionRailState(agent)

    // Policy check: session/legacy rails carry the per-token policy in
    // agent_allowances (the AllowanceModule config), so a missing row means the
    // token is not configured. The DELEGATION rail (#829) keeps NO allowance
    // row — its authority is the signed budget delegation, checked in the
    // delegation branch below (which returns its own 403 when no delegation
    // authorizes this token/recipient). Applying the allowance gate there would
    // wrongly reject a fully-configured delegation agent, so scope it out.
    if (railState.safeExecutionRail !== 'delegation') {
      const dbAllowance = await pool.query<{ allowance_amount: string }>(
        `SELECT allowance_amount FROM agent_allowances
         WHERE agent_id = $1 AND LOWER(token_address) = LOWER($2)`,
        [agent.id, tokenAddress],
      )
      if (dbAllowance.rows.length === 0) {
        return reply.code(403).send({
          error: `Agent is not configured for ${tokenConfig.symbol} payments`,
        })
      }
    }

    // ── Delegation rail (#829, epic #821) ────────────────────────────────
    // The agent's signed delegation IS the policy: budget (with native
    // refill), recipient and expiry are enforced ON-CHAIN by audited caveat
    // enforcers during gas estimation. An out-of-policy payment therefore
    // fails during prepare — before any state is written and before the
    // agent is asked for a signature. No coverage arithmetic, no approval
    // queue, no schedule machinery: the chain rules.
    if (railState.safeExecutionRail === 'delegation') {
      if (tokenAddress === ZERO_ADDRESS) {
        return reply.code(400).send({
          error: 'Native-token transfers are not supported on the delegation rail',
        })
      }
      let authorization
      try {
        authorization = await prepareDelegationPayment(
          { id: agent.id, chain_id: agent.chain_id, delegate_address: agent.delegate_address },
          tokenAddress,
          to.toLowerCase(),
          amountRaw,
        )
      } catch (err) {
        // Caveat rejection (budget/recipient/expiry) or bundler failure —
        // both land here, both leave the database untouched.
        return reply.code(502).send({
          error: 'Delegation-rail authorization failed (on-chain policy or bundler)',
          details: redactVendorSecrets(err instanceof Error ? err.message : String(err)),
        })
      }
      if (!authorization) {
        return reply.code(403).send({
          error: `Agent has no active budget delegation for ${tokenConfig.symbol} to this recipient`,
        })
      }

      const delegationResult = await pool.query<PaymentIntentRow>(
        `INSERT INTO payment_intents (
          agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
          to_address, amount_raw, amount_human, delegate_address,
          allowance_nonce, sign_hash,
          execution_rail, delegation_hash, prepared_user_op,
          status, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          'pending_signature', NOW() + interval '10 minutes')
        RETURNING *`,
        [
          agent.id, agent.user_id, agent.safe_address, agent.chain_id,
          tokenConfig.symbol, tokenAddress, to.toLowerCase(),
          amountRaw.toString(), amount, agent.delegate_address,
          0, // AllowanceModule-only concept; unused on this rail
          authorization.prepared.userOpHash,
          'delegation',
          authorization.delegationHash,
          serializeUserOp(authorization.prepared.userOperation),
        ],
      )
      const delegationIntent = delegationResult.rows[0]

      return reply.code(201).send({
        payment_id: delegationIntent.id,
        status: delegationIntent.status,
        expires_at: delegationIntent.expires_at,
        sign_data: {
          hash: authorization.prepared.userOpHash,
          signature_scheme: 'eip712_userop',
          // The account validates THIS typed data (not the bare 4337 hash).
          typed_data: authorization.prepared.signingTypedData,
          components: {
            account: authorization.prepared.delegateAccountAddress,
            token: tokenAddress,
            to: to.toLowerCase(),
            amount: amountRaw.toString(),
          },
          instructions:
            'Sign sign_data.typed_data with your delegate (agent) key using EIP-712 ' +
            '(signTypedData; @haven_ai/sdk does this automatically). Then POST ' +
            `/payments/${delegationIntent.id}/sign with { signature } — Haven relays it; ` +
            'your budget delegation authorizes it on-chain.',
        },
      })
    }

    const railDecision = resolveExecutionRail({
      ...railState,
      chainId: agent.chain_id,
    })
    if (railDecision.rail === 'session_key') {
      // ── Session rail RETIRED (#834, epic #821) ─────────────────────────
      // The typed seam stays for reversibility, but no session machinery
      // remains behind it: schedules, rotation, and Smart Sessions prepare/
      // submit are deleted. Accounts still marked session_key re-onboard on
      // the delegation rail. Fail-closed: refuse loudly, write nothing.
      return reply.code(410).send({
        error:
          'The session rail is retired — re-onboard this account on the delegation rail ' +
          '(POST /accounts/hybrid, then grant a budget) to keep paying.',
      })
    }

    // 5. On-chain allowance check. Read the allowance and chain time together:
    // the reset decision must key off chain `block.timestamp`, not wall-clock.
    let onChainAllowance
    let chainTimeSec: number
    try {
      ;[onChainAllowance, chainTimeSec] = await Promise.all([
        getTokenAllowance(
          agent.chain_id,
          agent.safe_address,
          agent.delegate_address,
          tokenAddress,
        ),
        getLatestBlockTimeSec(agent.chain_id),
      ])
    } catch (err) {
      return reply.code(502).send({
        error: 'Failed to read on-chain allowance',
        details: err instanceof Error ? err.message : String(err),
      })
    }

    const effective = computeEffectiveAllowance(onChainAllowance, chainTimeSec)

    // 5a. Coverage decision (shared with the x402 / MPP money paths via
    // lib/payment-coverage.decideCoverage). The normal-send flow is allowance-
    // only — there is no delegate hot-wallet leg, so over-allowance always
    // queues for owner approval. Agents can request payments of any size; the
    // owner approves or rejects in the dashboard.
    const coverage = decideCoverage('allowance-only', {
      amount: amountRaw,
      remaining: effective.remaining,
    })
    if (coverage.kind === 'queue') {
      const reason = (request.body as unknown as Record<string, unknown>).reason as string | undefined
      const remainingHuman = ethers.formatUnits(effective.remaining, tokenConfig.decimals)
      const approvalReason =
        reason ??
        `Exceeds remaining allowance (${amount} ${tokenConfig.symbol} requested, ${remainingHuman} available)`

      const approvalResult = await pool.query<{ id: string; status: string; expires_at: string }>(
        `INSERT INTO approval_requests (
          agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
          to_address, amount_raw, amount_human, reason, status, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending',
          NOW() + interval '24 hours')
        RETURNING id, status, expires_at`,
        [
          agent.id,
          agent.user_id,
          agent.safe_address,
          agent.chain_id,
          tokenConfig.symbol,
          tokenAddress,
          to.toLowerCase(),
          amountRaw.toString(),
          amount,
          approvalReason,
        ],
      )

      const approval = approvalResult.rows[0]
      return reply.code(202).send({
        payment_id: approval.id,
        kind: 'approval_request',
        status: 'pending_approval',
        phase: AgentPaymentPhase.UserApprovalRequired,
        next_action: AgentPaymentNextAction.WaitForUserApproval,
        message: `Payment of ${amount} ${tokenConfig.symbol} exceeds the remaining on-chain allowance. Queued for owner approval.`,
        remaining: remainingHuman,
        requested: amount,
        token: tokenConfig.symbol,
        expires_at: approval.expires_at,
      })
    }

    // 6. Generate the transfer hash on-chain
    let signHash: string
    try {
      signHash = await generateTransferHash(
        agent.chain_id,
        agent.safe_address,
        tokenAddress,
        to,
        amountRaw,
        ZERO_ADDRESS, // paymentToken (no gas refund for POC)
        0n,           // payment amount
        onChainAllowance.nonce,
      )
    } catch (err) {
      return reply.code(502).send({
        error: 'Failed to generate transfer hash',
        details: err instanceof Error ? err.message : String(err),
      })
    }

    // 7. Store the intent
    const result = await pool.query<PaymentIntentRow>(
      `INSERT INTO payment_intents (
        agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
        to_address, amount_raw, amount_human, delegate_address,
        allowance_nonce, sign_hash, status, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending_signature',
        NOW() + interval '10 minutes')
      RETURNING *`,
      [
        agent.id,
        agent.user_id,
        agent.safe_address,
        agent.chain_id,
        tokenConfig.symbol,
        tokenAddress,
        to.toLowerCase(),
        amountRaw.toString(),
        amount,
        agent.delegate_address,
        onChainAllowance.nonce,
        signHash,
      ],
    )

    const intent = result.rows[0]

    return reply.code(201).send({
      payment_id: intent.id,
      status: intent.status,
      expires_at: intent.expires_at,
      sign_data: {
        hash: signHash,
        components: {
          safe: agent.safe_address,
          token: tokenAddress,
          to: to.toLowerCase(),
          amount: amountRaw.toString(),
          payment_token: ZERO_ADDRESS,
          payment: '0',
          nonce: onChainAllowance.nonce,
        },
        instructions:
          'Sign the hash with your delegate private key using raw ECDSA (not eth_sign). ' +
          'The signature must be 65 bytes: r (32) + s (32) + v (1), where v is 27 or 28.',
      },
    })
  })

  // ── POST /:id/sign — Sign and execute ───────────────────

  app.post<{ Params: { id: string }; Body: SignPaymentBody }>(
    '/:id/sign',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      const agent = request.agent as AgentContext
      const { id } = request.params
      const { signature } = request.body

      if (!signature || typeof signature !== 'string' || !signature.startsWith('0x')) {
        return reply.code(400).send({ error: 'Valid 0x-prefixed signature is required' })
      }

      // 1. Load intent
      const intentResult = await pool.query<PaymentIntentRow>(
        `SELECT * FROM payment_intents WHERE id = $1 AND agent_id = $2`,
        [id, agent.id],
      )

      if (intentResult.rows.length === 0) {
        return reply.code(404).send({ error: 'Payment intent not found' })
      }

      const intent = intentResult.rows[0]

      // Check status
      if (intent.status !== 'pending_signature') {
        return reply.code(409).send({
          error: `Payment intent is ${intent.status}, expected pending_signature`,
          status: intent.status,
        })
      }

      // Check expiry
      if (new Date(intent.expires_at) < new Date()) {
        await pool.query(
          `UPDATE payment_intents
           SET status = 'expired'
           WHERE id = $1 AND agent_id = $2 AND status = 'pending_signature'`,
          [id, agent.id],
        )
        return reply.code(410).send({ error: 'Payment intent has expired' })
      }

      // 2. Verify signature matches delegate. Delegation-rail intents sign the
      // account's EIP-712 typed data; legacy intents sign the AllowanceModule
      // transfer hash with raw ECDSA. The intent's rail was pinned at
      // authorize time, so a signature can never be checked against the wrong
      // scheme. Session-rail intents are RETIRED (#834): any still-pending
      // one is refused before anything is verified or written.
      if (intent.execution_rail === 'session_key') {
        return reply.code(410).send({
          error:
            'The session rail is retired — this intent can no longer execute. ' +
            'Re-onboard the account on the delegation rail and authorize again.',
        })
      }
      const isDelegationRail = intent.execution_rail === 'delegation'

      // Delegation-rail intents sign the prepared UserOperation with the
      // ACCOUNT's EIP-712 scheme, which the delegate smart account itself
      // validates in `validateUserOp`. That on-chain check IS the signature
      // verification — strictly stronger than a local recover, and it cannot
      // drift from the account's own rules. A bad signature is rejected by
      // the bundler at submit; nothing moves. We therefore only shape-check
      // here (a local EIP-712 reconstruction would add a second, weaker
      // source of truth that could false-reject valid signatures).
      if (isDelegationRail) {
        if (!/^0x[0-9a-fA-F]{100,}$/.test(signature)) {
          return reply.code(400).send({ error: 'Invalid signature format' })
        }
      } else {
        let recoveredAddress: string
        try {
          recoveredAddress = recoverSigner(intent.sign_hash, signature)
        } catch (err) {
          return reply.code(400).send({
            error: 'Invalid signature format',
            details: err instanceof Error ? err.message : String(err),
          })
        }

        if (recoveredAddress.toLowerCase() !== intent.delegate_address.toLowerCase()) {
          return reply.code(403).send({
            error: 'Signature does not match delegate address',
            expected: intent.delegate_address,
            recovered: recoveredAddress,
          })
        }
      }

      // 3. Atomically claim the pending intent before any on-chain execution.
      const submittedResult = await pool.query<{ id: string }>(
        `UPDATE payment_intents
         SET signature = $1, signed_at = NOW(), status = 'submitted', submitted_at = NOW()
         WHERE id = $2
           AND agent_id = $3
           AND status = 'pending_signature'
           AND expires_at > NOW()
         RETURNING id`,
        [signature, id, agent.id],
      )

      if (submittedResult.rows.length === 0) {
        const expiredResult = await pool.query<{ status: string }>(
          `UPDATE payment_intents
           SET status = 'expired'
           WHERE id = $1
             AND agent_id = $2
             AND status = 'pending_signature'
             AND expires_at <= NOW()
           RETURNING status`,
          [id, agent.id],
        )

        if (expiredResult.rows.length > 0) {
          return reply.code(410).send({ error: 'Payment intent has expired' })
        }

        const current = await pool.query<{ status: string }>(
          `SELECT status FROM payment_intents WHERE id = $1 AND agent_id = $2`,
          [id, agent.id],
        )
        const status = current.rows[0]?.status ?? 'unknown'
        return reply.code(409).send({
          error: `Payment intent is ${status}, expected pending_signature`,
          status,
        })
      }

      // 4. Execute on-chain — on the rail the intent was authorized for.
      try {
        let txHash: string
        if (isDelegationRail) {
          // Replay the exact prepared redemption whose hash the agent signed;
          // only the signature is stamped in. The caveat enforcers authorize
          // it on-chain — no owner, relayer, or Haven key signs anything.
          if (intent.prepared_user_op == null || !intent.delegation_hash) {
            throw new Error('delegation-rail intent is missing its prepared UserOperation state')
          }
          const result = await submitDelegationPayment(
            { chain_id: intent.chain_id, delegate_address: intent.delegate_address },
            deserializeUserOp(intent.prepared_user_op),
            signature as `0x${string}`,
          )
          txHash = result.txHash
        } else {
          const result = await executeAllowanceTransfer(
            intent.chain_id,
            intent.safe_address,
            intent.token_address,
            intent.to_address,
            BigInt(intent.amount_raw),
            ZERO_ADDRESS,
            0n,
            intent.delegate_address,
            signature,
          )
          txHash = result.txHash
        }

        const fiatValues = await getFiatValuesForTokenAmount(
          intent.token_symbol,
          intent.amount_human,
        )

        // 5. Success
        const confirmedResult = await pool.query(
          `UPDATE payment_intents
           SET status = 'confirmed',
               tx_hash = $1,
               confirmed_at = NOW(),
               usd_value = $3,
               eur_value = $4
           WHERE id = $2 AND agent_id = $5 AND status = 'submitted'
           RETURNING id`,
          [txHash, id, fiatValues.usd, fiatValues.eur, agent.id],
        )

        if (confirmedResult.rows.length === 0) {
          return reply.code(409).send({
            payment_id: id,
            status: 'submitted',
            error: 'Payment intent changed after on-chain execution',
          })
        }

        await tryRecordMachinePaymentEvidenceBaseById(id, agent.id, request.log)
        emitFunnelEvent(agent.user_id, 'first_payment_settled', { payment_id: id, rail: 'manual' })

        return reply.send({
          payment_id: id,
          status: 'confirmed',
          tx_hash: txHash,
          chain_id: intent.chain_id,
          explorer_url: getExplorerUrl(intent.chain_id, 'tx', txHash),
          token: intent.token_symbol,
          amount: intent.amount_human,
          to: intent.to_address,
        })
      } catch (err) {
        // 6. Failure. Session-rail (bundler) errors echo the request URL,
        // which embeds the API key — scrub before persisting or responding.
        const errorMsg = redactVendorSecrets(err instanceof Error ? err.message : String(err))
        await pool.query(
          `UPDATE payment_intents
           SET status = 'failed', error_message = $1
           WHERE id = $2 AND agent_id = $3 AND status = 'submitted'`,
          [errorMsg, id, agent.id],
        )

        return reply.code(502).send({
          payment_id: id,
          status: 'failed',
          error: 'On-chain execution failed',
          details: errorMsg,
        })
      }
    },
  )

  // ── GET /:id/resume_state — Rehydrate protocol resume state ─────────

  /**
   * GET /payments/:id/resume_state
   *
   * Reconstructs the serializable x402/MPP resume-state bundle for a payment
   * intent or approval request owned by this agent. This returns stored payment
   * context only; it never signs, executes, relays, or expands authority.
   */
  app.get<{ Params: { id: string } }>('/:id/resume_state', async (request, reply) => {
    const agent = request.agent as AgentContext
    const { id } = request.params
    const result = await getAgentPaymentResumeState(agent, id)

    if (!result.status) {
      return reply.code(404).send({ error: 'Payment or approval request not found' })
    }

    if (result.status.status === 'expired') {
      return reply.code(410).send({
        error: result.error ?? 'Payment approval expired and cannot be resumed',
        error_code: result.errorCode,
        payment_id: result.status.payment_id,
        rail: result.status.rail,
        status: result.status.status,
      })
    }

    if (!result.resumeState) {
      // 422 instead of 409 specifically for "this rail is documented as a
      // valid AgentPaymentRail value but the resume-state surface doesn't
      // currently rehydrate it." Generic 409 stays for other "cannot resume
      // right now" cases (incomplete context, wrong status).
      const code = result.errorCode === 'rail_not_resumable' ? 422 : 409
      return reply.code(code).send({
        error: result.error ?? 'Payment cannot be resumed',
        error_code: result.errorCode,
        payment_id: result.status.payment_id,
        rail: result.status.rail,
        status: result.status.status,
      })
    }

    return reply.send(result.resumeState)
  })

  // ── GET /:id — Payment status ───────────────────────────

  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const agent = request.agent as AgentContext
    const { id } = request.params

    const result = await pool.query<PaymentIntentRow>(
      `SELECT * FROM payment_intents WHERE id = $1 AND agent_id = $2`,
      [id, agent.id],
    )

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Payment intent not found' })
    }

    const intent = result.rows[0]
    let status = intent.status

    if (status === 'pending_signature' && new Date(intent.expires_at) < new Date()) {
      const expiredResult = await pool.query<{ status: string }>(
        `UPDATE payment_intents
         SET status = 'expired'
         WHERE id = $1 AND agent_id = $2 AND status = 'pending_signature'
         RETURNING status`,
        [id, agent.id],
      )
      status = expiredResult.rows[0]?.status ?? status
    }

    return {
      payment_id: intent.id,
      status,
      chain_id: intent.chain_id,
      token: intent.token_symbol,
      amount: intent.amount_human,
      to: intent.to_address,
      tx_hash: intent.tx_hash,
      explorer_url: intent.tx_hash ? getExplorerUrl(intent.chain_id, 'tx', intent.tx_hash) : null,
      fee: buildResponseFee(intent),
      error_message: intent.error_message,
      created_at: intent.created_at,
      signed_at: intent.signed_at,
      submitted_at: intent.submitted_at,
      confirmed_at: intent.confirmed_at,
      expires_at: intent.expires_at,
    }
  })

  // ── GET /:id/receipt — verifiable proof bundle for a settled payment ──

  app.get<{ Params: { id: string } }>('/:id/receipt', async (request, reply) => {
    const agent = request.agent as AgentContext
    const receipt = await getPaymentReceipt(request.params.id, agent.id)
    if (!receipt) {
      return reply.code(404).send({ error: 'No settled payment found for this id' })
    }
    // Self-verify so the response states the proof status; the bundle is also
    // verifiable independently of Haven (recover the signer from authorization).
    const verification = verifyPaymentReceipt(receipt)
    return { receipt, verification }
  })

  // ── GET / — List payment intents for this agent ─────────

  app.get('/', async (request) => {
    const agent = request.agent as AgentContext

    await pool.query(
      `UPDATE payment_intents
       SET status = 'expired'
       WHERE agent_id = $1 AND status = 'pending_signature' AND expires_at < NOW()`,
      [agent.id],
    )

    const result = await pool.query<PaymentIntentRow>(
      `SELECT * FROM payment_intents WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [agent.id],
    )

    return {
      payments: result.rows.map((intent) => ({
        payment_id: intent.id,
        status: intent.status,
        token: intent.token_symbol,
        amount: intent.amount_human,
        to: intent.to_address,
        tx_hash: intent.tx_hash,
        created_at: intent.created_at,
        confirmed_at: intent.confirmed_at,
      })),
    }
  })
}
