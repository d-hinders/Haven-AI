import { FastifyInstance } from 'fastify'
import { ethers } from 'ethers'
import pool from '../db.js'
import { selfSignAgentAuthMiddleware, type SelfSignAgentContext } from '../middleware/selfSignAgentAuth.js'
import { getChain, getExplorerUrl } from '../lib/chains.js'
import {
  getTokenAllowance,
  generateTransferHash,
  recoverSigner,
  executeAllowanceTransfer,
} from '../lib/allowance-module.js'

// ── Constants ─────────────────────────────────────────────────────

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// ── Types ─────────────────────────────────────────────────────────

interface CreatePaymentBody {
  token: string    // e.g. "USDC.e", "xDAI"
  amount: string   // human-readable, e.g. "25.50"
  to: string       // recipient address
  reason?: string  // optional note, used when queued for approval
}

interface SignPaymentBody {
  signature: string // 0x-prefixed 65-byte ECDSA sig
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
  sign_hash: string | null
  signature: string | null
  tx_hash: string | null
  status: string
  error_message: string | null
  reason: string | null
  created_at: string
  signed_at: string | null
  submitted_at: string | null
  confirmed_at: string | null
  expires_at: string
}

// ── Helpers ───────────────────────────────────────────────────────

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr)
}

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

/**
 * Sum amount_raw for this agent+token over payments in the current reset window.
 * Counts 'submitted' and 'confirmed' to prevent double-spending before on-chain confirmation.
 * If resetPeriodMin === 0 the limit is cumulative (no reset).
 */
async function computeSpent(
  agentId: string,
  tokenAddress: string,
  resetPeriodMin: number,
): Promise<bigint> {
  let query: string
  let params: unknown[]

  if (resetPeriodMin > 0) {
    const windowStart = new Date(Date.now() - resetPeriodMin * 60 * 1000)
    query = `
      SELECT COALESCE(SUM(amount_raw::NUMERIC), 0)::TEXT AS total
      FROM self_sign_payment_intents
      WHERE agent_id = $1
        AND LOWER(token_address) = LOWER($2)
        AND status IN ('submitted', 'confirmed')
        AND created_at >= $3`
    params = [agentId, tokenAddress, windowStart]
  } else {
    // No reset — lifetime cumulative
    query = `
      SELECT COALESCE(SUM(amount_raw::NUMERIC), 0)::TEXT AS total
      FROM self_sign_payment_intents
      WHERE agent_id = $1
        AND LOWER(token_address) = LOWER($2)
        AND status IN ('submitted', 'confirmed')`
    params = [agentId, tokenAddress]
  }

  const result = await pool.query<{ total: string }>(query, params)
  return BigInt(result.rows[0].total)
}

// ── Routes ────────────────────────────────────────────────────────

