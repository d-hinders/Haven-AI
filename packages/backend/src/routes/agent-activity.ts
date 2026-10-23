import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { getExplorerUrl } from '../domain/chains.js'
import {
  DEFAULT_TRANSACTION_CURRENCY,
  type TransactionCurrency,
} from '../domain/transaction-currency.js'
import { machinePaymentLifecycle } from '../domain/machine-payment-lifecycle.js'
import { agentExistsForUser, listAgentNamesForUser } from '../infra/repositories/agents.js'
import {
  listAgentPayments,
  listAgentPaymentsFiltered,
  countAgentPaymentsFiltered,
  listFeedPayments,
  sumAgentSpendAllTime,
  sumAgentSpendToday,
  type ActivityPaymentRow,
  type AgentPaymentActivityFilter,
} from '../infra/repositories/agent-activity.js'
import {
  countAgentRefusalsFiltered,
  listAgentRefusalsFiltered,
  type AgentRefusalActivityFilter,
  type AgentRefusalRow,
} from '../infra/repositories/payment-refusals.js'
import { humanTokenAmount } from '../domain/tokens.js'
import {
  listToolInvocationsForAgent,
  listToolInvocationsForAgentFiltered,
  countToolInvocationsForAgentFiltered,
  listToolInvocationsForAgents,
  type AgentToolInvocationFilter,
  type AgentToolInvocationRow,
} from '../infra/repositories/agent-tool-invocations.js'
import {
  isValidActivityTimeZone,
  localDayBounds,
  toCanonicalAddress,
  resolveTransactionCurrency,
  serveTimeAmount,
  serveTimeAmountTriple,
} from '../modules/transactions/index.js'
import { MACHINE_PAYMENT_RAILS } from '@haven_ai/core'

/**
 * Route options — the production register passes none.
 *
 * `now` is the injectable clock the "today" window derives from (#3977):
 * tests register the plugin with a fixed instant and assert the exact
 * local-day bounds the query received, without freezing anything global.
 */
export interface AgentActivityRouteOptions {
  now?: () => Date
}

// ── Routes ────────────────────────────────────────────────────────

/**
 * #3824: the currency the approx amounts are struck in — the user's
 * preference, read FAIL-SOFT: an unreadable preference row serves the
 * documented default (`transactionCurrencyOrDefault`'s spirit) rather than
 * 500-ing a feed whose primary data is the payment rows themselves. The
 * pricing read downstream already fails soft per row (`serve-time.ts`).
 */
async function approxCurrencyFor(userId: string): Promise<TransactionCurrency> {
  try {
    return await resolveTransactionCurrency(userId)
  } catch {
    return DEFAULT_TRANSACTION_CURRENCY
  }
}

// ── The kinded read (#4229) ──────────────────────────────────────────────────
//
// The per-agent activity read is pageable and filterable per population when
// `kind` is given. Omitting `kind` serves today's merged response untouched —
// byte-identical, filters included, so an old caller (and the old backend a
// new caller may hit: the query schema has no `additionalProperties: false`)
// sees exactly the shape it has always seen.

/** The `status` vocabularies per `kind`; a value from the other kind is a 400. */
const PAYMENT_STATUS_FILTERS = new Set(['sent', 'pending', 'failed', 'needs_attention'])
const TOOL_CALL_STATUS_FILTERS = new Set(['ok', 'error', 'denied'])
// #4323: the refusal population IS the refused population — `refused` is the
// facet's one value (the deep link's `status=refused`), and there is nothing
// else to narrow to. Any other value is a client bug, same as above.
const REFUSAL_STATUS_FILTERS = new Set(['refused'])

/**
 * ISO bounds: a date (`2026-07-10`) or a full date-time with zone/offset.
 * `from` is inclusive, `to` exclusive — the caller passes the window's end as
 * the next window's start, so adjacent periods tile without overlap. The
 * regex keeps a lenient-but-not-ISO string away from Postgres's timestamptz
 * cast (a cast error would surface as a 500, not the 400 it deserves).
 */
