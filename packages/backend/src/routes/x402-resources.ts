/**
 * x402 resource management — server side of the x402 payment protocol.
 *
 * Lets Haven users register resources (URLs, APIs, data) behind a payment
 * wall. Any HTTP client — including Haven API Key agents via POST /x402/authorize
 * — can pay the required amount and get a verified receipt in return.
 *
 * Flow:
 *   1. Resource owner: POST /x402/resources           → registers resource + price
 *   2. Payer's server: GET  /x402/resources/:id        → public challenge (402 info)
 *   3. Agent pays via: POST /x402/authorize            → gets tx_hash
 *   4. Payer's server: POST /x402/resources/:id/verify → verifies tx_hash on-chain
 *   5. If valid: resource_owner sees receipt in GET /x402/receipts
 */

import { FastifyInstance } from 'fastify'
import { ethers } from 'ethers'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { getChain } from '../lib/chains.js'
import { getProvider } from '../lib/allowance-module.js'
import { formatTokenValue } from '../lib/tokens.js'

// ── ABI for decoding AllowanceModule calldata ─────────────────────

const ALLOWANCE_MODULE_IFACE = new ethers.Interface([
  'function executeAllowanceTransfer(address safe, address token, address to, uint96 amount, address paymentToken, uint96 payment, address delegate, bytes signature)',
])

// ── Types ─────────────────────────────────────────────────────────

interface ResourceRow {
  id: string
  user_id: string
  safe_id: string | null
  safe_address: string | null
  name: string
  description: string | null
  price_amount: string
  token_address: string
  token_symbol: string
  chain_id: number
  active: boolean
  created_at: string
}

interface ReceiptRow {
  id: string
  resource_id: string
  resource_name: string
  user_id: string
  tx_hash: string
  payer_address: string | null
  amount_raw: string
  chain_id: number
  verified_at: string
}

interface CreateResourceBody {
  name: string
  description?: string
  price_amount: string   // atomic units
  token_address: string
  token_symbol: string
  chain_id?: number
  safe_id?: string
}

interface VerifyBody {
  tx_hash: string
}

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr)
}

function isValidTxHash(hash: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(hash)
}

// ── Routes ────────────────────────────────────────────────────────

