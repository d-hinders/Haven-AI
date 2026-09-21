import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { retiredNameVerdict, retiredSafeQuery } from '../middleware/retired-safe-names.js'
import { agentExistsForUser } from '../infra/repositories/agents.js'
import {
  findMachinePaymentEvidenceDetail,
  findAccountOwnership,
  listBasicAccountsForUser,
} from '../infra/repositories/transaction-history.js'
import { listContactsForUser } from '../infra/repositories/contacts.js'
import { getChain, isSupportedChain } from '../domain/chains.js'
import {
  aggregateAccountTransactions,
  buildAccountTransactionsPage,
  EXPORT_ROW_CAP,
  buildTransactionCsvFilename,
  enrichTransactionsWithAccounting,
  exceedsExportRowCap,
  filterEnrichedTransactions,
  mergeSortDedupeAndEnrich,
  paginateByOffset,
  resolveTransactionCurrency,
  resolveTransactionFilters,
  transactionsToCsv,
  type ParsedTokenFilter,
} from '../modules/transactions/index.js'
import type { ListScope } from '../modules/transactions/index.js'
import { CSV_BOM } from '../domain/csv.js'
import { ETH_ADDRESS_RE } from '@haven_ai/core'

/** Own-account name lookup key — address is case-insensitive, chain is not. */
function accountNameKey(address: string, chainId: number): string {
  return `${address.toLowerCase()}:${chainId}`
}

/**
 * The bounds (`minimum`/`maximum`) and the defaults are the spec's, enforced
 * and injected before the handler since #3030; ajv has coerced the value to
 * a number by the time it arrives. The fallback only covers a caller that
 * mounted the module without the plugin.
 */
function readInt(value: number | string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  return typeof value === 'number' ? value : parseInt(value, 10)
}

