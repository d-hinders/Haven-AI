import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ethers } from 'ethers'
import { buildX402ExpectedMessage } from '@haven_ai/sdk'
import pool from '../db.js'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import { AgentPaymentNextAction, AgentPaymentPhase, AgentPaymentRail } from '../lib/agent-payment-taxonomy.js'
import { getChain, getExplorerUrl } from '../lib/chains.js'
import { getFiatValuesForTokenAmount } from '../lib/fiat-values.js'
import { formatTokenValue } from '../lib/tokens.js'
import {
  getTokenAllowance,
  getTokenBalance,
  getLatestBlockTimeSec,
  computeEffectiveAllowance,
  generateTransferHash,
  recoverSigner,
  executeAllowanceTransfer,
} from '../lib/allowance-module.js'
import { tryRecordMachinePaymentEvidenceBaseById } from '../lib/machine-payment-evidence.js'
import { createMachineApproval } from '../lib/machine-payments.js'
import { decideCoverage } from '../lib/payment-coverage.js'
import { emitFunnelEvent } from '../lib/onboarding-funnel.js'
import {
  agentPaymentStatusHttpCode,
  getAgentPaymentStatus,
} from '../lib/agent-payment-status.js'

// ── Constants ─────────────────────────────────────────────────────

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const DECIMAL_ATOMIC_AMOUNT_RE = /^[0-9]+$/

// ── Types ─────────────────────────────────────────────────────────

interface X402AuthorizeBody {
  url: string
  payTo: string
  merchantPayTo?: string
  amount: string          // atomic units
  asset: string           // token contract address
  network: string         // CAIP-2 chain ID or x402 network name
  description?: string
  maxTimeoutSeconds?: number
  category?: string       // api_access, data, compute
  idempotencyKey?: string
  signature?: string      // delegate signature (optional — enables one-shot authorize+execute)
}

interface X402ApprovalRow {
  id: string
  status: string
  token_symbol: string
  amount_human: string
  expires_at: string
  machine_challenge_id: string | null
}

interface X402ExpectedContext {
  paymentId: string
  payloadHash: string
  resourceUrl: string
  merchantTo: string
  amount: string
  asset: string
  network: string
  expiresAt?: string
}

// ── Helpers ───────────────────────────────────────────────────────

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr)
}

function isPositiveDecimalAtomicAmount(value: string): boolean {
  return DECIMAL_ATOMIC_AMOUNT_RE.test(value) && BigInt(value) > 0n
}

/**
 * Normalise an Ethereum address to its canonical EIP-55 checksum form.
 *
 * x402 payment-required headers are emitted by third-party services that may
 * ship malformed (non-checksummed or mis-cased) addresses. ethers v6 throws
 * `bad address checksum` when ABI-encoding such values, which surfaced here
 * as a confusing "Failed to generate transfer hash" error.
 *
 * Lower-casing first lets `getAddress()` skip checksum validation and just
 * recompute it, so any 40-hex address (any casing) is accepted.
 */
function normaliseAddress(addr: string): string {
  return ethers.getAddress(addr.toLowerCase())
}

function chainIdFromX402Network(network: string): number | null {
  if (network === 'base') return 8453
  if (network.startsWith('eip155:')) {
    const chainId = Number(network.slice('eip155:'.length))
    return Number.isInteger(chainId) ? chainId : null
  }
  return null
}

async function signX402ExpectedContext(context: X402ExpectedContext) {
  const privateKey = process.env.X402_BINDING_PRIVATE_KEY
  if (!privateKey) {
    throw new Error(
      'X402_BINDING_PRIVATE_KEY must be set to authenticate x402 expected context. ' +
        'Do not fall back to RELAYER_PRIVATE_KEY — the binding signer must be a dedicated key ' +
        'so that the edge signer can verify it against HAVEN_X402_BINDING_SIGNER.',
    )
  }
  const wallet = new ethers.Wallet(privateKey)
  const message = buildX402ExpectedMessage(context)
  return {
    version: 1 as const,
    message,
    signature: await wallet.signMessage(message),
    signer: wallet.address,
  }
}

async function currentPaymentIntentStatus(id: string, agent: AgentContext): Promise<string> {
  const current = await pool.query<{ status: string }>(
    `SELECT status FROM payment_intents WHERE id = $1 AND agent_id = $2`,
    [id, agent.id],
  )
  return current.rows[0]?.status ?? 'unknown'
}