export default async function x402ResourceRoutes(app: FastifyInstance): Promise<void> {

  // ── Authenticated resource management ──────────────────────────

  // POST /x402/resources — register a payable resource
  app.post<{ Body: CreateResourceBody }>(
    '/resources',
    { onRequest: [authMiddleware] },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { name, description, price_amount, token_address, token_symbol, chain_id, safe_id } =
        request.body

      if (!name?.trim()) return reply.code(400).send({ error: 'name is required' })
      if (!price_amount) return reply.code(400).send({ error: 'price_amount (atomic units) is required' })
      if (!token_address || !isValidAddress(token_address)) {
        return reply.code(400).send({ error: 'Valid token_address is required' })
      }
      if (!token_symbol?.trim()) return reply.code(400).send({ error: 'token_symbol is required' })

      try {
        BigInt(price_amount)
      } catch {
        return reply.code(400).send({ error: 'price_amount must be an integer string (atomic units)' })
      }

      const resolvedChainId = chain_id ?? 100

      // Verify safe belongs to user (if provided)
      let safeAddress: string | null = null
      if (safe_id) {
        const safeCheck = await pool.query<{ safe_address: string }>(
          'SELECT safe_address FROM user_safes WHERE id = $1 AND user_id = $2',
          [safe_id, sub],
        )
        if (safeCheck.rows.length === 0) {
          return reply.code(400).send({ error: 'Safe not found or does not belong to you' })
        }
        safeAddress = safeCheck.rows[0].safe_address
      } else {
        // Fall back to user's default safe
        const userSafe = await pool.query<{ id: string; safe_address: string }>(
          'SELECT id, safe_address FROM user_safes WHERE user_id = $1 AND is_default = true LIMIT 1',
          [sub],
        )
        if (userSafe.rows.length > 0) {
          safeAddress = userSafe.rows[0].safe_address
        }
      }

      if (!safeAddress) {
        return reply.code(400).send({ error: 'No Safe found — deploy a Safe first' })
      }

      const result = await pool.query<{ id: string }>(
        `INSERT INTO x402_resources
           (user_id, safe_id, name, description, price_amount, token_address, token_symbol, chain_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          sub,
          safe_id ?? null,
          name.trim(),
          description?.trim() ?? null,
          price_amount,
          token_address.toLowerCase(),
          token_symbol.toUpperCase(),
          resolvedChainId,
        ],
      )

      const id = result.rows[0].id
      const priceHuman = formatTokenValue(price_amount, _tokenDecimals(resolvedChainId, token_address))

      return reply.code(201).send({
        resource_id: id,
        name: name.trim(),
        price_amount,
        price_human: priceHuman,
        token_symbol: token_symbol.toUpperCase(),
        token_address: token_address.toLowerCase(),
        chain_id: resolvedChainId,
        pay_to: safeAddress,
        challenge: _buildChallenge(id, safeAddress, token_address, price_amount, resolvedChainId, name.trim()),
      })
    },
  )

  // GET /x402/resources — list user's resources
  app.get(
    '/resources',
    { onRequest: [authMiddleware] },
    async (request) => {
      const { sub } = request.user as { sub: string }

      const result = await pool.query<ResourceRow>(
        `SELECT r.id, r.user_id, r.safe_id, us.safe_address,
                r.name, r.description, r.price_amount, r.token_address,
                r.token_symbol, r.chain_id, r.active, r.created_at
         FROM x402_resources r
         LEFT JOIN user_safes us ON r.safe_id = us.id
         WHERE r.user_id = $1
         ORDER BY r.created_at DESC`,
        [sub],
      )

      return {
        resources: result.rows.map((r) => ({
          resource_id: r.id,
          name: r.name,
          description: r.description,
          price_amount: r.price_amount,
          price_human: formatTokenValue(r.price_amount, _tokenDecimals(r.chain_id, r.token_address)),
          token_symbol: r.token_symbol,
          token_address: r.token_address,
          chain_id: r.chain_id,
          pay_to: r.safe_address,
          active: r.active,
          created_at: r.created_at,
          challenge: r.safe_address
            ? _buildChallenge(r.id, r.safe_address, r.token_address, r.price_amount, r.chain_id, r.name)
            : null,
        })),
      }
    },
  )

  // DELETE /x402/resources/:id — deactivate a resource
  app.delete<{ Params: { id: string } }>(
    '/resources/:id',
    { onRequest: [authMiddleware] },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params

      const result = await pool.query(
        `UPDATE x402_resources SET active = false, updated_at = NOW()
         WHERE id = $1 AND user_id = $2 RETURNING id`,
        [id, sub],
      )
      if (result.rows.length === 0) return reply.code(404).send({ error: 'Resource not found' })
      return { success: true }
    },
  )

  // GET /x402/receipts — list received payments
  app.get(
    '/receipts',
    { onRequest: [authMiddleware] },
    async (request) => {
      const { sub } = request.user as { sub: string }

      const result = await pool.query<ReceiptRow>(
        `SELECT rc.id, rc.resource_id, r.name AS resource_name,
                rc.user_id, rc.tx_hash, rc.payer_address,
                rc.amount_raw, rc.chain_id, rc.verified_at
         FROM x402_receipts rc
         JOIN x402_resources r ON rc.resource_id = r.id
         WHERE rc.user_id = $1
         ORDER BY rc.verified_at DESC
         LIMIT 100`,
        [sub],
      )

      return {
        receipts: result.rows.map((r) => ({
          receipt_id: r.id,
          resource_id: r.resource_id,
          resource_name: r.resource_name,
          tx_hash: r.tx_hash,
          payer_address: r.payer_address,
          amount_raw: r.amount_raw,
          amount_human: formatTokenValue(r.amount_raw, 6), // USDC default; best-effort
          chain_id: r.chain_id,
          verified_at: r.verified_at,
        })),
      }
    },
  )

  // ── Public endpoints ────────────────────────────────────────────

  /**
   * GET /x402/resources/:id/challenge
   *
   * Public endpoint — returns the 402 payment challenge for a resource.
   * Resource servers embed this in their 402 response so paying agents
   * know exactly what to send and where.
   */
  app.get<{ Params: { id: string } }>(
    '/resources/:id/challenge',
    async (request, reply) => {
      const { id } = request.params

      const result = await pool.query<ResourceRow>(
        `SELECT r.id, r.name, r.description, r.price_amount, r.token_address,
                r.token_symbol, r.chain_id, r.active, us.safe_address
         FROM x402_resources r
         LEFT JOIN user_safes us ON r.safe_id = us.id
         WHERE r.id = $1`,
        [id],
      )

      if (result.rows.length === 0) return reply.code(404).send({ error: 'Resource not found' })
      const r = result.rows[0]
      if (!r.active) return reply.code(410).send({ error: 'Resource is no longer active' })
      if (!r.safe_address) return reply.code(503).send({ error: 'Resource has no payment address configured' })

      return reply.code(402).send(
        _buildChallenge(r.id, r.safe_address, r.token_address, r.price_amount, r.chain_id, r.name),
      )
    },
  )

  /**
   * POST /x402/resources/:id/verify
   *
   * Verify that a given tx_hash represents a valid payment for this resource.
   * Anyone (typically the resource owner's server) can call this.
   *
   * On success: stores a receipt and returns { verified: true, receipt_id }.
   * On failure: returns 400/402 with the reason.
   */
  app.post<{ Params: { id: string }; Body: VerifyBody }>(
    '/resources/:id/verify',
    async (request, reply) => {
      const { id } = request.params
      const { tx_hash } = request.body

      if (!tx_hash || !isValidTxHash(tx_hash)) {
        return reply.code(400).send({ error: 'Valid tx_hash (0x + 64 hex chars) is required' })
      }

      // Load resource
      const resourceResult = await pool.query<ResourceRow>(
        `SELECT r.id, r.user_id, r.name, r.price_amount, r.token_address,
                r.token_symbol, r.chain_id, r.active, us.safe_address
         FROM x402_resources r
         LEFT JOIN user_safes us ON r.safe_id = us.id
         WHERE r.id = $1`,
        [id],
      )
      if (resourceResult.rows.length === 0) return reply.code(404).send({ error: 'Resource not found' })
      const resource = resourceResult.rows[0]
      if (!resource.active) return reply.code(410).send({ error: 'Resource is no longer active' })
      if (!resource.safe_address) return reply.code(503).send({ error: 'Resource has no payment address' })

      // Duplicate receipt check
      const existing = await pool.query(
        'SELECT id FROM x402_receipts WHERE tx_hash = $1',
        [tx_hash.toLowerCase()],
      )
      if (existing.rows.length > 0) {
        return reply.code(409).send({ error: 'This transaction has already been used as payment' })
      }

      // On-chain verification
      const verification = await _verifyTx(
        resource.chain_id,
        tx_hash,
        resource.safe_address,
        resource.token_address,
        BigInt(resource.price_amount),
      )

      if (!verification.valid) {
        return reply.code(402).send({
          verified: false,
          reason: verification.reason,
          expected: {
            to: resource.safe_address,
            token: resource.token_address,
            min_amount: resource.price_amount,
            chain_id: resource.chain_id,
          },
        })
      }

      // Store receipt
      const receiptResult = await pool.query<{ id: string; verified_at: string }>(
        `INSERT INTO x402_receipts
           (resource_id, user_id, tx_hash, payer_address, amount_raw, chain_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, verified_at`,
        [
          resource.id,
          resource.user_id,
          tx_hash.toLowerCase(),
          verification.payer ?? null,
          verification.amount?.toString() ?? resource.price_amount,
          resource.chain_id,
        ],
      )
      const receipt = receiptResult.rows[0]

      return reply.code(201).send({
        verified: true,
        receipt_id: receipt.id,
        resource_id: resource.id,
        resource_name: resource.name,
        tx_hash: tx_hash.toLowerCase(),
        payer_address: verification.payer,
        amount_raw: verification.amount?.toString(),
        amount_human: formatTokenValue(
          (verification.amount ?? BigInt(resource.price_amount)).toString(),
          _tokenDecimals(resource.chain_id, resource.token_address),
        ),
        token_symbol: resource.token_symbol,
        verified_at: receipt.verified_at,
      })
    },
  )
}

// ── Private helpers ────────────────────────────────────────────────

function _buildChallenge(
  resourceId: string,
  payTo: string,
  tokenAddress: string,
  priceAmount: string,
  chainId: number,
  description: string,
) {
  const network = `eip155:${chainId}`
  return {
    version: '1',
    resource_id: resourceId,
    accepts: [
      {
        scheme: 'exact',
        network,
        asset: tokenAddress,
        maxAmountRequired: priceAmount,
        payTo,
        description,
        extra: {
          name: 'Haven AllowanceModule',
          authorize_endpoint: '/x402/authorize',
          verify_endpoint: `/x402/resources/${resourceId}/verify`,
        },
      },
    ],
  }
}

/** Best-effort decimals lookup — defaults to 6 (USDC/stables) */
function _tokenDecimals(chainId: number, tokenAddress: string): number {
  try {
    const chain = getChain(chainId)
    const lower = tokenAddress.toLowerCase()
    for (const cfg of Object.values(chain.tokens)) {
      if (cfg.address?.toLowerCase() === lower) return cfg.decimals
    }
  } catch {
    // unknown chain
  }
  return 6
}

/**
 * Verify an on-chain AllowanceModule transfer transaction.
 *
 * Decodes the tx calldata and checks that:
 *   - tx was confirmed (status = 1)
 *   - tx was sent to the AllowanceModule contract
 *   - transfer went to the expected Safe (payTo)
 *   - token matches the resource's token
 *   - amount >= expected price
 */
async function _verifyTx(
  chainId: number,
  txHash: string,
  expectedSafe: string,   // the Safe that should receive the funds (payTo in AllowanceModule)
  expectedToken: string,
  expectedAmount: bigint,
): Promise<{ valid: boolean; reason?: string; payer?: string; amount?: bigint }> {
  try {
    const provider = getProvider(chainId)
    const chain = getChain(chainId)

    const [tx, receipt] = await Promise.all([
      provider.getTransaction(txHash),
      provider.getTransactionReceipt(txHash),
    ])

    if (!tx) return { valid: false, reason: 'Transaction not found on chain' }
    if (!receipt) return { valid: false, reason: 'Transaction not yet confirmed' }
    if (receipt.status !== 1) return { valid: false, reason: 'Transaction reverted' }

    // Check tx was to the AllowanceModule
    const moduleAddress = chain.allowanceModule?.toLowerCase()
    if (moduleAddress && tx.to?.toLowerCase() !== moduleAddress) {
      return { valid: false, reason: 'Transaction was not sent to the AllowanceModule contract' }
    }

    // Decode calldata
    let parsed: ethers.TransactionDescription | null = null
    try {
      parsed = ALLOWANCE_MODULE_IFACE.parseTransaction({ data: tx.data })
    } catch {
      return { valid: false, reason: 'Could not decode transaction calldata as AllowanceModule transfer' }
    }

    if (!parsed || parsed.name !== 'executeAllowanceTransfer') {
      return { valid: false, reason: 'Transaction is not an executeAllowanceTransfer call' }
    }

    const [safe, token, to, amount] = parsed.args as [string, string, string, bigint]

    // 'to' in executeAllowanceTransfer is the recipient of the funds (the Safe owner's Safe)
    if (to.toLowerCase() !== expectedSafe.toLowerCase()) {
      return {
        valid: false,
        reason: `Payment went to ${to}, expected ${expectedSafe}`,
      }
    }

    if (token.toLowerCase() !== expectedToken.toLowerCase()) {
      return {
        valid: false,
        reason: `Wrong token: got ${token}, expected ${expectedToken}`,
      }
    }

    if (amount < expectedAmount) {
      return {
        valid: false,
        reason: `Insufficient amount: got ${amount.toString()}, required ${expectedAmount.toString()}`,
      }
    }

    return {
      valid: true,
      payer: safe.toLowerCase(), // the Safe that paid (payer's Safe)
      amount,
    }
  } catch (err) {
    return {
      valid: false,
      reason: `Verification error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
