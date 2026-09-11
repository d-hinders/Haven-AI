import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { agentExistsForUser } from '../infra/repositories/agents.js'
import {
  findMachinePaymentEvidenceDetail,
  findSafeOwnership,
  listBasicSafesForUser,
} from '../infra/repositories/transaction-history.js'
import { listContactsForUser } from '../infra/repositories/contacts.js'
import { getChain, isSupportedChain } from '../domain/chains.js'
import {
  aggregateSafeTransactions,
  buildSafeTransactionsPage,
  EXPORT_ROW_CAP,
  buildTransactionCsvFilename,
  enrichTransactionsWithAccounting,
  exceedsExportRowCap,
  filterEnrichedTransactions,
  mergeSortDedupeAndEnrich,
  paginateByOffset,
  resolveTransactionFilters,
  transactionsToCsv,
  type ParsedTokenFilter,
} from '../modules/transactions/index.js'
import { CSV_BOM } from '../domain/csv.js'
import { ETH_ADDRESS_RE } from '@haven_ai/core'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Own-account name lookup key — address is case-insensitive, chain is not. */
function accountNameKey(address: string, chainId: number): string {
  return `${address.toLowerCase()}:${chainId}`
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (value === undefined) return fallback
  const parsed = parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    return null
  }
  return parsed
}

function parseChainId(value: unknown): number | null {
  if (value === undefined) return null
  if (Array.isArray(value)) return Number.NaN

  const raw = String(value).trim()
  if (!/^[1-9]\d*$/.test(raw)) return Number.NaN

  const chainId = Number(raw)
  return Number.isSafeInteger(chainId) ? chainId : Number.NaN
}

function parseFreshFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

function parseTokenKey(tokenKey: string | undefined): ParsedTokenFilter | null {
  if (!tokenKey) return null

  const [chainPart, assetPart, ...rest] = tokenKey.split(':')
  if (!chainPart || !assetPart || rest.length > 0) return null

  const chainId = parseInt(chainPart, 10)
  if (Number.isNaN(chainId)) return null

  try {
    getChain(chainId)
  } catch {
    return null
  }

  if (assetPart === 'native') {
    return { chainId, address: null }
  }

  if (!ETH_ADDRESS_RE.test(assetPart)) {
    return null
  }

  return { chainId, address: assetPart.toLowerCase() }
}

