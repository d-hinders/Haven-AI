/**
 * Owner company details orchestration (#3332): validation, normalisation, and
 * the async VIES re-check runner.
 *
 * Nothing here calls the database or the network directly except through
 * `infra/repositories/owner-company-details.js` and `./vies-client.js` — kept
 * this way so the route handler stays thin and the transition logic (when
 * does a write become `pending`, when is `pending` stale enough to re-check)
 * lives in exactly one place.
 */
import {
  claimStalePendingForUser,
  deleteOwnerCompanyDetails,
  getOwnerCompanyDetails,
  markViesPending,
  setViesResult,
  upsertOwnerCompanyDetails,
  type OwnerAddress,
  type OwnerCompanyDetailsRow,
  type ViesStatus,
} from '../../infra/repositories/owner-company-details.js'
import { checkVatWithVies, isViesMemberPrefix, viesRequestForVatNumber } from './vies-client.js'

export const MAX_LEGAL_NAME_LENGTH = 200
export const MAX_ORG_NUMBER_LENGTH = 32
/**
 * #4870: RFC 5321 §4.5.3.1.3's forward-path limit (254), less the angle
 * brackets. The same bound the design doc states for `receipt_email`.
 */
export const MAX_RECEIPT_EMAIL_LENGTH = 254
/**
 * #4870: the address bounds from `docs/architecture/13-checkout-details.md`
 * § *The address shape*. They are Haven's own bounds — they fit every address
 * an owner can type and bound the answer a merchant receives — not a
 * validation that the address exists.
 */
export const ADDRESS_MAX_LENGTHS = {
  line1: 70,
  line2: 70,
  line3: 70,
  city: 50,
  postCode: 16,
  subdivision: 6,
  country: 2,
} as const
// #3332 review minor: C0 (\u0000-\u001F), DEL, C1 (\u0080-\u009F), and the
// bidi override/isolate controls (‪-‮, ⁦-⁩) — a legal
// name is rendered on receipts a merchant reads, and any of these can make
// displayed text lie about its own reading order or hide characters
// (a classic homograph/spoofing vector), not just break rendering.
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/
const COUNTRY_RE = /^[A-Z]{2}$/
const ORG_NUMBER_RE = /^[A-Za-z0-9 .\-/]{1,32}$/
// EU VAT number shape: 2-letter country prefix + 2-20 alnum. Deliberately
// tolerant of the per-country format (checksum rules vary by member state and
// VIES itself is the actual validator) — this only bounds the SHAPE.
const VAT_NUMBER_RE = /^[A-Z]{2}[A-Z0-9]{2,20}$/

/**
 * Re-check cadence for a `pending` row that never resolved (a crash or a
 * timed-out worker between the write and the async check completing). Chosen
 * short enough that an owner reloading `GET /user/company-details` sees it
 * move within the session, long enough that a normal in-flight check
 * (bounded by `VIES_REQUEST_TIMEOUT_MS`, single-digit seconds) is never
 * mistaken for stuck.
 */
export const STALE_PENDING_MINUTES = 5

export interface CompanyDetailsInput {
  legal_name: string
  country: string
  org_number: string
  /** Raw as submitted; normalised here. Empty string and null both mean "no VAT number". */
  vat_number: string | null
  /**
   * #4870. `undefined` means the request OMITTED the field — keep whatever is
   * stored. `null` (or an empty string) clears it. A value is validated and
   * stored. The distinction is the whole point: an old dashboard tab that
   * sends only the four original fields must not wipe these.
   */
  receipt_email?: string | null
  billing_address?: AddressInput | null
  shipping_address?: AddressInput | null
}

/**
 * The address as a request carries it (#4870). Every member is optional on
 * the wire so the service, not the schema, decides what "required" means and
 * answers with the route's own `400 { error }` shape.
 */
export interface AddressInput {
  line1?: string | null
  line2?: string | null
  line3?: string | null
  city?: string | null
  postCode?: string | null
  subdivision?: string | null
  country?: string | null
}

