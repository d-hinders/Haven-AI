import { HavenError } from './types.js'

/**
 * Where the PAID retry goes — and whether it may go there at all (#3097).
 *
 * A merchant's 402 challenge declares `resource.url`. Haven records that
 * declaration as the resource's identity (the binding message, the intent
 * row, the resume checks all compare against it), but the paid request —
 * the one carrying `PAYMENT-SIGNATURE` — must go to the URL the CALLER
 * actually asked for whenever one exists. The declaration is the merchant's
 * word about itself, not an instruction to the client: the Ampersend
 * sandbox declares `http://` for a resource it serves over `https` (live,
 * 2026-09-17; its `http://` answers 308 → https), and a client that adopted
 * it sent the signed header in clear on the first hop.
 *
 * Two rules, both pure, both pinned by tests:
 *
 *  - `resolveX402RetryTarget`: the caller's request URL wins; the merchant's
 *    `resource.url` is the fallback for callers that only hold the challenge
 *    (the hosted pay-from-quote path). The result says which one it chose and
 *    whether the two disagree, so a quote can surface the disagreement.
 *  - `isSecureX402RetryTarget`: `https` always; `http` only to a target that
 *    cannot leave the machine or the test bench — loopback addresses and the
 *    RFC 2606/6761 reserved names (`.test`, `.localhost`, `.invalid`,
 *    `.example`), which every fixture in this repo uses. A public `http://`
 *    target is refused BEFORE a signed header is handed to a transport.
 */
export interface X402RetryTarget {
  /** The URL the paid request goes to. */
  url: string
  /** Which input produced it. */
  source: 'request' | 'resource'
  /**
   * True when the merchant's declared `resource.url` is not the caller's URL.
   * Absent (undefined) when nothing was compared — the caller named no URL
   * and the declaration was adopted as-is — so a consumer never reads
   * "false" as "the merchant agrees with what you quoted".
   */
  resourceUrlDiffersFromRequest?: boolean
}

export function resolveX402RetryTarget(input: {
  requestUrl?: string | null
  resourceUrl: string
}): X402RetryTarget {
  const requestUrl = input.requestUrl?.trim() || undefined
  if (requestUrl) {
    return {
      url: requestUrl,
      source: 'request',
      resourceUrlDiffersFromRequest: requestUrl !== input.resourceUrl,
    }
  }
  return { url: input.resourceUrl, source: 'resource' }
}

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]'])
const RESERVED_SUFFIXES = ['.test', '.localhost', '.invalid', '.example']
// The whole 127/8 block, matched octet by octet. A string-prefix test on the
// hostname (`startsWith('127.')`) is NOT this: `127.attacker.io` is an ordinary
// registrable public name whose first label happens to be digits, and it would
// have passed (haven-reviewer finding on #3112). `URL` already normalises the
// exotic spellings (`0x7f.0.0.1`, `2130706433`) to dotted decimal before this
// runs, so dotted decimal is the only form that reaches it.
const IPV4_LOOPBACK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/** True when a retry carrying a payment header may be sent to `url`. */
export function isSecureX402RetryTarget(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === 'https:') return true
  if (parsed.protocol !== 'http:') return false
  const host = parsed.hostname.toLowerCase()
  if (LOOPBACK_HOSTS.has(host) || IPV4_LOOPBACK.test(host)) return true
  return RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

export const INSECURE_RETRY_TARGET_CODE = 'INSECURE_RETRY_TARGET'

/** Refused before any signed header leaves: the paid retry would travel in clear. */
export class HavenInsecureRetryTargetError extends HavenError {
  constructor(public readonly url: string) {
    super(
      `Refusing to send a payment header to ${url}: the paid x402 retry must go to an https URL ` +
        '(or a loopback / reserved test host). The merchant\'s challenge declared this resource URL; ' +
        'retry with the https URL you quoted (pass it as `url`), and report a merchant whose ' +
        'challenge downgrades the scheme.',
      INSECURE_RETRY_TARGET_CODE,
      400,
    )
    this.name = 'HavenInsecureRetryTargetError'
  }
}

export function assertSecureX402RetryTarget(url: string): void {
  if (!isSecureX402RetryTarget(url)) throw new HavenInsecureRetryTargetError(url)
}