const ISO_BOUND_RE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/

function parseIsoBound(value: string | undefined): string | null | 'invalid' {
  if (value === undefined) return null
  if (!ISO_BOUND_RE.test(value) || Number.isNaN(Date.parse(value))) return 'invalid'
  return value
}

/**
 * The one payment-entry builder the per-agent paths share, so the kinded read
 * and the legacy merged read emit IDENTICAL rows. The feed route keeps its
 * own agent-labelled copy — its extra fields are its own wire contract.
 */
function toPaymentEntry(
  p: ActivityPaymentRow,
  approxAmount: Awaited<ReturnType<typeof serveTimeAmount>>,
  currency: TransactionCurrency,
) {
  const lifecycle = machinePaymentLifecycle({
    rail: p.source,
    paymentStatus: p.status,
    paymentProofStatus: p.payment_proof_status,
    reconciliationEventType: p.payment_reconciliation_event_type,
  })

  return ({
    type: 'payment' as const,
    id: p.id,
    token: p.token_symbol,
    amount_raw: p.amount_raw,
    amount: p.amount_human,
    // #3824: the serve-time amount in `approx_currency` (the user's
    // preference), null when the token has no usable quote — never 0.
    approx_amount: approxAmount,
    approx_currency: currency,
    to: toCanonicalAddress(p.to_address),
    status: p.status,
    // #3763: `tx_hash` keeps its FUNDING meaning (Haven's sponsored
    // UserOp, account → delegate). The merchant's settlement travels
    // beside it, named, when one is recorded — and `explorer_url`
    // headlines it: the merchant names the settlement, so the
    // activity feed links the SAME transaction the merchant shows,
    // falling back to the funding leg when nothing is recorded.
    tx_hash: p.tx_hash,
    funding_tx_hash: p.tx_hash,
    settlement_tx_hash: p.settlement_tx_hash,
    settlement_scheme: p.settlement_scheme,
    payment_id: p.id,
    payment_proof_status: p.payment_proof_status,
    payment_flow_status: lifecycle.paymentFlowStatus,
    payment_attention_reason: lifecycle.paymentAttentionReason,
    source: p.source ?? 'direct',
    x402_resource_url: p.x402_resource_url,
    x402_merchant_address: toCanonicalAddress(p.x402_merchant_address),
    // #3778: the non-secret delivery pointer, when one was reported —
    // the owner's "a deliverable exists" signal on the activity row.
    delivery_reference: p.delivery_reference ?? null,
    chain_id: p.chain_id,
    token_address: toCanonicalAddress(p.token_address),
    account_id: p.account_id,
    account_address: toCanonicalAddress(p.account_address),
    account_name: p.account_name,
    // #3763: headlines the settlement when one is recorded, else the
    // funding leg. Null exactly when both are null — for a payment
    // row that means tx_hash is null (settlement implies a confirmed
    // funding), which keeps the spec's "null when no transaction"
    // contract honest under its new wording.
    explorer_url: (p.settlement_tx_hash ?? p.tx_hash)
      ? getExplorerUrl(p.chain_id, 'tx', (p.settlement_tx_hash ?? p.tx_hash) as string)
      : null,
    // #799: which on-chain mechanism moved the money, and (session rail)
    // WHICH period-session the intent was pinned to — makes the #769
    // lazy rollover observable to the owner without DB access.
    execution_rail: p.execution_rail,
    // #829: which delegation authorized a delegation-rail payment.
    delegation_hash: p.delegation_hash,
    confirmed_at: p.confirmed_at,
    created_at: p.created_at,
  })
}

/** The one tool-call-entry builder, shared by both per-agent reads. */
function toToolCallEntry(inv: AgentToolInvocationRow) {
  return {
    type: 'mcp_tool_call' as const,
    id: inv.id,
    tool_name: inv.tool_name,
    payment_id: inv.payment_id,
    result_status: inv.result_status,
    next_action: inv.next_action,
    error_code: inv.error_code,
    status_code: inv.status_code,
    created_at: inv.created_at,
  }
}

