/**
 * EU VIES VAT-number validation client (#3332).
 *
 * Calls the EU Commission's VIES REST API
 * (`POST https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number`)
 * through the SSRF guard (`infra/http/ssrf-guard.ts`) — the same discipline
 * every other Haven-initiated outbound call to a fixed, non-merchant-supplied
 * URL uses, even though this URL is a Haven constant rather than caller
 * input: the guard also enforces the request timeout, redirect policy and
 * response-size cap, none of which this module wants to re-implement.
 *
 * Response shapes VERIFIED LIVE on 2026-09-27 against both the production
 * endpoint and the Commission's test service
 * (`POST …/rest-api/check-vat-test-service`, which answers fixed shapes for
 * the numbers 100, 200, 201, 202, 300, 301, 302, 400, 500, 600). Every answer
 * is HTTP 200; the body is one of two shapes:
 *
 *   - a check result: `{ countryCode, vatNumber, requestDate, valid: boolean,
 *     requestIdentifier, name, address, … }` — `valid` is the only field read;
 *     the name/address VIES returns are deliberately NOT read or stored;
 *   - a failure: `{ actionSucceed: false, errorWrappers: [{ error: CODE }] }`,
 *     where CODE is e.g. `INVALID_INPUT`, `INVALID_REQUESTER_INFO`,
 *     `SERVICE_UNAVAILABLE`, `MS_UNAVAILABLE`, `TIMEOUT`, `VAT_BLOCKED`,
 *     `GLOBAL_MAX_CONCURRENT_REQ`, `MS_MAX_CONCURRENT_REQ`.
 *
 * Any other shape (a future drift) is `not_verifiable`, never a throw.
 *
 * The one invariant this file is pinned on by its own tests: NOTHING that
 * looks like the service being unavailable — a network refusal, a timeout, a
 * non-200, a malformed body, an unrecognised failure code — is ever reported as
 * `invalid`. `invalid` is reserved for the one case VIES itself asserts the
 * number is not valid. An outage must read as "we could not check", not as
 * "this number is wrong" (owner decision recorded on #3332).
 */
import { safePostJson, type SafeFetchOptions } from '../../infra/http/ssrf-guard.js'

export const VIES_CHECK_URL = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number'

/** Bounded — VIES itself can hang for tens of seconds when a member state is slow; this must not hold a Haven request handler hostage. */
export const VIES_REQUEST_TIMEOUT_MS = 8_000

export type ViesCheckStatus = 'valid' | 'invalid' | 'not_verifiable'

export interface ViesCheckResult {
  status: ViesCheckStatus
  /** The VIES error code (or a locally-assigned reason) for logs — never the full VAT number, never logged at info level by a caller. */
  reason: string | null
}

interface ViesBody {
  valid?: unknown
  actionSucceed?: unknown
  errorWrappers?: unknown
}

/** The first `errorWrappers[].error` code, when the body is VIES's failure shape. */
function viesErrorCode(body: ViesBody): string | null {
  if (!Array.isArray(body.errorWrappers)) return null
  const first = body.errorWrappers[0] as { error?: unknown } | undefined
  return typeof first?.error === 'string' ? first.error : 'unknown_error'
}

function parseViesBody(raw: string): ViesCheckResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 'not_verifiable', reason: 'malformed_response' }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 'not_verifiable', reason: 'malformed_response' }
  }
  const body = parsed as ViesBody
  // The failure shape — EVERY code is `not_verifiable`: the outage family
  // (SERVICE_UNAVAILABLE, MS_UNAVAILABLE, TIMEOUT, the concurrency limits,
  // VAT_BLOCKED) says nothing about the number, and INVALID_INPUT /
  // INVALID_REQUESTER_INFO describe the REQUEST Haven sent (a Haven-side
  // shape bug), not a fact about the number either. Only `valid: false` is.
  const errorCode = viesErrorCode(body)
  if (errorCode !== null || body.actionSucceed === false) {
    return { status: 'not_verifiable', reason: errorCode ?? 'action_failed' }
  }
  if (typeof body.valid === 'boolean') {
    return { status: body.valid ? 'valid' : 'invalid', reason: null }
  }
  return { status: 'not_verifiable', reason: 'malformed_response' }
}

