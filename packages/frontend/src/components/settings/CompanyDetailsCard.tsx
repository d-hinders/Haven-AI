'use client'

/**
 * Settings → Company details (#3332), behind `HAVEN_OWNER_COMPANY_DETAILS`.
 *
 * ── Gating ───────────────────────────────────────────────────────────────
 * `useCompanyDetails`'s `status` decides everything this component renders:
 * `'off'` renders nothing at all (the section does not exist on this
 * deployment); `'loading'` a skeleton; `'error'` a retry state (never a blank
 * crash); `'empty'`/`'ready'` the form, pre-filled from `details` when it is
 * `'ready'`.
 *
 * ── VIES ─────────────────────────────────────────────────────────────────
 * The status line under the VAT field follows the product doc's naming
 * discipline: "checked against VIES", never "verified" — see
 * `docs/product/owner-company-details.md` § The VIES states. The hook polls
 * while `pending`; "Check again" re-triggers a check on demand.
 *
 * ── Delete ───────────────────────────────────────────────────────────────
 * "Remove company details" asks for confirmation (the same `Modal` +
 * danger-button shape `ConnectionsCard`'s Disconnect dialog uses) before
 * calling `DELETE /user/company-details`; success resets the form to empty.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { useT } from '@/context/LocaleContext'
import { Button } from '@/components/ui/Button'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Skeleton } from '@/components/ui/Skeleton'
import { SettingsSection } from '@/app/(authenticated)/settings/SettingsSection'
import { useCompanyDetails, type CompanyDetails, type ViesStatus } from '@/hooks/useCompanyDetails'

const COUNTRY_RE = /^[A-Za-z]{2}$/

interface Draft {
  legalName: string
  country: string
  orgNumber: string
  vatNumber: string
}

function draftFrom(details: CompanyDetails | null): Draft {
  return {
    legalName: details?.legal_name ?? '',
    country: details?.country ?? '',
    orgNumber: details?.org_number ?? '',
    vatNumber: details?.vat_number ?? '',
  }
}

function formatCheckedDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric' }).format(date)
}

/** Exported for the copy-lint "never verified" mutation test to import directly. */
export function viesStatusLine(
  copy: {
    pending: string
    valid: (date: string) => string
    invalid: string
    notVerifiable: string
  },
  status: ViesStatus | null,
  checkedAt: string | null,
): string | null {
  if (status === 'pending') return copy.pending
  if (status === 'valid') return copy.valid(checkedAt ? formatCheckedDate(checkedAt) : '')
  if (status === 'invalid') return copy.invalid
  if (status === 'not_verifiable') return copy.notVerifiable
  return null
}

