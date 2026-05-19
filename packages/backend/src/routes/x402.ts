import { FastifyInstance } from 'fastify'
import { ethers } from 'ethers'
import pool from '../db.js'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import { getChain, getExplorerUrl } from '../lib/chains.js'
import { getFiatValuesForTokenAmount } from '../lib/fiat-values.js'
import { formatTokenValue } from '../lib/tokens.js'
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

// ── Helpers ───────────────────────────────────────────────────────

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr)
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
) {
  return {
    payment_id: approval.id,
    status: 'pending_approval',
    message: `Payment of ${approval.amount_human} ${approval.token_symbol} exceeds the remaining on-chain allowance. Queued for owner approval.`,
    remaining: remainingHuman,
    requested: approval.amount_human,
    token: approval.token_symbol,
    expires_at: approval.expires_at,
    rail: 'x402',
    challenge_id: approval.machine_challenge_id,
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
  app.post<{ Body: X402AuthorizeBody }>('/', async (request, reply) => {
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
    let amountRaw: bigint
    try {
      amountRaw = BigInt(amount)
    } catch {
      return reply.code(400).send({ error: 'Invalid amount — must be integer atomic units' })
    }
    if (amountRaw <= 0n) {
      return reply.code(400).send({ error: 'Amount must be greater than zero' })
    }

    // Human-readable amount for storage
    const amountHuman = formatTokenValue(amountRaw.toString(), tokenConfig.decimals)

    if (idempotencyKey) {
      const existingResult = await pool.query(
        `SELECT *
         FROM payment_intents
         WHERE agent_id = $1
           AND (x402_idempotency_key = $2 OR machine_idempotency_key = $2)
           AND status NOT IN ('failed', 'expired')
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
      if (existing?.status === 'pending_signature') {
        let existingHash = existing.sign_hash
        let existingNonce = existing.allowance_nonce
        const refreshedAllowance = await getTokenAllowance(
          agent.chain_id,
          agent.safe_address,
          agent.delegate_address,
          existing.token_address,
        )

        if (Number(refreshedAllowance.nonce) !== Number(existing.allowance_nonce)) {
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

          await pool.query(
            `UPDATE payment_intents
             SET allowance_nonce = $1,
                 sign_hash = $2,
                 expires_at = NOW() + interval '10 minutes'
             WHERE id = $3`,
            [existingNonce, existingHash, existing.id],
          )
        }

        return reply.code(200).send({
          payment_id: existing.id,
          status: existing.status,
          expires_at: existing.expires_at,
          chain_id: existing.chain_id ?? agent.chain_id,
          safe_address: existing.safe_address,
          payer: existing.safe_address,
          token: existing.token_symbol,
          amount: existing.amount_human,
          to: existing.to_address,
          merchant_to: existing.x402_merchant_address,
          resource_url: existing.x402_resource_url,
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
      if (existingApproval?.status === 'rejected') {
        return reply.code(409).send({
          payment_id: existingApproval.id,
          status: existingApproval.status,
          error: 'Payment was rejected by the account owner',
        })
      }
      if (existingApproval) {
        return reply.code(202).send(pendingApprovalResponse(existingApproval, null))
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
    if (amountRaw > effective.remaining) {
      const remainingHuman = ethers.formatUnits(effective.remaining, tokenConfig.decimals)
      const merchantPart = merchantPayTo ? ` to merchant ${merchantPayTo}` : ''
      const approvalReason = `x402 payment for ${url}${merchantPart}${category ? ` (${category})` : ''} — exceeds remaining allowance (${amountHuman} ${tokenConfig.symbol} requested, ${remainingHuman} available)`
      const metadata = {
        protocol: 'x402',
        network,
        category: category ?? null,
        description: description ?? null,
      }

      const approvalResult = await pool.query<X402ApprovalRow>(
        `INSERT INTO approval_requests (
          agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
          to_address, amount_raw, amount_human, reason, source, x402_resource_url,
          payment_rail, payment_resource_url, merchant_address, machine_idempotency_key,
          machine_metadata, status, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'x402', $11,
          'x402', $12, $13, $14, $15, 'pending',
          NOW() + interval '24 hours')
        ON CONFLICT (agent_id, machine_idempotency_key)
          WHERE machine_idempotency_key IS NOT NULL
            AND status NOT IN ('expired')
        DO NOTHING
        RETURNING id, status, token_symbol, amount_human, expires_at, machine_challenge_id`,
        [
          agent.id, agent.user_id, agent.safe_address, agent.chain_id,
          tokenConfig.symbol, tokenAddress, payTo.toLowerCase(),
          amountRaw.toString(), amountHuman, approvalReason, url,
          url, merchantPayTo?.toLowerCase() ?? null, idempotencyKey ?? null,
          JSON.stringify(metadata),
        ],
      )
      let approval = approvalResult.rows[0] ?? null
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
      return reply.code(202).send(pendingApprovalResponse(approval, remainingHuman))
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

      // Update intent with signature
      await pool.query(
        `UPDATE payment_intents SET signature = $1, signed_at = NOW(), status = 'submitted', submitted_at = NOW() WHERE id = $2`,
        [signature, intent.id],
      )

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

        await pool.query(
          `UPDATE payment_intents
           SET status = 'confirmed',
               tx_hash = $1,
               confirmed_at = NOW(),
               usd_value = $3,
               eur_value = $4
           WHERE id = $2`,
          [txHash, intent.id, fiatValues.usd, fiatValues.eur],
        )

        await tryRecordMachinePaymentEvidenceBaseById(intent.id, agent.id, request.log)

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
          `UPDATE payment_intents SET status = 'failed', error_message = $1 WHERE id = $2`,
          [errorMsg, intent.id],
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
  })
}
