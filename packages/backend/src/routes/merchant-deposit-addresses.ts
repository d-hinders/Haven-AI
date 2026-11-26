/**
 * The Stripe deposit-address registry's routes (#4952, epic #4886). Dev and
 * Stripe sandbox only, enforced per Sales account by #5028: every route answers
 * 403 `DEPOSIT_ADDRESSES_TESTNET_ONLY` when the account's chain is not a
 * testnet, and writes nothing. The gate runs right after `resolveSalesScope`
 * and before any existence check, so `DEPOSIT_ADDRESS_ALREADY_REGISTERED` is
 * never answered on a gated account. The ownership-proof slice removes it.
 *
 * `GET /merchant-deposit-addresses`, `POST /merchant-deposit-addresses` and
 * `POST /merchant-deposit-addresses/:id/retire`: owner-session routes
 * (dashboard JWT), never the Sales key's. The Sales key is `sk_merchant_...`
 * and `authMiddleware` verifies a JWT, so a key is refused at the door (401);
 * a key route would let a leaked key attach any address's payments to the
 * account. Register and retire are on the device-login must-refuse list.
 *
 * Merchant services off (or no merchant account): the list is empty, and the
 * two writes answer 409 `MERCHANT_ACCOUNT_REQUIRED`, as the sales reads and
 * clear do. The rules live in `modules/transactions/merchant-deposit-addresses.ts`.
 *
 * Money path: the registry decides which transfers are attributed to an
 * account as Stripe-held sales. The routes hold no key, sign nothing, move no
 * funds and touch no balance.
 */
import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { moneyPathRateLimit } from '../middleware/rate-limit.js'
import { MERCHANT_ACCOUNT_REQUIRED } from '../domain/merchant-keys.js'
import {
  DEPOSIT_ADDRESS_VERIFICATION_NOTE,
  DEPOSIT_ADDRESSES_TESTNET_ONLY,
  depositAddressRegistryOpen,
  listRegistrations,
  registerDepositAddress,
  resolveSalesScope,
  retireRegistration,
  serializeDepositAddress,
} from '../modules/transactions/index.js'

interface RegisterBody {
  address: string
}

interface IdParams {
  id: string
}

const OFF = {
  error: 'Turn merchant services on before registering a deposit address',
  error_code: MERCHANT_ACCOUNT_REQUIRED,
}

/**
 * #5028: the registry is dev and Stripe sandbox only until a proof of address
 * ownership exists. A Sales account whose chain is not a testnet gets this one
 * refusal from every route, and nothing is written.
 */
const TESTNET_ONLY = {
  error: 'Stripe deposit addresses are available on a test network only.',
  error_code: DEPOSIT_ADDRESSES_TESTNET_ONLY,
}

export default async function merchantDepositAddressRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.get('/', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const scope = await resolveSalesScope(sub)
    if (scope === null) {
      return {
        verification: DEPOSIT_ADDRESS_VERIFICATION_NOTE,
        addresses: [],
      }
    }
    if (!depositAddressRegistryOpen(scope.chainId)) return reply.code(403).send(TESTNET_ONLY)
    const rows = await listRegistrations(scope)
    return {
      verification: DEPOSIT_ADDRESS_VERIFICATION_NOTE,
      addresses: rows.map(serializeDepositAddress),
    }
  })

  app.post<{ Body: RegisterBody }>('/', { config: moneyPathRateLimit }, async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const scope = await resolveSalesScope(sub)
    if (scope === null) return reply.code(409).send(OFF)
    if (!depositAddressRegistryOpen(scope.chainId)) return reply.code(403).send(TESTNET_ONLY)
    const result = await registerDepositAddress(scope, request.body.address)
    if (!result.ok) {
      return reply.code(result.status).send({ error: result.message, error_code: result.code })
    }
    request.log.info(
      { user_id: sub, account_id: scope.accountId, deposit_address_id: result.registration.id },
      'merchant deposit address registered by the owner',
    )
    return reply.code(201).send(serializeDepositAddress(result.registration))
  })

  app.post<{ Params: IdParams }>('/:id/retire', { config: moneyPathRateLimit }, async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const scope = await resolveSalesScope(sub)
    if (scope === null) return reply.code(409).send(OFF)
    if (!depositAddressRegistryOpen(scope.chainId)) return reply.code(403).send(TESTNET_ONLY)
    const result = await retireRegistration(scope, request.params.id)
    if (!result.ok) {
      return reply.code(result.status).send({ error: result.message, error_code: result.code })
    }
    request.log.info(
      { user_id: sub, account_id: scope.accountId, deposit_address_id: result.registration.id },
      'merchant deposit address retired by the owner',
    )
    return serializeDepositAddress(result.registration)
  })
}
