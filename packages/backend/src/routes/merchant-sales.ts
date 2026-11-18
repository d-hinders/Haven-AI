/**
 * `POST /merchant/sales` (#4897, epic #4885): the merchant key's one write.
 *
 * The merchant's server reports a sale record (`12-merchant-kit.md` section 5).
 * The account comes from the key only; the work — read the chain, index the
 * transfers, store the sale — lives in `modules/transactions/merchant-sales.ts`.
 * This handler is the auth door, the rate limit and the status mapping.
 *
 * Money path: the route stores a merchant's statement beside a chain read. It
 * holds no key, signs nothing and moves no funds, and its answer never says
 * whether a hash paid some other account.
 */
import { FastifyInstance } from 'fastify'
import { merchantAuthMiddleware } from '../middleware/merchantAuth.js'
import { merchantSalesRateLimit } from '../middleware/rate-limit.js'
import {
  ingestMerchantSale,
  serializeSale,
  type SaleRecordInput,
} from '../modules/transactions/index.js'

export default async function merchantSalesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', merchantAuthMiddleware)

  app.post<{ Body: SaleRecordInput }>(
    '/sales',
    { config: merchantSalesRateLimit },
    async (request, reply) => {
      const merchant = request.merchant!
      const result = await ingestMerchantSale({
        merchant,
        record: request.body,
        log: request.log,
      })
      if (!result.ok) {
        const { status, code, message, retryAfterSeconds } = result.failure
        if (retryAfterSeconds !== undefined) reply.header('Retry-After', String(retryAfterSeconds))
        return reply.code(status).send({
          error: code,
          error_code: code,
          message,
          ...(retryAfterSeconds !== undefined ? { retry_after_seconds: retryAfterSeconds } : {}),
        })
      }
      return reply.code(result.created ? 201 : 200).send(serializeSale(result.sale))
    },
  )
}
