import { FastifyRequest, FastifyReply } from 'fastify'
import { reportingFeedAvailable } from '../lib/entitlements.js'

/**
 * Gate the reporting-feed routes (epic #491). Register AFTER the auth hook so
 * `request.user` is set. Returns 404 (not 403) when the feed is unavailable —
 * we don't advertise a paid feature to accounts that don't have it.
 */
export async function requireReportingFeed(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const sub = (request.user as { sub?: string } | undefined)?.sub
  if (!sub || !(await reportingFeedAvailable(sub))) {
    reply.code(404).send({ error: 'Not found' })
  }
}