/**
 * Normalizes the query's optional filters into the repository shape: the UI's
 * `sent` is `payment_intents`' `confirmed`, whitespace around `q` is not
 * part of the search term, and an empty string filters nothing.
 */

/**
 * The one refusal-entry builder for the kinded read (#4323).
 *
 * `amount` is ATOMIC on the wire — the reviewer's contract — and the renderer
 * derives the human amount from the shared registry's decimals
 * (`core/chains`, the same source `humanAmount` reads). The serve-time fiat
 * triple, by contrast, is struck HERE from the human amount, so both views of
 * one refusal come from one conversion, never two.
 */
function toRefusalEntry(r: AgentRefusalRow): Promise<Record<string, unknown>> {
  return serveTimeAmountTriple(r.token_symbol, humanTokenAmount(r.chain_id, r.token_symbol, r.amount_atomic)).then(
    (approx) => ({
      type: 'refusal' as const,
      id: r.id,
      created_at: r.created_at,
      // Atomic, deliberately unscaled here: `formatTokenValue` on the client
      // (via the registry) is the one humanizer, as for the budget surfaces.
      amount: r.amount_atomic,
      token_symbol: r.token_symbol,
      chain_id: r.chain_id,
      merchant_to: r.merchant_to,
      resource_url: r.resource_url,
      reason: r.reason,
      attempts: r.attempts,
      // Serve-time fiat in all three currencies (#4323); `sek_value` is not
      // stored, so SEK is serve-time only — null, never 0, on a price outage.
      approx_amount_usd: approx.usd,
      approx_amount_eur: approx.eur,
      approx_amount_sek: approx.sek,
    }),
  )
}

/**
 * Normalizes the query's optional filters into the repository shape: the UI's
 * `sent` is `payment_intents`' `confirmed`, whitespace around `q` is not
 * part of the search term, and an empty string filters nothing.
 */
function paymentFilter(query: Record<string, string>): AgentPaymentActivityFilter {
  const rawStatus = query.status ?? null
  return {
    status: rawStatus === 'sent' ? 'confirmed' : rawStatus,
    rails: Array.from(MACHINE_PAYMENT_RAILS),
    from: query.from ?? null,
    to: query.to ?? null,
    q: query.q?.trim() ? query.q.trim() : null,
    paymentId: query.paymentId ?? null,
    // #4226: the Activity tab's Token facet — an ERC-20 address. A native
    // token is not a payment rail here (budgets are metered per ERC-20), so
    // an address is the whole vocabulary; anything else matches nothing.
    token: query.token?.trim() ? query.token.trim() : null,
  }
}

function toolCallFilter(query: Record<string, string>): AgentToolInvocationFilter {
  return {
    status: query.status ?? null,
    from: query.from ?? null,
    to: query.to ?? null,
    q: query.q?.trim() ? query.q.trim() : null,
    paymentId: query.paymentId ?? null,
  }
}

