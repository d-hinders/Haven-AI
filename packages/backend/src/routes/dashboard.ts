import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import {
  findPortfolioSnapshots,
  hasFirstAgentPayment,
  insertPortfolioSnapshot,
  listDashboardAgents,
  listDashboardAccounts,
  sumMonthlyPaymentSpend,
  type DashboardAllowanceRow,
  type MonthlySpendRow,
} from '../infra/repositories/dashboard.js'
import { getFiatValuesForTokenAmount } from '../infra/fiat-values.js'
import { listContactsForUser } from '../infra/repositories/contacts.js'
import { listReceiptMerchantNamesForUser } from '../infra/repositories/analytics.js'
import {
  combineBalanceFreshness,
  fetchPortfolioForAccount,
  isPortfolioUnpriceable,
} from '../modules/accounts/index.js'
import { deriveDelegationAllowances } from '../rails/delegation-budget-view.js'
import {
  buildActivityGroups,
  compareTransactions,
  isValidActivityTimeZone,
  type EnrichedTransaction,
  enrichedTransactionIdentityKey,
  enrichTransactionsWithAgents,
  fetchAccountTransactions,
  mergeX402Transactions,
  resolveTransactionCurrency,
} from '../modules/transactions/index.js'

const AGENT_PREVIEW_LIMIT = 6
const TRANSACTION_PREVIEW_LIMIT = 5

function getSnapshotDate(offsetDays = 0): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

function computePercentChange(current: number, previous: number): number {
  if (previous === 0) {
    return 0
  }
  return ((current - previous) / previous) * 100
}

async function accumulateMonthlySpend(
  rows: MonthlySpendRow[],
): Promise<{ usd: number; eur: number; sek: number }> {
  let usd = 0
  let eur = 0
  let sek = 0

  for (const row of rows) {
    usd += Number(row.usd_sum ?? '0')
    eur += Number(row.eur_sum ?? '0')
    sek += Number(row.sek_sum ?? '0')

    // Two INDEPENDENT re-price buckets. `getFiatValuesForTokenAmount` prices
    // the token amount into all three currencies, but each bucket may only
    // land its own currency: `sek_sum` already holds every row's booked
    // `sek_value`, and pricing SEK from the USD/EUR bucket's read is the
    // double-count the round-2 review measured (21 vs 10.5) — migration 090
    // backfills rows whose usd/eur are NULL, so the USD/EUR predicate
    // collects rows SEK has already priced. The buckets' predicates agree
    // per row shape (#3195): NULL, or zero-booked beside a real amount,
    // collects into BOTH buckets; a priced row into neither.
    const fallbackAmount = Number(row.fallback_amount ?? '0')
    if (fallbackAmount > 0) {
      const fallback = await getFiatValuesForTokenAmount(
        row.token_symbol,
        fallbackAmount.toString(),
      )
      usd += fallback.usd ?? 0
      eur += fallback.eur ?? 0
    }

    const fallbackAmountSek = Number(row.fallback_amount_sek ?? '0')
    if (fallbackAmountSek > 0) {
      const sekFallback = await getFiatValuesForTokenAmount(
        row.token_symbol,
        fallbackAmountSek.toString(),
      )
      sek += sekFallback.sek ?? 0
    }
  }

  return { usd, eur, sek }
}

