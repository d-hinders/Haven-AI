/**
 * Self-service catalogue submission entry point (epic #1717, #1711).
 *
 * Public, unauthenticated `POST /catalog/submit`: writes a queue row and
 * returns `id` + `verify_token`. That is ALL it does — the request path never
 * probes, never fetches, never touches the merchant endpoint. Everything after
 * the write (ownership proof #1712, the SSRF-hardened verification probe
 * #1713, lifecycle #1714) runs async on the leader-locked monitor.
 *
 * The anti-abuse posture, layered so no single gate carries the load:
 *   1. honeypot field — bots that autofill the plausible-looking `website`
 *      field get a fake success and no write;
 *   2. per-IP rate limit (`catalogSubmitRateLimit`) — self-disarming behind an
 *      untrusted proxy, exactly like signup/login (#1670), so a shared proxy
 *      address cannot become a global lockout;
 *   3. per-hostname dedupe — one pending/active submission per host, enforced
 *      as a database invariant (partial unique index, migration 066);
 *   4. capped pending queue — a flood cannot grow the pending set unboundedly.
 *
 * Heavier controls ride on later slices: the `verify_token` + well-known-file
 * ownership proof (#1712) is the single load-bearing anti-abuse gate (it
 * collapses the "Haven as DDoS cannon" vector — an attacker cannot enroll a
 * victim's domain), and the probe's SSRF hardening lands with the probe
 * (#1713). This slice deliberately does NOT attempt full SSRF host
 * classification; it blocks only the cheapest junk (localhost, loopback,
 * link-local, unspecified literals). RFC1918/private ranges are rejected by
 * the SI2/SI3 fetch hardening where the outbound request actually happens.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import {
  countPendingCatalogSubmissions,
  findPendingCatalogSubmissionByHost,
  insertCatalogSubmission,
} from '../infra/repositories/catalog-submissions.js'
import { catalogSubmitRateLimit } from '../middleware/rate-limit.js'

/** Pending-queue ceiling — a flood cannot grow the pending set past this. */
const QUEUE_CAP = 500
const MAX_RESOURCE_URL_LENGTH = 2048
const MAX_HOSTNAME_LENGTH = 253

/** A plausible-looking field bots tend to autofill; humans leave it empty. */
interface SubmitBody {
  resource_url?: unknown
  /** Honeypot. Presence + non-empty → bot, dropped with a fake success. */
  website?: unknown
}

/**
 * Cheap syntactic junk filter only — `localhost`, loopback, link-local and
 * unspecified literals. RFC1918/private-range blocking belongs to the
 * SSRF-hardened fetch in SI2/SI3, where the outbound request actually happens;
 * see the file header.
 */
function isLocallyBoundHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    return true
  }
  // URL.hostname keeps the brackets on IPv6 literals (https://[::1]/ →
  // `[::1]`); node:net's isIP wants the bare address.
  const ipCandidate = hostname.replace(/^\[|\]$/g, '')
  const version = isIP(ipCandidate)
  if (version === 4) {
    const first = Number(ipCandidate.split('.')[0])
    // 127/8 loopback, 0/8 unspecified, 169.254/16 link-local (metadata service).
    return first === 127 || first === 0 || first === 169
  }
  if (version === 6) {
    const lower = ipCandidate.toLowerCase()
    return (
      lower.startsWith('::1') || // loopback
      lower === '::' || // unspecified
      lower.startsWith('fe80') || // link-local
      lower.startsWith('ff') // multicast
    )
  }
  return false
}

function normalizeSubmitTarget(
  raw: unknown,
): { hostname: string; resource_url: string } | { error: string } {
  if (raw === undefined || raw === null) return { error: 'resource_url is required' }
  if (typeof raw !== 'string') return { error: 'resource_url must be a string' }
  const resourceUrl = raw.trim()
  if (!resourceUrl) return { error: 'resource_url is required' }
  if (resourceUrl.length > MAX_RESOURCE_URL_LENGTH) {
    return { error: `resource_url must be ${MAX_RESOURCE_URL_LENGTH} characters or fewer` }
  }

  let parsed: URL
  try {
    parsed = new URL(resourceUrl)
  } catch {
    return { error: 'resource_url must be a valid https URL' }
  }
  if (parsed.protocol !== 'https:') {
    return { error: 'Only https resource_url values are accepted' }
  }

  const hostname = parsed.hostname.toLowerCase()
  if (!hostname || hostname.length > MAX_HOSTNAME_LENGTH) {
    return { error: `resource_url host must be ${MAX_HOSTNAME_LENGTH} characters or fewer` }
  }
  if (isLocallyBoundHost(hostname)) {
    return { error: 'resource_url host must be a public hostname' }
  }

  return { hostname, resource_url: parsed.toString() }
}

export default async function catalogSubmissionRoutes(
  app: FastifyInstance,
  opts: { trustProxyHops?: number } = {},
): Promise<void> {
  // #1711 (mirroring authRoutes #1670): the per-IP tier only arms when the
  // deployment trusts its proxy. Injectable so tests can exercise both states;
  // production callers never pass it and get the environment's value.
  const trustProxyHops = opts.trustProxyHops ?? config.trustProxyHops

  app.post<{ Body: SubmitBody | undefined }>(
    '/submit',
    { config: { ...catalogSubmitRateLimit(trustProxyHops) } },
    async (request, reply) => {
      const body = request.body

      // Honeypot: bots autofill `website`. Fake success, no write — the trap
      // must not teach the bot that the field is watched.
      if (body && typeof body.website === 'string' && body.website.trim() !== '') {
        return reply.code(201).send({
          id: randomUUID(),
          verify_token: randomBytes(24).toString('hex'),
          status: 'submitted',
        })
      }

      const target = normalizeSubmitTarget(body?.resource_url)
      if ('error' in target) {
        return reply.code(400).send({ error: target.error })
      }

      // Dedupe first (AC: same host while pending/active → same id, a no-op),
      // then the queue cap, then the insert. The insert's ON CONFLICT keeps
      // the dedupe airtight under a concurrent first-time submit.
      const existing = await findPendingCatalogSubmissionByHost(target.hostname)
      if (existing) {
        return reply.code(201).send(existing)
      }

      const pending = await countPendingCatalogSubmissions()
      if (pending >= QUEUE_CAP) {
        return reply.code(429).send({ error: 'The submission queue is full, try again later' })
      }

      const created = await insertCatalogSubmission({
        hostname: target.hostname,
        resource_url: target.resource_url,
        submitter_ip: request.ip,
        verify_token: randomBytes(24).toString('hex'),
      })
      if (created) {
        return reply.code(201).send(created)
      }

      // A concurrent first-time submit for the same host won the race; return
      // the winner's handle so both callers observe the same id.
      const winner = await findPendingCatalogSubmissionByHost(target.hostname)
      if (winner) {
        return reply.code(201).send(winner)
      }
      return reply.code(500).send({ error: 'Could not create the submission, try again later' })
    },
  )
}