export default async function agentActivityRoutes(
  app: FastifyInstance,
  options: AgentActivityRouteOptions = {},
): Promise<void> {
  app.addHook('onRequest', authMiddleware)
  // The injectable clock (#3977): every "today" bound derives from this one
  // instant, so a test can pin the whole window without freezing global time.
  const now = options.now ?? (() => new Date())

  // GET /agent-activity/:id/activity — paginated payment + MCP tool-call
  // history (#2055: the approval half is gone with the table).
  // #4229: WITH `kind` the route serves ONE population — filtered by
  // `status`/`from`/`to`/`q`/`paymentId` (and `token`, #4226's Activity-tab
  // facet, payments only), paged by `limit`/`offset`, and
  // measured (`total`/`hasMore`, plus `counts.error` for tool calls). WITHOUT
  // `kind` it serves today's merged window untouched: both sources each
  // capped at `limit`, one `offset` walking both, no total — filters are
  // ignored there, so the legacy shape is byte-identical for legacy callers.
  app.get<{
    Params: { id: string }
    Querystring: {
      limit?: string
      offset?: string
      kind?: string
      status?: string
      from?: string
      to?: string
      q?: string
      paymentId?: string
      token?: string
    }
  }>('/:id/activity', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params
    const query = request.query as Record<string, string>
    const limit = Math.min(Number(query.limit) || 30, 100)
    const offset = Number(query.offset) || 0

    // Verify agent belongs to user
    if (!(await agentExistsForUser(id, sub))) {
      return reply.code(404).send({ error: 'Agent not found' })
    }

    const kind =
      query.kind === 'payments'
        ? 'payments'
        : query.kind === 'tool_calls'
          ? 'tool_calls'
          : query.kind === 'refusals'
            ? 'refusals'
            : undefined

    if (kind) {
      // A `status` value from the OTHER kind's vocabulary is a client bug —
      // answer 400 rather than silently serving an unfiltered population.
      const status = query.status ?? null
      const allowedStatuses =
        kind === 'payments'
          ? PAYMENT_STATUS_FILTERS
          : kind === 'refusals'
            ? REFUSAL_STATUS_FILTERS
            : TOOL_CALL_STATUS_FILTERS
      if (status && !allowedStatuses.has(status)) {
        return reply.code(400).send({ error: `status ${status} does not apply to kind ${kind}` })
      }
      const from = parseIsoBound(query.from)
      const to = parseIsoBound(query.to)
      if (from === 'invalid' || to === 'invalid') {
        return reply.code(400).send({ error: 'invalid period bound' })
      }

      // #3824: the approx amounts are struck in the user's preferred currency —
      // one read per request, same as the legacy read.
      const currency = await approxCurrencyFor(sub)

      if (kind === 'refusals') {
        // #4323: the refusal population. `refused` is the only status value it
        // takes (checked above); the filters are the shared ISO bounds and the
        // `q` search over the refusal's two merchant-naming columns. The fiat
        // is serve-time (all three currencies), so the preference read above
        // is not consumed here — it stays for the payments arm.
        const filter: AgentRefusalActivityFilter = {
          from: query.from ?? null,
          to: query.to ?? null,
          q: query.q?.trim() ? query.q.trim() : null,
        }
        const [rows, total] = await Promise.all([
          listAgentRefusalsFiltered(id, filter, limit, offset),
          countAgentRefusalsFiltered(id, filter),
        ])
        const activity = await Promise.all(rows.map(toRefusalEntry))
        return { activity, total, hasMore: offset + activity.length < total }
      }

      if (kind === 'payments') {
        const filter = paymentFilter(query)
        const [rows, total] = await Promise.all([
          listAgentPaymentsFiltered(id, filter, limit, offset),
          countAgentPaymentsFiltered(id, filter),
        ])
        const approxAmounts = await Promise.all(
          rows.map((p) => serveTimeAmount(p.token_symbol, p.amount_human, currency)),
        )
        const activity = rows.map((p, i) => toPaymentEntry(p, approxAmounts[i], currency))
        return { activity, total, hasMore: offset + activity.length < total }
      }

      const filter = toolCallFilter(query)
      const [rows, counts] = await Promise.all([
        listToolInvocationsForAgentFiltered(id, filter, limit, offset),
        countToolInvocationsForAgentFiltered(id, filter),
      ])
      return {
        activity: rows.map(toToolCallEntry),
        total: counts.total,
        hasMore: offset + rows.length < counts.total,
        // The summary-line number: counted WITHOUT the status filter, so it
        // stays stable while the caller flips the status selection.
        counts: { error: counts.errorCount },
      }
    }

    // #3824: the approx amounts are struck in the user's preferred currency —
    // the preference the feed never read before (the /transactions route and
    // the dashboard have read it since #3127). One read per request.
    const currency = await approxCurrencyFor(sub)

    // Fetch payments
    const payments = await listAgentPayments(id, limit, offset)

    // #2055: the approval-request feed entries are gone with the table —
    // queue history is waived (owner decision on #2021); the activity feed is
    // payments + tool invocations now.
    // Fetch MCP tool invocations (audit log)
    const invocations = await listToolInvocationsForAgent(id, limit, offset)

    // #3824: a serve-time amount at today's rate for every payment row —
    // null, never 0, when the token has no usable quote (`serve-time.ts`).
    // The activity rows carry token amounts only; this is their only fiat.
    const approxAmounts = await Promise.all(
      payments.map((p) => serveTimeAmount(p.token_symbol, p.amount_human, currency)),
    )

    // Merge and sort by created_at desc
    const activity = [
      ...payments.map((p, i) => toPaymentEntry(p, approxAmounts[i], currency)),
      ...invocations.map((inv) => toToolCallEntry(inv)),
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    return { activity }
  })

  // GET /agents/:id/stats — spending stats for an agent
  app.get<{ Params: { id: string }; Querystring: { tz?: string } }>(
    '/:id/stats',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params

      // #3977: "today" is the USER's local day, so the caller names the zone —
      // validated exactly as the dashboard validates its `tz`: an invalid zone
      // is a 400, before any read. Default UTC, same as the dashboard (the
      // spec declares the parameter, so an off-spec `tz` shape never reaches
      // the handler under the request-validation plugin).
      const tz = request.query.tz ?? 'UTC'
      if (!isValidActivityTimeZone(tz)) {
        // Never echo the raw query value (same reasoning as the dashboard's
        // 400 body): an offset/abbreviation reflected verbatim is exactly the
        // instrument analytics refuses to be.
        return reply.code(400).send({ error: 'unsupported tz' })
      }

      // Verify agent belongs to user
      if (!(await agentExistsForUser(id, sub))) {
        return reply.code(404).send({ error: 'Agent not found' })
      }

      // Total spent per token (confirmed only)
      const totals = await sumAgentSpendAllTime(id)

      // Spent today per token — "today" is the CALLER's local day: the bounds
      // are derived from the route's clock in the validated zone and passed
      // as SQL parameters, so nothing here leans on the database session's
      // time zone (`CURRENT_DATE` before #3977 read the server default). The
      // window counts on `confirmed_at`, the same column the dashboard's
      // spend windows count (#3803 §4).
      const { startIso, endIso } = localDayBounds(now().getTime(), tz)
      const todayTotals = await sumAgentSpendToday(id, startIso, endIso)

      // #2055: pending approvals are structurally zero — the queue died with
      // the AllowanceModule rail; the wire field survives for compatibility.
      const pendingApprovals = 0

      return {
        all_time: totals.map((r) => ({
          token: r.token_symbol,
          total_spent: r.total_spent,
          tx_count: Number(r.tx_count),
        })),
        today: todayTotals.map((r) => ({
          token: r.token_symbol,
          total_spent: r.total_spent,
          tx_count: Number(r.tx_count),
        })),
        pending_approvals: pendingApprovals,
      }
    },
  )

  // GET /agent-activity/feed — all agents combined activity feed
  app.get<{
    Querystring: { limit?: string; offset?: string }
  }>('/feed', async (request) => {
    const { sub } = request.user as { sub: string }
    const limit = Math.min(Number((request.query as Record<string, string>).limit) || 30, 100)
    const offset = Number((request.query as Record<string, string>).offset) || 0

    // All user's agents
    const agentRows = await listAgentNamesForUser(sub)
    const agentNames = new Map(agentRows.map((a) => [a.id, a.name]))
    const agentIds = agentRows.map((a) => a.id)

    if (agentIds.length === 0) {
      return { activity: [], pending_approvals: 0 }
    }

    // Recent payments across all agents
    const payments = await listFeedPayments(agentIds, limit, offset)

    // Recent approval requests
    // #2055: approval feed entries died with the table (see the per-agent
    // handler above).

    // Recent MCP tool invocations (audit log)
    const invocations = await listToolInvocationsForAgents(agentIds, limit, offset)

    // #3824: the approx amounts are struck in the user's preferred currency —
    // the preference the feed never read before (the /transactions route and
    // the dashboard have read it since #3127). One read per request.
    const currency = await approxCurrencyFor(sub)
    // Serve-time amounts for the payment rows — null, never 0, when the
    // token has no usable quote (`serve-time.ts`).
    const approxAmounts = await Promise.all(
      payments.map((p) => serveTimeAmount(p.token_symbol, p.amount_human, currency)),
    )

    // Merge and sort
    const activity = [
      ...payments.map((p, i) => {
        const lifecycle = machinePaymentLifecycle({
          rail: p.source,
          paymentStatus: p.status,
          paymentProofStatus: p.payment_proof_status,
          reconciliationEventType: p.payment_reconciliation_event_type,
        })

        return ({
          type: 'payment' as const,
          id: p.id,
          agent_id: p.agent_id,
          agent_name: agentNames.get(p.agent_id) ?? 'Unknown',
          token: p.token_symbol,
          amount_raw: p.amount_raw,
          amount: p.amount_human,
          // #3824: the serve-time amount in `approx_currency` (the user's
          // preference), null when the token has no usable quote — never 0.
          approx_amount: approxAmounts[i],
          approx_currency: currency,
          to: toCanonicalAddress(p.to_address),
          status: p.status,
          // #3763: `tx_hash` keeps its FUNDING meaning (Haven's sponsored
          // UserOp, account → delegate). The merchant's settlement travels
          // beside it, named, when one is recorded — see the per-agent
          // handler above for the explorer_url headline rule.
          tx_hash: p.tx_hash,
          funding_tx_hash: p.tx_hash,
          settlement_tx_hash: p.settlement_tx_hash,
          settlement_scheme: p.settlement_scheme,
          payment_id: p.id,
          payment_proof_status: p.payment_proof_status,
          payment_flow_status: lifecycle.paymentFlowStatus,
          payment_attention_reason: lifecycle.paymentAttentionReason,
          source: p.source ?? 'direct',
          x402_resource_url: p.x402_resource_url,
          x402_merchant_address: toCanonicalAddress(p.x402_merchant_address),
          // #3778: the non-secret delivery pointer, when one was reported —
          // the owner's "a deliverable exists" signal on the activity row.
          delivery_reference: p.delivery_reference ?? null,
          chain_id: p.chain_id,
          token_address: toCanonicalAddress(p.token_address),
          account_id: p.account_id,
          account_address: toCanonicalAddress(p.account_address),
          account_name: p.account_name,
          // #3763: headlines the settlement when one is recorded, else the
          // funding leg. Null exactly when both are null — for a payment
          // row that means tx_hash is null (settlement implies a confirmed
          // funding), which keeps the spec's "null when no transaction"
          // contract honest under its new wording.
          explorer_url: (p.settlement_tx_hash ?? p.tx_hash)
            ? getExplorerUrl(p.chain_id, 'tx', (p.settlement_tx_hash ?? p.tx_hash) as string)
            : null,
          // #799: which on-chain mechanism moved the money, and (session rail)
          // WHICH period-session the intent was pinned to — makes the #769
          // lazy rollover observable to the owner without DB access.
          execution_rail: p.execution_rail,
          // #829: which delegation authorized a delegation-rail payment.
          delegation_hash: p.delegation_hash,
          confirmed_at: p.confirmed_at,
          created_at: p.created_at,
        })
      }),
      ...invocations.map((inv) => ({
        type: 'mcp_tool_call' as const,
        id: inv.id,
        agent_id: inv.agent_id,
        agent_name: agentNames.get(inv.agent_id) ?? 'Unknown',
        tool_name: inv.tool_name,
        payment_id: inv.payment_id,
        result_status: inv.result_status,
        next_action: inv.next_action,
        error_code: inv.error_code,
        status_code: inv.status_code,
        created_at: inv.created_at,
      })),
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
     .slice(0, limit)

    // #2055: structurally zero — the approval queue died with the
    // AllowanceModule rail; the wire field survives for compatibility.
    const pendingApprovals = 0

    return {
      activity,
      pending_approvals: pendingApprovals,
    }
  })
}