export default async function dashboardRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.get<{ Querystring: { tz?: string } }>('/overview', async (request, reply) => {
    const { sub } = request.user as { sub: string }

    // #3824: the activity groups bucket by the USER's local day, so the
    // caller names the zone. Validated exactly as analytics validates its
    // `tz` — an invalid zone is a 400, before any read. Default UTC, same as
    // analytics (`analytics-overview.ts`).
    const tz = request.query.tz ?? 'UTC'
    if (!isValidActivityTimeZone(tz)) {
      // Never echo the raw query value: an offset/abbreviation reflected
      // verbatim into a 400 body is exactly the instrument analytics refuses
      // to be (same wording and reasoning as its handler).
      return reply.code(400).send({ error: 'unsupported tz' })
    }

    const [
      accounts,
      agents,
      firstAgentPayment,
    ] = await Promise.all([
      listDashboardAccounts(sub),
      listDashboardAgents(sub),
      hasFirstAgentPayment(sub),
    ])
    // #2055: structurally zero — the approval queue died with the
    // AllowanceModule rail; both wire fields survive for compatibility.
    const actionableApprovals = 0

    const activeAgents = agents.filter((agent) => agent.status === 'active')

    // Delegation-rail agents: the live budget is the active delegation set
    // (#1090). Legacy-rail agents get no allowance entries — the Safe rail is
    // retired (#1440/#2020) and `agent_allowances` is no longer read.
    const allowancesByAgent = new Map<string, DashboardAllowanceRow[]>()
    const delegationAgentIds = agents
      .filter((agent) => agent.account_type === 'delegator_hybrid')
      .map((agent) => agent.id)
    const derivedByAgent = await deriveDelegationAllowances(delegationAgentIds)
    for (const agentId of delegationAgentIds) {
      allowancesByAgent.set(agentId, derivedByAgent.get(agentId) ?? [])
    }

    const currentPortfolio = await Promise.all(
      accounts.map((account) => fetchPortfolioForAccount(account.chain_id, account.account_address)),
    )

    // #3295: a portfolio whose balance read failed serves the last-known
    // balances, marked stale (or unavailable when nothing was ever read).
    // The totals already use those substituted values, so a degraded read
    // shows the last figure we actually saw — never an understated zero.
    const balancesDegraded = combineBalanceFreshness(
      currentPortfolio.flatMap((portfolio) =>
        (portfolio.breakdown ?? []).map((item) => item.balanceFreshness),
      ),
    )

    const totalUsd = currentPortfolio.reduce((sum, item) => sum + item.totalUsd, 0)
    const totalEur = currentPortfolio.reduce((sum, item) => sum + item.totalEur, 0)
    const totalSek = currentPortfolio.reduce((sum, item) => sum + item.totalSek, 0)

    const todayDate = getSnapshotDate(0)
    const yesterdayDate = getSnapshotDate(-1)

    const snapshotRows = await findPortfolioSnapshots(sub, [todayDate, yesterdayDate])

    const snapshotsByDate = new Map(
      snapshotRows.map((row) => [row.snapshot_date, row]),
    )

    if (!snapshotsByDate.has(todayDate)) {
      // #3296: a read valued from a failed balance leg or a missing price is
      // unpriceable — inserting it would pin an understated figure on the day
      // (the row is never replaced and becomes tomorrow's baseline), so the
      // insert is skipped and the first CLEAN load that day writes it. Prices
      // served from #3297's last-good cache count as priced. One day with no
      // snapshot reports `change.available = false` tomorrow — a wrong figure
      // is worse than a missing one.
      const snapshotBlocked = currentPortfolio.some((portfolio) =>
        isPortfolioUnpriceable(portfolio),
      )
      if (snapshotBlocked) {
        // No amounts on purpose: the log line is a finding aid for a day with
        // no snapshot, not a figures channel.
        request.log.info(
          { userId: sub },
          'Daily portfolio snapshot skipped: the portfolio read is unpriceable (#3296)',
        )
      } else {
        await insertPortfolioSnapshot(sub, todayDate, totalUsd, totalEur, totalSek)
      }
    }

    const yesterdaySnapshot = snapshotsByDate.get(yesterdayDate)
    const previousUsd = Number(yesterdaySnapshot?.total_usd ?? '0')
    const previousEur = Number(yesterdaySnapshot?.total_eur ?? '0')
    // A pre-090 snapshot carries total_sek NULL: treated as "no SEK figure for
    // that day", not as a real zero — a zero would fabricate a -100% change.
    const changeAvailable = Boolean(yesterdaySnapshot)
    const sekChangeAvailable = changeAvailable && yesterdaySnapshot?.total_sek != null
    const previousSek = Number(yesterdaySnapshot?.total_sek ?? '0')
    const paymentSpendRows = await sumMonthlyPaymentSpend(sub)
    const paymentSpend = await accumulateMonthlySpend(paymentSpendRows)

    const monthlySpendUsd = paymentSpend.usd
    const monthlySpendEur = paymentSpend.eur
    const monthlySpendSek = paymentSpend.sek

    const mergedTransactions: EnrichedTransaction[] = []
    // #3824: a capped explorer read makes every count the groups serve a
    // FLOOR over an unknown total — the flag is read per account here and ORs
    // into the group builder below (`countIsFloor`).
    let explorerTruncated = false
    const transactionResults = await Promise.allSettled(
      accounts.map(async (account) => {
        const { transactions, truncated } = await fetchAccountTransactions({
          accountId: account.id,
          accountAddress: account.account_address,
          chainId: account.chain_id,
          log: request.log,
        })

        if (truncated) explorerTruncated = true

        return transactions.map((tx) => ({
          ...tx,
          chainId: account.chain_id,
          accountId: account.id,
          accountAddress: account.account_address,
          accountName: account.name,
        }))
      }),
    )

    transactionResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        mergedTransactions.push(...result.value)
        return
      }

      const account = accounts[index]
      request.log.warn(
        { err: result.reason, accountId: account.id, chainId: account.chain_id },
        'Dashboard transaction aggregation failed',
      )
    })

    const visibleTransactions = await mergeX402Transactions(
      sub,
      accounts,
      mergedTransactions,
    )

    visibleTransactions.sort(compareTransactions)

    const seen = new Set<string>()
    const dedupedTransactions = visibleTransactions.filter((tx) => {
      const key = enrichedTransactionIdentityKey(tx)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    const currency = await resolveTransactionCurrency(sub)
    const enrichedTransactions = await enrichTransactionsWithAgents(
      sub,
      dedupedTransactions,
      // The preview names its currency like the feed does (#3127 round-2
      // review): without the preference, the same payment is SEK here and
      // USD on /transactions for a USD user. #3824: hoisted so the activity
      // groups' serve-time pricing strikes in the SAME currency.
      currency,
    )

    const successfulTransactions = dedupedTransactions.filter((tx) => !tx.isError).length

    // #3824: the grouped activity rows — server-side over the SAME feed the
    // preview slices, so the counts are not bounded by any client window.
    // Merchant labels come from the same two lookups analytics resolves them
    // from (address-book contacts, then receipt merchant names); one read of
    // each per request, over the counterparty addresses the feed carries.
    const merchantAddresses = Array.from(
      new Set(
        enrichedTransactions
          .filter((tx) => tx.direction === 'out' && tx.to)
          .map((tx) => tx.to.toLowerCase()),
      ),
    )
    // Fail-soft on purpose: the labels are display garnish on top of the
    // grouped rows — a contacts or receipt-read outage must not 500 the
    // overview, it just serves the raw addresses (the same degradation the
    // CSV export has always had when a lookup came back empty).
    const [contacts, receiptNames] = await Promise.all([
      listContactsForUser(sub).catch(() => []),
      listReceiptMerchantNamesForUser(sub, merchantAddresses).catch(() => new Map<string, string>()),
    ])
    const contactNames = new Map(contacts.map((c) => [c.address.toLowerCase(), c.name]))
    const resolveMerchantName = (address: string): string | null =>
      contactNames.get(address.toLowerCase()) ?? receiptNames.get(address.toLowerCase()) ?? null

    const activity = await buildActivityGroups({
      transactions: enrichedTransactions,
      truncated: explorerTruncated,
      tz,
      currency,
      resolveMerchantName,
    })

    return {
      totals: {
        usd: totalUsd,
        eur: totalEur,
        sek: totalSek,
      },
      change: {
        available: changeAvailable,
        // #3295: when some token has no known value, the totals are
        // understated by an unknown amount — the change is reported as
        // unavailable (null amounts), never as a swing computed from a zero.
        // Marked-stale tokens still diff normally: the last-known figures are
        // on both sides of the subtraction.
        usdAmount: balancesDegraded?.status === 'unavailable' ? null : totalUsd - previousUsd,
        eurAmount: balancesDegraded?.status === 'unavailable' ? null : totalEur - previousEur,
        // Null, not 0, when yesterday's snapshot predates migration 090: the
        // wire distinguishes "no SEK figure to diff against" from "changed by
        // exactly 0", and the frontend reports the change as unavailable
        // rather than fabricating a -100% swing from a missing baseline.
        sekAmount:
          sekChangeAvailable && balancesDegraded?.status !== 'unavailable'
            ? totalSek - previousSek
            : null,
        usdPercent: changeAvailable ? computePercentChange(totalUsd, previousUsd) : 0,
        eurPercent: changeAvailable ? computePercentChange(totalEur, previousEur) : 0,
        // sekPercent 0 beside sekAmount null is deliberate: the frontend
        // branches on the AMOUNT (null = "change unavailable") and never
        // reads the percentage in that state — the schema wants a number, so
        // 0 is the inert filler, not a claim the change was zero.
        sekPercent: sekChangeAvailable ? computePercentChange(totalSek, previousSek) : 0,
        // Additive (#3295): present only when at least one token's read is
        // stale or unavailable; absent on a clean read.
        ...(balancesDegraded ? { balancesFreshness: balancesDegraded } : {}),
      },
      metrics: {
        connectedAgents: activeAgents.length,
        monthlyAgentSpendUsd: monthlySpendUsd,
        monthlyAgentSpendEur: monthlySpendEur,
        monthlyAgentSpendSek: monthlySpendSek,
        successfulTransactions,
        activeAccounts: accounts.length,
      },
      actionableApprovals,
      pendingApprovals: actionableApprovals,
      onboardingProgress: {
        hasFirstAgentPayment: firstAgentPayment,
      },
      agents: agents.slice(0, AGENT_PREVIEW_LIMIT).map((agent) =>
        ({
          id: agent.id,
          name: agent.name,
          status: agent.status,
          accountId: agent.account_id,
          accountName: agent.account_name,
          accountChainId: agent.account_chain_id,
          allowances: (allowancesByAgent.get(agent.id) ?? []).map((allowance) => ({
            tokenSymbol: allowance.token_symbol,
            allowanceAmount: allowance.allowance_amount,
            resetPeriodMin: allowance.reset_period_min,
          })),
        }),
      ),
      // #3824: up to 8 grouped-activity rows over the last 7 user-local days,
      // newest first, grouped server-side over the feed above. The 5-row
      // preview below stays on the wire unchanged until #3810 retires it.
      activity,
      transactions: enrichedTransactions.slice(0, TRANSACTION_PREVIEW_LIMIT).map((tx) =>
        ({
          hash: tx.hash,
          type: tx.type,
          from: tx.from,
          to: tx.to,
          value: tx.value,
          valueFormatted: tx.valueFormatted,
          asset: tx.asset,
          decimals: tx.decimals,
          direction: tx.direction,
          timestamp: tx.timestamp,
          // #3132: the preview carries the same synthesized x402 rows as the
          // feed, so the marked fallback must reach it too (no `scope`: the
          // preview is not a list query).
          timestampSource: tx.timestampSource,
          confirmedAt: tx.confirmedAt,
          blockNumber: tx.blockNumber,
          isError: tx.isError,
          tokenAddress: tx.tokenAddress,
          tokenSymbol: tx.tokenSymbol,
          chainId: tx.chainId,
          accountId: tx.accountId,
          accountAddress: tx.accountAddress,
          accountName: tx.accountName,
          agentId: tx.agentId,
          agentName: tx.agentName,
          source: tx.source,
          x402ResourceUrl: tx.x402ResourceUrl,
          x402MerchantAddress: tx.x402MerchantAddress,
          // #3778: the non-secret delivery pointer, when one was reported.
          deliveryReference: tx.deliveryReference ?? null,
        }),
      ),
    }
  })
}
