/**
 * The owner's sales reads and the clear route (#4897, epic #4885).
 *
 * `GET /merchant-sales/summary`, `GET /merchant-sales/payments`,
 * `GET /merchant-sales/facets` (#4959), `GET /merchant-sales/payments/:txHash` and `DELETE
 * /merchant-sales/payments/:txHash/record`: owner-session routes (dashboard
 * JWT), never the Sales key's. The Sales key is `sk_merchant_...` and
 * `authMiddleware` verifies a JWT, so a key is refused at the door (401); a
 * device-code session is refused by the owner-CLI census (the clear route is on
 * its must-refuse list).
 *
 * The account is the CALLER's merchant account and only while merchant
 * services are on; off, or no account, the reads answer the empty state (as
 * `routes/merchant-catalogue.ts` does) and the clear answers 409
 * `MERCHANT_ACCOUNT_REQUIRED`. The figures, the paging and the payer kinds
 * live in `modules/transactions/merchant-sales-reads.ts`; this handler is the
 * auth door, the validation of the period, the rate limit and the status
 * mapping. The filters of the summary and the list (`kind`, `product_id`,
 * `payer`, `q`; #4959) are validated by the spec through the request-validation
 * plugin, and an unknown parameter name is ignored, as before.
 *
 * Money path: reads only, plus the owner deleting a merchant's statement. The
 * route holds no key, signs nothing, moves no funds and never touches a
 * transfer.
 */
import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { moneyPathRateLimit } from '../middleware/rate-limit.js'
import { MERCHANT_ACCOUNT_REQUIRED } from '../domain/merchant-keys.js'
import {
  clearSaleRecord,
  decodePaymentsCursor,
  emptySummary,
  parsePeriod,
  PAYMENTS_DEFAULT_LIMIT,
  PAYMENTS_MAX_LIMIT,
  readPaymentDetail,
  readPaymentsPage,
  readSalesFacets,
  readSalesSummaryForOwner,
  refreshMerchantAccountIndex,
  resolveSalesScope,
  type SalesFilterInput,
} from '../modules/transactions/index.js'

interface PeriodQuery {
  from?: string
  to?: string
}

/** #4959: each filter may repeat; the spec coerces a single value to a list. */
interface FilteredQuery extends PeriodQuery, SalesFilterInput {}

/**
 * A repeatable filter as a list. The enforced spec already coerces a single
 * value to a list of one; this does not lean on that, so a handler mounted
 * without the plugin cannot hand the SQL a bare string where it binds a text[].
 */
function asList<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value : [value]
}

function filterInput(query: SalesFilterInput): SalesFilterInput {
  return {
    kind: asList(query.kind),
    product_id: asList(query.product_id),
    payer: asList(query.payer),
    q: query.q,
  }
}

interface PaymentsQuery extends FilteredQuery {
  cursor?: string
  limit?: number
}

interface TxHashParams {
  txHash: string
}

const PAYMENT_NOT_FOUND = 'PAYMENT_NOT_FOUND'
const SALE_RECORD_NOT_FOUND = 'SALE_RECORD_NOT_FOUND'
const INVALID_PERIOD = 'INVALID_PERIOD'
const INVALID_CURSOR = 'INVALID_CURSOR'

export default async function merchantSalesReadRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.get<{ Querystring: FilteredQuery }>('/summary', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const period = parsePeriod(request.query.from, request.query.to)
    if (!period.ok) {
      return reply.code(400).send({ error: period.message, error_code: INVALID_PERIOD })
    }
    const scope = await resolveSalesScope(sub)
    if (scope === null) return emptySummary()
    // #5012: the owner is looking at Sales, so refresh the account's index in
    // the background. It is throttled per account (one refresh per 30 s,
    // however many tabs poll this read or `/payments`), never throws, and
    // never delays or changes this answer: a transfer it finds shows on the
    // page's next poll.
    void refreshMerchantAccountIndex(scope.accountId, request.log)
    return readSalesSummaryForOwner(scope, period.period, filterInput(request.query))
  })

  app.get<{ Querystring: PeriodQuery }>('/facets', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const period = parsePeriod(request.query.from, request.query.to)
    if (!period.ok) {
      return reply.code(400).send({ error: period.message, error_code: INVALID_PERIOD })
    }
    const scope = await resolveSalesScope(sub)
    if (scope === null) return { products: [], payers: [] }
    return readSalesFacets(scope, period.period)
  })

  app.get<{ Querystring: PaymentsQuery }>('/payments', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const period = parsePeriod(request.query.from, request.query.to)
    if (!period.ok) {
      return reply.code(400).send({ error: period.message, error_code: INVALID_PERIOD })
    }
    let cursor = null
    if (request.query.cursor !== undefined) {
      cursor = decodePaymentsCursor(request.query.cursor)
      if (cursor === null) {
        return reply
          .code(400)
          .send({ error: 'The cursor is not one this list issued.', error_code: INVALID_CURSOR })
      }
    }
    const scope = await resolveSalesScope(sub)
    if (scope === null) return { payments: [], next_cursor: null, total: 0, usdc_rates: null }
    // #5012: the same throttled background refresh as `/summary`. The first-run
    // screen reads only this list, so a merchant's first unreported payment
    // would otherwise never be looked for.
    void refreshMerchantAccountIndex(scope.accountId, request.log)
    const limit = Math.min(request.query.limit ?? PAYMENTS_DEFAULT_LIMIT, PAYMENTS_MAX_LIMIT)
    return readPaymentsPage(scope, period.period, { limit, cursor }, filterInput(request.query))
  })

  app.get<{ Params: TxHashParams }>('/payments/:txHash', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const scope = await resolveSalesScope(sub)
    const detail = scope === null ? null : await readPaymentDetail(scope, request.params.txHash)
    if (detail === null) {
      return reply.code(404).send({ error: 'No such payment on this account.', error_code: PAYMENT_NOT_FOUND })
    }
    return detail
  })

  /**
   * Clear a sale record. Only the merchant's record is deleted: the payment
   * stays, shown with no product, and a new record for the transaction is
   * accepted afterwards by `POST /merchant/sales`.
   */
  app.delete<{ Params: TxHashParams }>(
    '/payments/:txHash/record',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const scope = await resolveSalesScope(sub)
      if (scope === null) {
        return reply.code(409).send({
          error: 'Turn merchant services on before clearing a sale record',
          error_code: MERCHANT_ACCOUNT_REQUIRED,
        })
      }
      const cleared = await clearSaleRecord(scope, request.params.txHash)
      if (!cleared) {
        return reply.code(404).send({
          error: 'This payment has no sale record to clear.',
          error_code: SALE_RECORD_NOT_FOUND,
        })
      }
      request.log.info(
        { user_id: sub, account_id: scope.accountId, tx_hash: request.params.txHash.toLowerCase() },
        'merchant sale record cleared by the owner',
      )
      return reply.code(204).send()
    },
  )
}
