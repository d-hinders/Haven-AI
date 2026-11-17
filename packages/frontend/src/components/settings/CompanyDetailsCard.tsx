'use client'

/**
 * Company details card on the Settings → Business tab (#3332; moved to the
 * Business tab by #4359), behind `HAVEN_OWNER_COMPANY_DETAILS`.
 *
 * ── Gating ───────────────────────────────────────────────────────────────
 * `useCompanyDetails`'s `status` decides everything this component renders:
 * `'off'` AND `'loading'` render nothing at all (design review 7 — no
 * title/skeleton flash while the first read is in flight, so a flag-off
 * deployment never shows a title for a section that does not exist);
 * `'error'` a retry state (never a blank crash). `'ready'` the form,
 * pre-filled from `details`. `'empty'` (#4359) the empty state — "No
 * company details", the purpose line and **Add company details**, which
 * reveals the form — because a first-time owner no longer meets a wall of
 * empty inputs; the purpose line stays above it either way
 * (`owner-company-details.md`: the purpose text is shown above the form — in
 * the empty state too — and the error state does not show it).
 *
 * The reads come from `BusinessDataProvider` (#4359): the card, the
 * Connections card and the Business tab's visibility rule share ONE
 * `useCompanyDetails` — its VIES polling must never run twice.
 *
 * ── Country (#4359) ──────────────────────────────────────────────────────
 * A native `Select` of the assigned ISO 3166-1 alpha-2 codes, labelled in
 * the user's locale (`lib/countries.ts`) — browser typeahead, no search
 * (a searchable combobox would be a new pattern). It saves the same
 * alpha-2 code the text input did, so the wire is unchanged. A saved code
 * outside the list ("UK", "EL", "XI", "XK") renders as its own option
 * labelled with the code and round-trips unchanged — the backend accepts
 * any `^[A-Z]{2}$`, and the buyer country on receipts must never change
 * silently.
 *
 * ── Receipt email and addresses (#4870) ──────────────────────────────────
 * Three optional fields, saved with the rest of the business details:
 *
 * - **Receipt email.** Prefilled from the SIGN-UP email when nothing is
 *   stored, and stored only when the owner saves — the sign-up email is
 *   never used as a receipt email anywhere else (owner decision 2026-11-17,
 *   #4868). Clearing the box saves `null`.
 * - **Billing and shipping addresses.** Structured, not free text, so a
 *   merchant can use them: street address, second line, postal code, city
 *   and country. The stored shape is
 *   `docs/architecture/13-checkout-details.md` § *The address shape*; the
 *   form edits the five members an owner types and CARRIES OVER `line3` and
 *   `subdivision` from the stored address, so a value written by another
 *   client is never silently dropped by this form. An address with every box
 *   blank is saved as `null` (cleared).
 * - **"Shipping address is the same as billing"** is a FORM CONVENIENCE, not
 *   a stored flag: ticking it hides the shipping block and saves the billing
 *   address as the shipping address. It is shown ticked when the two stored
 *   addresses are equal.
 *
 * Nothing here is sent to a merchant by this slice (#4870): the fields are
 * stored, and #4871 is the slice that answers a merchant's request.
 *
 * ── VIES ─────────────────────────────────────────────────────────────────
 * The status renders as a `StatusBadge` plus the checked date and "Check
 * again" (#4359). The badge follows the product doc's naming discipline:
 * "checked against VIES", never "verified" — see
 * `docs/product/owner-company-details.md` § The VIES states. The badge — and
 * "Check again" — are about the SAVED VAT number, so both hide while the VAT
 * field has been edited to something else (design review 11/12). The hook
 * polls while `pending`, bounded; once the bound elapses "Check again"
 * replaces the frozen "Checking…" badge (#3332 review M1).
 *
 * ── Validation ───────────────────────────────────────────────────────────
 * Client-side checks mirror the backend's own allowed-character rules
 * (`ORG_NUMBER_RE`/`CONTROL_CHAR_RE`/`EMAIL_RE` in
 * `modules/owner-profile/service.ts`) so a rejected value names the actual
 * cause instead of a generic one. Any 400 that still reaches the backend is
 * mapped from its own message text back onto the field it describes (no API
 * change — the backend has no field code on the wire, only the message), and
 * the first invalid field gets focus on submit (design review 3).
 *
 * ── Delete ───────────────────────────────────────────────────────────────
 * "Remove company details" asks for confirmation through the shared
 * `ConfirmDialog` (#4570 — every confirmation goes through it), before
 * calling `DELETE /user/company-details`. A failed delete shows its error
 * INSIDE the dialog (design review 5) and blocks Escape/backdrop-close while
 * the request is in flight; success closes the dialog and announces
 * "Company details removed." (design review 6) — the card then falls back to
 * the empty state. The trigger is a `ghost` button in the card's footer row,
 * left of Save (#4359): not `tertiary`, which a past design review rejected
 * here because it reads as a secondary call to action.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useT } from '@/context/LocaleContext'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import ConfirmDialog from '@/components/ConfirmDialog'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { SettingsSection } from '@/components/ui/SettingsSection'
import { StatusBadge, type StatusTone } from '@/components/ui/StatusBadge'
import { useBusinessData } from '@/components/settings/BusinessDataContext'
import { countryOptions } from '@/lib/countries'
import type { CompanyDetailsRow, ViesStatus } from '@/hooks/useCompanyDetails'

const COUNTRY_RE = /^[A-Za-z]{2}$/
// Mirrors `ORG_NUMBER_RE` in `packages/backend/src/modules/owner-profile/service.ts`.
const ORG_NUMBER_ALLOWED_RE = /^[A-Za-z0-9 .\-/]*$/
// Mirrors `CONTROL_CHAR_RE` in the same file: C0, DEL, C1, and the bidi
// override/isolate controls — never rendered in a legal name (#3332 review).
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/
// Mirrors `EMAIL_RE` in the same file (#4870): one `@`, no whitespace, a dot
// in the domain — which also refuses a display name and any CR/LF.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Mirrors `ADDRESS_MAX_LENGTHS` in the same file (#4870).
const ADDRESS_MAX = { line1: 70, line2: 70, postCode: 16, city: 50 } as const
const MAX_RECEIPT_EMAIL_LENGTH = 254

type AddressKey = 'billing' | 'shipping'
type AddressField = 'line1' | 'line2' | 'postCode' | 'city' | 'country'
type FieldKey =
  | 'legalName'
  | 'country'
  | 'orgNumber'
  | 'vatNumber'
  | 'receiptEmail'
  | `${AddressKey}.${AddressField}`

const FIELD_ID: Record<FieldKey, string> = {
  legalName: 'company-legal-name',
  country: 'company-country',
  orgNumber: 'company-org-number',
  vatNumber: 'company-vat-number',
  receiptEmail: 'company-receipt-email',
  'billing.line1': 'company-billing-line1',
  'billing.line2': 'company-billing-line2',
  'billing.postCode': 'company-billing-postcode',
  'billing.city': 'company-billing-city',
  'billing.country': 'company-billing-country',
  'shipping.line1': 'company-shipping-line1',
  'shipping.line2': 'company-shipping-line2',
  'shipping.postCode': 'company-shipping-postcode',
  'shipping.city': 'company-shipping-city',
  'shipping.country': 'company-shipping-country',
}

const FIELD_ORDER: FieldKey[] = [
  'legalName',
  'country',
  'orgNumber',
  'vatNumber',
  'receiptEmail',
  'billing.line1',
  'billing.line2',
  'billing.postCode',
  'billing.city',
  'billing.country',
  'shipping.line1',
  'shipping.line2',
  'shipping.postCode',
  'shipping.city',
  'shipping.country',
]

interface AddressDraft {
  line1: string
  line2: string
  postCode: string
  city: string
  country: string
}

interface Draft {
  legalName: string
  country: string
  orgNumber: string
  vatNumber: string
  receiptEmail: string
  billing: AddressDraft
  shipping: AddressDraft
  shippingSameAsBilling: boolean
}

const EMPTY_ADDRESS: AddressDraft = { line1: '', line2: '', postCode: '', city: '', country: '' }

function addressDraftFrom(address: CompanyDetailsRow['billing_address'] | undefined): AddressDraft {
  if (!address) return { ...EMPTY_ADDRESS }
  return {
    line1: address.line1 ?? '',
    line2: address.line2 ?? '',
    postCode: address.postCode ?? '',
    city: address.city ?? '',
    country: address.country ?? '',
  }
}

/** True when both stored addresses exist and carry the same five typed members. */
function addressesEqual(
  a: CompanyDetailsRow['billing_address'] | undefined,
  b: CompanyDetailsRow['billing_address'] | undefined,
): boolean {
  if (!a || !b) return false
  return (
    a.line1 === b.line1 &&
    (a.line2 ?? '') === (b.line2 ?? '') &&
    (a.postCode ?? '') === (b.postCode ?? '') &&
    a.city === b.city &&
    a.country === b.country
  )
}

