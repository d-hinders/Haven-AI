import type { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import {
  queryFunnel,
  queryFunnelSegments,
  type FunnelSegment,
} from '../infra/repositories/onboarding-funnel.js'

export default async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  // GET /analytics/funnel?from=YYYY-MM-DD&to=YYYY-MM-DD[&segment=via|run_mode]
  // Requires dashboard JWT. Returns step-conversion counts and median TTFP,
  // and — when `segment` is given (#2529) — the same steps split by that
  // dimension so the agent-driven funnel can be read against the rest.
  // `segment` is typed as the enum the spec enforces (#3030): the module is
  // in `enforcedModules`, so a value outside it never reaches this handler.
  app.get<{ Querystring: { from?: string; to?: string; segment?: FunnelSegment } }>(
    '/funnel',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const { from: fromStr, to: toStr, segment } = request.query

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

      // An unknown `segment` is refused rather than ignored (a silently
      // dropped dimension would hand a misspelling caller a real, unsegmented
      // funnel and let it believe it is the segmented one). Since #3030 the
      // refusal is the spec's: the enforced module answers the 400 envelope
      // for anything outside the `segment` enum, and the test suite pins
      // that enum to `FUNNEL_SEGMENTS` so the two cannot drift apart.

      const { steps, medianTtfpMs } = await queryFunnel(from, to)
      const body = { steps, medianTtfpMs, from: from.toISOString(), to: to.toISOString() }

      if (segment === undefined) return body
      return { ...body, segment, segments: await queryFunnelSegments(from, to, segment) }
    },
  )
}
