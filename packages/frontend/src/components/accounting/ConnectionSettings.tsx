'use client'

/**
 * Per-connection feed settings, inline under the provider row (#2868,
 * backend #2867): the suggested account and the auto-feed toggle.
 *
 * The suggested account is a HINT. It rides the fed document's non-asserting
 * reference field (Fortnox: `YourReference: "suggested account 6540"`) and
 * never an account field — the accountant still chooses. The copy says so
 * next to the field, because a four-digit BAS number beside a Save button
 * reads as "this books to 6540" unless told otherwise.
 *
 * Errors surface INLINE, next to the setting they are about: a 400
 * `INVALID_SETTING` names the `key` the backend refused, and the field-level
 * shape check (`^[1-8]\d{3}$` for Fortnox) runs first so the common typo
 * never leaves the browser. A refused patch applies nothing — the form keeps
 * the user's draft rather than snapping back.
 */
import { useState, type FormEvent } from 'react'
import { useT } from '@/context/LocaleContext'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { Input } from '@/components/ui/Input'
import {
  accountingRefusal,
  type AccountingConnection,
  type AccountingConnectionSettingsPatch,
} from '@/hooks/useAccounting'

/** Fortnox's rule for a BAS account (#2867): four digits, first 1–8. Other providers: 1–32 chars. */
const FORTNOX_ACCOUNT = /^[1-8]\d{3}$/

export function isValidSuggestedAccount(provider: string, value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '') return true
  if (provider === 'fortnox') return FORTNOX_ACCOUNT.test(trimmed)
  return trimmed.length <= 32
}

export interface ConnectionSettingsProps {
  connection: AccountingConnection
  onSave: (patch: AccountingConnectionSettingsPatch) => Promise<unknown>
}

export function ConnectionSettings({ connection, onSave }: ConnectionSettingsProps) {
  const t = useT()
  const copy = t.settings.accounting.settings
  const [account, setAccount] = useState(connection.settings.suggestedAccount ?? '')
  const [autoFeed, setAutoFeed] = useState(connection.settings.autoFeed)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const accountInvalid = !isValidSuggestedAccount(connection.provider, account)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaved(false)
    if (accountInvalid) {
      setError(copy.invalidSuggestedAccount)
      return
    }
    setError(null)
    setSaving(true)
    try {
      const trimmed = account.trim()
      await onSave({ suggested_account: trimmed === '' ? null : trimmed, auto_feed: autoFeed })
      setSaved(true)
    } catch (err) {
      const refusal = accountingRefusal(err)
      if (refusal.code === 'INVALID_SETTING') {
        setError(
          refusal.key === 'suggested_account'
            ? copy.invalidSuggestedAccount
            : copy.invalidSetting(refusal.key ?? 'settings'),
        )
      } else {
        setError(copy.error)
      }
    } finally {
      setSaving(false)
    }
  }

  const accountId = `suggested-account-${connection.provider}`
  const errorId = `${accountId}-error`

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="space-y-4 px-6 py-4"
      aria-label={copy.title}
      data-testid={`connection-settings-${connection.provider}`}
    >
      <h3 className="text-sm font-semibold text-[var(--v2-ink)]">{copy.title}</h3>

      <div className="max-w-xs">
        <label htmlFor={accountId} className="block text-sm font-medium text-[var(--v2-ink)]">
          {copy.suggestedAccountLabel}
        </label>
        <Input
          id={accountId}
          value={account}
          onChange={(event) => {
            setAccount(event.target.value)
            setSaved(false)
          }}
          placeholder={copy.suggestedAccountPlaceholder}
          inputMode="numeric"
          invalid={accountInvalid}
          aria-describedby={error ? errorId : undefined}
          helperText={copy.suggestedAccountHelp}
          className="mt-1"
        />
      </div>

      <Checkbox
        label={copy.autoFeedLabel}
        helperText={copy.autoFeedHelp}
        checked={autoFeed}
        onChange={(event) => {
          setAutoFeed(event.target.checked)
          setSaved(false)
        }}
        className="text-sm text-[var(--v2-ink)]"
      />

      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={saving} aria-busy={saving}>
          {saving ? copy.saving : copy.save}
        </Button>
        {error ? <InlineAlert id={errorId}>{error}</InlineAlert> : null}
        {saved && !error ? (
          <p role="status" className="text-xs text-[var(--v2-success)]">
            {copy.saved}
          </p>
        ) : null}
      </div>
    </form>
  )
}

export default ConnectionSettings
