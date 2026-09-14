import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { config } from '../config.js'
import { listContactsForUser } from '../infra/repositories/contacts.js'
import {
  aggregateRefusalsForUserByAgent,
  listRefusalsForUser,
  type PaymentRefusalRow,
} from '../infra/repositories/payment-refusals.js'
import {
  computeBudgetBands,
  listActiveDelegationsForUser,
  listBalanceByDayForUser,
  listByDaySpendForUser,
  listGasEventsByChainForUser,
  listPerAgentSpendForUser,
  listPerAgentTopMerchantForUser,
  listReceiptMerchantNamesForUser,
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
const CURRENCIES = new Set(['usd', 'eur'])

function isValidTimeZone(tz: string): boolean {
  try {
    // Throws RangeError for an unrecognized zone; this IS the fixed IANA
    // check the issue allows in place of a `pg_timezone_names` round trip —
    // no extra query, and it fails the same set of inputs pg would.
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format()
    return true
  } catch {
    return false
  }
}

/** `YYYY-MM-DD` in the given zone — used to bucket refusal rows the same way `BY_DAY_SPEND_SQL` buckets payments. */
function dayKeyInZone(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso))
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

  // GET /analytics/overview?range=7d|30d|90d&currency=usd|eur&tz=<IANA>
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
        return reply.code(400).send({ error: 'currency must be one of: usd, eur' })
      }
      const tz = tzParam ?? 'UTC'
      if (!isValidTimeZone(tz)) {
        return reply.code(400).send({ error: `tz is not a recognized IANA time zone: ${tz}` })
      }
      const cur = currency as 'usd' | 'eur'

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
        refusalRows,
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
        listRefusalsForUser(sub, { fromExclusive: current.from, toInclusive: current.to }, 10_000),
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
      const refusedAmount = refusalRows.reduce((sum, r: PaymentRefusalRow) => {
        const value = cur === 'usd' ? r.usd_value : r.eur_value
        return sum + (value ? Number(value) : 0)
      }, 0)

      // ── by_day: spend (from SQL) + refusals (bucketed here from the reads above). ──
      const refusalsByDay = new Map<string, number>()
      for (const r of refusalRows) {
        const key = dayKeyInZone(r.created_at, tz)
        refusalsByDay.set(key, (refusalsByDay.get(key) ?? 0) + 1)
      }
      const byDayMap = new Map<string, { spent_by_agent: Record<string, string>; refusals: number }>()
      for (const row of byDaySpend) {
        const entry = byDayMap.get(row.day) ?? { spent_by_agent: {}, refusals: 0 }
        entry.spent_by_agent[row.agent_id] = cur === 'usd' ? row.usd : row.eur
        byDayMap.set(row.day, entry)
      }
      for (const [day, count] of refusalsByDay) {
        const entry = byDayMap.get(day) ?? { spent_by_agent: {}, refusals: 0 }
        entry.refusals = count
        byDayMap.set(day, entry)
      }
      const byDay = Array.from(byDayMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, v]) => ({ date, spent_by_agent: v.spent_by_agent, refusals: v.refusals }))

      // ── agents[] ──────────────────────────────────────────────────────────
      const topMerchantByAgent = new Map(perAgentTopMerchant.map((m) => [m.agent_id, m.merchant_key]))
      const totalSpentAcrossAgents = perAgentSpend.reduce(
        (sum, a) => sum + Number(cur === 'usd' ? a.spent_usd : a.spent_eur),
        0,
      )
      const agents = perAgentSpend.map((a) => {
        const refusalAgg = refusalsCurrentByAgent.find((r) => r.agent_id === a.agent_id)
        const spent = Number(cur === 'usd' ? a.spent_usd : a.spent_eur)
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
          spent: (cur === 'usd' ? a.spent_usd : a.spent_eur),
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
        spent: cur === 'usd' ? m.spent_usd : m.spent_eur,
        payments: Number(m.payments),
        agent_ids: m.agent_ids,
        first_seen: m.first_seen,
        last_seen: m.last_seen,
      }))

      // ── balance_by_day[] ─────────────────────────────────────────────────
      const balanceSeries = balanceByDay.map((b) => ({
        date: b.snapshot_date,
        value: cur === 'usd' ? b.total_usd : b.total_eur,
      }))

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
        },
        totals: {
          spent: cur === 'usd' ? totals.spent_usd : totals.spent_eur,
          spent_previous: cur === 'usd' ? totals.spent_previous_usd : totals.spent_previous_eur,
          refused_count: refusedCount,
          refused_attempts: refusedAttempts,
          refused_amount: refusedAmount,
          refused_previous_count: refusedPreviousCount,
          budget_bands: budgetBands,
          fees: {
            amount: cur === 'usd' ? fees.fee_usd : fees.fee_eur,
            previous: cur === 'usd' ? fees.fee_usd_previous : fees.fee_eur_previous,
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
