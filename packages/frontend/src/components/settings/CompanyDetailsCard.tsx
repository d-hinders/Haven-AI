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
 * (`owner-company-details.md`: the purpose and retention text is shown
 * above the form, always).
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
 * ── VIES ─────────────────────────────────────────────────────────────────
 * The status renders as a `StatusBadge` plus the checked date and "Check
 * again" (#4359). The badge follows the product doc's naming discipline:
 * "checked against VIES", never "verified" — see
 * `docs/product/owner-company-details.md` § The VIES states. The badge —
 * and "Check again" — are about the SAVED VAT number, so both hide while
 * the VAT field has been edited to something else (design review 11/12).
 * The hook polls while `pending`, bounded; once the bound elapses "Check
 * again" replaces the frozen "Checking…" badge (#3332 review M1).
 *
 * ── Validation ───────────────────────────────────────────────────────────
 * Client-side checks mirror the backend's own allowed-character rules
 * (`ORG_NUMBER_RE`/`CONTROL_CHAR_RE` in `modules/owner-profile/service.ts`)
 * so a rejected value names the actual cause instead of a generic one. Any
 * 400 that still reaches the backend is mapped from its own message text
 * back onto the field it describes (no API change — the backend has no
 * field code on the wire, only the message), and the first invalid field
 * gets focus on submit (design review 3).
 *
 * ── Delete ───────────────────────────────────────────────────────────────
 * "Remove company details" asks for confirmation (the same `Modal` +
 * danger-button shape `ConnectionsCard`'s Disconnect dialog uses) before
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
import { Button } from '@/components/ui/Button'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
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
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/

type FieldKey = 'legalName' | 'country' | 'orgNumber' | 'vatNumber'

const FIELD_ID: Record<FieldKey, string> = {
  legalName: 'company-legal-name',
  country: 'company-country',
  orgNumber: 'company-org-number',
  vatNumber: 'company-vat-number',
}

const FIELD_ORDER: FieldKey[] = ['legalName', 'country', 'orgNumber', 'vatNumber']

interface Draft {
  legalName: string
  country: string
  orgNumber: string
  vatNumber: string
}

function draftFrom(details: CompanyDetailsRow | null): Draft {
  return {
    legalName: details?.legal_name ?? '',
    country: details?.country ?? '',
    orgNumber: details?.org_number ?? '',
    vatNumber: details?.vat_number ?? '',
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

  return errors
}

// The backend has no field CODE on the wire (`VALIDATION_MESSAGES` in
// `routes/owner-company-details.ts` sends only the message) — this maps its
// four known, stable message strings back onto the field each describes, so
// a 400 that reaches the backend (chiefly the VAT shape check, which is not
// duplicated client-side) still lands under the right field rather than a
// generic banner (design review 3, "no API change").
const BACKEND_VALIDATION_FIELD: Record<string, FieldKey> = {
  'Enter a legal name using 200 characters or fewer.': 'legalName',
  'Country must be a two-letter ISO 3166-1 code, e.g. "SE".': 'country',
  'Enter an organisation number using 32 characters or fewer.': 'orgNumber',
  'Enter a VAT number as a two-letter country prefix followed by up to 20 letters or digits.': 'vatNumber',
}

export function CompanyDetailsCard() {
  const t = useT()
  const copy = t.settings.companyDetails
  const { company } = useBusinessData()
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

  const [draft, setDraft] = useState<Draft>(() => draftFrom(details))
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
  useEffect(() => {
    setDraft(draftFrom(details))
    setTouched(false)
    setFieldErrors({})
  }, [details?.legal_name, details?.country, details?.org_number, details?.vat_number])

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
  // both in red, which read as the same point made twice. The three fields
  // below pass `helperText={fieldError(field) ?? copy.fields.xHelp}` for
  // exactly this reason, always a truthy string, so `Input`'s conditional
  // `if (!helperText) return inputEl` branch never flips: the helper
  // paragraph — and the `<input>` beside it — stay the same element across
  // the invalid/valid transition instead of a structural change React
  // reconciles as a different subtree, which was unmounting and
  // recreating the `<input>` DOM node on that transition and silently
  // dropping the focus this same code path sets right after (caught by the
  // round-2 fix pass, not by design review 2 itself — a mutation of the
  // "focuses it" assertion in the VAT-shape-400 test would have caught it
  // too, and does now).

  function onFieldChange(mutate: (draft: Draft) => Draft) {
    setDraft(mutate)
    setSaved(false)
    setJustRemoved(false)
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
    const result = await save({
      legal_name: draft.legalName.trim(),
      country: draft.country.trim().toUpperCase(),
      org_number: draft.orgNumber.trim(),
      vat_number: vatNumber === '' ? null : vatNumber.toUpperCase(),
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
            </div>

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
        <Modal
          open
          onClose={() => {
            setConfirmingDelete(false)
            resetDeleteError()
          }}
          title={copy.remove.confirmTitle}
          closeOnBackdrop={!deleting}
          closeOnEscape={!deleting}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setConfirmingDelete(false)
                  resetDeleteError()
                }}
                disabled={deleting}
              >
                {copy.remove.cancel}
              </Button>
              <Button
                variant="danger"
                disabled={deleting}
                aria-busy={deleting}
                onClick={() => {
                  void remove().then((result) => {
                    if (result.ok) {
                      setConfirmingDelete(false)
                      setSaved(false)
                      setAdding(false)
                      setJustRemoved(true)
                    }
                  })
                }}
              >
                {copy.remove.confirm}
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <p>{copy.remove.confirmBody}</p>
            {deleteError ? <InlineAlert>{copy.remove.error}</InlineAlert> : null}
          </div>
        </Modal>
      ) : null}
    </SettingsSection>
  )
}

export default CompanyDetailsCard