function x402MetadataNetwork(metadata: unknown): string | null {
  if (!metadata) return null
  const parsed = typeof metadata === 'string'
    ? (() => {
        try {
          return JSON.parse(metadata) as unknown
        } catch {
          return null
        }
      })()
    : metadata
  if (!parsed || typeof parsed !== 'object') return null
  const network = (parsed as { network?: unknown }).network
  return typeof network === 'string' ? network : null
}

function existingX402IntentMismatch(
  existing: Record<string, unknown>,
  requested: {
    resourceUrl: string
    fundingTo: string
    merchantTo: string
    amountRaw: string
    tokenAddress: string
    network: string
  },
): string | null {
  const existingResource = existing.x402_resource_url ?? existing.payment_resource_url
  if (existingResource && existingResource !== requested.resourceUrl) return 'resource_url'

  const existingFundingTo = typeof existing.to_address === 'string' ? existing.to_address.toLowerCase() : null
  if (existingFundingTo && existingFundingTo !== requested.fundingTo.toLowerCase()) return 'funding_to'

  const existingMerchant = existing.x402_merchant_address ?? existing.merchant_address
  if (typeof existingMerchant === 'string' && existingMerchant.toLowerCase() !== requested.merchantTo.toLowerCase()) {
    return 'merchant_to'
  }

  if (existing.amount_raw && existing.amount_raw !== requested.amountRaw) return 'amount'

  const existingToken = typeof existing.token_address === 'string' ? existing.token_address.toLowerCase() : null
  if (existingToken && existingToken !== requested.tokenAddress.toLowerCase()) return 'asset'

  const existingNetwork = x402MetadataNetwork(existing.machine_metadata)
  if (existingNetwork && existingNetwork !== requested.network) return 'network'

  return null
}

/** Resolve a token from its contract address for a specific chain. */
function resolveTokenByAddress(chainId: number, address: string) {
  const lower = address.toLowerCase()
  const chain = getChain(chainId)
  if (lower === ZERO_ADDRESS) {
    return Object.values(chain.tokens).find((t) => t.address === null) ?? null
  }
  return chain.tokenByAddress[lower] ?? null
}

function pendingApprovalResponse(
  approval: X402ApprovalRow,
  remainingHuman: string | null,
  context: {
    url: string
    merchantPayTo: string | null
    chainId: number
    amountAtomic: string
    asset: string
    network: string
    description?: string
    idempotencyKey?: string
  },
) {
  return {
    payment_id: approval.id,
    kind: 'approval_request',
    rail: AgentPaymentRail.X402,
    status: 'pending_approval',
    phase: AgentPaymentPhase.UserApprovalRequired,
    next_action: AgentPaymentNextAction.WaitForUserApproval,
    message:
      `This x402 funding payment of ${approval.amount_human} ${approval.token_symbol} is waiting for user approval in Haven. ` +
      'Do not start a new merchant session or create another payment; poll this payment id and resume the original x402 request after approval.',
    remaining: remainingHuman,
    requested: approval.amount_human,
    token: approval.token_symbol,
    resource_url: context.url,
    merchant_address: context.merchantPayTo,
    chain_id: context.chainId,
    amount_atomic: context.amountAtomic,
    asset: context.asset,
    network: context.network,
    description: context.description ?? null,
    idempotency_key: context.idempotencyKey ?? null,
    expires_at: approval.expires_at,
    challenge_id: approval.machine_challenge_id,
    x402: {
      amount_atomic: context.amountAtomic,
      asset: context.asset,
      network: context.network,
      resource_url: context.url,
      merchant_address: context.merchantPayTo,
      description: context.description ?? null,
      idempotency_key: context.idempotencyKey ?? null,
    },
  }
}

// ── Routes ────────────────────────────────────────────────────────

