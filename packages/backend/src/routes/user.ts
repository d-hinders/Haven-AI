import { FastifyInstance } from 'fastify'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { getSafeDetails } from '../lib/safe-details.js'
import { emitFunnelEvent } from '../lib/onboarding-funnel.js'

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const MAX_NAME_LENGTH = 80
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/
const OWNER_FETCH_CONCURRENCY = 4

interface WalletBody {
  wallet_address: string
}

interface SafeBody {
  safe_address: string
  chain_id?: number
}

interface PreferencesBody {
  currency_preference: string
}

interface ProfileBody {
  name: string
}

interface OwnerAliasBody {
  name: string
}

interface UserSafeRow {
  id: string
  safe_address: string
  chain_id: number
  name: string
}

interface OwnerAliasRow {
  owner_address: string
  name: string
}

function normalizeName(name: unknown): string | null {
  if (typeof name !== 'string') return null

  const normalized = name.trim().replace(/\s+/g, ' ')
  if (
    normalized.length === 0 ||
    normalized.length > MAX_NAME_LENGTH ||
    CONTROL_CHAR_RE.test(name)
  ) {
    return null
  }

  return normalized
}

async function listUserSafes(userId: string): Promise<UserSafeRow[]> {
  const result = await pool.query<UserSafeRow>(
    `SELECT id, safe_address, chain_id, name
     FROM user_safes
     WHERE user_id = $1
     ORDER BY created_at ASC`,
    [userId],
  )

  return result.rows
}

async function getCurrentOwnerDirectory(userId: string) {
  const safes = await listUserSafes(userId)
  const ownerMap = new Map<string, {
    owner_address: string
    accounts: UserSafeRow[]
  }>()
  const failedSafeIds: string[] = []

  for (let index = 0; index < safes.length; index += OWNER_FETCH_CONCURRENCY) {
    const batch = safes.slice(index, index + OWNER_FETCH_CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(async (safe) => ({
        safe,
        details: await getSafeDetails(safe.safe_address, safe.chain_id),
      })),
    )

    for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
      const result = results[resultIndex]
      if (result.status === 'rejected') {
        failedSafeIds.push(batch[resultIndex].id)
        continue
      }

      const { safe, details } = result.value
      for (const owner of details.owners) {
        const normalizedOwner = owner.toLowerCase()
        const existing = ownerMap.get(normalizedOwner)
        if (existing) {
          existing.accounts.push(safe)
        } else {
          ownerMap.set(normalizedOwner, {
            owner_address: normalizedOwner,
            accounts: [safe],
          })
        }
      }
    }
  }

  return {
    owners: [...ownerMap.values()],
    failedSafeIds,
    partialFailure: failedSafeIds.length > 0,
  }
}