function draftFrom(details: CompanyDetailsRow | null, signupEmail: string): Draft {
  return {
    legalName: details?.legal_name ?? '',
    country: details?.country ?? '',
    orgNumber: details?.org_number ?? '',
    vatNumber: details?.vat_number ?? '',
    // #4870: the sign-up email is a SUGGESTION, never a stored value — it is
    // shown when nothing is stored and saved only if the owner saves.
    receiptEmail: details?.receipt_email ?? signupEmail,
    billing: addressDraftFrom(details?.billing_address),
    shipping: addressDraftFrom(details?.shipping_address),
    shippingSameAsBilling: addressesEqual(details?.shipping_address, details?.billing_address),
  }
}

// The repo's date convention (`lib/analytics-format.ts`'s `en-GB`, day-first)
// rather than a hard-coded `en-US` render (nit, #3332 review).
function formatCheckedDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: 'long', day: 'numeric' }).format(date)
}

/** Exported for the copy-lint "never verified" mutation test to import directly. */
export interface ViesBadge {
  label: string
  tone: StatusTone
}

export function viesBadge(
  copy: {
    pending: string
    pendingTimedOut: string
    valid: string
    invalid: string
    notVerifiable: string
  },
  status: ViesStatus | null,
  // `checkedAt` is rendered beside the badge, not inside it, so it is not
  // part of this table's answer.
  pollTimedOut = false,
): ViesBadge | null {
  if (status === 'pending') return { label: pollTimedOut ? copy.pendingTimedOut : copy.pending, tone: 'neutral' }
  // `not_verifiable` is NEUTRAL — never `danger`, never `warning`: "VIES
  // could not check" must not read as "the number is wrong"
  // (`owner-company-details.md` § The VIES states, the one load-bearing rule).
  if (status === 'valid') return { label: copy.valid, tone: 'success' }
  if (status === 'invalid') return { label: copy.invalid, tone: 'warning' }
  if (status === 'not_verifiable') return { label: copy.notVerifiable, tone: 'neutral' }
  return null
}

