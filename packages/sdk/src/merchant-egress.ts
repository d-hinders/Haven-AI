import { HavenError } from './types.js'

/**
 * #3747: the hosted merchant-egress policy.
 *
 * Hosted Haven sends requests to merchant URLs agents choose. This module is
 * the STRING-LEVEL policy those requests run under when the embedder opts in
 * (`HavenClientConfig.merchantEgress`, set by `createHostedHavenClient`):
 * https only, no IP-literal hosts, no local or internal names, re-checked GET
 * redirects, and per-use budgets (timeouts, a response byte cap enforced
 * WHILE reading — never after buffering).
 *
 * Scope and limits, stated plainly:
 *
 *  - The policy is checked before every request and every redirect hop, but
 *    it is a string check. A public host name whose DNS ANSWER points at
 *    private space is NOT blocked here — that needs the resolution-time
 *    checks parked in #3742–#3744 (owner-accepted residual, 2026-10-07).
 *  - Without `merchantEgress`, NOTHING in the SDK changes: no `redirect:
 *    'manual'`, no body capping, no extra refusals. SDK, local-MCP and
 *    embedder callers keep today's behaviour byte for byte.
 *  - The policy is network policy, not spend control. It never gates a
 *    payment's authority — the on-chain allowance stays the real control
 *    (CASP: off-chain policy is never the spend control).
 */

/** Which merchant use a budget applies to, so each use's timeout is pinnable. */
export type MerchantEgressUse = 'quote' | 'mcpSession' | 'discovery' | 'delivery'

export interface MerchantEgressTimeouts {
  /** Quote probes (`quoteX402`, resume probes) — short. */
  quote?: number
  /** MCP session setup (`initialize`) — short. */
  mcpSession?: number
  /** Discovery fetches — short (the #1271 budget is 5s). */
  discovery?: number
  /** Paid delivery — finite (today's default is 300s). */
  delivery?: number
}

export interface MerchantEgressPolicy {
  /**
   * Refuse a URL before any request (or redirect hop) connects. Throws
   * `MerchantEgressRefusedError` with `beforeRequest: true`; the transport
   * re-marks hop-time refusals as mid-flight.
   */
  assertUrl(url: string): void
  /**
   * Response byte cap, enforced while the body is being read (the stream
   * errors mid-read) — never by buffering first. `undefined` = no cap.
   */
  maxResponseBytes?: number
  /**
   * How many GET redirects may be followed; EVERY hop is re-asserted against
   * `assertUrl` before it connects. A redirect on any other method is
   * refused outright. `undefined` = no redirect following.
   */
  maxGetRedirects?: number
  /** Per-use timeouts (ms). Absent uses fall back to `merchantTimeout`. */
  timeouts?: MerchantEgressTimeouts
}

export type MerchantEgressRefusalReason =
  | 'url_not_allowed'
  | 'redirect_on_non_get'
  | 'redirect_missing_location'
  | 'redirect_invalid_location'
  | 'redirect_budget_exceeded'

export const MERCHANT_EGRESS_REFUSED_CODE = 'MERCHANT_EGRESS_REFUSED'

/**
 * The policy refused a merchant request. `beforeRequest` is true when the
 * refusal happened BEFORE any request of that merchant use was sent (nothing
 * is on the wire); false when it happened mid-flight — the initial request
 * was already sent (a redirect answered, a hop refused, a body mid-read),
 * which after a PAID delivery means the payment header may have been
 * delivered and the money is in the verify-then-sweep state (#1300).
 */
export class MerchantEgressRefusedError extends HavenError {
  readonly url: string
  readonly refusal: MerchantEgressRefusalReason
  readonly beforeRequest: boolean

  constructor(
    message: string,
    url: string,
    refusal: MerchantEgressRefusalReason,
    beforeRequest: boolean,
  ) {
    super(message, MERCHANT_EGRESS_REFUSED_CODE, 400)
    this.name = 'MerchantEgressRefusedError'
    this.url = url
    this.refusal = refusal
    this.beforeRequest = beforeRequest
  }
}

export const MERCHANT_EGRESS_RESPONSE_CAP_CODE = 'MERCHANT_EGRESS_RESPONSE_CAP'

/**
 * A response body grew past `maxResponseBytes` WHILE it was being read —
 * the read was aborted mid-stream, never buffered past the cap. Always
 * mid-flight: the request was already sent.
 */
export class MerchantEgressResponseCapError extends HavenError {
  readonly url: string | undefined
  readonly limitBytes: number

  constructor(message: string, limitBytes: number, url?: string) {
    super(message, MERCHANT_EGRESS_RESPONSE_CAP_CODE, 400)
    this.name = 'MerchantEgressResponseCapError'
    this.limitBytes = limitBytes
    this.url = url
  }
}

