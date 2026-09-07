import type { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import {
  queryFunnel,
  queryFunnelSegments,
  isFunnelSegment,
  FUNNEL_SEGMENTS,
} from '../infra/repositories/onboarding-funnel.js'

export default async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  // GET /analytics/funnel?from=YYYY-MM-DD&to=YYYY-MM-DD[&segment=via|run_mode]
  // Requires dashboard JWT. Returns step-conversion counts and median TTFP,
  // and — when `segment` is given (#2529) — the same steps split by that
  // dimension so the agent-driven funnel can be read against the rest.
  app.get<{ Querystring: { from?: string; to?: string; segment?: string } }>(
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

      // Refused rather than ignored. A silently dropped `segment` returns a
      // well-formed unsegmented body, so a caller that misspells the
      // dimension reads a real funnel and believes it is the segmented one —
      // the failure mode is a wrong conclusion, not a visible error.
      if (segment !== undefined && !isFunnelSegment(segment)) {
        return reply.code(400).send({
          error: `Unknown segment — expected one of: ${Object.keys(FUNNEL_SEGMENTS).join(', ')}`,
        })
      }

      const { steps, medianTtfpMs } = await queryFunnel(from, to)
      const body = { steps, medianTtfpMs, from: from.toISOString(), to: to.toISOString() }

      if (segment === undefined) return body
      return { ...body, segment, segments: await queryFunnelSegments(from, to, segment) }
    },
  )
}
