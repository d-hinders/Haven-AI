import { FastifyInstance } from 'fastify'
import { ethers } from 'ethers'
import pool from '../db.js'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import { getChain, getExplorerUrl } from '../lib/chains.js'
import { getFiatValuesForTokenAmount } from '../lib/fiat-values.js'
import {
  getTokenAllowance,
  computeEffectiveAllowance,
  generateTransferHash,
  recoverSigner,
  executeAllowanceTransfer,
} from '../lib/allowance-module.js'
import { tryRecordMachinePaymentEvidenceBaseById } from '../lib/machine-payment-evidence.js'

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
}

// ── Helpers ───────────────────────────────────────────────────────

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr)
}

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

  app.post<{ Body: CreatePaymentBody }>('/', async (request, reply) => {
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

    // 4. Policy check: verify agent has this token in their on-chain allowance config
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

    // 5. On-chain allowance check
    let onChainAllowance
    try {
      onChainAllowance = await getTokenAllowance(
        agent.chain_id,
        agent.safe_address,
        agent.delegate_address,
        tokenAddress,
      )
    } catch (err) {
      return reply.code(502).send({
        error: 'Failed to read on-chain allowance',
        details: err instanceof Error ? err.message : String(err),
      })
    }

    const effective = computeEffectiveAllowance(onChainAllowance)

    // 5a. Auto-queue for owner approval when the amount exceeds the on-chain
    // remaining allowance. Agents can request payments of any size — the
    // owner approves or rejects in the dashboard.
    if (amountRaw > effective.remaining) {
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
        status: 'pending_approval',
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

      // 2. Verify signature matches delegate
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

      // 4. Execute on-chain
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
        // 6. Failure
        const errorMsg = err instanceof Error ? err.message : String(err)
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
      error_message: intent.error_message,
      created_at: intent.created_at,
      signed_at: intent.signed_at,
      submitted_at: intent.submitted_at,
      confirmed_at: intent.confirmed_at,
      expires_at: intent.expires_at,
    }
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
