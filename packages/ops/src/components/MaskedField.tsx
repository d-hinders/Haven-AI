'use client'

/**
 * The masked-field frame (#3516).
 *
 * The value arrives masked from the backend (`da•••@gmail.com`); the reveal
 * control is the ONE way an unmasked value enters this component, it goes
 * through `POST /ops/reveal` (audited server-side), it lives in component
 * state ONLY — never a store, never a cache, never written anywhere — and it
 * is dropped on unmount, so navigating away re-masks (the AC).
 *
 * `busy` is set for the whole call: a second click cannot race a reveal in
 * flight, and a failed reveal keeps the masked value with the error shown.
 */
import { useEffect, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Button } from '@haven_ai/ui'
import type { OpsRead } from '../lib/ops-client'
import type { OpsRevealRequest, OpsRevealResponse } from '../lib/ops-types'

/** The reveal call the frame makes. Injected, so tests observe it once. */
export type RevealFn = (request: OpsRevealRequest) => Promise<OpsRead<OpsRevealResponse>>

export function MaskedField({
  label,
  masked,
  nullable,
  request,
  reveal,
  className = '',
}: {
  label: string
  /** The masked string as the backend served it. */
  masked: string
  /** True when the underlying value can be null (name) — renders "not set". */
  nullable?: boolean
  request: OpsRevealRequest
  reveal: RevealFn
  className?: string
}) {
  const [revealed, setRevealed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Re-mask on unmount is not an action to take — the state IS the revealed
  // value, so unmount destroys it. The guard makes the contract explicit and
  // gives a test a mount point to observe.
  useEffect(() => {
    return () => {
      setRevealed(null)
      setError(null)
    }
  }, [])

  if (nullable && masked === '') {
    return (
      <div className={className}>
        <p className="text-xs text-[var(--v2-ink-3)]">{label}</p>
        <p className="text-sm text-[var(--v2-ink-2)]">Not set</p>
      </div>
    )
  }

  const shown = revealed ?? masked
  return (
    <div className={className}>
      <p className="text-xs text-[var(--v2-ink-3)]">{label}</p>
      <div className="flex items-center gap-2">
        <span
          data-testid={`masked-value-${request.field}`}
          className="v2-tabular text-sm text-[var(--v2-ink)]"
        >
          {shown}
        </span>
        {revealed === null ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              if (busy) return
              setBusy(true)
              setError(null)
              // One call per click, no retries: the backend answers 403 on a
              // field reveal the operator is not allowed, and repeating it
              // would only re-audit the same refusal.
              reveal(request)
                .then((read) => {
                  if (read.ok && read.data.value !== null) {
                    setRevealed(read.data.value === '' ? '(empty)' : read.data.value)
                  } else if (read.ok) {
                    setError('The value could not be revealed.')
                  } else {
                    setError(read.error.message)
                  }
                })
                .catch(() => setError('The console could not reach the backend.'))
                .finally(() => setBusy(false))
            }}
            aria-label={`Reveal ${label}`}
          >
            <Eye aria-hidden className="h-3.5 w-3.5" />
            Reveal
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setRevealed(null)
              setError(null)
            }}
            aria-label={`Hide ${label}`}
          >
            <EyeOff aria-hidden className="h-3.5 w-3.5" />
            Hide
          </Button>
        )}
      </div>
      {error !== null ? (
        <p role="alert" className="mt-1 text-xs text-[var(--v2-danger)]">
          {error}
        </p>
      ) : null}
    </div>
  )
}