export type CompanyDetailsValidationError =
  | 'invalid_legal_name'
  | 'invalid_country'
  | 'invalid_org_number'
  | 'invalid_vat_number'
  | 'invalid_receipt_email'
  | 'invalid_billing_address'
  | 'invalid_shipping_address'

export interface NormalizedCompanyDetails {
  legal_name: string
  country: string
  org_number: string
  vat_number: string | null
  /**
   * #4870. Optional by design: `undefined` = the request omitted the field,
   * so keep the stored value; `null` = clear it. `validateCompanyDetailsInput`
   * always sets all three (possibly to `undefined`), and
   * `writeCompanyDetails` resolves them against the previous row.
   */
  receipt_email?: string | null
  billing_address?: OwnerAddress | null
  shipping_address?: OwnerAddress | null
}

/**
 * The email shape `routes/auth.ts` uses for sign-up emails, kept here rather
 * than imported from a route module (a module must not depend on a route).
 * Deliberately the same rule: one `@`, no whitespace, a dot in the domain —
 * which also refuses a display name (`Ada <ada@example.se>`) and any CR/LF.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Normalises one address, or `null` when it is not a usable address.
 *
 * Blank optional members are OMITTED from the result, never stored as `null`
 * or as an empty string — the design doc's rule for the shape a merchant
 * receives. `line1`, `city` and `country` are required; `country` is
 * uppercased (ISO 3166-1 alpha-2 is uppercase) and must be exactly two
 * letters. Control characters are refused in every member: an address is
 * rendered on a receipt a merchant reads, and a bidi override can make the
 * displayed text lie about its own reading order.
 */
export function normalizeAddress(input: AddressInput): OwnerAddress | null {
  const read = (key: keyof typeof ADDRESS_MAX_LENGTHS): string => {
    const raw = input[key]
    if (raw === undefined || raw === null) return ''
    return raw.trim()
  }

  const line1 = read('line1')
  const city = read('city')
  const country = read('country').toUpperCase()
  if (line1.length === 0 || city.length === 0 || !COUNTRY_RE.test(country)) return null

  const optional: Array<[keyof typeof ADDRESS_MAX_LENGTHS, string]> = [
    ['line2', read('line2')],
    ['line3', read('line3')],
    ['postCode', read('postCode')],
    ['subdivision', read('subdivision')],
  ]

  for (const [key, value] of optional) {
    if (value.length > ADDRESS_MAX_LENGTHS[key]) return null
  }
  if (line1.length > ADDRESS_MAX_LENGTHS.line1 || city.length > ADDRESS_MAX_LENGTHS.city) return null

  // Control characters anywhere in the address make it unusable — checked on
  // the RAW members so a control character cannot be trimmed away first.
  for (const key of Object.keys(ADDRESS_MAX_LENGTHS) as Array<keyof typeof ADDRESS_MAX_LENGTHS>) {
    const raw = input[key]
    if (typeof raw === 'string' && CONTROL_CHAR_RE.test(raw)) return null
  }

  const address: OwnerAddress = { line1, city, country }
  for (const [key, value] of optional) {
    if (value.length > 0) address[key] = value
  }
  return address
}

/**
 * Normalises the receipt email, or `null` when it is not a usable address.
 * An empty string is treated as "clear" by the caller, not as an error — the
 * same convention `vat_number` already follows.
 */
export function normalizeReceiptEmail(raw: string): string | null {
  const email = raw.trim()
  if (email.length === 0 || email.length > MAX_RECEIPT_EMAIL_LENGTH) return null
  if (CONTROL_CHAR_RE.test(raw) || !EMAIL_RE.test(email)) return null
  return email
}

/**
 * Pure validation + normalisation. Returns the error code or the normalised
 * fields — never both — so the route can map the code to its own wire copy.
 */