export default async function selfSignPaymentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', selfSignAgentAuthMiddleware)

  // ── POST / — Create payment intent ─────────────────────

  app.post<{ Body: CreatePaymentBody }>('/', async (request, reply) => {
    const agent = request.selfSignAgent as SelfSignAgentContext
    const { token, amount, to, reason } = request.body

    // 1. Validate inputs
    if (!token || typeof token !== 'string') {
      return reply.code(400).send({ error: 'token is required' })
    }
    if (!amount || typeof amount !== 'string' || isNaN(Number(amount)) || Number(amount) <= 0) {
      return reply.code(400).send({ error: 'amount must be a positive number' })
    }
    if (!to || !isValidAddress(to)) {
      return reply.code(400).send({ error: 'Valid recipient address is required' })
    }

    // 2. Resolve token
    const chain = getChain(agent.chain_id)
    const tokenConfig = resolveToken(agent.chain_id, token)
    if (!tokenConfig) {
      return reply.code(400).send({
        error: `Unsupported token: ${token}`,
        supported: Object.values(chain.tokens).map((t) => t.symbol),
      })
    }

    const tokenAddress = tokenConfig.address ?? ZERO_ADDRESS

    // 3. Parse amount
    let amountRaw: bigint
    try {
      amountRaw = ethers.parseUnits(amount, tokenConfig.decimals)
    } catch {
      return reply.code(400).send({ error: `Invalid amount for ${tokenConfig.symbol}` })
    }

    if (amountRaw <= 0n) {
      return reply.code(400).send({ error: 'Amount must be greater than zero' })
    }

    // 4. Policy check — token must be configured in allowances
    const dbAllowance = await pool.query<{
      allowance_amount: string
      reset_period_min: number
      approval_threshold: string | null
    }>(
      `SELECT allowance_amount, reset_period_min, approval_threshold
       FROM self_sign_agent_allowances
       WHERE agent_id = $1 AND LOWER(token_address) = LOWER($2)`,
      [agent.id, tokenAddress],
    )

    if (dbAllowance.rows.length === 0) {
      return reply.code(403).send({
        error: `Agent is not configured for ${tokenConfig.symbol} payments`,
      })
    }

    const { allowance_amount, reset_period_min, approval_threshold } = dbAllowance.rows[0]
    const allowanceAmount = BigInt(allowance_amount)

    // 5. Recipient allowlist check
    const agentRow = await pool.query<{ restrict_recipients: boolean }>(
      'SELECT restrict_recipients FROM self_sign_agents WHERE id = $1',
      [agent.id],
    )
    if (agentRow.rows[0]?.restrict_recipients) {
      const recipientCheck = await pool.query(
        `SELECT id FROM self_sign_agent_recipients
         WHERE agent_id = $1 AND LOWER(address) = LOWER($2)`,
        [agent.id, to],
      )
      if (recipientCheck.rows.length === 0) {
        return reply.code(403).send({
          error: `Recipient ${to} is not in the allowed recipients list for this agent`,
        })
      }
    }

    // 6. Approval threshold check
    const approvalThresholdBigInt = approval_threshold ? BigInt(approval_threshold) : null
    if (approvalThresholdBigInt !== null && amountRaw > approvalThresholdBigInt) {
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
          reason ?? null,
        ],
      )
      const approval = approvalResult.rows[0]
      return reply.code(202).send({
        payment_id: approval.id,
        status: 'pending_approval',
        message: `Payment of ${amount} ${tokenConfig.symbol} exceeds approval threshold. Queued for human approval.`,
        approval_threshold: ethers.formatUnits(approvalThresholdBigInt, tokenConfig.decimals),
        expires_at: approval.expires_at,
      })
    }

    // 7. DB spending enforcement — check remaining in current reset window
    const spent = await computeSpent(agent.id, tokenAddress, reset_period_min)
    const remaining = allowanceAmount - spent

    if (amountRaw > remaining) {
      return reply.code(403).send({
        error: 'Amount exceeds remaining spending limit',
        token: tokenConfig.symbol,
        allowance: ethers.formatUnits(allowanceAmount, tokenConfig.decimals),
        spent: ethers.formatUnits(spent, tokenConfig.decimals),
        remaining: ethers.formatUnits(remaining > 0n ? remaining : 0n, tokenConfig.decimals),
        requested: amount,
        reset_period_min,
      })
    }

    // 8. Generate transfer hash (AllowanceModule format)
    let signHash: string
    let allowanceNonce: number

    try {
      const onChainAllowance = await getTokenAllowance(
        agent.chain_id,
        agent.safe_address,
        agent.delegate_address,
        tokenAddress,
      )
      allowanceNonce = onChainAllowance.nonce

      signHash = await generateTransferHash(
        agent.chain_id,
        agent.safe_address,
        tokenAddress,
        to,
        amountRaw,
        ZERO_ADDRESS,
        0n,
        allowanceNonce,
      )
    } catch {
      // Delegate not registered on-chain — store intent for manual/off-chain flow
      signHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['address', 'address', 'address', 'uint256', 'uint256'],
          [agent.safe_address, tokenAddress, to.toLowerCase(), amountRaw, Date.now()],
        ),
      )
      allowanceNonce = 0
    }

    // 9. Store payment intent
    const result = await pool.query<PaymentIntentRow>(
      `INSERT INTO self_sign_payment_intents (
         agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
         to_address, amount_raw, amount_human, delegate_address,
         sign_hash, reason, status, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         'pending_signature', NOW() + interval '10 minutes')
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
        signHash,
        reason ?? null,
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
          nonce: allowanceNonce,
        },
        instructions:
          'Sign the hash with your delegate private key using raw ECDSA (not eth_sign). ' +
          'Signature must be 65 bytes: r (32) + s (32) + v (1), where v is 27 or 28.',
      },
    })
  })

  // ── POST /:id/sign — Submit signature and execute ───────

  app.post<{ Params: { id: string }; Body: SignPaymentBody }>(
    '/:id/sign',
    async (request, reply) => {
      const agent = request.selfSignAgent as SelfSignAgentContext
      const { id } = request.params
      const { signature } = request.body

      if (!signature || typeof signature !== 'string' || !signature.startsWith('0x')) {
        return reply.code(400).send({ error: 'Valid 0x-prefixed signature is required' })
      }

      // Load intent
      const intentResult = await pool.query<PaymentIntentRow>(
        'SELECT * FROM self_sign_payment_intents WHERE id = $1 AND agent_id = $2',
        [id, agent.id],
      )
      if (intentResult.rows.length === 0) {
        return reply.code(404).send({ error: 'Payment intent not found' })
      }

      const intent = intentResult.rows[0]

      if (intent.status !== 'pending_signature') {
        return reply.code(409).send({
          error: `Payment intent is ${intent.status}, expected pending_signature`,
          status: intent.status,
        })
      }

      if (new Date(intent.expires_at) < new Date()) {
        await pool.query(
          "UPDATE self_sign_payment_intents SET status = 'expired' WHERE id = $1",
          [id],
        )
        return reply.code(410).send({ error: 'Payment intent has expired' })
      }

      // Verify signature matches delegate
      if (!intent.sign_hash) {
        return reply.code(400).send({ error: 'Payment intent has no sign_hash' })
      }

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

      // Mark submitted
      await pool.query(
        `UPDATE self_sign_payment_intents
         SET signature = $1, signed_at = NOW(), status = 'submitted', submitted_at = NOW()
         WHERE id = $2`,
        [signature, id],
      )

      // Execute on-chain via AllowanceModule
      try {
        const { txHash } = await executeAllowanceTransfer(
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

        await pool.query(
          `UPDATE self_sign_payment_intents
           SET status = 'confirmed', tx_hash = $1, confirmed_at = NOW()
           WHERE id = $2`,
          [txHash, id],
        )

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
        const errorMsg = err instanceof Error ? err.message : String(err)
        await pool.query(
          `UPDATE self_sign_payment_intents
           SET status = 'failed', error_message = $1
           WHERE id = $2`,
          [errorMsg, id],
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

  // ── GET /:id — Payment status ───────────────────────────

  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const agent = request.selfSignAgent as SelfSignAgentContext
    const { id } = request.params

    const result = await pool.query<PaymentIntentRow>(
      'SELECT * FROM self_sign_payment_intents WHERE id = $1 AND agent_id = $2',
      [id, agent.id],
    )
    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Payment not found' })
    }

    const intent = result.rows[0]
    return {
      payment_id: intent.id,
      status: intent.status,
      chain_id: intent.chain_id,
      token: intent.token_symbol,
      amount: intent.amount_human,
      to: intent.to_address,
      tx_hash: intent.tx_hash,
      explorer_url: intent.tx_hash
        ? getExplorerUrl(intent.chain_id, 'tx', intent.tx_hash)
        : null,
      error_message: intent.error_message,
      created_at: intent.created_at,
      signed_at: intent.signed_at,
      confirmed_at: intent.confirmed_at,
      expires_at: intent.expires_at,
    }
  })

  // ── GET / — List payments for this agent ────────────────

  app.get('/', async (request) => {
    const agent = request.selfSignAgent as SelfSignAgentContext

    const result = await pool.query<PaymentIntentRow>(
      `SELECT * FROM self_sign_payment_intents
       WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 50`,
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