/**
 * Derives the `{countryCode, vatNumber}` VIES itself expects from a
 * normalised Haven VAT number (the caller's own 2-letter prefix + 2-20
 * alnum, uppercase, no spaces — `modules/owner-profile/service.ts`'s
 * `VAT_NUMBER_RE`).
 *
 * VIES's `countryCode` is the VAT number's OWN prefix, never the company's
 * `country` field — an EU group can register for VAT in a member state that
 * is not its seat of incorporation, and `country`/the VAT prefix are allowed
 * to differ (`service.ts`'s own validation comment) — and `vatNumber` is sent
 * WITHOUT that prefix. Both shapes were VERIFIED LIVE against the production
 * endpoint on 2026-09-27: `{countryCode:'SE', vatNumber:'SE556703748501'}`
 * (prefix left inside `vatNumber`) answered `valid:false` for the SAME number
 * `{countryCode:'SE', vatNumber:'556703748501'}` (prefix stripped) answered
 * `valid:true` for.
 *
 * Greece is the one member state where VIES's own `countryCode` differs from
 * the ISO 3166-1 / VAT prefix: Greek EU VAT numbers use the prefix `EL`, not
 * `GR` (Greece's ISO code) — `GR094014201` maps to `{countryCode:'EL',
 * vatNumber:'094014201'}`. Sending `EL` as the prefix (i.e. asking VIES with
 * `{countryCode:'EL', vatNumber:'EL094014201'}` — prefix left in twice) was
 * verified live to answer `INVALID_INPUT`. Northern Ireland's `XI` prefix
 * already IS VIES's own country code and needs no mapping.
 */
export function viesRequestForVatNumber(vatNumber: string): { countryCode: string; vatNumber: string } {
  const prefix = vatNumber.slice(0, 2)
  const countryCode = prefix === 'GR' ? 'EL' : prefix
  return { countryCode, vatNumber: vatNumber.slice(2) }
}

/**
 * VIES's own member-state country codes (#3332 review m1, captain's
 * decision): the 27 EU member states' own 2-letter codes, Greece as `EL`
 * (never `GR` — see `viesRequestForVatNumber`'s own doc), and Northern
 * Ireland's `XI` (a VIES-recognised code with no EU member state behind it,
 * carried over from the UK's post-Brexit Windsor Framework arrangement).
 * A VAT number whose prefix is not one of these is well-formed
 * (`service.ts`'s `VAT_NUMBER_RE`) but is not a number VIES itself can ever
 * confirm — asking anyway would either be refused by VIES as `INVALID_INPUT`
 * (read back here as an ordinary outage, `not_verifiable`) or, worse, risk a
 * false negative if some future country code collided with a member state's.
 * `runViesCheck` checks membership BEFORE calling `checkVatWithVies` and
 * skips the network call entirely for a non-member prefix.
 */
const VIES_MEMBER_COUNTRY_CODES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR',
  'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO',
  'SE', 'SI', 'SK', 'XI',
])

/** True when a normalised Haven VAT number's own prefix (GR mapped to EL, same as `viesRequestForVatNumber`) is a VIES member country code. */
export function isViesMemberPrefix(vatNumber: string): boolean {
  return VIES_MEMBER_COUNTRY_CODES.has(viesRequestForVatNumber(vatNumber).countryCode)
}

/**
 * Checks one VAT number. Never throws — every failure mode (network, SSRF
 * refusal, timeout, non-200, malformed body) resolves to `not_verifiable`.
 *
 * `countryCode`/`vatNumber` here are already in VIES's OWN shape — the
 * caller (`modules/owner-profile/service.ts`'s `runViesCheck`) derives them
 * from the stored VAT number with `viesRequestForVatNumber` before calling
 * this; this function does not re-derive them, so a caller that passes the
 * company's `country` field or a still-prefixed `vatNumber` reproduces the
 * exact wrong-shape bug `viesRequestForVatNumber`'s own doc records.
 *
 * `options` carries the SSRF guard's injectable seams (`transport`,
 * `resolver`, `timeoutMs`) so unit tests can supply a recorded response
 * without a network call; production callers pass nothing and get the real
 * transport and DNS resolver.
 */
export async function checkVatWithVies(
  countryCode: string,
  vatNumber: string,
  options: SafeFetchOptions = {},
): Promise<ViesCheckResult> {
  try {
    const result = await safePostJson(
      VIES_CHECK_URL,
      { countryCode, vatNumber },
      { timeoutMs: VIES_REQUEST_TIMEOUT_MS, ...options },
    )
    if (!result.ok) {
      // Every SsrfRefusal reason (timeout, transport_error, dns_failure, a
      // non-2xx the guard itself refused, …) is an outage from this caller's
      // point of view, not a statement about the VAT number.
      return { status: 'not_verifiable', reason: result.reason }
    }
    if (result.status !== 200) {
      return { status: 'not_verifiable', reason: `http_${result.status}` }
    }
    return parseViesBody(result.body)
  } catch {
    // The guard's own transport can reject rather than resolve a refusal
    // (a synchronous socket throw). This function's contract is that it
    // NEVER throws — the caller (`runViesCheck`) always has an outcome to
    // record, never an unhandled rejection to crash a detached async task.
    return { status: 'not_verifiable', reason: 'transport_threw' }
  }
}
