/**
 * Self-service catalogue submission entry point (epic #1717, #1711).
 *
 * Public, unauthenticated `POST /catalog/submit`: writes a queue row and
 * returns `id` + `verify_token` (the token only to the caller whose own insert
 * created the row — see `acknowledgement`). That is ALL it does — the path never
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
 *   4. capped pending queue — the ceiling is enforced by a serialised
 *      count-and-insert, not a check-then-act (see the repository);
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
 * - **Transitional IPv6 encodings of a v4 address.** `mappedIpv4` folds the
 *   `::ffff:` form only. NAT64 (`64:ff9b::7f00:1`) and 6to4
 *   (`2002:7f00:1::`) spellings of 127.0.0.1 are accepted. Same class of gap
 *   as the line above and deferred to the same place: those prefixes only
 *   reach the embedded address on a network actually running such a gateway,
 *   whereas `::ffff:` round-trips on any dual-stack host, which is why that
 *   one is folded here and these are not.
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
 * - **Existence of another party's submission.** The de-duplicating response
 *   necessarily reveals that a pending submission exists for a host, and its
 *   coarse status — that is what "same id returned" means, so it cannot be
 *   hidden without dropping the acceptance criterion. What it no longer
 *   reveals is the `verify_token` (see `acknowledgement`).
 *
 * ## No reachability oracle (constraint shared with #1712)
 *
 * Every refusal here describes the CALLER'S OWN INPUT — bad scheme, bad
 * length, a locally-bound literal they themselves typed. None reports whether
 * a host resolves, what address class it resolved to, or whether Haven can
 * reach it, because this slice performs no resolution and no connection at
 * all. That property must survive: #1712's ownership check produces granular
 * refusal reasons (`ipv4-private`, `ipv6-unique-local`, `dns_failure`, …), and
 * surfacing those verbatim to an anonymous submitter would turn a status
 * response into a blind internal-DNS-existence probe — aim a claim at a host
 * you do not own and learn whether Haven's resolver can see it. Whoever adds
 * the status endpoint keeps the granular reason in logs/telemetry and returns
 * a generic "not yet verified" to untrusted callers.
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
  getCatalogSubmission,
  insertCatalogSubmission,
} from '../infra/repositories/catalog-submissions.js'
import {
  ownershipInstructions,
  type OwnershipClaim,
} from '../modules/catalog/ownership.js'
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

/**
 * Ownership-proof instructions for a row, or undefined when the deployment
 * has no `CATALOG_OWNERSHIP_SECRET` (the proof payload cannot be computed and
 * verification is impossible either way; the UI then shows status only).
 *
 * Safe to return to any caller who holds the submission id: the payload is
 * bound to the row's domain via HMAC, so publishing it is the intended action
 * (ownership.ts). The `verify_token` itself is NEVER shipped here.
 */
function instructionsFor(
  row: { id: string; hostname: string; verify_token: string; created_at: string },
  secret: string,
):
  | ReturnType<typeof ownershipInstructions>
  | undefined {
  if (secret === '') return undefined
  const claim: OwnershipClaim = {
    submissionId: row.id,
    hostname: row.hostname,
    verifyToken: row.verify_token,
    tokenIssuedAt: new Date(row.created_at),
  }
  return ownershipInstructions(claim, secret)
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

/**
 * The dedupe response: id + status, and deliberately NO `verify_token`.
 *
 * The token is an ownership-proof credential minted for ONE submitter. Echoing
 * the stored row wholesale would hand it to any anonymous caller who merely
 * names the hostname, and would turn this endpoint into a free oracle for
 * "does a submission exist for X, and how far along is it". Only the caller
 * whose own insert created the row ever sees the token; anyone else gets the
 * handle they need to check status and nothing more.
 */
function acknowledgement(row: { id: string; status: string }): { id: string; status: string } {
  return { id: row.id, status: row.status }
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

  // Strip the FQDN root dot before ANY comparison. `new URL()` preserves it on
  // non-IP hosts, so `https://localhost./x` arrives as the hostname
  // `'localhost.'` — which equals none of the literals below and sailed
  // straight through the locally-bound filter. It is also a dedupe evasion:
  // `example.com.` and `example.com` are the same origin to every resolver but
  // two different strings to a unique index. Canonicalising here fixes both,
  // and is why the stored hostname is the dotless form.
  // `\.+$`, not `\.$`: stripping only one dot leaves `example.com...` as its
  // own distinct stored string. Not exploitable — a name with an internal
  // empty label does not resolve — but airtight costs nothing here.
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '')
  if (!hostname || hostname.length > MAX_HOSTNAME_LENGTH) {
    return { error: `resource_url host must be ${MAX_HOSTNAME_LENGTH} characters or fewer` }
  }
  if (isLocallyBoundHost(hostname)) {
    return { error: 'resource_url host must be a public hostname' }
  }

  // Canonicalise the URL to the same dotless host that is stored and deduped
  // on, so a later slice cannot fetch a spelling this one never checked.
  parsed.hostname = hostname
  return { hostname, resource_url: parsed.toString() }
}

