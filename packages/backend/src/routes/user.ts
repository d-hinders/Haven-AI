import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { retiredSafeInflowHandler, retiredSafeInflowRoute } from '../middleware/safe-inflow-retired.js'
import { retiredSafePathHandler } from './user-accounts-retired.js'
import { DEFAULT_TRANSACTION_CURRENCY, type TransactionCurrency } from '../domain/transaction-currency.js'
import {
  findCurrencyPreference,
  updateCurrencyPreference,
  updateUserName,
  updateUserWalletAddress,
} from '../infra/repositories/users.js'

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
  /** The spec's enum, enforced before the handler (#3030). */
  currency_preference: TransactionCurrency
}

interface ProfileBody {
  name: string
}

// Shape (string, 1–80) is the spec's, enforced before the handler since
// #3030; blank-after-trim, whitespace collapse and control characters stay
// here — no schema states them.
function normalizeName(name: string): string | null {
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

    // The address pattern is the spec's (`wallet_address: address`), refused
    // before the handler since #3030.
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
  app.put('/account', retiredSafeInflowRoute('import'), retiredSafeInflowHandler('import'))

  // GET /user/preferences
  app.get('/preferences', async (request) => {
    const { sub } = request.user as { sub: string }

    // #3127: the no-preference default is SEK — documented and deliberate
    // (domain/transaction-currency.ts), the currency the transaction feed
    // serves. The characterization test pins the fallback SHAPE (null row and
    // missing row both fall back), not the currency.
    return { currency_preference: (await findCurrencyPreference(sub)) ?? DEFAULT_TRANSACTION_CURRENCY }
  })

  // PUT /user/preferences
  app.put<{ Body: PreferencesBody }>('/preferences', async (request, reply) => {
    const { currency_preference } = request.body
    const { sub } = request.user as { sub: string }

    // #3127: SEK joins the offered set — it is the currency every converted
    // transaction amount is struck in by default, so it was the one currency
    // no user could actually select. The list is the shared
    // `TRANSACTION_CURRENCIES` from `domain/transaction-currency.ts`, the
    // same list the transaction path converts against, so the enum and the
    // served currency cannot drift apart again.
    // The enum is the spec's, refused before the handler since #3030; the
    // test suite pins that enum to `TRANSACTION_CURRENCIES` so the spec and
    // the conversion path cannot drift apart.
    const updated = await updateCurrencyPreference(currency_preference, sub)

    if (!updated) userRowVanished()

    return { currency_preference: updated.currency_preference }
  })
}