/** Suffixes that name local or internal space, never a public merchant. */
const INTERNAL_SUFFIXES = ['.internal', '.local', '.localhost', '.test', '.invalid', '.example'] as const

/**
 * The strict hosted string check: https (any port), no IP literals (v4 or
 * v6 — `URL` normalises the exotic spellings to these two shapes before this
 * runs, as #3112 established for the retry-target check), no `localhost`, no
 * single-label host, none of the internal/reserved suffixes. `true` for
 * exactly the URLs a hosted merchant request may connect to.
 */
export function isPublicHttpsMerchantUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  // WHATWG `URL` strips the brackets: an IPv6 literal's hostname CONTAINS a
  // colon, and no registrable name ever does.
  if (host.includes(':')) return false
  // IPv4 literal. `URL` has already normalised `0x7f.0.0.1`, `2130706433`,
  // and the like to dotted decimal, so this shape is the only one that reaches
  // here (same reasoning as IPV4_LOOPBACK in x402-retry-target.ts).
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false
  // `localhost` and every other single-label host.
  if (!host.includes('.')) return false
  return !INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

/** Human-readable reason a URL failed `isPublicHttpsMerchantUrl`. */
export function publicHttpsMerchantUrlRefusal(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'it is not a valid URL'
  }
  if (parsed.protocol !== 'https:') return `its scheme is ${parsed.protocol.replace(':', '')}, not https`
  const host = parsed.hostname.toLowerCase()
  if (host.includes(':')) return `${host} is an IP-literal host (IPv6)`
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return `${host} is an IP-literal host (IPv4)`
  if (!host.includes('.')) return `${host} is a single-label host`
  const suffix = INTERNAL_SUFFIXES.find((s) => host.endsWith(s))
  if (suffix) return `${host} ends in the internal/reserved suffix ${suffix}`
  return 'it is not a public https URL'
}

/**
 * The `assertUrl` half of the strict hosted policy: throws
 * `MerchantEgressRefusedError` (beforeRequest: true) unless the URL is a
 * public https URL. Message names the offending URL (agent-chosen input —
 * never a RESOLVED address; this policy never resolves DNS).
 */
export function assertPublicHttpsMerchantUrl(url: string): void {
  if (isPublicHttpsMerchantUrl(url)) return
  throw new MerchantEgressRefusedError(
    `Hosted egress policy refuses ${url}: ${publicHttpsMerchantUrlRefusal(url)}. ` +
      'Hosted merchant requests go to public https hosts only — no IP literals, no localhost, ' +
      'no single-label or internal names. Re-quote the merchant at its public https URL.',
    url,
    'url_not_allowed',
    true,
  )
}

/** #1271's discovery budget, reused as the floor for hosted discovery reads. */
export const HOSTED_DISCOVERY_TIMEOUT_MS = 5_000
/** Hosted per-use timeouts: short probes, finite paid delivery. */
export const HOSTED_EGRESS_TIMEOUTS: Required<MerchantEgressTimeouts> = {
  quote: 15_000,
  mcpSession: 15_000,
  discovery: HOSTED_DISCOVERY_TIMEOUT_MS,
  // Today's DEFAULT_MERCHANT_TIMEOUT — stated here rather than imported to
  // keep this module dependency-free in both directions.
  delivery: 300_000,
}
/** Hosted response byte cap, enforced while reading. */
export const HOSTED_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
/** Hosted GET-redirect budget: every hop re-checked against the URL rules. */
export const HOSTED_MAX_GET_REDIRECTS = 3

/**
 * The strict hosted policy `createHostedHavenClient` installs. Deliberately
 * exported so the budgets are pinnable in tests and a deployment can build
 * its own variant beside it.
 */
export function strictMerchantEgressPolicy(): MerchantEgressPolicy {
  return {
    assertUrl: assertPublicHttpsMerchantUrl,
    maxResponseBytes: HOSTED_MAX_RESPONSE_BYTES,
    maxGetRedirects: HOSTED_MAX_GET_REDIRECTS,
    timeouts: { ...HOSTED_EGRESS_TIMEOUTS },
  }
}

/**
 * Read a response body as text with a byte cap enforced WHILE reading: the
 * moment the stream grows past `maxBytes` the read is cancelled and a
 * `MerchantEgressResponseCapError` is thrown — nothing is buffered past the
 * cap, and a body that never ends cannot hold the read open.
 */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return response.text()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new MerchantEgressResponseCapError(
        `Merchant response exceeded the ${maxBytes}-byte cap while it was being read; the read was aborted.`,
        maxBytes,
      )
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}