export default async function catalogSubmissionRoutes(
  app: FastifyInstance,
  opts: { trustProxyHops?: number; ownershipSecret?: string } = {},
): Promise<void> {
  // #1711 (mirroring authRoutes #1670): the per-IP tier only arms when the
  // deployment trusts its proxy. Injectable so tests can exercise both states;
  // production callers never pass it and get the environment's value.
  const trustProxyHops = opts.trustProxyHops ?? config.trustProxyHops
  // #1715: the ownership-proof instructions factory needs the HMAC secret.
  // Injectable so tests can exercise the instructions path without mutating
  // the process-wide config.
  const ownershipSecret = opts.ownershipSecret ?? config.catalogOwnershipSecret

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
        return reply.code(201).send(acknowledgement(existing))
      }

      // Cheap pre-check so an already-full queue is refused without opening a
      // transaction. It is NOT the ceiling — the authoritative, serialised one
      // lives inside `insertCatalogSubmission`, because a count read here can
      // be stale by the time the insert runs.
      const pending = await countPendingCatalogSubmissions()
      if (pending >= QUEUE_CAP) {
        return reply.code(429).send({ error: 'The submission queue is full, try again later' })
      }

      const created = await insertCatalogSubmission({
        hostname: target.hostname,
        resource_url: target.resource_url,
        submitter_ip: request.ip,
        verify_token: randomBytes(24).toString('hex'),
        queueCap: QUEUE_CAP,
      })
      // The ONLY response that carries a verify_token: this caller just minted
      // it by creating the row. Ownership-proof instructions come from
      // GET /catalog/submit/:id (they are derivable from the row and must be
      // computable even after a page reload, so they do not belong in the
      // one-shot create response).
      if (created) {
        return reply.code(201).send(created)
      }

      // No row means one of two refusals, told apart by reading the host back.
      // A winner: a concurrent first-time submit for the same host got there
      // first, so both callers observe the same id. No winner: the cap bound.
      const winner = await findPendingCatalogSubmissionByHost(target.hostname)
      if (winner) {
        return reply.code(201).send(acknowledgement(winner))
      }
      return reply.code(429).send({ error: 'The submission queue is full, try again later' })
    },
  )

  // GET /catalog/submit/:id — public submission status (#1715).
  //
  // Coarse current state plus, while the proof is still usable, the
  // ownership instructions. Deliberately minimal:
  //   - the `verify_token` NEVER crosses this wire (it is a credential minted
  //     once at creation — see `acknowledgement`);
  //   - failure reasons are coarse (`status: 'failed'`) with no `detail`,
  //     so the endpoint cannot become the blind internal-DNS oracle that
  //     #1711's header warns about — the granular guard verdicts stay in logs.
  app.get<{ Params: { id: string } }>('/submit/:id', async (request, reply) => {
    const row = await getCatalogSubmission(request.params.id)
    if (!row) {
      return reply.code(404).send({ error: 'Submission not found' })
    }
    const canStillProve = row.status === 'submitted' || row.status === 'ownership_verified'
    const instructions = canStillProve ? instructionsFor(row, ownershipSecret) : undefined
    return {
      id: row.id,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_verified_at: row.last_verified_at,
      name: row.name,
      description: row.description,
      entrypoint: row.entrypoint,
      ...(instructions ? { instructions } : {}),
    }
  })
}
