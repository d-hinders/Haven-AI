import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { config } from '../config.js'
import { listContactsForUser } from '../infra/repositories/contacts.js'
import { agentExistsForUser } from '../infra/repositories/agents.js'
import { listAccountsForUser } from '../infra/repositories/smart-accounts.js'
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
import {
  ownAccountNameForAddress,
  resolveCounterpartyName,
} from '../modules/transactions/index.js'

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

const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const
type AnalyticsRange = keyof typeof RANGE_DAYS
/** Exported for the test that pins the spec's enums to these (#3030). */
export const ANALYTICS_OVERVIEW_ENUMS = { range: Object.keys(RANGE_DAYS), currency: ['usd', 'eur', 'sek'] } as const
/** The spec's query, as the enforced module hands it over (#3030). Kept as
 *  an alias: a quoted union inside the route generic hides the path literal
 *  from `generate-route-modules`, which scans for it. `agentId` is the spec's
 *  uuid (#4332) — a malformed id is the enforced 400 envelope, so the handler
 *  sees only well-formed uuids. */
type OverviewQuery = { range: AnalyticsRange; currency?: 'usd' | 'eur' | 'sek'; tz?: string; agentId?: string }

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

export default async function analyticsOverviewRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // GET /analytics/overview?range=7d|30d|90d&currency=usd|eur|sek&tz=<IANA>&agentId=<uuid>
  // `range` (required) and `currency` are the spec's enums, enforced before
  // the handler since #3030 — the module is in `enforcedModules`, so the
  // types below are the enums and the defaults are injected. `tz` stays a
  // handler decision: "a zone Intl knows" is not a shape the spec can state.
  // `agentId` (#4332) is the spec's uuid — a malformed id never reaches this
  // handler (the enforced 400 envelope answers it), and a WELL-FORMED id
  // that is not the user's is a 404 below, never another user's data.
  app.get<{ Querystring: OverviewQuery }>(
    '/overview',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { range: rangeParam, currency: currencyParam, tz: tzParam, agentId: agentIdParam } = request.query

      const days = RANGE_DAYS[rangeParam]
      const currency = currencyParam ?? 'usd'
      const tz = tzParam ?? 'UTC'
      if (!isValidTimeZone(tz)) {
        // Never echo the raw query value: an offset/abbreviation/injection
        // shape reflected verbatim into a 400 body is exactly the kind of
        // instrument this endpoint must not become.
        return reply.code(400).send({ error: 'unsupported tz' })
      }
      const cur = currency

      // ── Ownership (#4332). A revoked agent KEEPS its history: the check is
      // existence for this user, not status (`agentExistsForUser` selects by
      // id + user only), so a revoked agent's filtered page still renders.
      let agentId: string | null = null
      if (agentIdParam !== undefined) {
        if (!(await agentExistsForUser(agentIdParam, sub))) {
          // The same "not found or not yours" contract the other agent
          // routes answer with — no existence oracle, no cross-tenant probe.
          return reply.code(404).send({ error: 'Agent not found' })
        }
        agentId = agentIdParam
      }
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
        sumTotalsSpendForUser(sub, current, previous, agentId),
        countUnsettledSubmittedForUser(sub, current, agentId),
        listByDaySpendForUser(sub, tz, current, agentId),
        listPerAgentSpendForUser(sub, current),
        listPerAgentTopMerchantForUser(sub, current),
        listTopMerchantsForUser(sub, current, agentId),
        listBalanceByDayForUser(sub, current),
        sumFeesTotalsForUser(sub, current, previous, agentId),
        listGasEventsByChainForUser(sub, current),
        listActiveDelegationsForUser(sub),
        aggregateRefusalsForUserByAgent(sub, { fromExclusive: current.from, toInclusive: current.to }),
        aggregateRefusalsForUserByAgent(sub, { fromExclusive: previous.from, toInclusive: previous.to }),
        // Amount and by-day are ONE aggregate scan each (analytics.ts,
        // review of #2946) — never a client-side fold over a fetched row
        // list, and both use the same `[from, to)` boundary as spend.
        aggregateRefusalAmountForUser(sub, current, agentId),
        listRefusalsByDayForUser(sub, tz, current, agentId),
        // The ledger floor (#3013) — read inside NO window bound: it is a
        // property of the ledger, not of the requested range.
        firstRefusalDayForUser(sub),
        listContactsForUser(sub),
      ])

      // ── agentId scoping (#4332) — the JS half. The per-agent reads and the
      // per-agent refusal aggregate return EVERY agent's rows keyed by
      // `agent_id`, so the filter is an exact projection, not a re-query:
      // `payment-refusals.ts` is CASP-covered (no parameter added there) and
      // the delegations are filtered BEFORE `shapeBudgets`, so no other
      // agent's chain reads run. Balance and gas are intentionally unscoped.
      const scopedPerAgentSpend = agentId
        ? perAgentSpend.filter((a) => a.agent_id === agentId)
        : perAgentSpend
      const scopedPerAgentTopMerchant = agentId
        ? perAgentTopMerchant.filter((m) => m.agent_id === agentId)
        : perAgentTopMerchant
      const scopedRefusalsCurrent = agentId
        ? refusalsCurrentByAgent.filter((r) => r.agent_id === agentId)
        : refusalsCurrentByAgent
      const scopedRefusalsPrevious = agentId
        ? refusalsPreviousByAgent.filter((r) => r.agent_id === agentId)
        : refusalsPreviousByAgent
      const scopedDelegations = agentId
        ? activeDelegations.filter((d) => d.agent_id === agentId)
        : activeDelegations

      // Budget reads are RPC calls, not SQL — sequential per delegation,
      // documented in infra/repositories/analytics.ts.
      const budgetsByAgent = await shapeBudgets(scopedDelegations)
      const budgetBands = computeBudgetBands(budgetsByAgent)

      const contactsByAddress = new Map(contacts.map((c) => [c.address.toLowerCase(), c.name]))
      // Address-only own-account names (#4332): `LIST_ACCOUNTS_FOR_USER_SQL`
      // orders `created_at ASC`, so `ownAccountNameForAddress`'s first match
      // is the OLDEST account when several share an address, on any chain.
      const ownAccounts = await listAccountsForUser(sub)
      const merchantAddresses = Array.from(
        new Set([
          ...topMerchants.map((m) => m.merchant_key),
          ...scopedPerAgentTopMerchant.map((m) => m.merchant_key),
        ]),
      )
      const receiptByAddress = await listReceiptMerchantNamesForUser(sub, merchantAddresses)

      /** The five-step naming order (Scope §2), from the candidates this route fetched. */
      const nameMerchant = (merchantKey: string, x402ResourceUrl: string | null) =>
        resolveCounterpartyName({
          x402ResourceUrl,
          ownAccountName: ownAccountNameForAddress(ownAccounts, merchantKey),
          contactName: contactsByAddress.get(merchantKey.toLowerCase()) ?? null,
          receiptName: receiptByAddress.get(merchantKey.toLowerCase()) ?? null,
        })

      // ── Refusal totals, folded from the per-agent aggregate (no re-query). ──
      let refusedCount = 0
      let refusedAttempts = 0
      for (const a of scopedRefusalsCurrent) {
        refusedCount += a.refusals
        refusedAttempts += a.attempts
      }
      let refusedPreviousCount = 0
      for (const a of scopedRefusalsPrevious) refusedPreviousCount += a.refusals
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
      const topMerchantByAgent = new Map(
        scopedPerAgentTopMerchant.map((m) => [m.agent_id, m] as const),
      )
      const totalSpentAcrossAgents = scopedPerAgentSpend.reduce(
        (sum, a) =>
          sum + Number(cur === 'usd' ? a.spent_usd : cur === 'eur' ? a.spent_eur : a.spent_sek),
        0,
      )
      // #3540 inclusion rule. The repository returns every delegation-rail
      // agent the tenant owns; the table lists an agent when it is not
      // revoked (its budget column still informs at zero activity), when it
      // had activity in range (`refusals` covers `refusal_attempts`), or when
      // it is revoked yet still holds an active delegation — revoking flips
      // only `agents.status`, so that agent can still spend, and
      // `totals.budget_bands` already counts it.
      const agents = scopedPerAgentSpend.map((a) => {
        const refusalAgg = scopedRefusalsCurrent.find((r) => r.agent_id === a.agent_id)
        const spent = Number(cur === 'usd' ? a.spent_usd : cur === 'eur' ? a.spent_eur : a.spent_sek)
        const topMerchant = topMerchantByAgent.get(a.agent_id) ?? null
        const budgets = (budgetsByAgent.get(a.agent_id) ?? []).map((b) => ({
          token: b.token,
          recipient: b.recipient,
          used_atomic: b.used_atomic,
          budget_atomic: b.budget_atomic,
          remaining_from_chain: b.remaining_from_chain,
          period_start: b.period_start,
          period_end: b.period_end,
          chain_id: b.chain_id,
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
          top_merchant: topMerchant
            ? {
                label: nameMerchant(topMerchant.merchant_key, topMerchant.resource_url).label,
                address: topMerchant.merchant_key,
              }
            : null,
          last_payment_at: a.last_payment_at,
        }
      }).filter(
        (row) => row.status !== 'revoked' || row.payments > 0 || row.refusals > 0 || row.budgets.length > 0,
      )

      // ── merchants[] (top 10) ─────────────────────────────────────────────
      // `label` is NULLABLE now (#4332): `unknown` means the client renders
      // "Unknown recipient" (#4333), where /transactions says "New
      // recipient". `filter_address` is the address /transactions' search
      // matches — the "View in Transactions" link's target, NOT the group
      // key (the two COALESCEs can disagree; see TOP_MERCHANTS_SQL).
      const merchants = topMerchants.map((m) => {
        const name = nameMerchant(m.merchant_key, m.resource_url)
        return {
          label: name.label,
          kind: name.kind,
          filter_address: m.filter_address,
          address: m.merchant_key,
          spent: cur === 'usd' ? m.spent_usd : cur === 'eur' ? m.spent_eur : m.spent_sek,
          payments: Number(m.payments),
          agent_ids: m.agent_ids,
          first_seen: m.first_seen,
          last_seen: m.last_seen,
        }
      })

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
        // Balance is stored per USER only (`user_daily_portfolio_snapshots`);
        // it is deliberately NOT scoped by agentId, and the response says so.
        balance_scope: 'all_accounts',
        balance_by_day: balanceSeries,
      }
    },
  )
}