export default async function transactionRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.get<{
    Querystring: {
      safeId?: string
      agentId?: string
      tokenKey?: string
      offset?: string
      limit?: string
      fresh?: string
    }
  }>('/', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const offset = parsePositiveInt(request.query.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    const limit = parsePositiveInt(request.query.limit, 25, 1, 100)
    const fresh = parseFreshFlag(request.query.fresh)

    if (offset === null || limit === null) {
      return reply.code(400).send({ error: 'Invalid pagination params' })
    }

    if (request.query.safeId && !UUID_RE.test(request.query.safeId)) {
      return reply.code(400).send({ error: 'Invalid safeId' })
    }

    if (
      request.query.agentId &&
      request.query.agentId !== 'user' &&
      !UUID_RE.test(request.query.agentId)
    ) {
      return reply.code(400).send({ error: 'Invalid agentId' })
    }

    const tokenFilter = parseTokenKey(request.query.tokenKey)
    if (request.query.tokenKey && !tokenFilter) {
      return reply.code(400).send({ error: 'Invalid tokenKey' })
    }

    let safes = await listBasicSafesForUser(sub)

    if (request.query.safeId) {
      safes = safes.filter((safe) => safe.id === request.query.safeId)
      if (safes.length === 0) {
        return reply.code(400).send({ error: 'Invalid safeId' })
      }
    }

    if (request.query.agentId && request.query.agentId !== 'user') {
      const agentOwned = await agentExistsForUser(request.query.agentId, sub)
      if (!agentOwned) {
        return reply.code(400).send({ error: 'Invalid agentId' })
      }
    }

    if (safes.length === 0) {
      return {
        transactions: [],
        total: 0,
        offset,
        limit,
        hasMore: false,
        partialFailure: false,
        failedSafeIds: [],
        truncated: false,
      }
    }

    const { merged, failedSafeIds, truncated } = await aggregateSafeTransactions(
      safes,
      request.log,
      fresh,
    )
    const enriched = await mergeSortDedupeAndEnrich(sub, safes, merged)
    const filtered = filterEnrichedTransactions(enriched, {
      agentId: request.query.agentId,
      tokenFilter,
    })
    const { page: paginated, hasMore } = paginateByOffset(filtered, offset, limit)
    // #2870: the accounting badge rides the PAGE, not the whole feed — one
    // ledger query per response, and none for an unentitled account.
    const transactions = await enrichTransactionsWithAccounting(sub, paginated)

    return {
      transactions,
      total: filtered.length,
      offset,
      limit,
      hasMore,
      partialFailure: failedSafeIds.length > 0,
      failedSafeIds: Array.from(new Set(failedSafeIds)),
      // #2882: the rows above are capped at the explorer window per account,
      // so `total` is the truncated count, not the account's history.
      truncated,
    }
  })

  app.get<{ Params: { paymentId: string } }>(
    '/payment-intents/:paymentId/evidence',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { paymentId } = request.params

      if (!UUID_RE.test(paymentId)) {
        return reply.code(400).send({ error: 'Invalid paymentId' })
      }

      const evidence = await findMachinePaymentEvidenceDetail(paymentId, sub)
      if (!evidence) {
        return reply.code(404).send({ error: 'Payment evidence not found' })
      }

      // Every response field is a same-named passthrough of the evidence row
      // except `payment_id` — verified 1:1 against MachinePaymentEvidenceDetailRow.
      return {
        evidence: {
          ...evidence,
          payment_id: evidence.payment_intent_id ?? evidence.approval_request_id,
        },
      }
    },
  )

  /**
   * GET /transactions/export.csv — the filtered list as a CSV file (#2871).
   *
   * Filter-faithful over the whole set the aggregation returned, not the page
   * the dashboard has loaded: it accepts the same `safeId` / `agentId` /
   * `tokenKey` filters as `GET /`, plus the `direction` and `chainId` the
   * dashboard used to apply in the browser.
   *
   * Two bounds, not one. `EXPORT_ROW_CAP` refuses above a ceiling, so one
   * request can never stream an unbounded result set. Underneath it the feed
   * itself is capped at the explorer window per account (#2882) — which is
   * why "whole" above is the aggregation's result set and not the account's
   * history. The page says so next to its count; the file carries no such
   * note, which is recorded on #2882's pull request.
   */
  app.get<{
    Querystring: {
      safeId?: string
      agentId?: string
      tokenKey?: string
      direction?: string
      chainId?: string
      fresh?: string
    }
  }>('/export.csv', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const fresh = parseFreshFlag(request.query.fresh)

    if (request.query.safeId && !UUID_RE.test(request.query.safeId)) {
      return reply.code(400).send({ error: 'Invalid safeId' })
    }

    if (
      request.query.agentId &&
      request.query.agentId !== 'user' &&
      !UUID_RE.test(request.query.agentId)
    ) {
      return reply.code(400).send({ error: 'Invalid agentId' })
    }

    const tokenFilter = parseTokenKey(request.query.tokenKey)
    if (request.query.tokenKey && !tokenFilter) {
      return reply.code(400).send({ error: 'Invalid tokenKey' })
    }

    const direction = request.query.direction
    if (direction !== undefined && direction !== 'in' && direction !== 'out') {
      return reply.code(400).send({ error: 'Invalid direction' })
    }

    const chainId = parseChainId(request.query.chainId)
    if (Number.isNaN(chainId)) {
      return reply.code(400).send({ error: 'Invalid chainId' })
    }
    if (chainId !== null && !isSupportedChain(chainId)) {
      return reply.code(400).send({ error: `Unsupported chain: ${chainId}` })
    }

    // Kept unfiltered for name resolution below: a transfer between two of
    // the user's own accounts must still name the far side when the export is
    // scoped to one of them, exactly as the dashboard table does.
    const allSafes = await listBasicSafesForUser(sub)
    let safes = allSafes

    if (request.query.safeId) {
      safes = safes.filter((safe) => safe.id === request.query.safeId)
      if (safes.length === 0) {
        return reply.code(400).send({ error: 'Invalid safeId' })
      }
    }

    if (request.query.agentId && request.query.agentId !== 'user') {
      const agentOwned = await agentExistsForUser(request.query.agentId, sub)
      if (!agentOwned) {
        return reply.code(400).send({ error: 'Invalid agentId' })
      }
    }

    let filtered: Awaited<ReturnType<typeof mergeSortDedupeAndEnrich>> = []
    if (safes.length > 0) {
      const { merged } = await aggregateSafeTransactions(safes, request.log, fresh)
      const enriched = await mergeSortDedupeAndEnrich(sub, safes, merged)
      filtered = filterEnrichedTransactions(enriched, {
        agentId: request.query.agentId,
        tokenFilter,
        direction,
        chainId: chainId ?? undefined,
      })
    }

    if (exceedsExportRowCap(filtered.length)) {
      return reply.code(413).send({
        error: 'Export too large',
        statusCode: 413,
        // Grouped digits: `10001` and `10000` are near-indistinguishable at a
        // glance, which defeats the sentence's job of conveying how far over
        // the export is.
        details:
          `This export would contain ${filtered.length.toLocaleString('en-US')} rows; ` +
          `the limit is ${EXPORT_ROW_CAP.toLocaleString('en-US')}. Narrow the filters — ` +
          'by account, agent, token, network or direction — and export again.',
      })
    }

    // The address book is chain-agnostic (`contacts` has no chain_id), the
    // user's own accounts are not — the same two-step resolution, in the same
    // order, as the dashboard table.
    const contacts = await listContactsForUser(sub)
    const contactNames = new Map(contacts.map((c) => [c.address.toLowerCase(), c.name]))
    const safeNames = new Map(
      allSafes.map((safe) => [accountNameKey(safe.safe_address, safe.chain_id), safe.name]),
    )

    const csv = transactionsToCsv(filtered, {
      resolveName: (address, addressChainId) => {
        const contactName = contactNames.get(address.toLowerCase())
        if (contactName) return contactName
        return safeNames.get(accountNameKey(address, addressChainId)) ?? null
      },
    })

    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="${buildTransactionCsvFilename(new Date())}"`,
      )
      .header('X-Export-Row-Count', String(filtered.length))
      .send(`${CSV_BOM}${csv}`)
  })

  app.get<{ Querystring: { fresh?: string } }>('/filters', async (request) => {
    const { sub } = request.user as { sub: string }
    const fresh = parseFreshFlag(request.query.fresh)

    const { safes, agents, tokens } = await resolveTransactionFilters(sub, request.log, fresh)

    return {
      safes: safes.map((safe) => ({
        id: safe.id,
        name: safe.name,
        address: safe.safe_address,
        chainId: safe.chain_id,
      })),
      agents,
      tokens,
    }
  })

  app.get<{
    Params: { safeAddress: string }
    Querystring: { page?: string; limit?: string; fresh?: string; chain_id?: string }
  }>('/:safeAddress', async (request, reply) => {
    const { safeAddress } = request.params
    const { sub } = request.user as { sub: string }
    const page = parsePositiveInt(request.query.page, 1, 1, Number.MAX_SAFE_INTEGER)
    const limit = parsePositiveInt(request.query.limit, 25, 1, 100)
    const fresh = parseFreshFlag(request.query.fresh)
    const requestedChainId = parseChainId(request.query.chain_id)

    if (page === null || limit === null) {
      return reply.code(400).send({ error: 'Invalid pagination params' })
    }

    if (!ETH_ADDRESS_RE.test(safeAddress)) {
      return reply.code(400).send({ error: 'Invalid address' })
    }

    if (Number.isNaN(requestedChainId)) {
      return reply.code(400).send({ error: 'Invalid chain_id' })
    }

    if (requestedChainId !== null && !isSupportedChain(requestedChainId)) {
      return reply.code(400).send({ error: `Unsupported chain: ${requestedChainId}` })
    }

    const ownershipRows = await findSafeOwnership(sub, safeAddress, requestedChainId)
    if (ownershipRows.length === 0) {
      return reply.code(403).send({ error: 'Not your Safe' })
    }
    if (requestedChainId === null && ownershipRows.length > 1) {
      return reply.code(400).send({ error: 'chain_id required' })
    }

    const safeId = ownershipRows[0].id
    const chainId = requestedChainId ?? ownershipRows[0].chain_id

    const { transactions: enriched, total } = await buildSafeTransactionsPage({
      userId: sub,
      safeId,
      safeAddress,
      chainId,
      log: request.log,
      fresh,
      page,
      limit,
    })

    return {
      transactions: enriched.map(
        ({ chainId: _chainId, safeId: _safeId, safeAddress: _safeAddress, safeName: _safeName, agentId: _agentId, ...tx }) => tx,
      ),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    }
  })
}
