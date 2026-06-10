import type { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { queryFunnel } from '../lib/onboarding-funnel.js'

export default async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  // GET /analytics/funnel?from=YYYY-MM-DD&to=YYYY-MM-DD
  // Requires dashboard JWT. Returns step-conversion counts and median TTFP.
  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/funnel',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const { from: fromStr, to: toStr } = request.query

      const to = toStr ? new Date(toStr) : new Date()
      const from = fromStr
        ? new Date(fromStr)
        : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000)

      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return reply.code(400).send({ error: 'Invalid date range' })
      }
      if (from >= to) {
        return reply.code(400).send({ error: 'from must be before to' })
      }

      const { steps, medianTtfpMs } = await queryFunnel(from, to)
      return { steps, medianTtfpMs, from: from.toISOString(), to: to.toISOString() }
    },
  )
}
