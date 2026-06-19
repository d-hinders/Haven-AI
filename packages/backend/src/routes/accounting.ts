import { FastifyInstance } from 'fastify'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { buildAccountingEntries } from '../lib/accounting-entry.js'
import { sieExporter } from '../lib/sie-exporter.js'
import { reconcileEntries } from '../lib/reconcile.js'

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
}