export function validateCompanyDetailsInput(
  input: CompanyDetailsInput,
): { ok: true; value: NormalizedCompanyDetails } | { ok: false; error: CompanyDetailsValidationError } {
  const legalName = input.legal_name.trim().replace(/\s+/g, ' ')
  if (
    legalName.length === 0 ||
    legalName.length > MAX_LEGAL_NAME_LENGTH ||
    CONTROL_CHAR_RE.test(input.legal_name)
  ) {
    return { ok: false, error: 'invalid_legal_name' }
  }

  const country = input.country.trim().toUpperCase()
  if (!COUNTRY_RE.test(country)) {
    return { ok: false, error: 'invalid_country' }
  }

  const orgNumber = input.org_number.trim()
  if (orgNumber.length === 0 || orgNumber.length > MAX_ORG_NUMBER_LENGTH || !ORG_NUMBER_RE.test(orgNumber)) {
    return { ok: false, error: 'invalid_org_number' }
  }

  const rawVat = input.vat_number?.trim() ?? ''
  let vatNumber: string | null = null
  if (rawVat.length > 0) {
    vatNumber = rawVat.toUpperCase().replace(/\s+/g, '')
    if (!VAT_NUMBER_RE.test(vatNumber)) {
      return { ok: false, error: 'invalid_vat_number' }
    }
    // Deliberate choice (documented, #3332 acceptance): the VAT number's own
    // 2-letter prefix is accepted AS GIVEN and is not required to match
    // `country` — an EU group can register for VAT in a member state that is
    // not its seat of incorporation, and VIES itself is the authority on
    // whether the number is valid; Haven does not second-guess the prefix.
  }

  // #4870: `undefined` (omitted) stays `undefined` — "keep the stored value".
  // `null` and an empty string both mean "clear it". Anything else is
  // validated and normalised.
  let receiptEmail: string | null | undefined
  if (input.receipt_email === undefined) {
    receiptEmail = undefined
  } else if (input.receipt_email === null || input.receipt_email.trim().length === 0) {
    receiptEmail = null
  } else {
    receiptEmail = normalizeReceiptEmail(input.receipt_email)
    if (receiptEmail === null) return { ok: false, error: 'invalid_receipt_email' }
  }

  const billingAddress = normalizeOptionalAddress(input.billing_address)
  if (billingAddress === INVALID_ADDRESS) return { ok: false, error: 'invalid_billing_address' }
  const shippingAddress = normalizeOptionalAddress(input.shipping_address)
  if (shippingAddress === INVALID_ADDRESS) return { ok: false, error: 'invalid_shipping_address' }

  return {
    ok: true,
    value: {
      legal_name: legalName,
      country,
      org_number: orgNumber,
      vat_number: vatNumber,
      receipt_email: receiptEmail,
      billing_address: billingAddress,
      shipping_address: shippingAddress,
    },
  }
}

/** Sentinel distinguishing "the request omitted this address" from "it is invalid". */
const INVALID_ADDRESS = Symbol('invalid_address')

/**
 * `undefined` = omitted (keep), `null` = clear, an object = validate it.
 * Returns the `INVALID_ADDRESS` sentinel when the object is not a usable
 * address, so the caller can name the field in its error code.
 */
function normalizeOptionalAddress(
  input: AddressInput | null | undefined,
): OwnerAddress | null | undefined | typeof INVALID_ADDRESS {
  if (input === undefined) return undefined
  if (input === null) return null
  const normalized = normalizeAddress(input)
  return normalized ?? INVALID_ADDRESS
}

/** True when a write should re-run the VIES check: the VAT number is set/changed. */
export function shouldTriggerViesCheck(
  previous: OwnerCompanyDetailsRow | null,
  next: NormalizedCompanyDetails,
): boolean {
  if (!next.vat_number) return false
  return previous?.vat_number !== next.vat_number
}

/** The status to write immediately (synchronously, in the same request as the upsert). */
export function nextViesStatus(
  previous: OwnerCompanyDetailsRow | null,
  next: NormalizedCompanyDetails,
): ViesStatus | null {
  if (!next.vat_number) return null
  if (shouldTriggerViesCheck(previous, next)) return 'pending'
  return previous?.vies_status ?? 'pending'
}

