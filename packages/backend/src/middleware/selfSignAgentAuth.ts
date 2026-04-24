import { FastifyRequest, FastifyReply } from 'fastify'
import { createHash } from 'crypto'
import pool from '../db.js'

// ── Types ─────────────────────────────────────────────────────────

export interface SelfSignAgentContext {
  id: string
  user_id: string
  name: string
  delegate_address: string
  safe_address: string
  chain_id: number
}

declare module 'fastify' {
  interface FastifyRequest {
    selfSignAgent?: SelfSignAgentContext
  }
}

// ── EIP-191 signature recovery ────────────────────────────────────

/**
 * Recover the signer address from an EIP-191 personal_sign signature.
 * Message is prefixed with "\x19Ethereum Signed Message:\n{len}".
 */
function recoverAddress(message: string, signature: string): string {
  const { createHash } = require('crypto') as typeof import('crypto')

  const msgBytes = Buffer.from(message, 'utf8')
  const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${msgBytes.length}`, 'utf8')
  const prefixed = Buffer.concat([prefix, msgBytes])
  const msgHash = createHash('sha256').update(prefixed).digest()

  // Use secp256k1 via the Node.js built-in crypto if available (Node 22+),
  // otherwise fall back to the ethereum-cryptography package.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { secp256k1 } = require('ethereum-cryptography/secp256k1') as typeof import('ethereum-cryptography/secp256k1')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { keccak256 } = require('ethereum-cryptography/keccak') as typeof import('ethereum-cryptography/keccak')

    const fullMsg = Buffer.concat([prefix, msgBytes])
    const hash = keccak256(fullMsg)

    const sigHex = signature.startsWith('0x') ? signature.slice(2) : signature
    const r = BigInt('0x' + sigHex.slice(0, 64))
    const s = BigInt('0x' + sigHex.slice(64, 128))
    const v = parseInt(sigHex.slice(128, 130), 16)
    const recovery = v >= 27 ? v - 27 : v

    const sig = new secp256k1.Signature(r, s).addRecoveryBit(recovery)
    const pubKey = sig.recoverPublicKey(hash)
    const pubKeyBytes = pubKey.toRawBytes(false).slice(1) // remove 04 prefix
    const addrHash = keccak256(pubKeyBytes)
    return '0x' + Buffer.from(addrHash).slice(-20).toString('hex')
  } catch {
    throw new Error('Failed to recover signer address — ethereum-cryptography not available')
  }
}

// ── Middleware ─────────────────────────────────────────────────────

/**
 * Authenticate self-signing agent requests via Ethereum signature.
 *
 * Required headers:
 *   X-Agent-Address   — the agent's Ethereum delegate address
 *   X-Agent-Signature — EIP-191 personal_sign of the canonical message
 *   X-Agent-Timestamp — Unix seconds (must be within 5 minutes)
 *
 * Canonical message signed by the agent:
 *   "Haven-AI Agent Request\nAddress: {address}\nTimestamp: {ts}\nMethod: {METHOD}\nPath: {path}\nBody-Hash: {keccak256(body)}"
 */
export async function selfSignAgentAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const address = (request.headers['x-agent-address'] as string | undefined)?.toLowerCase()
  const signature = request.headers['x-agent-signature'] as string | undefined
  const timestampStr = request.headers['x-agent-timestamp'] as string | undefined

  if (!address || !signature || !timestampStr) {
    return reply.code(401).send({
      error: 'Missing self-sign headers: X-Agent-Address, X-Agent-Signature, X-Agent-Timestamp',
    })
  }

  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    return reply.code(401).send({ error: 'Invalid X-Agent-Address format' })
  }

  // Replay protection — timestamp must be within ±5 minutes
  const timestamp = parseInt(timestampStr, 10)
  const nowSec = Math.floor(Date.now() / 1000)
  if (isNaN(timestamp) || Math.abs(nowSec - timestamp) > 300) {
    return reply.code(401).send({ error: 'X-Agent-Timestamp expired or invalid' })
  }

  // Build canonical message
  const rawBody = request.rawBody ?? ''
  const bodyHash = createHash('sha256').update(rawBody).digest('hex')
  const message = [
    'Haven-AI Agent Request',
    `Address: ${address}`,
    `Timestamp: ${timestampStr}`,
    `Method: ${request.method}`,
    `Path: ${request.url}`,
    `Body-Hash: ${bodyHash}`,
  ].join('\n')

  // Recover and verify signer
  let recovered: string
  try {
    recovered = recoverAddress(message, signature)
  } catch (err) {
    return reply.code(401).send({ error: 'Signature recovery failed' })
  }

  if (recovered.toLowerCase() !== address) {
    return reply.code(401).send({ error: 'Signature does not match X-Agent-Address' })
  }

  // Look up agent by delegate_address
  const result = await pool.query<{
    id: string
    user_id: string
    name: string
    delegate_address: string
    safe_address: string | null
    chain_id: number
  }>(
    `SELECT a.id, a.user_id, a.name, a.delegate_address,
            COALESCE(us.safe_address, u.safe_address) AS safe_address,
            COALESCE(us.chain_id, 100) AS chain_id
     FROM self_sign_agents a
     JOIN users u ON a.user_id = u.id
     LEFT JOIN user_safes us ON a.safe_id = us.id
     WHERE LOWER(a.delegate_address) = $1 AND a.status = 'active'`,
    [address],
  )

  if (result.rows.length === 0) {
    return reply.code(401).send({ error: 'No active self-sign agent for this address' })
  }

  const row = result.rows[0]

  if (!row.safe_address) {
    return reply.code(403).send({ error: 'No Safe deployed for this account' })
  }

  request.selfSignAgent = {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    delegate_address: row.delegate_address,
    safe_address: row.safe_address,
    chain_id: row.chain_id,
  }
}
