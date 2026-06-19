import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { buildAccountingEntries } from '../lib/accounting-entry.js'
import { sieExporter } from '../lib/sie-exporter.js'

interface ExportQuery {
  format?: string
  from?: string
  to?: string
  company?: string
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/

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
}