/**
 * Minimal structured logger for the VIES outcome (#3332 review M3) — never
 * threaded a userId or a request through, because this runs DETACHED from
 * any request (the HTTP response is already gone by the time a check
 * completes; see this function's own doc). Deliberately NOT `console.log`
 * free text: `event`/`status`/`reason` are grep-able fields so a systematic
 * wrong result (e.g. every check landing `not_verifiable` because Haven's
 * own request shape drifted from VIES's, or a spike of `invalid`) is visible
 * in production log search without correlating request logs. Never logs the
 * VAT number or the org number — `reason` is VIES's own error CODE (or a
 * locally-assigned one, see `ViesCheckResult.reason`), never the input.
 */
function logViesOutcome(status: ViesStatus, reason: string | null, recorded: boolean): void {
  console.log(
    JSON.stringify({ level: 'info', event: 'owner_profile.vies_check_result', status, reason, recorded }),
  )
}

/**
 * Runs the VIES check and records the outcome — ALWAYS records one, even on
 * throw, so a row can never stay `pending` because the runner itself failed
 * outside `checkVatWithVies`'s own never-throws contract. Deliberately
 * fire-and-forget from the route's point of view (see `routes/owner-company-details.ts`):
 * the HTTP response has already gone out with `vies_status: 'pending'`.
 *
 * `vatNumber` is the FULL, stored, normalised number (own 2-letter prefix +
 * digits/letters) — `viesRequestForVatNumber` derives what VIES itself wants
 * (`{countryCode, vatNumber}`, country from the VAT prefix, never from the
 * company's `country` field — see that function's own doc, #3332 review B1).
 * The SAME `vatNumber` is also the guard `setViesResult` binds its write to
 * (#3332 review M1): a result only lands on the row it was actually computed
 * for, `AND vat_number = $N AND vies_status = 'pending'` — never onto a VAT
 * number the owner changed to, or cleared, while this check was in flight.
 * `setViesResult` returns `null` (not a throw) when that guard does not
 * match; the `catch` below is for a genuine DB failure (a lost connection),
 * not for "the row moved on" — that case is the expected, silent no-op the
 * guard exists to produce.
 *
 * #3332 review m1 (captain's decision): a VAT number whose prefix is not a
 * VIES member country code (`isViesMemberPrefix`) is still accepted and
 * stored (`service.ts`'s `VAT_NUMBER_RE` only bounds the SHAPE) — but VIES
 * itself can never confirm it, so no VIES call is made at all. The result is
 * recorded immediately as `not_verifiable` with reason `non_member_prefix`,
 * never `invalid`: this is Haven saying "not a number VIES can check", the
 * same never-invalid discipline an outage gets, not a statement that the
 * number is wrong.
 */
export async function runViesCheck(userId: string, vatNumber: string): Promise<void> {
  let status: ViesStatus = 'not_verifiable'
  let reason: string | null = null
  if (!isViesMemberPrefix(vatNumber)) {
    status = 'not_verifiable'
    reason = 'non_member_prefix'
  } else {
    try {
      const { countryCode, vatNumber: bareNumber } = viesRequestForVatNumber(vatNumber)
      const result = await checkVatWithVies(countryCode, bareNumber)
      status = result.status
      reason = result.reason
    } catch {
      status = 'not_verifiable'
      reason = 'runner_threw'
    }
  }
  let recorded = false
  try {
    const updated = await setViesResult(userId, status, new Date().toISOString(), vatNumber)
    recorded = updated !== null
  } catch {
    // A genuine DB failure recording the outcome (e.g. a lost connection) —
    // the row is left `pending`; `recheckIfStalePending`'s stale-pending
    // claim (or an explicit `POST .../vies-check`) picks it up later. There
    // is no request waiting on this detached task to retry immediately.
  }
  logViesOutcome(status, reason, recorded)
}