/** Shape (`integer, minimum: 1`) is the spec's since #3030; support is not. */
function parseChainId(value: unknown): number | null {
  if (value === undefined) return null
  return Number(value)
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
      accountId?: string
      agentId?: string
      tokenKey?: string
      offset?: string
      limit?: string
      fresh?: string
    }
  }>('/', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const offset = readInt(request.query.offset, 0)
    const limit = readInt(request.query.limit, 25)
    const fresh = parseFreshFlag(request.query.fresh)

    // #2914: `safeId` is retired. It stays DECLARED so it can be REFUSED —
    // Fastify drops an undeclared query key silently, and a filter that
    // quietly stops filtering returns every row rather than none. The verdict
    // keys on what the caller RELIES on, not on presence: #2908's published
    // clients dual-send both names, and 400-ing them would punish the ones
    // that followed the migration instruction.
    const safeIdVerdict = retiredNameVerdict(request.query.safeId, request.query.accountId)
    if (safeIdVerdict.kind === 'refuse') {
      return reply.code(400).send(retiredSafeQuery('safeId', 'accountId', safeIdVerdict.reason))
    }

    // Shapes are the spec's since #3030 (`accountId` uuid, `agentId` `user`
    // or a uuid, `tokenKey` `<chain>:<native|address>`); what is checked here
    // is ownership and support — the id must be the caller's, the chain one
    // Haven serves.
    const accountFilterId = request.query.accountId

    const tokenFilter = parseTokenKey(request.query.tokenKey)
    if (request.query.tokenKey && !tokenFilter) {
      return reply.code(400).send({ error: 'Invalid tokenKey' })
    }

    let safes = await listBasicAccountsForUser(sub)

    if (accountFilterId) {
      safes = safes.filter((safe) => safe.id === accountFilterId)
      if (safes.length === 0) {
        return reply.code(400).send({ error: 'Invalid accountId' })
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
        failedAccountIds: [],
        truncated: false,
      }
    }

    // #3127: the converted triple on every row is struck in the user's
    // preferred currency — the setting the product offered and then ignored.
    // One preference read per request, alongside the account read.
    const [currency, aggregate] = await Promise.all([
      resolveTransactionCurrency(sub),
      aggregateAccountTransactions(safes, request.log, fresh),
    ])
    const enriched = await mergeSortDedupeAndEnrich(sub, safes, aggregate.merged, currency)
    const filtered = filterEnrichedTransactions(enriched, {
      agentId: request.query.agentId,
      tokenFilter,
    })
    const { page: paginated, hasMore } = paginateByOffset(filtered, offset, limit)
    // #2870: the accounting badge rides the PAGE, not the whole feed — one
    // ledger query per response, and none for an unentitled account.
    const enrichedPage = await enrichTransactionsWithAccounting(sub, paginated, request.log)
    // #3132 (owner decision 3): every row states its population and its
    // narrowing as two values. The feed is WALLET-scoped by construction —
    // `agentId` / `accountId` narrow it, they do not turn it into the
    // agent-scoped receipts view (different populations, different row
    // classes), and the two-value shape says so without prose.
    // `agentId=user` narrows too (rows with no agent attribution) — any agent
    // axis value is a query-time narrowing of the wallet feed.
    const agentNarrowed = Boolean(request.query.agentId)
    const scope: ListScope = {
      source: 'wallet',
      filter: agentNarrowed && accountFilterId ? 'account+agent' : agentNarrowed ? 'agent' : accountFilterId ? 'account' : null,
    }
    return {
      // One account name. The `safeName` twin outlived #2914 by exactly one
      // release so `@haven_ai/cli` on `latest` would not print every ACCOUNT
      // cell blank; `latest` is 0.3.0-alpha.0 now and reads `accountName`.
      transactions: enrichedPage.map((tx) => ({ ...tx, scope })),
      total: filtered.length,
      offset,
      limit,
      hasMore,
      partialFailure: aggregate.failedAccountIds.length > 0,
      failedAccountIds: Array.from(new Set(aggregate.failedAccountIds)),
      // #2882: the rows above are capped at the explorer window per account,
      // so `total` is the truncated count, not the account's history.
      truncated: aggregate.truncated,
    }
  })

  app.get<{ Params: { paymentId: string } }>(
    '/payment-intents/:paymentId/evidence',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { paymentId } = request.params

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
   * the dashboard has loaded: it accepts the same `accountId` / `agentId` /
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
      accountId?: string
      agentId?: string
      tokenKey?: string
      direction?: 'in' | 'out' // the spec's enum, enforced before the handler (#3030)
      chainId?: string
      fresh?: string
    }
  }>('/export.csv', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const fresh = parseFreshFlag(request.query.fresh)
    // #2914: see the sibling feed above — same verdict, same reasoning.
    const safeIdVerdict = retiredNameVerdict(request.query.safeId, request.query.accountId)
    if (safeIdVerdict.kind === 'refuse') {
      return reply.code(400).send(retiredSafeQuery('safeId', 'accountId', safeIdVerdict.reason))
    }

    // Shapes are the spec's since #3030 (`accountId` uuid, `agentId` `user`
    // or a uuid, `tokenKey` `<chain>:<native|address>`); what is checked here
    // is ownership and support — the id must be the caller's, the chain one
    // Haven serves.
    const accountFilterId = request.query.accountId

    const tokenFilter = parseTokenKey(request.query.tokenKey)
    if (request.query.tokenKey && !tokenFilter) {
      return reply.code(400).send({ error: 'Invalid tokenKey' })
    }

    const direction = request.query.direction

    const chainId = parseChainId(request.query.chainId)
    if (chainId !== null && !isSupportedChain(chainId)) {
      return reply.code(400).send({ error: `Unsupported chain: ${chainId}` })
    }

    // Kept unfiltered for name resolution below: a transfer between two of
    // the user's own accounts must still name the far side when the export is
    // scoped to one of them, exactly as the dashboard table does.
    const allSafes = await listBasicAccountsForUser(sub)
    let safes = allSafes

    if (accountFilterId) {
      safes = safes.filter((safe) => safe.id === accountFilterId)
      if (safes.length === 0) {
        return reply.code(400).send({ error: 'Invalid accountId' })
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
      // #3127: the export reads the preference too — the file's
      // `converted_currency` column names the currency the user's dashboard
      // feed converts in. The AMOUNTS stay the fixed-SEK branch (below);
      // this read names that column, nothing more.
      const [currency, aggregateResult] = await Promise.all([
        resolveTransactionCurrency(sub),
        aggregateAccountTransactions(safes, request.log, fresh),
      ])
      const enriched = await mergeSortDedupeAndEnrich(sub, safes, aggregateResult.merged, currency)
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
    const accountNames = new Map(
      allSafes.map((safe) => [accountNameKey(safe.account_address, safe.chain_id), safe.name]),
    )

    const csv = transactionsToCsv(filtered, {
      resolveName: (address, addressChainId) => {
        const contactName = contactNames.get(address.toLowerCase())
        if (contactName) return contactName
        return accountNames.get(accountNameKey(address, addressChainId)) ?? null
      },
      // #3127: the accounting export stays a FIXED-currency file. Deliberate,
      // not the default everywhere: the feed was built (epic 026, #2871)
      // around one reporting currency, the accountants' importers are keyed
      // on it, and `amount_sek` is the stored book-time column — a
      // preference-driven amount would re-express a filed figure instead of
      // reporting one. The user's currency_preference (read above) names the
      // column so the reader still sees how the file relates to what the
      // dashboard serves them; the AMOUNT does not follow it.
      reportingCurrency: 'SEK',
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
      // #2914's last retired RESPONSE name. It was not twinned like the other
      // two and no published package ever read it — the dashboard is the only
      // consumer, and it ships from the same promotion as this backend.
      accounts: safes.map((account) => ({
        id: account.id,
        name: account.name,
        address: account.account_address,
        chainId: account.chain_id,
      })),
      agents,
      tokens,
    }
  })

  // #2914: this is `GET /transactions/{accountAddress}` and nothing else now.
  // A single dynamic path segment has no wire-visible name, so the old
  // `{safeAddress}` spelling and the new one were always the SAME Fastify
  // route — `GET /transactions/0xabc...` matched both documented paths at
  // once. There is consequently nothing to retire here and no tombstone to
  // register: an old client's URL is byte-identical to a new one's. (#2907
  // verified the mechanics against a live instance: registering a second
  // parametric route at one position throws `FST_ERR_DUPLICATED_ROUTE` at
  // `app.ready()`, so the twin never could have been a second registration.)
  // Only the multi-segment `/user/safes/...` paths needed 410 tombstones.
  app.get<{
    Params: { accountAddress: string }
    Querystring: { page?: string; limit?: string; fresh?: string; chain_id?: string }
  }>('/:accountAddress', async (request, reply) => {
    const { accountAddress: address } = request.params
    const { sub } = request.user as { sub: string }
    const page = readInt(request.query.page, 1)
    const limit = readInt(request.query.limit, 25)
    const fresh = parseFreshFlag(request.query.fresh)
    const requestedChainId = parseChainId(request.query.chain_id)

    if (requestedChainId !== null && !isSupportedChain(requestedChainId)) {
      return reply.code(400).send({ error: `Unsupported chain: ${requestedChainId}` })
    }

    const ownershipRows = await findAccountOwnership(sub, address, requestedChainId)
    if (ownershipRows.length === 0) {
      return reply.code(403).send({ error: 'Not your Safe' })
    }
    if (requestedChainId === null && ownershipRows.length > 1) {
      return reply.code(400).send({ error: 'chain_id required' })
    }

    const accountId = ownershipRows[0].id
    const chainId = requestedChainId ?? ownershipRows[0].chain_id

    const { transactions: enriched, total } = await buildAccountTransactionsPage({
      userId: sub,
      accountId,
      accountAddress: address,
      chainId,
      log: request.log,
      fresh,
      page,
      limit,
      // #3127: same converted triple as the multi-account feed.
      currency: await resolveTransactionCurrency(sub),
    })

    return {
      transactions: enriched.map(
        ({ chainId: _chainId, accountId: _accountId, accountAddress: _accountAddress, accountName: _accountName, agentId: _agentId, ...tx }) => tx,
      ),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    }
  })
}
