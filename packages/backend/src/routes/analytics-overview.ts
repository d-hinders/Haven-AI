import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { config } from '../config.js'
import { listContactsForUser } from '../infra/repositories/contacts.js'
import { aggregateRefusalsForUserByAgent, firstRefusalDayForUser } from '../infra/repositories/payment-refusals.js'
import {
  aggregateRefusalAmountForUser,
  computeBudgetBands,
  listActiveDelegationsForUser,
  listBalanceByDayForUser,
  listByDaySpendForUser,
  listGasEventsByChainForUser,
  listPerAgentSpendForUser,
  listPerAgentTopMerchantForUser,
  listReceiptMerchantNamesForUser,
  listRefusalsByDayForUser,
  listTopMerchantsForUser,
  shapeBudgets,
  sumFeesTotalsForUser,
  sumTotalsSpendForUser,
  sumValueBearingGasOps,
  countUnsettledSubmittedForUser,
  type DateRange,
} from '../infra/repositories/analytics.js'

/**
 * `GET /analytics/overview` (#2946, slice B of epic #2944).
 *
 * A SEPARATE module from `routes/analytics.ts` (the internal onboarding
 * funnel), registered under the SAME `/analytics` prefix — Fastify routes on
 * a shared prefix are just distinct path strings under one mount point, the
 * same pattern `catalogRoutes` + `catalogSubmissionRoutes` already use under
 * `/catalog` (`index.ts`). `/analytics/funnel` and `/analytics/overview`
 * never collide because neither module declares the other's sub-path; there
 * is nothing to "fight over".
 */

const RANGE_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 }
const CURRENCIES = new Set(['usd', 'eur', 'sek'])

/**
 * `Intl.DateTimeFormat`'s own constructor accepts far more than IANA zone
 * names — UTC offsets (`+05:00`), fixed abbreviations (`EST`), and even
 * two-letter country codes (`GB`) all construct successfully, but Postgres's
 * `AT TIME ZONE` (`BY_DAY_SPEND_SQL`) and this function's own JS Date math
 * interpret an offset string with OPPOSITE sign conventions (POSIX vs ISO-8601),
 * so accepting one here would silently bucket a day on the wrong side of
 * midnight relative to what the SQL does. `Intl.supportedValuesOf('timeZone')`
 * is the actual IANA tzdata list — `'UTC'` is added explicitly because the
 * spec permits implementations to omit it from that list.
 */
function isValidTimeZone(tz: string): boolean {
  return tz === 'UTC' || Intl.supportedValuesOf('timeZone').includes(tz)
}

interface MerchantLabelSources {
  contactsByAddress: Map<string, string>
  receiptByAddress: Map<string, string>
}

function resolveMerchantLabel(address: string, sources: MerchantLabelSources): string {
  const key = address.toLowerCase()
  return sources.contactsByAddress.get(key) ?? sources.receiptByAddress.get(key) ?? address
}