export function CompanyDetailsCard() {
  const t = useT()
  const copy = t.settings.companyDetails
  const {
    status,
    details,
    error,
    reload,
    save,
    saving,
    saveError,
    remove,
    deleting,
    deleteError,
    recheckVies,
    checkingVies,
    viesCheckError,
  } = useCompanyDetails()

  const [draft, setDraft] = useState<Draft>(() => draftFrom(details))
  const [touched, setTouched] = useState(false)
  const [saved, setSaved] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [clientError, setClientError] = useState<string | null>(null)

  // Re-seed the draft whenever the saved row changes underneath it (initial
  // load, a save, a delete, or a VIES poll tick landing) — never while the
  // owner has an untouched blank they are about to fill in for the first
  // time, and the draft's own pending edits are not clobbered by a VIES poll
  // tick, which changes `vies_status`/`vies_checked_at` but never the fields
  // this form owns.
  useEffect(() => {
    setDraft(draftFrom(details))
    setTouched(false)
  }, [details?.legal_name, details?.country, details?.org_number, details?.vat_number])

  if (status === 'off') return null

  if (status === 'loading') {
    return (
      <SettingsSection title={copy.title} description={copy.description}>
        <div className="space-y-3 px-6 py-4" role="status" aria-busy="true" aria-label={copy.title}>
          <Skeleton variant="text" className="h-5 w-48" />
          <Skeleton variant="text" className="h-4 w-full max-w-md" />
        </div>
      </SettingsSection>
    )
  }

  if (status === 'error') {
    return (
      <SettingsSection title={copy.title} description={copy.description}>
        <div className="space-y-3 px-6 py-4">
          <InlineAlert>{error ?? copy.loadError}</InlineAlert>
          <Button variant="tertiary" size="sm" onClick={() => void reload()}>
            {copy.retry}
          </Button>
        </div>
      </SettingsSection>
    )
  }

  const legalNameInvalid = touched && draft.legalName.trim().length === 0
  const countryInvalid = touched && !COUNTRY_RE.test(draft.country.trim())
  const orgNumberInvalid = touched && draft.orgNumber.trim().length === 0

  function clientValidationMessage(): string | null {
    const legalName = draft.legalName.trim()
    const country = draft.country.trim()
    const orgNumber = draft.orgNumber.trim()
    const vatNumber = draft.vatNumber.trim()
    if (legalName.length === 0) return copy.validation.legalNameRequired
    if (legalName.length > 200) return copy.validation.legalNameTooLong
    if (!COUNTRY_RE.test(country)) return copy.validation.countryInvalid
    if (orgNumber.length === 0) return copy.validation.orgNumberRequired
    if (orgNumber.length > 32) return copy.validation.orgNumberTooLong
    if (vatNumber.length > 32) return copy.validation.vatNumberTooLong
    return null
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    setSaved(false)
    const message = clientValidationMessage()
    if (message) {
      setClientError(message)
      return
    }
    setClientError(null)
    const vatNumber = draft.vatNumber.trim()
    const result = await save({
      legal_name: draft.legalName.trim(),
      country: draft.country.trim().toUpperCase(),
      org_number: draft.orgNumber.trim(),
      vat_number: vatNumber === '' ? null : vatNumber.toUpperCase(),
    })
    if (result.ok) setSaved(true)
  }

  const saveErrorText =
    clientError ??
    (saveError?.code === 'validation'
      ? saveError.message
      : saveError?.code === 'rate_limited'
        ? copy.vies.rateLimited
        : saveError?.code === 'unknown'
          ? copy.saveError
          : null)

  const viesLine = viesStatusLine(copy.vies, details?.vies_status ?? null, details?.vies_checked_at ?? null)
  const hasVatNumber = Boolean(details?.vat_number)
  const viesPending = details?.vies_status === 'pending'

  return (
    <SettingsSection title={copy.title} description={copy.description}>
      <div className="space-y-4 px-6 py-4">
        <p className="text-sm text-[var(--v2-ink-3)]" data-testid="company-details-purpose">
          {copy.purpose}
        </p>

        <form onSubmit={(event) => void submit(event)} className="space-y-4" data-testid="company-details-form">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="company-legal-name" className="block text-sm font-medium text-[var(--v2-ink)]">
                {copy.fields.legalName}
              </label>
              <Input
                id="company-legal-name"
                value={draft.legalName}
                onChange={(event) => {
                  setDraft((d) => ({ ...d, legalName: event.target.value }))
                  setSaved(false)
                }}
                placeholder={copy.fields.legalNamePlaceholder}
                invalid={legalNameInvalid}
                maxLength={200}
                className="mt-1"
              />
            </div>

            <div>
              <label htmlFor="company-country" className="block text-sm font-medium text-[var(--v2-ink)]">
                {copy.fields.country}
              </label>
              <Input
                id="company-country"
                value={draft.country}
                onChange={(event) => {
                  setDraft((d) => ({ ...d, country: event.target.value.toUpperCase() }))
                  setSaved(false)
                }}
                placeholder={copy.fields.countryPlaceholder}
                invalid={countryInvalid}
                maxLength={2}
                helperText={copy.fields.countryHelp}
                className="mt-1"
              />
            </div>

            <div>
              <label htmlFor="company-org-number" className="block text-sm font-medium text-[var(--v2-ink)]">
                {copy.fields.orgNumber}
              </label>
              <Input
                id="company-org-number"
                value={draft.orgNumber}
                onChange={(event) => {
                  setDraft((d) => ({ ...d, orgNumber: event.target.value }))
                  setSaved(false)
                }}
                placeholder={copy.fields.orgNumberPlaceholder}
                invalid={orgNumberInvalid}
                maxLength={32}
                helperText={copy.fields.orgNumberHelp}
                className="mt-1"
              />
            </div>

            <div>
              <label htmlFor="company-vat-number" className="block text-sm font-medium text-[var(--v2-ink)]">
                {copy.fields.vatNumber}
              </label>
              <Input
                id="company-vat-number"
                value={draft.vatNumber}
                onChange={(event) => {
                  setDraft((d) => ({ ...d, vatNumber: event.target.value }))
                  setSaved(false)
                }}
                placeholder={copy.fields.vatNumberPlaceholder}
                maxLength={32}
                helperText={copy.fields.vatNumberHelp}
                className="mt-1"
              />
            </div>
          </div>

          {viesLine ? (
            <div className="flex flex-wrap items-center gap-3" data-testid="vies-status-line">
              <p role="status" className="text-sm text-[var(--v2-ink-2)]">
                {viesLine}
              </p>
              {hasVatNumber && !viesPending ? (
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
              {viesCheckError.code === 'rate_limited' ? copy.vies.rateLimited : copy.vies.checkError}
            </InlineAlert>
          ) : null}

          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={saving} aria-busy={saving}>
              {saving ? copy.saving : copy.save}
            </Button>
            {saveErrorText ? <InlineAlert>{saveErrorText}</InlineAlert> : null}
            {saved && !saveErrorText ? (
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
            {deleteError ? <InlineAlert>{copy.remove.error}</InlineAlert> : null}
          </div>
        ) : null}
      </div>

      {confirmingDelete ? (
        <Modal
          open
          onClose={() => setConfirmingDelete(false)}
          title={copy.remove.confirmTitle}
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
                    if (result.ok) setConfirmingDelete(false)
                  })
                }}
              >
                {copy.remove.confirm}
              </Button>
            </>
          }
        >
          <p>{copy.remove.confirmBody}</p>
        </Modal>
      ) : null}
    </SettingsSection>
  )
}

export default CompanyDetailsCard
