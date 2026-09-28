'use client'

/**
 * Settings → Company details (#3332), behind `HAVEN_OWNER_COMPANY_DETAILS`.
 *
 * ── Gating ───────────────────────────────────────────────────────────────
 * `useCompanyDetails`'s `status` decides everything this component renders:
 * `'off'` AND `'loading'` render nothing at all (design review 7 — no
 * title/skeleton flash while the first read is in flight, so a flag-off
 * deployment never shows a title for a section that does not exist);
 * `'error'` a retry state (never a blank crash); `'empty'`/`'ready'` the
 * form, pre-filled from `details` when it is `'ready'`.
 *
 * ── VIES ─────────────────────────────────────────────────────────────────
 * The status line under the VAT field follows the product doc's naming
 * discipline: "checked against VIES", never "verified" — see
 * `docs/product/owner-company-details.md` § The VIES states. The hook polls
 * while `pending`, bounded; once the bound elapses "Check again" replaces
 * the frozen "Checking…" line (#3332 review M1) rather than leaving the
 * owner with no action. The line — and "Check again" — are about the SAVED
 * VAT number, so both hide while the VAT field has been edited to something
 * else (design review 11/12).
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
 * the request is in flight; success closes the dialog, resets the form to
 * empty and announces "Company details removed." (design review 6).
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useT } from '@/context/LocaleContext'
import { Button } from '@/components/ui/Button'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { SettingsSection } from '@/app/(authenticated)/settings/SettingsSection'
import { useCompanyDetails, type CompanyDetailsRow, type ViesStatus } from '@/hooks/useCompanyDetails'

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
export function viesStatusLine(
  copy: {
    pending: string
    valid: (date: string) => string
    validNoDate: string
    invalid: string
    notVerifiable: string
  },
  status: ViesStatus | null,
  checkedAt: string | null,
): string | null {
  if (status === 'pending') return copy.pending
  // A `valid` row with no `checkedAt` (e.g. #3332 review m1's stale-pending
  // re-trigger path landing the outcome without a VIES-answer timestamp)
  // never renders a dangling "on" with nothing after it.
  if (status === 'valid') return checkedAt ? copy.valid(formatCheckedDate(checkedAt)) : copy.validNoDate
  if (status === 'invalid') return copy.invalid
  if (status === 'not_verifiable') return copy.notVerifiable
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
  const {
    status,
    details,
    reload,
    save,
    saving,
    remove,
    deleting,
    deleteError,
    recheckVies,
    checkingVies,
    viesCheckError,
    pollTimedOut,
  } = useCompanyDetails()

  const [draft, setDraft] = useState<Draft>(() => draftFrom(details))
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
          <Button variant="tertiary" size="sm" onClick={() => void reload()}>
            {copy.retry}
          </Button>
        </div>
      </SettingsSection>
    )
  }

  function fieldError(field: FieldKey): string | null {
    return touched ? (fieldErrors[field] ?? null) : null
  }

  function fieldDescribedBy(field: FieldKey, helpId: string): string | undefined {
    const errorId = `${FIELD_ID[field]}-error`
    return fieldError(field) ? `${helpId} ${errorId}` : helpId
  }

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
      setFormError(copy.vies.rateLimited)
      return
    }
    if (result.code === 'feature_off') {
      setFormError(copy.featureOff)
      return
    }
    setFormError(copy.saveError)
  }

  // Design review 11/12: the VIES line (and "Check again") describe the
  // SAVED VAT number — while the field has been edited away from it, hide
  // both rather than let the status read as being about the box on screen.
  const savedVatNumber = details?.vat_number ?? ''
  const vatEdited = draft.vatNumber.trim().toUpperCase() !== savedVatNumber
  const viesLine = vatEdited ? null : viesStatusLine(copy.vies, details?.vies_status ?? null, details?.vies_checked_at ?? null)
  const hasVatNumber = Boolean(details?.vat_number)
  const viesPending = details?.vies_status === 'pending' && !vatEdited
  // #3332 review M1: once the poll's 60s bound elapses a still-pending check
  // gets an action instead of a frozen "Checking…" forever; hidden only
  // while a poll tick is actually in flight.
  const showCheckAgain = !vatEdited && hasVatNumber && (!viesPending || pollTimedOut)

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
              <Input
                id={FIELD_ID.country}
                value={draft.country}
                onChange={(event) => onFieldChange((d) => ({ ...d, country: event.target.value.toUpperCase() }))}
                placeholder={copy.fields.countryPlaceholder}
                invalid={Boolean(fieldError('country'))}
                maxLength={2}
                helperText={copy.fields.countryHelp}
                helperTextId={`${FIELD_ID.country}-help`}
                className="mt-1"
                aria-describedby={fieldDescribedBy('country', `${FIELD_ID.country}-help`)}
              />
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
                helperText={copy.fields.orgNumberHelp}
                helperTextId={`${FIELD_ID.orgNumber}-help`}
                className="mt-1"
                autoComplete="off"
                aria-describedby={fieldDescribedBy('orgNumber', `${FIELD_ID.orgNumber}-help`)}
              />
              {fieldError('orgNumber') ? (
                <InlineAlert id={`${FIELD_ID.orgNumber}-error`}>{fieldError('orgNumber')}</InlineAlert>
              ) : null}
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
                helperText={copy.fields.vatNumberHelp}
                helperTextId={`${FIELD_ID.vatNumber}-help`}
                className="mt-1"
                autoComplete="off"
                aria-describedby={fieldDescribedBy('vatNumber', `${FIELD_ID.vatNumber}-help`)}
              />
              {fieldError('vatNumber') ? (
                <InlineAlert id={`${FIELD_ID.vatNumber}-error`}>{fieldError('vatNumber')}</InlineAlert>
              ) : null}
            </div>
          </div>

          {viesLine ? (
            <div className="flex flex-wrap items-center gap-3" data-testid="vies-status-line">
              <p role="status" className="text-sm text-[var(--v2-ink-2)]">
                {viesLine}
              </p>
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
                  : copy.vies.checkError}
            </InlineAlert>
          ) : null}

          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={saving} aria-busy={saving}>
              {saving ? copy.saving : copy.save}
            </Button>
            {formError ? <InlineAlert>{formError}</InlineAlert> : null}
            {saved && !formError ? (
              <p role="status" className="text-xs text-[var(--v2-success)]">
                {copy.saved}
              </p>
            ) : null}
          </div>
        </form>

        {status === 'ready' ? (
          <div className="border-t border-[var(--v2-border)] pt-4">
            <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(true)}>
              {copy.remove.action}
            </Button>
          </div>
        ) : null}
      </div>

      {confirmingDelete ? (
        <Modal
          open
          onClose={() => setConfirmingDelete(false)}
          title={copy.remove.confirmTitle}
          closeOnBackdrop={!deleting}
          closeOnEscape={!deleting}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmingDelete(false)} disabled={deleting}>
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
          <p>{copy.remove.confirmBody}</p>
          {deleteError ? <InlineAlert>{copy.remove.error}</InlineAlert> : null}
        </Modal>
      ) : null}
    </SettingsSection>
  )
}

export default CompanyDetailsCard
