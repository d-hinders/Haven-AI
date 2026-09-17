import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { retiredSafeInflowHandler } from '../middleware/safe-inflow-retired.js'
import { retiredSafePathHandler } from './user-accounts-retired.js'
import {
  findCurrencyPreference,
  updateCurrencyPreference,
  updateUserName,
  updateUserWalletAddress,
} from '../infra/repositories/users.js'
import { ETH_ADDRESS_RE } from '@haven_ai/core'

/**
 * #2914 (naming epic #2906 phase 5, the contraction): these responses carry
 * `account_address` and nothing else. The `safe_address` twin, the dual-emit
 * mapper and the shim that fed it are all gone; the repository rows already
 * use the account vocabulary, so the row is returned unchanged.
 */

const MAX_NAME_LENGTH = 80
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/

/**
 * Every write here is scoped by the JWT subject, so "no row matched" can only
 * mean the account was deleted while a valid token for it was still in flight.
 *
 * Before #1178 the four writes disagreed about what that means: three returned
 * `undefined`, which Fastify reads as "the handler sent the reply itself" and
 * so leaves the request HANGING, and the fourth threw a bare `Error` and 500ed.
 * One cause, two wrong answers, neither of them the truth — the account is
 * gone. `GET /auth/me` already answered 404 for exactly this case, so that is
 * the answer all of them give now.
 */
function userRowVanished(): never {
  throw { statusCode: 404, message: 'User not found' }
}

interface WalletBody {
  wallet_address: string
}

interface PreferencesBody {
  currency_preference: string
}

interface ProfileBody {
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

    const updated = await updateUserName(normalizedName, sub)
    if (!updated) return userRowVanished()
    return updated
  })

  // PUT /user/wallet
  app.put<{ Body: WalletBody }>('/wallet', async (request, reply) => {
    const { wallet_address } = request.body
    const { sub } = request.user as { sub: string }

    if (!wallet_address || !ETH_ADDRESS_RE.test(wallet_address)) {
      return reply.code(400).send({ error: 'Invalid Ethereum address' })
    }

    const updated = await updateUserWalletAddress(wallet_address, sub)
    if (!updated) return userRowVanished()
    return updated
  })

  // PUT /user/safe — TOMBSTONE, twice over. #1984 closed the flow (the legacy
  // single-account link was an IMPORT: it wrote `smart_accounts` and emitted
  // the `safe_imported` funnel event) and #1988 deleted the body; #2914 then
  // retired the PATH's Safe vocabulary. It answers the NAMING 410 naming
  // `PUT /user/account`, which is where the rail refusal — a different and
  // still-true fact — lives. Kept as a 410 rather than removed, per #834/#1328.
  app.put('/safe', retiredSafePathHandler(
    'PUT /user/account',
    'That path is itself retired (#1984): this link is an import, closed with the Safe rail, and no path replaces it. Create a Haven account on the delegation rail with POST /accounts/hybrid.',
  ))

  // PUT /user/account — RETIRED (#1984, epic #1440): importing an account is
  // closed with the Safe rail. `updateUserAccount` in `openapi/spec.ts`.
  app.put('/account', retiredSafeInflowHandler('import'))

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

    if (!updated) userRowVanished()

    return { currency_preference: updated.currency_preference }
  })
}