function clientFieldErrors(
  draft: Draft,
  copy: {
    legalNameRequired: string
    legalNameTooLong: string
    legalNameInvalidChars: string
    countryInvalid: string
    orgNumberRequired: string
    orgNumberTooLong: string
    orgNumberInvalidChars: string
    vatNumberTooLong: string
    receiptEmailInvalid: string
    receiptEmailTooLong: string
    addressLine1Required: string
    addressLine1TooLong: string
    addressLine2TooLong: string
    addressPostCodeTooLong: string
    addressCityRequired: string
    addressCityTooLong: string
    addressCountryInvalid: string
  },
): Partial<Record<FieldKey, string>> {
  const errors: Partial<Record<FieldKey, string>> = {}

  const legalName = draft.legalName.trim()
  if (legalName.length === 0) errors.legalName = copy.legalNameRequired
  else if (legalName.length > 200) errors.legalName = copy.legalNameTooLong
  else if (CONTROL_CHAR_RE.test(draft.legalName)) errors.legalName = copy.legalNameInvalidChars

  const country = draft.country.trim()
  if (!COUNTRY_RE.test(country)) errors.country = copy.countryInvalid

  const orgNumber = draft.orgNumber.trim()
  if (orgNumber.length === 0) errors.orgNumber = copy.orgNumberRequired
  else if (orgNumber.length > 32) errors.orgNumber = copy.orgNumberTooLong
  else if (!ORG_NUMBER_ALLOWED_RE.test(orgNumber)) errors.orgNumber = copy.orgNumberInvalidChars

  const vatNumber = draft.vatNumber.trim()
  if (vatNumber.length > 32) errors.vatNumber = copy.vatNumberTooLong

  // #4870: the receipt email is optional; blank means "clear it".
  const receiptEmail = draft.receiptEmail.trim()
  if (receiptEmail.length > MAX_RECEIPT_EMAIL_LENGTH) errors.receiptEmail = copy.receiptEmailTooLong
  else if (receiptEmail.length > 0 && !EMAIL_RE.test(receiptEmail)) errors.receiptEmail = copy.receiptEmailInvalid

  // #4870: an address is optional as a whole. Once ANY box is filled it must
  // be a usable address — a street line, a city and a two-letter country —
  // because that is what the backend stores and a merchant reads.
  const addressKeys: AddressKey[] = draft.shippingSameAsBilling ? ['billing'] : ['billing', 'shipping']
  for (const key of addressKeys) {
    const address = draft[key]
    const touched =
      address.line1.trim().length > 0 ||
      address.line2.trim().length > 0 ||
      address.postCode.trim().length > 0 ||
      address.city.trim().length > 0 ||
      address.country.trim().length > 0
    if (!touched) continue

    if (address.line1.trim().length === 0) errors[`${key}.line1`] = copy.addressLine1Required
    else if (address.line1.trim().length > ADDRESS_MAX.line1) errors[`${key}.line1`] = copy.addressLine1TooLong
    if (address.line2.trim().length > ADDRESS_MAX.line2) errors[`${key}.line2`] = copy.addressLine2TooLong
    if (address.postCode.trim().length > ADDRESS_MAX.postCode) errors[`${key}.postCode`] = copy.addressPostCodeTooLong
    if (address.city.trim().length === 0) errors[`${key}.city`] = copy.addressCityRequired
    else if (address.city.trim().length > ADDRESS_MAX.city) errors[`${key}.city`] = copy.addressCityTooLong
    if (!COUNTRY_RE.test(address.country.trim())) errors[`${key}.country`] = copy.addressCountryInvalid
  }

  return errors
}

