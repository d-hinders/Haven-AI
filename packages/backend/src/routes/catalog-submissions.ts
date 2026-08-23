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
 *   5. body-size ceiling (`MAX_BODY_BYTES`) — the public path does not accept
 *      Fastify's 1 MB default;
 *   6. input normalization — https-only, length caps, and embedded
 *      credentials refused rather than stored.
 *
 * A queued row is INERT. It is a claim, not a fact: nothing in this slice
 * grants a submission any standing, and nothing here reads a row back out to
 * a public surface. `GET /catalog` is untouched.
 *
 * ## What this slice does NOT defend against (stated, not silently absent)
 *
 * - **Full SSRF host classification.** Only the cheapest junk is refused here
 *   (localhost, loopback, link-local, unspecified, IPv4-mapped forms of the
 *   same). RFC1918 literals — `https://10.0.0.5/x` — are ACCEPTED into the
 *   queue. That is deliberate: hostname-shaped blocking at submit time is
 *   cosmetic, because a perfectly public name can resolve to a private
 *   address, and resolving it here would be the outbound request this slice
 *   is forbidden to make. The real gate belongs where the fetch happens, on
 *   the resolved address, in #1712/#1713. A stored private-range row is
 *   harmless precisely because nothing in this slice ever dials it.
 * - **Per-IP fairness inside the queue cap.** The cap is global, so an
 *   attacker spread across many source addresses can fill the pending set to
 *   `QUEUE_CAP` with junk hostnames and make legitimate merchants see 429
 *   until #1714's lifecycle expires those rows. Bounded and self-healing, but
 *   real: a per-subnet quota within the cap is the fix if it is ever observed.
 * - **The rate limit when the deployment does not trust its proxy.** The tier
 *   self-disarms without `TRUST_PROXY_HOPS` (#1670), because a per-IP limit
 *   keyed on a proxy's own address is a shared-bucket DoS on every client.
 *   Disarmed, layers 3-6 carry the endpoint alone.
 * - **Anything about the merchant's honesty.** Verification catches broken
 *   endpoints, never dishonest ones.
 *
 * Heavier controls ride on later slices: the `verify_token` + well-known-file
 * ownership proof (#1712) is the single load-bearing anti-abuse gate (it
 * collapses the "Haven as DDoS cannon" vector — an attacker cannot enroll a
 * victim's domain), and the probe's SSRF hardening lands with the probe
 * (#1713).
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
/** Request-body ceiling for the public submit path (Fastify defaults to 1 MB). */
const MAX_BODY_BYTES = 8 * 1024

/** A plausible-looking field bots tend to autofill; humans leave it empty. */
interface SubmitBody {
  resource_url?: unknown
  /** Honeypot. Presence + non-empty → bot, dropped with a fake success. */
  website?: unknown
}

/** 127/8 loopback, 0/8 unspecified, 169.254/16 link-local (metadata service). */
function isLocallyBoundIpv4(ip: string): boolean {
  const octets = ip.split('.').map(Number)
  if (octets[0] === 127 || octets[0] === 0) return true
  // Narrowly 169.254/16 — the metadata range. NOT all of 169/8, which is
  // ordinary public address space (169.99.99.99 is a legitimate merchant).
  return octets[0] === 169 && octets[1] === 254
}

/**
 * The IPv4 address embedded in an IPv4-mapped IPv6 literal, else `null`.
 *
 * This exists because `new URL()` REWRITES the readable form into its
 * compressed hex twin: `https://[::ffff:127.0.0.1]/` arrives as
 * `[::ffff:7f00:1]`, which matches none of the textual IPv6 prefixes below.
 * Without this, `::ffff:127.0.0.1` walked straight past the loopback filter —
 * proven by the mutation test that removes this call.
 */
function mappedIpv4(lower: string): string | null {
  const match = /^::(?:ffff:)?([0-9a-f.:]+)$/.exec(lower)
  if (!match) return null
  const tail = match[1]
  if (isIP(tail) === 4) return tail // ::ffff:127.0.0.1, if ever seen unnormalized
  const groups = tail.split(':')
  if (groups.length !== 2) return null
  const high = Number.parseInt(groups[0], 16)
  const low = Number.parseInt(groups[1], 16)
  if (!Number.isInteger(high) || !Number.isInteger(low)) return null
  if (high > 0xffff || low > 0xffff || high < 0 || low < 0) return null
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
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
    return isLocallyBoundIpv4(ipCandidate)
  }
  if (version === 6) {
    const lower = ipCandidate.toLowerCase()
    const mapped = mappedIpv4(lower)
    if (mapped) return isLocallyBoundIpv4(mapped)
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
  // Reject embedded credentials rather than storing them. Two distinct harms,
  // both of which would otherwise be this slice handing a loaded gun to a
  // later one:
  //   1. `https://user:pass@host/` persists a secret in `resource_url` and
  //      would send it as Basic auth the moment #1713's probe fetches the row;
  //   2. `https://attacker.com@victim.com/` reads as attacker.com to a human
  //      skimming the string, while the real host is victim.com — a display
  //      spoof aimed at whoever reviews or renders the queue (#1715).
  if (parsed.username !== '' || parsed.password !== '') {
    return { error: 'resource_url must not contain embedded credentials' }
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
    {
      // A public, unauthenticated endpoint should not accept Fastify's default
      // 1 MB body. The largest legitimate submission is a 2 KB URL plus a
      // couple of short fields, so 8 KB is generous; anything larger is
      // refused (413) before the JSON parser allocates it, which keeps the
      // endpoint from doubling as a cheap memory-amplification target.
      bodyLimit: MAX_BODY_BYTES,
      config: { ...catalogSubmitRateLimit(trustProxyHops) },
    },
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
