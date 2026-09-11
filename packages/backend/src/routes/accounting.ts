import { FastifyInstance } from 'fastify'
// dep-lint-exempt: 3 BAS-mapping statements (settings read + upserts) awaiting a bookkeeping-settings repository — verbatim move deferred under #999's ~100-line fix-or-waive budget
import pool from '../db.js'
import { config } from '../config.js'
import { authMiddleware } from '../middleware/auth.js'
import { buildAccountingEntries, FortnoxError, getValidFortnoxAccessToken } from '../modules/accounting/index.js'
import { sieExporter } from '../modules/accounting/legacy/index.js'
// dep-lint-exempt: `legacy/index.ts` is deliberately NOT re-exported from the
// accounting module's public entry point (#2859) — that is the whole point of
// the split: the non-asserting feed must not be able to reach the asserting
// #462 code, and `__tests__/legacy-import-guard.test.ts` fails if it does. A
// deep import is therefore the ONLY way in, and these three dark legacy routes
// (`HAVEN_LEGACY_BOOKKEEPING_ENABLED`) are the only sanctioned consumers.
import { pushVoucher, reconcileEntries, toFortnoxVoucher } from '../modules/accounting/legacy/index.js'

interface ExportQuery {
  format?: string
  from?: string
  to?: string
  company?: string
}

interface PeriodQuery {
  from?: string
  to?: string
}

interface OverrideBody {
  resourceUrl?: string
  account?: string
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/
const BAS_ACCOUNT_RE = /^\d{3,6}$/

/**
 * Bookkeeping export (epic #462, P1 #464). Builds the canonical accounting
 * entries for the signed-in user over a period and serialises them with the
 * requested exporter. Read-only over settled-payment data — no custody surface.
 */
export default async function accountingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // GET /accounting/export?format=sie&from=&to=&company=
  app.get<{ Querystring: ExportQuery }>('/export', async (request, reply) => {
    // Legacy asserting surface — gated off by default, superseded by the
    // non-asserting reporting feed (#491/#492).
    if (!config.legacyBookkeepingEnabled) {
      return reply.code(410).send({
        error: 'SIE export is no longer available. Agent spend now syncs into your accounting tool as draft transactions.',
      })
    }
    const { sub } = request.user as { sub: string }
    const { format = 'sie', from, to, company } = request.query

    if (format !== 'sie') {
      return reply.code(400).send({ error: `Unsupported export format: ${format}` })
    }
    if (from && !ISO_DATE_RE.test(from)) {
      return reply.code(400).send({ error: 'Invalid "from" date (expected ISO)' })
    }
    if (to && !ISO_DATE_RE.test(to)) {
      return reply.code(400).send({ error: 'Invalid "to" date (expected ISO)' })
    }

    const entries = await buildAccountingEntries({ userId: sub, from, to })
    const result = sieExporter.export(entries, { companyName: company?.trim() || 'Haven' })

    return reply
      .header('Content-Type', result.mimeType)
      .header('Content-Disposition', `attachment; filename="${result.filename}"`)
      .header('X-Export-Entry-Count', String(result.entryCount))
      .header('X-Export-Skipped', String(result.skipped))
      .send(result.content)
  })

  // GET /accounting/reconcile?from=&to= — surface entries that can't book cleanly
  app.get<{ Querystring: PeriodQuery }>('/reconcile', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { from, to } = request.query
    if (from && !ISO_DATE_RE.test(from)) return reply.code(400).send({ error: 'Invalid "from" date (expected ISO)' })
    if (to && !ISO_DATE_RE.test(to)) return reply.code(400).send({ error: 'Invalid "to" date (expected ISO)' })
    const entries = await buildAccountingEntries({ userId: sub, from, to })
    return reconcileEntries(entries)
  })

  // GET /accounting/categories — the user's per-merchant BAS account overrides
  app.get('/categories', async (request) => {
    const { sub } = request.user as { sub: string }
    const result = await pool.query<{ resource_url: string; bas_account: string }>(
      `SELECT resource_url, bas_account FROM merchant_account_overrides
       WHERE user_id = $1 ORDER BY resource_url`,
      [sub],
    )
    return { overrides: result.rows }
  })

  // PUT /accounting/categories — set the BAS account for a merchant
  app.put<{ Body: OverrideBody }>('/categories', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const resourceUrl = request.body?.resourceUrl?.trim()
    const account = request.body?.account?.trim()
    if (!resourceUrl) return reply.code(400).send({ error: 'resourceUrl is required' })
    if (!account || !BAS_ACCOUNT_RE.test(account)) {
      return reply.code(400).send({ error: 'account must be a BAS account number' })
    }
    await pool.query(
      `INSERT INTO merchant_account_overrides (user_id, resource_url, bas_account, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, resource_url)
       DO UPDATE SET bas_account = EXCLUDED.bas_account, updated_at = NOW()`,
      [sub, resourceUrl, account],
    )
    return { resourceUrl, account }
  })

  // DELETE /accounting/categories?resourceUrl= — clear an override
  app.delete<{ Querystring: { resourceUrl?: string } }>('/categories', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const resourceUrl = request.query.resourceUrl?.trim()
    if (!resourceUrl) return reply.code(400).send({ error: 'resourceUrl is required' })
    await pool.query(
      'DELETE FROM merchant_account_overrides WHERE user_id = $1 AND resource_url = $2',
      [sub, resourceUrl],
    )
    return reply.code(204).send()
  })

  // POST /accounting/fortnox/push?from=&to= — the LEGACY asserting voucher
  // push (#462 P2 #465), moved here from `routes/fortnox.ts` when #2862
  // replaced that router with the provider-generic `/accounting/connections`
  // surface. Path, gate and shape are unchanged: it is dark behind
  // `HAVEN_LEGACY_BOOKKEEPING_ENABLED` (410 by default) and provider-specific
  // by nature — it pushes FINISHED Fortnox vouchers, which is exactly what the
  // non-asserting feed moved away from (#491/#492).
  app.post<{ Querystring: PeriodQuery }>('/fortnox/push', async (request, reply) => {
    if (!config.legacyBookkeepingEnabled) {
      return reply.code(410).send({
        error: 'Pushing finished vouchers is disabled. Agent spend now syncs into your accounting tool as draft transactions for your accountant to confirm.',
      })
    }
    const { sub } = request.user as { sub: string }
    const { from, to } = request.query
    if (from && !ISO_DATE_RE.test(from)) return reply.code(400).send({ error: 'Invalid "from" date (expected ISO)' })
    if (to && !ISO_DATE_RE.test(to)) return reply.code(400).send({ error: 'Invalid "to" date (expected ISO)' })

    const accessToken = await getValidFortnoxAccessToken(sub)
    if (!accessToken) return reply.code(400).send({ error: 'Fortnox is not connected. Connect it first.' })

    const entries = await buildAccountingEntries({ userId: sub, from, to })

    let pushed = 0
    let skipped = 0
    const failures: { paymentId: string; error: string }[] = []

    for (const entry of entries) {
      const voucher = toFortnoxVoucher(entry)
      if (!voucher) {
        skipped += 1 // no book-time SEK — unbookable
        continue
      }
      try {
        await pushVoucher(accessToken, voucher)
        pushed += 1
      } catch (err) {
        failures.push({
          paymentId: entry.paymentId,
          error: err instanceof FortnoxError ? err.message : String(err),
        })
      }
    }

    return reply.send({ pushed, skipped, failed: failures.length, failures })
  })
}