export default async function userRoutes(app: FastifyInstance): Promise<void> {
  // All routes in this plugin require auth
  app.addHook('onRequest', authMiddleware)

  // PUT /user/profile
  app.put<{ Body: ProfileBody }>('/profile', async (request, reply) => {
    const { name } = request.body
    const { sub } = request.user as { sub: string }
    const normalizedName = normalizeName(name)

    if (!normalizedName) {
      return reply.code(400).send({ error: 'Enter a name using 80 characters or fewer' })
    }

    const result = await pool.query(
      `UPDATE users SET name = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, email, wallet_address, safe_address, currency_preference, created_at`,
      [normalizedName, sub],
    )

    return result.rows[0]
  })

  // PUT /user/wallet
  app.put<{ Body: WalletBody }>('/wallet', async (request, reply) => {
    const { wallet_address } = request.body
    const { sub } = request.user as { sub: string }

    if (!wallet_address || !ETH_ADDRESS_RE.test(wallet_address)) {
      return reply.code(400).send({ error: 'Invalid Ethereum address' })
    }

    const result = await pool.query(
      `UPDATE users SET wallet_address = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, email, wallet_address, safe_address`,
      [wallet_address, sub],
    )

    return result.rows[0]
  })

  // PUT /user/safe
  app.put<{ Body: SafeBody }>('/safe', async (request, reply) => {
    const { safe_address, chain_id = 100 } = request.body
    const { sub } = request.user as { sub: string }

    if (!safe_address || !ETH_ADDRESS_RE.test(safe_address)) {
      return reply.code(400).send({ error: 'Invalid Ethereum address' })
    }

    const result = await pool.query(
      `UPDATE users SET safe_address = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, email, wallet_address, safe_address`,
      [safe_address, sub],
    )

    // Also insert into user_safes (multi-Safe support)
    await pool.query(
      `INSERT INTO user_safes (user_id, safe_address, chain_id, name, is_default)
       VALUES ($1, $2, $3, 'My account', true)
       ON CONFLICT (user_id, safe_address, chain_id) DO NOTHING`,
      [sub, safe_address, chain_id],
    )

    emitFunnelEvent(sub, 'safe_imported', { safe_address, chain_id })
    return result.rows[0]
  })

  // GET /user/preferences
  app.get('/preferences', async (request) => {
    const { sub } = request.user as { sub: string }

    const result = await pool.query(
      'SELECT currency_preference FROM users WHERE id = $1',
      [sub],
    )

    return { currency_preference: result.rows[0]?.currency_preference ?? 'USD' }
  })

  // PUT /user/preferences
  app.put<{ Body: PreferencesBody }>('/preferences', async (request, reply) => {
    const { currency_preference } = request.body
    const { sub } = request.user as { sub: string }

    if (!currency_preference || !['USD', 'EUR'].includes(currency_preference)) {
      return reply.code(400).send({ error: 'Invalid currency. Must be USD or EUR.' })
    }

    const result = await pool.query(
      `UPDATE users SET currency_preference = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING currency_preference`,
      [currency_preference, sub],
    )

    return { currency_preference: result.rows[0].currency_preference }
  })

  // GET /user/owners
  app.get('/owners', async (request) => {
    const { sub } = request.user as { sub: string }
    const directory = await getCurrentOwnerDirectory(sub)
    const addresses = directory.owners.map((owner) => owner.owner_address)
    const aliasMap = new Map<string, string>()

    if (addresses.length > 0) {
      const aliasResult = await pool.query<OwnerAliasRow>(
        `SELECT owner_address, name
         FROM owner_aliases
         WHERE user_id = $1
           AND owner_address = ANY($2::varchar[])`,
        [sub, addresses],
      )

      for (const row of aliasResult.rows) {
        aliasMap.set(row.owner_address.toLowerCase(), row.name)
      }
    }

    return {
      owners: directory.owners.map((owner) => ({
        owner_address: owner.owner_address,
        name: aliasMap.get(owner.owner_address) ?? null,
        accounts: owner.accounts.map((safe) => ({
          id: safe.id,
          safe_address: safe.safe_address,
          chain_id: safe.chain_id,
          name: safe.name,
        })),
      })),
      partialFailure: directory.partialFailure,
      failedSafeIds: directory.failedSafeIds,
    }
  })

  // PUT /user/owners/:ownerAddress
  app.put<{ Params: { ownerAddress: string }; Body: OwnerAliasBody }>(
    '/owners/:ownerAddress',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { ownerAddress } = request.params
      const normalizedOwner = ownerAddress.toLowerCase()
      const normalizedName = normalizeName(request.body?.name)

      if (!ETH_ADDRESS_RE.test(ownerAddress)) {
        return reply.code(400).send({ error: 'Invalid owner address' })
      }

      if (!normalizedName) {
        return reply.code(400).send({ error: 'Enter a name using 80 characters or fewer' })
      }

      const directory = await getCurrentOwnerDirectory(sub)
      const currentOwner = directory.owners.find((owner) => owner.owner_address === normalizedOwner)

      if (!currentOwner) {
        if (directory.partialFailure) {
          return reply.code(503).send({ error: 'Could not verify current account owners' })
        }
        return reply.code(404).send({ error: 'Owner not found for linked accounts' })
      }

      const result = await pool.query<OwnerAliasRow>(
        `INSERT INTO owner_aliases (user_id, owner_address, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, owner_address)
         DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
         RETURNING owner_address, name`,
        [sub, normalizedOwner, normalizedName],
      )

      return {
        owner_address: result.rows[0].owner_address,
        name: result.rows[0].name,
      }
    },
  )

  // DELETE /user/owners/:ownerAddress
  app.delete<{ Params: { ownerAddress: string } }>(
    '/owners/:ownerAddress',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { ownerAddress } = request.params

      if (!ETH_ADDRESS_RE.test(ownerAddress)) {
        return reply.code(400).send({ error: 'Invalid owner address' })
      }

      await pool.query(
        `DELETE FROM owner_aliases
         WHERE user_id = $1 AND owner_address = $2`,
        [sub, ownerAddress.toLowerCase()],
      )

      return { success: true }
    },
  )
}
