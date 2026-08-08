import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { getSafeDetails } from '../modules/accounts/index.js'
import { emitFunnelEvent } from '../infra/repositories/onboarding-funnel.js'
import {
  findCurrencyPreference,
  updateCurrencyPreference,
  updateUserName,
  updateUserSafeAddress,
  updateUserWalletAddress,
} from '../infra/repositories/users.js'
import {
  linkDefaultUserSafe,
  listSafesWithAccountTypeForUser,
  type SafeWithAccountTypeRow,
} from '../infra/repositories/user-safes.js'
import {
  deleteOwnerAlias,
  listOwnerAliases,
  upsertOwnerAlias,
} from '../infra/repositories/owner-aliases.js'
import { ETH_ADDRESS_RE, DEFAULT_CHAIN_ID } from '@haven_ai/core'
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

async function getCurrentOwnerDirectory(userId: string) {
  const safes = await listSafesWithAccountTypeForUser(userId)
  const ownerMap = new Map<string, {
    owner_address: string
    accounts: SafeWithAccountTypeRow[]
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

    // `?? undefined` preserves the inline query's `result.rows[0]` exactly: a
    // token whose user row no longer exists has always produced an undefined
    // return here, not a 404. Reported rather than fixed (#1167).
    return (await updateUserName(normalizedName, sub)) ?? undefined
  })

  // PUT /user/wallet
  app.put<{ Body: WalletBody }>('/wallet', async (request, reply) => {
    const { wallet_address } = request.body
    const { sub } = request.user as { sub: string }

    if (!wallet_address || !ETH_ADDRESS_RE.test(wallet_address)) {
      return reply.code(400).send({ error: 'Invalid Ethereum address' })
    }

    return (await updateUserWalletAddress(wallet_address, sub)) ?? undefined
  })

  // PUT /user/safe
  app.put<{ Body: SafeBody }>('/safe', async (request, reply) => {
    const { safe_address, chain_id = DEFAULT_CHAIN_ID } = request.body
    const { sub } = request.user as { sub: string }

    if (!safe_address || !ETH_ADDRESS_RE.test(safe_address)) {
      return reply.code(400).send({ error: 'Invalid Ethereum address' })
    }

    const updated = await updateUserSafeAddress(safe_address, sub)

    // Also insert into user_safes (multi-Safe support)
    await linkDefaultUserSafe(sub, safe_address, chain_id)

    emitFunnelEvent(sub, 'safe_imported', { safe_address, chain_id })
    return updated ?? undefined
  })

  // GET /user/preferences
  app.get('/preferences', async (request) => {
    const { sub } = request.user as { sub: string }

    return { currency_preference: (await findCurrencyPreference(sub)) ?? 'USD' }
  })

  // PUT /user/preferences
  app.put<{ Body: PreferencesBody }>('/preferences', async (request, reply) => {
    const { currency_preference } = request.body
    const { sub } = request.user as { sub: string }

    if (!currency_preference || !['USD', 'EUR'].includes(currency_preference)) {
      return reply.code(400).send({ error: 'Invalid currency. Must be USD or EUR.' })
    }

    const updated = await updateCurrencyPreference(currency_preference, sub)

    // The inline query read `rows[0].currency_preference` unguarded, so a
    // vanished user row threw and surfaced as a 500. Kept as a throw rather
    // than quietly turned into a 200 — behaviour-preserving (#1167).
    if (!updated) {
      throw new Error('User row not found while updating currency preference')
    }

    return { currency_preference: updated.currency_preference }
  })

  // GET /user/owners
  app.get('/owners', async (request) => {
    const { sub } = request.user as { sub: string }
    const directory = await getCurrentOwnerDirectory(sub)
    const addresses = directory.owners.map((owner) => owner.owner_address)
    const aliasMap = new Map<string, string>()

    if (addresses.length > 0) {
      // Only the addresses just confirmed on-chain — that narrowing is what
      // keeps a removed owner's alias from reappearing.
      for (const row of await listOwnerAliases(sub, addresses)) {
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

      const alias = await upsertOwnerAlias(sub, normalizedOwner, normalizedName)

      return {
        owner_address: alias.owner_address,
        name: alias.name,
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

      await deleteOwnerAlias(sub, ownerAddress.toLowerCase())

      return { success: true }
    },
  )
}