/**
 * The wire shape for one address, or `null` when every box is blank (which
 * CLEARS it). `line3` and `subdivision` are not edited by this form, so they
 * are carried over from the stored address rather than dropped — another
 * client may have written them.
 */
function addressPayload(
  draft: AddressDraft,
  stored: CompanyDetailsRow['billing_address'] | undefined,
): {
  line1: string
  line2?: string
  line3?: string
  city: string
  postCode?: string
  subdivision?: string
  country: string
} | null {
  const line1 = draft.line1.trim()
  const line2 = draft.line2.trim()
  const postCode = draft.postCode.trim()
  const city = draft.city.trim()
  const country = draft.country.trim().toUpperCase()
  if (line1.length === 0 && line2.length === 0 && postCode.length === 0 && city.length === 0 && country.length === 0) {
    return null
  }
  const payload: {
    line1: string
    line2?: string
    line3?: string
    city: string
    postCode?: string
    subdivision?: string
    country: string
  } = { line1, city, country }
  if (line2.length > 0) payload.line2 = line2
  if (postCode.length > 0) payload.postCode = postCode
  if (stored?.line3) payload.line3 = stored.line3
  if (stored?.subdivision) payload.subdivision = stored.subdivision
  return payload
}

// The backend has no field CODE on the wire (`VALIDATION_MESSAGES` in
// `routes/owner-company-details.ts` sends only the message) — this maps its
// known, stable message strings back onto the field each describes, so a 400
// that reaches the backend (chiefly the VAT shape check, which is not
// duplicated client-side) still lands under the right field rather than a
// generic banner (design review 3, "no API change").
const BACKEND_VALIDATION_FIELD: Record<string, FieldKey> = {
  'Enter a legal name using 200 characters or fewer.': 'legalName',
  'Country must be a two-letter ISO 3166-1 code, e.g. "SE".': 'country',
  'Enter an organisation number using 32 characters or fewer.': 'orgNumber',
  'Enter a VAT number as a two-letter country prefix followed by up to 20 letters or digits.': 'vatNumber',
  'Enter a receipt email address using 254 characters or fewer, e.g. "name@example.com".': 'receiptEmail',
  'Enter a billing address with a street line, a city and a two-letter country code.': 'billing.line1',
  'Enter a shipping address with a street line, a city and a two-letter country code.': 'shipping.line1',
}

