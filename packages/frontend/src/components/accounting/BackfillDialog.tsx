'use client'

/**
 * The backfill choice on return from a first successful connect (#2868,
 * backend #2867).
 *
 * Every connection gets `feedFrom = now` at connect, so nothing settled
 * before it is fed unasked. This dialog is the ONE place the user can say
 * otherwise: "Feed from now" (the default — closes without a call, the
 * floor already stands) or "Include payments since <date>", which POSTs
 * `{ since }` to the backfill route.
 *
 * `since` is sent as the strict `YYYY-MM-DD` the route wants — read straight
 * off a native date input (whose value IS that shape) and shape-checked
 * before the request, so a browser that lets free text through never earns
 * a `SINCE_INVALID` for a typo. The route's three refusals surface inline,
 * each with its own sentence: `SINCE_INVALID` (not a date, future, or before
 * 2020-01-01), `SINCE_NOT_EARLIER` (the floor is already earlier — nothing
 * to include), `NOT_ACTIVE` (not the destination). A refusal leaves the
 * dialog open with the choice intact.
 *
 * One call feeds at most 200 payments; the success line says how many, and
 * the intro points at Sync now for the rest.
 */
import { useState } from 'react'
import { useT } from '@/context/LocaleContext'
import { Button } from '@/components/ui/Button'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { accountingRefusal, type AccountingBackfillResult } from '@/hooks/useAccounting'

/** The route's `since` shape, checked here so a malformed value never leaves the browser. */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Today as `YYYY-MM-DD` in the user's own calendar, for the date input's `max`. */
function todayIsoDate(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

type Choice = 'now' | 'since'

export interface BackfillDialogProps {
  open: boolean
  providerName: string
  onClose: () => void
  /** `POST …/backfill { since }` — rejects with the `ApiRequestError` on a refusal. */
  onBackfill: (since: string) => Promise<AccountingBackfillResult>
}

export function BackfillDialog({ open, providerName, onClose, onBackfill }: BackfillDialogProps) {
  const t = useT()
  const copy = t.settings.accounting.backfill
  const [choice, setChoice] = useState<Choice>('now')
  const [since, setSince] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fed, setFed] = useState<number | null>(null)

  const confirm = async () => {
    if (choice === 'now') {
      onClose()
      return
    }
    if (!ISO_DATE.test(since)) {
      setError(copy.errors.SINCE_INVALID)
      return
    }
    setError(null)
    setBusy(true)
    try {
      const result = await onBackfill(since)
      setFed(result.fed)
    } catch (err) {
      const refusal = accountingRefusal(err)
      setError(
        refusal.code === 'SINCE_INVALID' || refusal.code === 'SINCE_NOT_EARLIER' || refusal.code === 'NOT_ACTIVE'
          ? copy.errors[refusal.code]
          : copy.errors.generic,
      )
    } finally {
      setBusy(false)
    }
  }

  const radioClass =
    'mt-0.5 h-4 w-4 shrink-0 accent-[var(--v2-brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)]'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={copy.title}
      subtitle={copy.intro(providerName)}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      footer={
        fed === null ? (
          <Button onClick={() => void confirm()} disabled={busy} aria-busy={busy}>
            {busy ? copy.working : copy.confirm}
          </Button>
        ) : (
          <Button onClick={onClose}>{copy.close}</Button>
        )
      }
    >
      {fed === null ? (
        <fieldset className="space-y-4" data-testid="backfill-choice">
          <legend className="sr-only">{copy.title}</legend>
          <label className="flex items-start gap-2 text-[var(--v2-ink)]">
            <input
              type="radio"
              name="backfill"
              value="now"
              checked={choice === 'now'}
              onChange={() => setChoice('now')}
              className={radioClass}
              disabled={busy}
            />
            <span>
              {copy.fromNow}
              <span className="mt-1 block text-[var(--v2-ink-3)]">{copy.fromNowHelp}</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-[var(--v2-ink)]">
            <input
              type="radio"
              name="backfill"
              value="since"
              checked={choice === 'since'}
              onChange={() => setChoice('since')}
              className={radioClass}
              disabled={busy}
            />
            <span className="min-w-0 flex-1">
              {copy.since}
              <span className="mt-1 block text-[var(--v2-ink-3)]">{copy.sinceHelp}</span>
              <span className="mt-2 block max-w-xs">
                <Input
                  type="date"
                  aria-label={copy.sinceLabel}
                  value={since}
                  max={todayIsoDate()}
                  min="2020-01-01"
                  onChange={(event) => {
                    setSince(event.target.value)
                    setChoice('since')
                    setError(null)
                  }}
                  disabled={busy}
                  invalid={error !== null && choice === 'since'}
                />
              </span>
            </span>
          </label>
          {error ? <InlineAlert>{error}</InlineAlert> : null}
        </fieldset>
      ) : (
        <p role="status" className="text-[var(--v2-ink)]">
          {copy.done(fed)}
        </p>
      )}
    </Modal>
  )
}

export default BackfillDialog
