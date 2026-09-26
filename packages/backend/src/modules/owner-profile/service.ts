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
  type OwnerCompanyDetailsRow,
  type ViesStatus,
} from '../../infra/repositories/owner-company-details.js'
import { checkVatWithVies, viesRequestForVatNumber } from './vies-client.js'

export const MAX_LEGAL_NAME_LENGTH = 200
export const MAX_ORG_NUMBER_LENGTH = 32
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
 * short enough that an owner watching the settings page after a page reload
 * sees it move within the session, long enough that a normal in-flight check
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
}

export type CompanyDetailsValidationError =
  | 'invalid_legal_name'
  | 'invalid_country'
  | 'invalid_org_number'
  | 'invalid_vat_number'

export interface NormalizedCompanyDetails {
  legal_name: string
  country: string
  org_number: string
  vat_number: string | null
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

  return { ok: true, value: { legal_name: legalName, country, org_number: orgNumber, vat_number: vatNumber } }
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
  // eslint-disable-next-line no-console -- no app logger is threaded through
  // this detached async task (see the comment above); this is the one place
  // in the module that logs anything, so it stays a single, greppable line.
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
 */
export async function runViesCheck(userId: string, vatNumber: string): Promise<void> {
  let status: ViesStatus = 'not_verifiable'
  let reason: string | null = null
  try {
    const { countryCode, vatNumber: bareNumber } = viesRequestForVatNumber(vatNumber)
    const result = await checkVatWithVies(countryCode, bareNumber)
    status = result.status
    reason = result.reason
  } catch {
    status = 'not_verifiable'
    reason = 'runner_threw'
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
    ...validated.value,
    vies_status: viesStatus,
    // #3332 review doc F9: `vies_checked_at` is cleared alongside
    // `vies_status` whenever the VAT number is cleared (`viesStatus === null`)
    // or a fresh check is starting (`'pending'`) — it names the CHECK'S OWN
    // clock, not the row's, so a cleared VAT number must not keep displaying
    // a stale check date it no longer has a status to go with.
    vies_checked_at: viesStatus === null || viesStatus === 'pending' ? null : previous?.vies_checked_at ?? null,
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