export function CompanyDetailsCard() {
  const t = useT()
  const copy = t.settings.companyDetails
  const { company } = useBusinessData()
  const { user } = useAuth()
  const {
    status,
    details,
    reload,
    save,
    saving,
    remove,
    deleting,
    deleteError,
    resetDeleteError,
    recheckVies,
    checkingVies,
    viesCheckError,
    pollTimedOut,
  } = company

  const signupEmail = user?.email ?? ''
  const [draft, setDraft] = useState<Draft>(() => draftFrom(details, signupEmail))
  const [adding, setAdding] = useState(false)
  const [touched, setTouched] = useState(false)
  const [saved, setSaved] = useState(false)
  const [justRemoved, setJustRemoved] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const removedNoticeRef = useRef<HTMLParagraphElement>(null)

  // Re-seed the draft whenever the saved row changes underneath it (initial
  // load, a save, a delete, or a VIES poll tick landing) — never while the
  // owner has an untouched blank they are about to fill in for the first
  // time, and the draft's own pending edits are not clobbered by a VIES poll
  // tick, which changes `vies_status`/`vies_checked_at` but never the fields
  // this form owns.
  //
  // #4870: the addresses are objects, and a poll tick hands back a NEW object
  // with the same value — depending on the object itself would reset the
  // draft every few seconds. The serialised value is the stable key.
  const billingKey = JSON.stringify(details?.billing_address ?? null)
  const shippingKey = JSON.stringify(details?.shipping_address ?? null)
  useEffect(() => {
    setDraft(draftFrom(details, signupEmail))
    setTouched(false)
    setFieldErrors({})
    // `signupEmail` is deliberately NOT a dependency: it is a prefill, and a
    // session refresh must not overwrite what the owner has typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    details?.legal_name,
    details?.country,
    details?.org_number,
    details?.vat_number,
    details?.receipt_email,
    billingKey,
    shippingKey,
  ])

  useEffect(() => {
    if (justRemoved) removedNoticeRef.current?.focus()
  }, [justRemoved])

  if (status === 'off' || status === 'loading') return null

  if (status === 'error') {
    return (
      <SettingsSection title={copy.title} description={copy.description}>
        <div className="space-y-3 px-6 py-4">
          <InlineAlert>{copy.loadError}</InlineAlert>
          {/* `variant="ghost" size="sm"` matches the other retry buttons in
              Settings (e.g. `AccountSignersCard`) and across the app — not
              `tertiary`, which reads as a secondary CTA rather than a plain
              retry (#3332 review round 2, design 5). */}
          <Button variant="ghost" size="sm" onClick={() => void reload()}>
            {copy.retry}
          </Button>
        </div>
      </SettingsSection>
    )
  }

  function fieldError(field: FieldKey): string | null {
    return touched ? (fieldErrors[field] ?? null) : null
  }

  // #3332 review round 2, design 2: a field error REPLACES its helper text
  // IN THE SAME PARAGRAPH — never a helper line plus a separate error line
  // both in red, which read as the same point made twice. The fields below
  // pass `helperText={fieldError(field) ?? copy.fields.xHelp}` for exactly
  // this reason, always a truthy string, so `Input`'s conditional
  // `if (!helperText) return inputEl` branch never flips: the helper
  // paragraph — and the `<input>` beside it — stay the same element across
  // the invalid/valid transition instead of a structural change React
  // reconciles as a different subtree, which was unmounting and recreating
  // the `<input>` DOM node on that transition and silently dropping the
  // focus this same code path sets right after (caught by the round-2 fix
  // pass, not by design review 2 itself — a mutation of the "focuses it"
  // assertion in the VAT-shape-400 test would have caught it too, and does
  // now).

  function onFieldChange(mutate: (draft: Draft) => Draft) {
    setDraft(mutate)
    setSaved(false)
    setJustRemoved(false)
  }

  function onAddressChange(key: AddressKey, field: AddressField, value: string) {
    onFieldChange((d) => ({ ...d, [key]: { ...d[key], [field]: value } }))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    setSaved(false)
    setJustRemoved(false)
    const errors = clientFieldErrors(draft, copy.validation)
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      setFormError(null)
      const firstInvalid = FIELD_ORDER.find((field) => errors[field])
      if (firstInvalid) document.getElementById(FIELD_ID[firstInvalid])?.focus()
      return
    }
    setFieldErrors({})
    setFormError(null)
    const vatNumber = draft.vatNumber.trim()
    const receiptEmail = draft.receiptEmail.trim()
    const billingAddress = addressPayload(draft.billing, details?.billing_address)
    const shippingAddress = draft.shippingSameAsBilling
      ? billingAddress
      : addressPayload(draft.shipping, details?.shipping_address)
    const result = await save({
      legal_name: draft.legalName.trim(),
      country: draft.country.trim().toUpperCase(),
      org_number: draft.orgNumber.trim(),
      vat_number: vatNumber === '' ? null : vatNumber.toUpperCase(),
      // #4870: blank clears (`null`), a value is stored as typed.
      receipt_email: receiptEmail === '' ? null : receiptEmail,
      billing_address: billingAddress,
      shipping_address: shippingAddress,
    })
    if (result.ok) {
      setSaved(true)
      return
    }
    if (result.code === 'validation') {
      const field = BACKEND_VALIDATION_FIELD[result.message]
      if (field) {
        setFieldErrors({ [field]: result.message })
        document.getElementById(FIELD_ID[field])?.focus()
        return
      }
      setFormError(result.message)
      return
    }
    if (result.code === 'rate_limited') {
      setFormError(copy.saveRateLimited)
      return
    }
    if (result.code === 'feature_off') {
      setFormError(copy.featureOff)
      return
    }
    setFormError(copy.saveError)
  }

  // Design review 11/12: the badge (and "Check again") describe the SAVED
  // VAT number — while the field has been edited away from it, hide both
  // rather than let the status read as being about the box on screen.
  const savedVatNumber = details?.vat_number ?? ''
  const vatEdited = draft.vatNumber.trim().toUpperCase() !== savedVatNumber
  const vies = vatEdited
    ? null
    : viesBadge(copy.vies, details?.vies_status ?? null, pollTimedOut)
  // Only `valid` carries the date, and only when there is one to show —
  // the date sits BESIDE the badge (#4359's spec table).
  const viesCheckedDate =
    details?.vies_status === 'valid' && !vatEdited && details?.vies_checked_at
      ? formatCheckedDate(details.vies_checked_at)
      : null
  const hasVatNumber = Boolean(details?.vat_number)
  const viesPending = details?.vies_status === 'pending' && !vatEdited
  // #3332 review M1: once the poll's 60s bound elapses a still-pending check
  // gets an action instead of a frozen "Checking…" forever; hidden only
  // while a poll tick is actually in flight.
  const showCheckAgain = !vatEdited && hasVatNumber && (!viesPending || pollTimedOut)

  // 'empty' shows the "No company details" state until Add company details
  // reveals the form (#4359); 'ready' shows the filled form directly.
  const showForm = status === 'ready' || (status === 'empty' && adding)

  /**
   * One address block. `fieldset`/`legend` is the native grouping for a set
   * of inputs that belong together — no new pattern, and the legend is what
   * a screen reader announces before the first field.
   */
  function renderAddress(key: AddressKey, title: string) {
    const address = draft[key]
    const label = (field: AddressField) => copy.addresses[`${key}.${field}`]
    return (
      <fieldset className="space-y-3 border-0 p-0" data-testid={`company-details-${key}-address`}>
        <legend className="text-sm font-medium text-[var(--v2-ink)]">{title}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor={FIELD_ID[`${key}.line1`]} className="block text-sm font-medium text-[var(--v2-ink)]">
              {label('line1')}
            </label>
            <Input
              id={FIELD_ID[`${key}.line1`]}
              value={address.line1}
              onChange={(event) => onAddressChange(key, 'line1', event.target.value)}
              placeholder={copy.addresses.line1Placeholder}
              invalid={Boolean(fieldError(`${key}.line1`))}
              maxLength={ADDRESS_MAX.line1}
              className="mt-1"
              autoComplete="off"
              aria-describedby={fieldError(`${key}.line1`) ? `${FIELD_ID[`${key}.line1`]}-error` : undefined}
            />
            {fieldError(`${key}.line1`) ? (
              <InlineAlert id={`${FIELD_ID[`${key}.line1`]}-error`}>{fieldError(`${key}.line1`)}</InlineAlert>
            ) : null}
          </div>

          <div className="sm:col-span-2">
            <label htmlFor={FIELD_ID[`${key}.line2`]} className="block text-sm font-medium text-[var(--v2-ink)]">
              {label('line2')}
            </label>
            <Input
              id={FIELD_ID[`${key}.line2`]}
              value={address.line2}
              onChange={(event) => onAddressChange(key, 'line2', event.target.value)}
              placeholder={copy.addresses.line2Placeholder}
              invalid={Boolean(fieldError(`${key}.line2`))}
              maxLength={ADDRESS_MAX.line2}
              className="mt-1"
              autoComplete="off"
              aria-describedby={fieldError(`${key}.line2`) ? `${FIELD_ID[`${key}.line2`]}-error` : undefined}
            />
            {fieldError(`${key}.line2`) ? (
              <InlineAlert id={`${FIELD_ID[`${key}.line2`]}-error`}>{fieldError(`${key}.line2`)}</InlineAlert>
            ) : null}
          </div>

          <div>
            <label htmlFor={FIELD_ID[`${key}.postCode`]} className="block text-sm font-medium text-[var(--v2-ink)]">
              {label('postCode')}
            </label>
            <Input
              id={FIELD_ID[`${key}.postCode`]}
              value={address.postCode}
              onChange={(event) => onAddressChange(key, 'postCode', event.target.value)}
              placeholder={copy.addresses.postCodePlaceholder}
              invalid={Boolean(fieldError(`${key}.postCode`))}
              maxLength={ADDRESS_MAX.postCode}
              className="mt-1"
              autoComplete="off"
              aria-describedby={fieldError(`${key}.postCode`) ? `${FIELD_ID[`${key}.postCode`]}-error` : undefined}
            />
            {fieldError(`${key}.postCode`) ? (
              <InlineAlert id={`${FIELD_ID[`${key}.postCode`]}-error`}>{fieldError(`${key}.postCode`)}</InlineAlert>
            ) : null}
          </div>

          <div>
            <label htmlFor={FIELD_ID[`${key}.city`]} className="block text-sm font-medium text-[var(--v2-ink)]">
              {label('city')}
            </label>
            <Input
              id={FIELD_ID[`${key}.city`]}
              value={address.city}
              onChange={(event) => onAddressChange(key, 'city', event.target.value)}
              placeholder={copy.addresses.cityPlaceholder}
              invalid={Boolean(fieldError(`${key}.city`))}
              maxLength={ADDRESS_MAX.city}
              className="mt-1"
              autoComplete="off"
              aria-describedby={fieldError(`${key}.city`) ? `${FIELD_ID[`${key}.city`]}-error` : undefined}
            />
            {fieldError(`${key}.city`) ? (
              <InlineAlert id={`${FIELD_ID[`${key}.city`]}-error`}>{fieldError(`${key}.city`)}</InlineAlert>
            ) : null}
          </div>

          <div>
            <label htmlFor={FIELD_ID[`${key}.country`]} className="block text-sm font-medium text-[var(--v2-ink)]">
              {label('country')}
            </label>
            <Select
              id={FIELD_ID[`${key}.country`]}
              value={address.country}
              onChange={(event) => onAddressChange(key, 'country', event.target.value.toUpperCase())}
              className="mt-1"
              aria-invalid={Boolean(fieldError(`${key}.country`)) || undefined}
              aria-describedby={fieldError(`${key}.country`) ? `${FIELD_ID[`${key}.country`]}-error` : undefined}
            >
              <option value="">{copy.addresses.countryPlaceholder}</option>
              {countryOptions(address.country).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            {fieldError(`${key}.country`) ? (
              <InlineAlert id={`${FIELD_ID[`${key}.country`]}-error`}>{fieldError(`${key}.country`)}</InlineAlert>
            ) : null}
          </div>
        </div>
      </fieldset>
    )
  }

  return (
    <SettingsSection title={copy.title} description={copy.description}>
      <div className="space-y-4 px-6 py-4">
        <p className="text-sm text-[var(--v2-ink-3)]" data-testid="company-details-purpose">
          {copy.purpose}
        </p>

        {justRemoved ? (
          <p
            ref={removedNoticeRef}
            role="status"
            tabIndex={-1}
            className="text-sm font-medium text-[var(--v2-success)]"
          >
            {copy.remove.removed}
          </p>
        ) : null}

        {showForm ? (
          <form onSubmit={(event) => void submit(event)} className="space-y-4" data-testid="company-details-form">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor={FIELD_ID.legalName} className="block text-sm font-medium text-[var(--v2-ink)]">
                  {copy.fields.legalName}
                </label>
                <Input
                  id={FIELD_ID.legalName}
                  value={draft.legalName}
                  onChange={(event) => onFieldChange((d) => ({ ...d, legalName: event.target.value }))}
                  placeholder={copy.fields.legalNamePlaceholder}
                  invalid={Boolean(fieldError('legalName'))}
                  maxLength={200}
                  className="mt-1"
                  aria-describedby={fieldError('legalName') ? `${FIELD_ID.legalName}-error` : undefined}
                />
                {fieldError('legalName') ? (
                  <InlineAlert id={`${FIELD_ID.legalName}-error`}>{fieldError('legalName')}</InlineAlert>
                ) : null}
              </div>

              <div>
                <label htmlFor={FIELD_ID.country} className="block text-sm font-medium text-[var(--v2-ink)]">
                  {copy.fields.country}
                </label>
                {/* Native `<select>` — browser typeahead does the finding; no
                    search UI (#4359: a combobox would be a new pattern). The
                    saved value is always among the options, including one
                    appended for a code outside the assigned list. */}
                <Select
                  id={FIELD_ID.country}
                  value={draft.country}
                  onChange={(event) => onFieldChange((d) => ({ ...d, country: event.target.value.toUpperCase() }))}
                  className="mt-1"
                  aria-invalid={Boolean(fieldError('country')) || undefined}
                  aria-describedby={fieldError('country') ? `${FIELD_ID.country}-error` : undefined}
                >
                  <option value="">{copy.fields.countryPlaceholder}</option>
                  {countryOptions(draft.country).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
                {fieldError('country') ? (
                  <InlineAlert id={`${FIELD_ID.country}-error`}>{fieldError('country')}</InlineAlert>
                ) : null}
              </div>

              <div>
                <label htmlFor={FIELD_ID.orgNumber} className="block text-sm font-medium text-[var(--v2-ink)]">
                  {copy.fields.orgNumber}
                </label>
                <Input
                  id={FIELD_ID.orgNumber}
                  value={draft.orgNumber}
                  onChange={(event) => onFieldChange((d) => ({ ...d, orgNumber: event.target.value }))}
                  placeholder={copy.fields.orgNumberPlaceholder}
                  invalid={Boolean(fieldError('orgNumber'))}
                  maxLength={32}
                  helperText={fieldError('orgNumber') ?? copy.fields.orgNumberHelp}
                  helperTextId={`${FIELD_ID.orgNumber}-help`}
                  className="mt-1"
                  autoComplete="off"
                  aria-describedby={`${FIELD_ID.orgNumber}-help`}
                />
              </div>

              <div>
                <label htmlFor={FIELD_ID.vatNumber} className="block text-sm font-medium text-[var(--v2-ink)]">
                  {copy.fields.vatNumber}
                </label>
                <Input
                  id={FIELD_ID.vatNumber}
                  value={draft.vatNumber}
                  onChange={(event) => onFieldChange((d) => ({ ...d, vatNumber: event.target.value }))}
                  placeholder={copy.fields.vatNumberPlaceholder}
                  invalid={Boolean(fieldError('vatNumber'))}
                  maxLength={32}
                  helperText={fieldError('vatNumber') ?? copy.fields.vatNumberHelp}
                  helperTextId={`${FIELD_ID.vatNumber}-help`}
                  className="mt-1"
                  autoComplete="off"
                  aria-describedby={`${FIELD_ID.vatNumber}-help`}
                />
              </div>

              <div className="sm:col-span-2">
                <label htmlFor={FIELD_ID.receiptEmail} className="block text-sm font-medium text-[var(--v2-ink)]">
                  {copy.fields.receiptEmail}
                </label>
                <Input
                  id={FIELD_ID.receiptEmail}
                  type="email"
                  value={draft.receiptEmail}
                  onChange={(event) => onFieldChange((d) => ({ ...d, receiptEmail: event.target.value }))}
                  placeholder={copy.fields.receiptEmailPlaceholder}
                  invalid={Boolean(fieldError('receiptEmail'))}
                  maxLength={MAX_RECEIPT_EMAIL_LENGTH}
                  helperText={fieldError('receiptEmail') ?? copy.fields.receiptEmailHelp}
                  helperTextId={`${FIELD_ID.receiptEmail}-help`}
                  className="mt-1"
                  autoComplete="off"
                  aria-describedby={`${FIELD_ID.receiptEmail}-help`}
                />
              </div>
            </div>

            {renderAddress('billing', copy.addresses.billingTitle)}

            <Checkbox
              label={copy.addresses.sameAsBilling}
              checked={draft.shippingSameAsBilling}
              onChange={(event) =>
                onFieldChange((d) => ({ ...d, shippingSameAsBilling: event.target.checked }))
              }
            />

            {draft.shippingSameAsBilling ? null : renderAddress('shipping', copy.addresses.shippingTitle)}

            {vies ? (
              <div className="flex flex-wrap items-center gap-3" data-testid="vies-status-line">
                <StatusBadge tone={vies.tone}>{vies.label}</StatusBadge>
                {viesCheckedDate ? <span className="text-sm text-[var(--v2-ink-2)]">{viesCheckedDate}</span> : null}
                {showCheckAgain ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={checkingVies}
                    aria-busy={checkingVies}
                    onClick={() => void recheckVies()}
                  >
                    {checkingVies ? copy.vies.checking : copy.vies.checkAgain}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {viesCheckError ? (
              <InlineAlert>
                {viesCheckError.code === 'rate_limited'
                  ? copy.vies.rateLimited
                  : viesCheckError.code === 'feature_off'
                    ? copy.vies.featureOff
                    : viesCheckError.code === 'no_vat_number'
                      ? copy.vies.noVatNumber
                      : copy.vies.checkError}
              </InlineAlert>
            ) : null}

            {/* The footer row: the destructive trigger on the LEFT, Save on
                the RIGHT (#4359). The trigger keeps its name — "Remove
                company details", no ellipsis — so tests and muscle memory
                keep selecting on it, and stays `ghost`: `tertiary` reads as
                a secondary CTA (past design review on #3332). The confirm
                modal below is unchanged. */}
            <div className="flex flex-wrap items-center justify-between gap-3" data-testid="company-details-footer">
              {status === 'ready' ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="company-details-remove"
                  onClick={() => {
                    resetDeleteError()
                    setConfirmingDelete(true)
                  }}
                >
                  {copy.remove.action}
                </Button>
              ) : (
                <span />
              )}
              <div className="flex flex-wrap items-center gap-3">
                {formError ? <InlineAlert>{formError}</InlineAlert> : null}
                {saved && !formError ? (
                  <p role="status" className="text-xs text-[var(--v2-success)]">
                    {copy.saved}
                  </p>
                ) : null}
                <Button type="submit" size="sm" disabled={saving} aria-busy={saving}>
                  {saving ? copy.saving : copy.save}
                </Button>
              </div>
            </div>
          </form>
        ) : (
          // 'empty' and not yet adding: one line plus the reveal (#4359).
          // The purpose line above is always visible — it is what the owner
          // is agreeing to by filling the form in (owner-company-details.md).
          <div className="space-y-3" data-testid="company-details-empty">
            <p className="text-sm text-[var(--v2-ink-2)]">{copy.empty.line}</p>
            <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
              {copy.empty.add}
            </Button>
          </div>
        )}
      </div>

      {confirmingDelete ? (
        <ConfirmDialog
          open
          onCancel={() => {
            setConfirmingDelete(false)
            resetDeleteError()
          }}
          onConfirm={() =>
            remove().then((result) => {
              if (result.ok) {
                setConfirmingDelete(false)
                setSaved(false)
                setAdding(false)
                setJustRemoved(true)
              }
            })
          }
          title={copy.remove.confirmTitle}
          body={copy.remove.confirmBody}
          confirmLabel={copy.remove.confirm}
          cancelLabel={copy.remove.cancel}
          tone="danger"
          loading={deleting}
          busyLabel={copy.remove.deleting}
          error={deleteError ? <InlineAlert>{copy.remove.error}</InlineAlert> : null}
        />
      ) : null}
    </SettingsSection>
  )
}

export default CompanyDetailsCard
