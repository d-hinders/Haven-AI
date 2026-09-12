import { FastifyRequest, FastifyReply } from 'fastify'
import { config } from '../config.js'
import { accountingFeedAvailable } from '../modules/agents/index.js'

/**
 * Gate the reporting-feed routes (epic #491). Register AFTER the auth hook so
 * `request.user` is set. Returns 404 (not 403) when the feed is unavailable —
 * we don't advertise a paid feature to accounts that don't have it.
 */
export async function requireAccountingFeed(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const sub = (request.user as { sub?: string } | undefined)?.sub
  if (!sub || !(await accountingFeedAvailable(sub))) {
    reply.code(404).send({ error: 'Not found' })
  }
}

/**
 * Gate the connection routes (#2862, epic #2858) on the deployment shape
 * alone — `config.hosted && config.accountingEnabled` — never the account
 * entitlement. #2861 decided entitlement guards the FEED (reading data out),
 * not connecting (writing a grant in): an unentitled account on a hosted,
 * enabled deployment can still connect, activate and backfill so upgrading
 * later needs no reconnect. Same 404 body shape as `requireAccountingFeed`
 * (issue #2918) — a deployment with the feature off does not advertise it by
 * answering differently.
 */
export async function requireAccountingFeature(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!config.hosted || !config.accountingEnabled) {
    reply.code(404).send({ error: 'Not found' })
  }
}