export default async function analyticsOverviewRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // GET /analytics/overview?range=7d|30d|90d&currency=usd|eur|sek&tz=<IANA>
  app.get<{ Querystring: { range?: string; currency?: string; tz?: string } }>(
    '/overview',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { range: rangeParam, currency: currencyParam, tz: tzParam } = request.query

      const days = rangeParam ? RANGE_DAYS[rangeParam] : undefined
      if (!days) {
        return reply.code(400).send({ error: 'range must be one of: 7d, 30d, 90d' })
      }
      const currency = (currencyParam ?? 'usd').toLowerCase()
      if (!CURRENCIES.has(currency)) {
        return reply.code(400).send({ error: 'currency must be one of: usd, eur, sek' })
      }
      const tz = tzParam ?? 'UTC'
      if (!isValidTimeZone(tz)) {
        // Never echo the raw query value: an offset/abbreviation/injection
        // shape reflected verbatim into a 400 body is exactly the kind of
        // instrument this endpoint must not become.
        return reply.code(400).send({ error: 'unsupported tz' })
      }
      const cur = currency as 'usd' | 'eur' | 'sek'

      const now = new Date()
      const to = now
      const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
      const previousTo = from
      const previousFrom = new Date(from.getTime() - days * 24 * 60 * 60 * 1000)

      const current: DateRange = { from: from.toISOString(), to: to.toISOString() }
      const previous: DateRange = { from: previousFrom.toISOString(), to: previousTo.toISOString() }

      const [
        totals,
        unsettledSubmitted,
        byDaySpend,
        perAgentSpend,
        perAgentTopMerchant,
        topMerchants,
        balanceByDay,
        fees,
        gasByChain,
        activeDelegations,
        refusalsCurrentByAgent,
        refusalsPreviousByAgent,
        refusalAmount,
        refusalsByDayRows,
        refusalLedgerFloor,
        contacts,
      ] = await Promise.all([
        sumTotalsSpendForUser(sub, current, previous),
        countUnsettledSubmittedForUser(sub, current),
        listByDaySpendForUser(sub, tz, current),
        listPerAgentSpendForUser(sub, current),
        listPerAgentTopMerchantForUser(sub, current),
        listTopMerchantsForUser(sub, current),
        listBalanceByDayForUser(sub, current),
        sumFeesTotalsForUser(sub, current, previous),
        listGasEventsByChainForUser(sub, current),
        listActiveDelegationsForUser(sub),
        aggregateRefusalsForUserByAgent(sub, { fromExclusive: current.from, toInclusive: current.to }),
        aggregateRefusalsForUserByAgent(sub, { fromExclusive: previous.from, toInclusive: previous.to }),
        // Amount and by-day are ONE aggregate scan each (analytics.ts,
        // review of #2946) — never a client-side fold over a fetched row
        // list, and both use the same `[from, to)` boundary as spend.
        aggregateRefusalAmountForUser(sub, current),
        listRefusalsByDayForUser(sub, tz, current),
        // The ledger floor (#3013) — read inside NO window bound: it is a
        // property of the ledger, not of the requested range.
        firstRefusalDayForUser(sub),
        listContactsForUser(sub),
      ])

      // Budget reads are RPC calls, not SQL — sequential per delegation,
      // documented in infra/repositories/analytics.ts.
      const budgetsByAgent = await shapeBudgets(activeDelegations)
      const budgetBands = computeBudgetBands(budgetsByAgent)

      const contactsByAddress = new Map(contacts.map((c) => [c.address.toLowerCase(), c.name]))
      const merchantAddresses = Array.from(
        new Set([
          ...topMerchants.map((m) => m.merchant_key),
          ...perAgentTopMerchant.map((m) => m.merchant_key),
        ]),
      )
      const receiptByAddress = await listReceiptMerchantNamesForUser(sub, merchantAddresses)
      const labelSources: MerchantLabelSources = { contactsByAddress, receiptByAddress }

      // ── Refusal totals, folded from the per-agent aggregate (no re-query). ──
      let refusedCount = 0
      let refusedAttempts = 0
      for (const a of refusalsCurrentByAgent) {
        refusedCount += a.refusals
        refusedAttempts += a.attempts
      }
      let refusedPreviousCount = 0
      for (const a of refusalsPreviousByAgent) refusedPreviousCount += a.refusals
      const refusedAmount =
        cur === 'usd'
          ? refusalAmount.refused_amount_usd
          : cur === 'eur'
            ? refusalAmount.refused_amount_eur
            : refusalAmount.refused_amount_sek

      // ── by_day: spend (from SQL) + refusals (from REFUSALS_BY_DAY_SQL, same tz bucketing). ──
      const byDayMap = new Map<string, { spent_by_agent: Record<string, string>; refusals: number }>()
      for (const row of byDaySpend) {
        const entry = byDayMap.get(row.day) ?? { spent_by_agent: {}, refusals: 0 }
        entry.spent_by_agent[row.agent_id] =
          cur === 'usd' ? row.usd : cur === 'eur' ? row.eur : row.sek
        byDayMap.set(row.day, entry)
      }
      for (const row of refusalsByDayRows) {
        const entry = byDayMap.get(row.day) ?? { spent_by_agent: {}, refusals: 0 }
        entry.refusals = Number(row.refusals)
        byDayMap.set(row.day, entry)
      }
      const byDay = Array.from(byDayMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, v]) => ({ date, spent_by_agent: v.spent_by_agent, refusals: v.refusals }))

      // ── agents[] ──────────────────────────────────────────────────────────
      const topMerchantByAgent = new Map(perAgentTopMerchant.map((m) => [m.agent_id, m.merchant_key]))
      const totalSpentAcrossAgents = perAgentSpend.reduce(
        (sum, a) =>
          sum + Number(cur === 'usd' ? a.spent_usd : cur === 'eur' ? a.spent_eur : a.spent_sek),
        0,
      )
      const agents = perAgentSpend.map((a) => {
        const refusalAgg = refusalsCurrentByAgent.find((r) => r.agent_id === a.agent_id)
        const spent = Number(cur === 'usd' ? a.spent_usd : cur === 'eur' ? a.spent_eur : a.spent_sek)
        const merchantKey = topMerchantByAgent.get(a.agent_id) ?? null
        const budgets = (budgetsByAgent.get(a.agent_id) ?? []).map((b) => ({
          token: b.token,
          recipient: b.recipient,
          used_atomic: b.used_atomic,
          budget_atomic: b.budget_atomic,
          remaining_from_chain: b.remaining_from_chain,
          period_start: b.period_start,
          period_end: b.period_end,
        }))
        return {
          id: a.agent_id,
          name: a.name,
          status: a.status,
          spent: cur === 'usd' ? a.spent_usd : cur === 'eur' ? a.spent_eur : a.spent_sek,
          share: totalSpentAcrossAgents > 0 ? spent / totalSpentAcrossAgents : 0,
          payments: Number(a.payments),
          refusals: refusalAgg?.refusals ?? 0,
          refusal_attempts: refusalAgg?.attempts ?? 0,
          budgets,
          top_merchant: merchantKey
            ? { label: resolveMerchantLabel(merchantKey, labelSources), address: merchantKey }
            : null,
          last_payment_at: a.last_payment_at,
        }
      })

      // ── merchants[] (top 10) ─────────────────────────────────────────────
      const merchants = topMerchants.map((m) => ({
        label: resolveMerchantLabel(m.merchant_key, labelSources),
        address: m.merchant_key,
        spent: cur === 'usd' ? m.spent_usd : cur === 'eur' ? m.spent_eur : m.spent_sek,
        payments: Number(m.payments),
        agent_ids: m.agent_ids,
        first_seen: m.first_seen,
        last_seen: m.last_seen,
      }))

      // ── balance_by_day[] ─────────────────────────────────────────────────
      // The SEK column is nullable (migration 090 backfills only days with
      // evidence): a pre-090 day has no SEK figure, and `Number(null)` would
      // read that absence as a real `0` on the chart — the same fabricated
      // swing the dashboard change guard refuses. Pre-090 days are DROPPED
      // for SEK rather than zeroed; the section's own sparse-floor renders
      // the honest empty state when too few days survive.
      const balanceSeries = balanceByDay.map((b) => ({
        date: b.snapshot_date,
        value: cur === 'usd' ? b.total_usd : cur === 'eur' ? b.total_eur : b.total_sek,
      })).filter((p) => p.value != null) as { date: string; value: string }[]

      const gasSponsoredOps = sumValueBearingGasOps(gasByChain)

      return {
        range: {
          from: current.from,
          to: current.to,
          days,
          previous_from: previous.from,
          previous_to: previous.to,
        },
        currency: cur,
        basis: {
          payments_counted: Number(totals.payments_counted),
          unsettled_submitted: unsettledSubmitted,
          refusals_counted: refusedCount,
          refusal_attempts: refusedAttempts,
          fee_rows: Number(fees.fee_rows),
          gas_sponsored_ops: gasSponsoredOps,
          snapshot_days: balanceByDay.length,
          tz,
          refusals_recorded_from: refusalLedgerFloor,
        },
        totals: {
          spent:
            cur === 'usd' ? totals.spent_usd : cur === 'eur' ? totals.spent_eur : totals.spent_sek,
          spent_previous:
            cur === 'usd'
              ? totals.spent_previous_usd
              : cur === 'eur'
                ? totals.spent_previous_eur
                : totals.spent_previous_sek,
          refused_count: refusedCount,
          refused_attempts: refusedAttempts,
          refused_amount: refusedAmount,
          refused_previous_count: refusedPreviousCount,
          budget_bands: budgetBands,
          fees: {
            amount: cur === 'usd' ? fees.fee_usd : cur === 'eur' ? fees.fee_eur : fees.fee_sek,
            previous:
              cur === 'usd'
                ? fees.fee_usd_previous
                : cur === 'eur'
                  ? fees.fee_eur_previous
                  : fees.fee_sek_previous,
            flag_on: config.feeEnabled,
          },
          gas_sponsored_ops: gasSponsoredOps,
        },
        by_day: byDay,
        agents,
        merchants,
        balance_by_day: balanceSeries,
      }
    },
  )
}
