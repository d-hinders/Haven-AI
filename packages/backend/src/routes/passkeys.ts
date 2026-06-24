import { FastifyInstance } from 'fastify'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { isSupportedChain } from '../lib/chains.js'
import { predictSafePasskeySignerAddress } from '../lib/passkey-signer.js'

const HEX_32_RE = /^0x[0-9a-fA-F]{64}$/
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

interface RegisterPasskeyBody {
  credential_id: string
  public_key_x: string
  public_key_y: string
  chain_id: number
  raw_attestation_object?: string
}

interface UserPasskeyRow {
  id: string
  credential_id: string
  signer_address: string
  chain_id: number
  safe_address: string | null
  created_at: string
}

function isBase64Url(value: string): boolean {
  return value.length > 0 && value.length <= 1024 && BASE64URL_RE.test(value)
}

function decodeBase64Url(value: string): Buffer {
  const padding = (4 - (value.length % 4)) % 4
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padding)
  return Buffer.from(base64, 'base64')
}

function isValidBase64UrlPayload(value: string): boolean {
  if (!isBase64Url(value)) {
    return false
  }

  try {
    const decoded = decodeBase64Url(value)
    return decoded.length > 0
  } catch {
    return false
  }
}

export default async function passkeyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.post<{ Body: RegisterPasskeyBody }>('/', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const {
      credential_id,
      public_key_x,
      public_key_y,
      chain_id,
      raw_attestation_object,
    } = request.body ?? {}

    if (!isSupportedChain(chain_id)) {
      return reply.code(400).send({ error: `Unsupported chain: ${chain_id}` })
    }

    if (!HEX_32_RE.test(public_key_x) || !HEX_32_RE.test(public_key_y)) {
      return reply.code(400).send({ error: 'public_key_x and public_key_y must be 32-byte 0x-prefixed hex values' })
    }

    if (!isBase64Url(credential_id)) {
      return reply.code(400).send({ error: 'credential_id must be a non-empty base64url string' })
    }

    if (
      raw_attestation_object !== undefined &&
      !isValidBase64UrlPayload(raw_attestation_object)
    ) {
      return reply.code(400).send({ error: 'raw_attestation_object must be a valid base64url string' })
    }

    const signerAddress = predictSafePasskeySignerAddress({
      x: public_key_x as `0x${string}`,
      y: public_key_y as `0x${string}`,
      chainId: chain_id,
    }).toLowerCase()

    try {
      // POC only: we persist the raw attestation for future verification, but do not
      // cryptographically verify it yet. A bad enrollment only harms the enrolling user.
      const result = await pool.query<UserPasskeyRow>(
        `INSERT INTO user_passkeys (
           user_id, credential_id, public_key_x, public_key_y, signer_address, chain_id, raw_attestation
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, credential_id, signer_address, chain_id`,
        [
          sub,
          credential_id,
          Buffer.from(public_key_x.slice(2), 'hex'),
          Buffer.from(public_key_y.slice(2), 'hex'),
          signerAddress,
          chain_id,
          raw_attestation_object ? decodeBase64Url(raw_attestation_object) : null,
        ],
      )

      return reply.code(201).send(result.rows[0])
    } catch (error) {
      const constraint = uniqueViolationConstraint(error)
      if (constraint === 'user_passkeys_user_id_chain_id_key') {
        return reply.code(409).send({ error: 'A passkey is already registered for this chain' })
      }
      if (constraint === 'user_passkeys_credential_id_key') {
        return reply.code(409).send({ error: 'This credential is already registered' })
      }
      throw error
    }
  })

  app.get('/', async (request) => {
    const { sub } = request.user as { sub: string }

    const result = await pool.query<UserPasskeyRow>(
      `SELECT id, credential_id, signer_address, chain_id, safe_address, created_at
       FROM user_passkeys
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [sub],
    )

    return { passkeys: result.rows }
  })
}

/**
 * The constraint name from a Postgres unique violation (SQLSTATE 23505), or null
 * for any other error — including null/primitive throws. Lets the caller map the
 * two distinct passkey unique constraints to their 409s without an unsafe
 * `error as {...}` cast (which would throw on a null/primitive throw). Uses the
 * `'code' in err` narrowing from routes/contacts.ts and routes/agents.ts, and is
 * slightly stricter than agents.ts (a `typeof === 'string'` check rather than
 * coercing via `String(...)`). Unlike contacts (single constraint), passkeys
 * needs the constraint name to tell its two unique constraints apart.
 */
function uniqueViolationConstraint(err: unknown): string | null {
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    err.code === '23505' &&
    'constraint' in err &&
    typeof err.constraint === 'string'
  ) {
    return err.constraint
  }
  return null
}