export default async function x402Routes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', agentAuthMiddleware)

  /**
   * POST /x402/authorize — Authorize an x402 payment
   *
   * Two modes:
   * 1. Without `signature`: creates a payment intent, returns sign_hash (agent signs, then calls POST /payments/:id/sign)
   * 2. With `signature`: creates intent AND executes in one shot (for SDK convenience)
   */
  const authorizeX402Handler = async (
    request: FastifyRequest<{ Body: X402AuthorizeBody }>,
    reply: FastifyReply,
  ) => {
    const agent = request.agent as AgentContext
    const {
      url,
      amount,
      asset,
      network,
      description,
      category,
      idempotencyKey,
      signature,
    } = request.body
    let { payTo } = request.body
    let { merchantPayTo } = request.body

    // 1. Validate inputs
    if (!url || typeof url !== 'string') {
      return reply.code(400).send({ error: 'Resource URL is required' })
    }
    if (!payTo || !isValidAddress(payTo)) {
      return reply.code(400).send({ error: 'Valid payTo address is required' })
    }
    // Re-checksum to canonical EIP-55 form. Third-party x402 servers sometimes
    // ship mis-cased addresses; ethers ABI-encoding rejects those downstream.
    payTo = normaliseAddress(payTo)
    if (!amount || typeof amount !== 'string') {
      return reply.code(400).send({ error: 'Amount (atomic units) is required' })
    }
    if (!isPositiveDecimalAtomicAmount(amount)) {
      return reply.code(400).send({
        error: 'Invalid amount — must be a positive decimal integer in atomic units',
      })
    }
    if (!asset || typeof asset !== 'string') {
      return reply.code(400).send({ error: 'Asset (token address) is required' })
    }
    if (!network || typeof network !== 'string') {
      return reply.code(400).send({ error: 'Network is required' })
    }
    const requestedChainId = chainIdFromX402Network(network)
    if (!requestedChainId) {
      return reply.code(400).send({ error: `Unsupported x402 network: ${network}` })
    }
    if (requestedChainId !== agent.chain_id) {
      return reply.code(400).send({
        error: `x402 network ${network} does not match agent chain ${agent.chain_id}`,
      })
    }
    if (merchantPayTo !== undefined) {
      if (!merchantPayTo || !isValidAddress(merchantPayTo)) {
        return reply.code(400).send({ error: 'Valid merchantPayTo address is required' })
      }
      merchantPayTo = normaliseAddress(merchantPayTo)
    }
    if (idempotencyKey !== undefined && (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.length === 0 ||
      idempotencyKey.length > 128
    )) {
      return reply.code(400).send({ error: 'idempotencyKey must be a non-empty string up to 128 characters' })
    }

    // 2. Resolve token from asset address
    const chain = getChain(agent.chain_id)
    const tokenConfig = resolveTokenByAddress(agent.chain_id, asset)
    if (!tokenConfig) {
      return reply.code(400).send({
        error: `Unsupported token asset: ${asset}`,
        supported: Object.values(chain.tokens).map((t) => ({
          symbol: t.symbol,
          address: t.address ?? ZERO_ADDRESS,
        })),
      })
    }

    // Token address for AllowanceModule
    const tokenAddress = tokenConfig.address ?? ZERO_ADDRESS

    // 3. Parse amount (already in atomic units from x402)
    const amountRaw = BigInt(amount)

    // Human-readable amount for storage
    const amountHuman = formatTokenValue(amountRaw.toString(), tokenConfig.decimals)

    if (idempotencyKey) {
      const existingResult = await pool.query(
        `SELECT *
         FROM payment_intents
         WHERE agent_id = $1
           AND (x402_idempotency_key = $2 OR machine_idempotency_key = $2)
           AND COALESCE(payment_rail, source) = 'x402'
           AND status <> 'failed'
         ORDER BY created_at DESC
         LIMIT 1`,
        [agent.id, idempotencyKey],
      )
      const existing = existingResult.rows[0]
      if (existing?.status === 'confirmed' && existing.tx_hash) {
        return reply.code(200).send({
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
        })
      }
      if (existing?.status === 'pending_signature' || existing?.status === 'expired') {
        const mismatch = existingX402IntentMismatch(existing, {
          resourceUrl: url,
          fundingTo: payTo,
          merchantTo: merchantPayTo?.toLowerCase() ?? payTo.toLowerCase(),
          amountRaw: amountRaw.toString(),
          tokenAddress,
          network,
        })
        if (mismatch) {
          return reply.code(409).send({
            payment_id: existing.id,
            status: existing.status,
            error: `idempotencyKey already belongs to a different x402 ${mismatch}`,
          })
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

        const refreshedResult = await pool.query<{
          id: string
          status: string
          sign_hash: string
          allowance_nonce: number
          expires_at: string
        }>(
          `UPDATE payment_intents
           SET allowance_nonce = $1,
               sign_hash = $2,
               status = 'pending_signature',
               expires_at = NOW() + interval '10 minutes',
               error_message = NULL
           WHERE id = $3
             AND agent_id = $4
             AND COALESCE(payment_rail, source) = 'x402'
             AND status IN ('pending_signature', 'expired')
             AND tx_hash IS NULL
             AND signature IS NULL
             AND (
               status = 'expired'
               OR expires_at <= NOW()
               OR allowance_nonce <> $1
               OR sign_hash <> $2
             )
           RETURNING id, status, sign_hash, allowance_nonce, expires_at`,
          [existingNonce, existingHash, existing.id, agent.id],
        )
        if (refreshedResult.rows.length > 0) {
          existingHash = refreshedResult.rows[0].sign_hash
          existingNonce = refreshedResult.rows[0].allowance_nonce
          existingExpiresAt = refreshedResult.rows[0].expires_at
          existingStatus = refreshedResult.rows[0].status
        } else if (existing.status === 'expired' || BigInt(refreshedAllowance.nonce) !== BigInt(existing.allowance_nonce)) {
          const status = await currentPaymentIntentStatus(existing.id, agent)
          return reply.code(409).send({
            payment_id: existing.id,
            status,
            error: `x402 payment is ${status}, expected pending_signature`,
          })
        }

        const x402ExpectedAuth = await signX402ExpectedContext({
          paymentId: existing.id,
          payloadHash: existingHash,
          resourceUrl: existing.x402_resource_url,
          merchantTo: existing.x402_merchant_address ?? existing.to_address,
          amount: existing.amount_raw,
          asset: existing.token_address,
          network,
          expiresAt: existingExpiresAt,
        })

        return reply.code(200).send({
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
        })
      }
      if (existing) {
        return reply.code(409).send({
          payment_id: existing.id,
          status: existing.status,
          error: 'x402 payment already in progress',
        })
      }

      const existingApprovalResult = await pool.query<X402ApprovalRow>(
        `SELECT id, status, token_symbol, amount_human, expires_at,
                machine_challenge_id
         FROM approval_requests
         WHERE agent_id = $1
           AND machine_idempotency_key = $2
           AND COALESCE(payment_rail, source) = 'x402'
           AND status <> 'expired'
         ORDER BY created_at DESC
         LIMIT 1`,
        [agent.id, idempotencyKey],
      )
      const existingApproval = existingApprovalResult.rows[0]
      if (existingApproval) {
        const status = await getAgentPaymentStatus(agent, existingApproval.id)
        if (!status) {
          return reply.code(409).send({ error: 'x402 approval already exists but could not be loaded' })
        }
        return reply.code(agentPaymentStatusHttpCode(status)).send(status)
      }
    }

    // 4. Policy check: agent must have this token in the on-chain allowance config
    const dbAllowance = await pool.query(
      `SELECT allowance_amount FROM agent_allowances
       WHERE agent_id = $1 AND LOWER(token_address) = LOWER($2)`,
      [agent.id, tokenAddress],
    )
    if (dbAllowance.rows.length === 0) {
      return reply.code(403).send({
        error: `Agent is not configured for ${tokenConfig.symbol} payments`,
      })
    }

    // 5. Rate limiting: max x402 payments per hour
    const agentConfig = await pool.query(
      `SELECT max_x402_per_hour FROM agents WHERE id = $1`,
      [agent.id],
    )
    const maxPerHour = agentConfig.rows[0]?.max_x402_per_hour ?? 100

    const recentCount = await pool.query(
      `SELECT COUNT(*) as cnt FROM payment_intents
       WHERE agent_id = $1 AND source = 'x402' AND created_at > NOW() - interval '1 hour'`,
      [agent.id],
    )
    if (Number(recentCount.rows[0].cnt) >= maxPerHour) {
      return reply.code(429).send({
        error: `Rate limit exceeded: max ${maxPerHour} x402 payments per hour`,
        retry_after_seconds: 60,
      })
    }

    // 6. On-chain allowance check + auto-queue when over the remaining allowance
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
      return reply.code(502).send({
        error: 'Failed to read delegate token balance',
        details: err instanceof Error ? err.message : String(err),
      })
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
      const balanceHuman = ethers.formatUnits(delegateBalance, tokenConfig.decimals)
      const remainingHuman = ethers.formatUnits(effective.remaining, tokenConfig.decimals)
      const coverageHuman = ethers.formatUnits(totalCoverage, tokenConfig.decimals)
      const shortfallHuman = ethers.formatUnits(shortfallRaw, tokenConfig.decimals)
      return reply.code(422).send({
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
      })
    }

    if (decision.kind === 'queue') {
      const remainingHuman = ethers.formatUnits(effective.remaining, tokenConfig.decimals)
      const merchantPart = merchantPayTo ? ` to merchant ${merchantPayTo}` : ''
      const approvalReason = `x402 payment for ${url}${merchantPart}${category ? ` (${category})` : ''} — exceeds remaining allowance (${amountHuman} ${tokenConfig.symbol} requested, ${remainingHuman} available)`
      const metadata = {
        protocol: 'x402',
        network,
        category: category ?? null,
        description: description ?? null,
      }

      // Shared approval-row writer (see lib/machine-payments.createMachineApproval)
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
        const existingApprovalResult = await pool.query<X402ApprovalRow>(
          `SELECT id, status, token_symbol, amount_human, expires_at,
                  machine_challenge_id
           FROM approval_requests
           WHERE agent_id = $1
             AND machine_idempotency_key = $2
             AND COALESCE(payment_rail, source) = 'x402'
             AND status <> 'expired'
           ORDER BY created_at DESC
           LIMIT 1`,
          [agent.id, idempotencyKey],
        )
        approval = existingApprovalResult.rows[0] ?? null
      }
      if (!approval) {
        return reply.code(409).send({ error: 'x402 approval already exists but could not be loaded' })
      }
      if (approval.status !== 'pending') {
        const status = await getAgentPaymentStatus(agent, approval.id)
        if (!status) {
          return reply.code(409).send({ error: 'x402 approval already exists but could not be loaded' })
        }
        return reply.code(agentPaymentStatusHttpCode(status)).send(status)
      }
      return reply.code(202).send(pendingApprovalResponse(approval, remainingHuman, {
        url,
        merchantPayTo: merchantPayTo?.toLowerCase() ?? null,
        chainId: agent.chain_id,
        amountAtomic: amountRaw.toString(),
        asset,
        network,
        description,
        idempotencyKey,
      }))
    }

    // 7. Generate transfer hash on-chain.
    //
    // For standard x402, `payTo` can be the agent-owned delegate EOA because
    // the protocol's merchant-facing payment header is settled from an EOA.
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
      return reply.code(502).send({
        error: 'Failed to generate transfer hash',
        details: err instanceof Error ? err.message : String(err),
      })
    }

    // 10. Store intent with x402 metadata
    const intentResult = await pool.query(
      `INSERT INTO payment_intents (
        agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
        to_address, amount_raw, amount_human, delegate_address,
        allowance_nonce, sign_hash, status, source, x402_resource_url, x402_category,
        x402_merchant_address, x402_idempotency_key,
        payment_rail, payment_resource_url, merchant_address, machine_idempotency_key,
        machine_metadata, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending_signature',
        'x402', $13, $14, $15, $16, 'x402', $17, $18, $19, $20,
        NOW() + interval '10 minutes')
      ON CONFLICT (agent_id, x402_idempotency_key)
        WHERE x402_idempotency_key IS NOT NULL
          AND status NOT IN ('failed', 'expired')
      DO NOTHING
      RETURNING *`,
      [
        agent.id, agent.user_id, agent.safe_address, agent.chain_id,
        tokenConfig.symbol, tokenAddress, payTo.toLowerCase(),
        amountRaw.toString(), amountHuman, agent.delegate_address,
        onChainAllowance.nonce, signHash,
        url, category ?? null, merchantPayTo?.toLowerCase() ?? null, idempotencyKey ?? null,
        url, merchantPayTo?.toLowerCase() ?? null, idempotencyKey ?? null,
        JSON.stringify({
          protocol: 'x402',
          network,
          category: category ?? null,
          description: description ?? null,
        }),
      ],
    )
    let intent = intentResult.rows[0]
    if (!intent && idempotencyKey) {
      const existingResult = await pool.query(
        `SELECT *
         FROM payment_intents
         WHERE agent_id = $1
           AND (x402_idempotency_key = $2 OR machine_idempotency_key = $2)
           AND COALESCE(payment_rail, source) = 'x402'
           AND status NOT IN ('failed', 'expired')
         ORDER BY created_at DESC
         LIMIT 1`,
        [agent.id, idempotencyKey],
      )
      intent = existingResult.rows[0]
    }
    if (!intent) {
      return reply.code(409).send({ error: 'x402 payment already exists but could not be loaded' })
    }

    // 11. If signature provided, execute immediately (one-shot mode)
    if (signature) {
      // Verify signature
      let recoveredAddress: string
      try {
        recoveredAddress = recoverSigner(signHash, signature)
      } catch (err) {
        return reply.code(400).send({
          error: 'Invalid signature format',
          details: err instanceof Error ? err.message : String(err),
        })
      }

      if (recoveredAddress.toLowerCase() !== agent.delegate_address.toLowerCase()) {
        return reply.code(403).send({
          error: 'Signature does not match delegate address',
          expected: agent.delegate_address,
          recovered: recoveredAddress,
        })
      }

      // Record the signature first (pending_signature → signed), then execute on-chain.
      // We do NOT set status='submitted' until we have a txHash in hand — if the process
      // crashes between a premature 'submitted' write and the RPC call, the intent would be
      // permanently stuck (idempotency check blocks retry on any status not in
      // ('failed','expired')). Instead we keep the record in 'pending_signature' until
      // execution succeeds, then flip it to 'confirmed' in one atomic write.
      const signatureResult = await pool.query<{ id: string }>(
        `UPDATE payment_intents
         SET signature = $1, signed_at = NOW()
         WHERE id = $2
           AND agent_id = $3
           AND COALESCE(payment_rail, source) = 'x402'
           AND status = 'pending_signature'
           AND tx_hash IS NULL
         RETURNING id`,
        [signature, intent.id, agent.id],
      )
      if (signatureResult.rows.length === 0) {
        const status = await currentPaymentIntentStatus(intent.id, agent)
        return reply.code(409).send({
          payment_id: intent.id,
          status,
          error: 'Payment intent changed before execution',
        })
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
        )

        const fiatValues = await getFiatValuesForTokenAmount(
          tokenConfig.symbol,
          amountHuman,
        )

        const confirmedResult = await pool.query<{ id: string }>(
          `UPDATE payment_intents
           SET status = 'confirmed',
               tx_hash = $1,
               submitted_at = NOW(),
               confirmed_at = NOW(),
               usd_value = $3,
               eur_value = $4
           WHERE id = $2
             AND agent_id = $5
             AND COALESCE(payment_rail, source) = 'x402'
             AND status = 'pending_signature'
             AND tx_hash IS NULL
           RETURNING id`,
          [txHash, intent.id, fiatValues.usd, fiatValues.eur, agent.id],
        )

        if (confirmedResult.rows.length === 0) {
          const status = await currentPaymentIntentStatus(intent.id, agent)
          return reply.code(409).send({
            payment_id: intent.id,
            status,
            error: 'Payment intent changed after on-chain execution',
          })
        }

        await tryRecordMachinePaymentEvidenceBaseById(intent.id, agent.id, request.log)
        emitFunnelEvent(agent.user_id, 'first_payment_settled', { payment_id: intent.id, rail: 'x402' })

        return reply.code(201).send({
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
        })
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        await pool.query(
          `UPDATE payment_intents
           SET status = 'failed', error_message = $1
           WHERE id = $2
             AND agent_id = $3
             AND COALESCE(payment_rail, source) = 'x402'
             AND status = 'pending_signature'
             AND tx_hash IS NULL`,
          [errorMsg, intent.id, agent.id],
        )
        return reply.code(502).send({
          success: false,
          payment_id: intent.id,
          status: 'failed',
          error: 'On-chain execution failed',
          details: errorMsg,
        })
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
    })

    // 12. No signature — return intent for client-side signing
    return reply.code(201).send({
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
    })
  }

  app.post<{ Body: X402AuthorizeBody }>('/', authorizeX402Handler)
  app.post<{ Body: X402AuthorizeBody }>('/authorize', authorizeX402Handler)
}