/**
 * Re-triggers a check for a row that has been `pending` for longer than
 * `STALE_PENDING_MINUTES` — the acceptance criterion that a crash between
 * write and check-completion must never leave a row stuck `pending` forever.
 * Called from `GET /user/company-details` (a read re-triggering on staleness,
 * chosen over a background sweep so it needs no scheduler — see the route's
 * own comment for the full tradeoff).
 *
 * #3332 review M3: `claimStalePendingForUser` is an atomic UPDATE, not a
 * SELECT — it only matches (and bumps `updated_at`) the FIRST caller to reach
 * a given stale row, so two concurrent `GET`s (a doubled request, two open
 * tabs) start AT MOST ONE check rather than one each.
 */
export async function recheckIfStalePending(userId: string): Promise<void> {
  const claimed = await claimStalePendingForUser(userId, STALE_PENDING_MINUTES)
  if (!claimed || !claimed.vat_number) return
  // Fire-and-forget, same contract as the write path.
  void runViesCheck(userId, claimed.vat_number)
}

export async function readCompanyDetails(userId: string): Promise<OwnerCompanyDetailsRow | null> {
  return getOwnerCompanyDetails(userId)
}

export type WriteCompanyDetailsResult =
  | { ok: true; row: OwnerCompanyDetailsRow }
  | { ok: false; error: CompanyDetailsValidationError }

export async function writeCompanyDetails(
  userId: string,
  input: CompanyDetailsInput,
): Promise<WriteCompanyDetailsResult> {
  const validated = validateCompanyDetailsInput(input)
  if (!validated.ok) {
    return { ok: false, error: validated.error }
  }
  const previous = await getOwnerCompanyDetails(userId)
  const viesStatus = nextViesStatus(previous, validated.value)
  const row = await upsertOwnerCompanyDetails(userId, {
    legal_name: validated.value.legal_name,
    country: validated.value.country,
    org_number: validated.value.org_number,
    vat_number: validated.value.vat_number,
    vies_status: viesStatus,
    // #3332 review doc F9: `vies_checked_at` is cleared alongside
    // `vies_status` whenever the VAT number is cleared (`viesStatus === null`)
    // or a fresh check is starting (`'pending'`) — it names the CHECK'S OWN
    // clock, not the row's, so a cleared VAT number must not keep displaying
    // a stale check date it no longer has a status to go with.
    vies_checked_at: viesStatus === null || viesStatus === 'pending' ? null : previous?.vies_checked_at ?? null,
    // #4870 "omitted keeps, `null` clears": an omitted field keeps the stored
    // value, an explicit `null` clears it. Resolved HERE, where the previous
    // row is already read, so the repository's write stays a full replacement
    // and an old dashboard tab that sends only the four original fields
    // cannot wipe the three new ones.
    receipt_email:
      validated.value.receipt_email === undefined
        ? previous?.receipt_email ?? null
        : validated.value.receipt_email,
    billing_address:
      validated.value.billing_address === undefined
        ? previous?.billing_address ?? null
        : validated.value.billing_address,
    shipping_address:
      validated.value.shipping_address === undefined
        ? previous?.shipping_address ?? null
        : validated.value.shipping_address,
  })
  if (validated.value.vat_number && shouldTriggerViesCheck(previous, validated.value)) {
    // Deliberately not awaited — see `runViesCheck`'s own doc.
    void runViesCheck(userId, validated.value.vat_number)
  }
  return { ok: true, row }
}

export async function removeCompanyDetails(userId: string): Promise<boolean> {
  return deleteOwnerCompanyDetails(userId)
}

/**
 * `POST /user/company-details/vies-check`: an explicit re-check, regardless of
 * whether the VAT number changed. Marks `pending` and fires the check
 * detached, same contract as the write path. Null (caller answers 404) when
 * there is no row or no VAT number to check.
 */
export async function triggerManualRecheck(userId: string): Promise<OwnerCompanyDetailsRow | null> {
  const pending = await markViesPending(userId)
  if (!pending || !pending.vat_number) return null
  void runViesCheck(userId, pending.vat_number)
  return pending
}
