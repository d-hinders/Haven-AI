'use client'

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { CodeBlock } from '@/components/ui/CodeBlock'
import { CopyButton } from '@/components/ui/CopyButton'
import { Input } from '@/components/ui/Input'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { Modal } from '@/components/ui/Modal'
import { Skeleton } from '@/components/ui/Skeleton'
import {
  getSubmissionStatus,
  submitCatalog,
  type CatalogSubmissionStatus,
} from '@/hooks/useCatalog'

/** How often the status panel re-checks a live submission (issue #1715). */
export const SUBMISSION_POLL_MS = 15_000

/** Mirrors the backend ceiling on `resource_url` (route catalog-submissions). */
const MAX_RESOURCE_URL_LENGTH = 2048

type Phase = 'form' | 'submitting' | 'error' | 'tracking' | 'listed' | 'failed' | 'delisted'

/**
 * Client-side validation for the resource URL field. Returns a calm, plain
 * message or null when the value is acceptable. The backend enforces the same
 * rules again; this only avoids a wasted round-trip.
 */
export function validateResourceUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return 'Enter the https URL of the payable endpoint.'
  if (trimmed.length > MAX_RESOURCE_URL_LENGTH) {
    return `Keep the URL under ${MAX_RESOURCE_URL_LENGTH} characters.`
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return 'Enter a valid https URL.'
  }
  if (parsed.protocol !== 'https:') return 'Use an https URL for your resource.'
  if (parsed.username !== '' || parsed.password !== '') {
    return 'Remove any username or password from the URL.'
  }
  if (!parsed.hostname) return 'Enter a URL with a hostname.'
  return null
}

/** The steps the submission moves through, in order (epic #1717). */
const STEPS: Array<{ key: string; label: string }> = [
  { key: 'submitted', label: 'Submitted' },
  { key: 'ownership_verified', label: 'Domain verified' },
  { key: 'verified_payable', label: 'Verified payable' },
  { key: 'listed', label: 'Listed' },
]

function stepIndex(status: CatalogSubmissionStatus['status']): number {
  if (status === 'submitted') return 0
  if (status === 'ownership_verified') return 1
  return 3 // verified_payable → the final "Listed" step
}

function StatusSteps({ status }: { status: CatalogSubmissionStatus['status'] }) {
  const current = stepIndex(status)
  return (
    <ol data-testid="submission-steps" className="space-y-2" aria-label="Submission progress">
      {STEPS.map((step, i) => {
        const isCurrent = i === current
        const done = i < current
        return (
          <li
            key={step.key}
            aria-current={isCurrent ? 'step' : undefined}
            className={`flex items-center gap-2 text-sm ${
              isCurrent
                ? 'font-medium text-[var(--v2-ink)]'
                : done
                  ? 'text-[var(--v2-success)]'
                  : 'text-[var(--v2-ink-3)]'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                isCurrent
                  ? 'bg-[var(--v2-brand)]'
                  : done
                    ? 'bg-[var(--v2-success)]'
                    : 'bg-[var(--v2-surface-2)]'
              }`}
            />
            {step.label}
          </li>
        )
      })}
    </ol>
  )
}

function InstructionRow({
  label,
  value,
  copyLabel,
}: {
  label: string
  value: string
  copyLabel: string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-xs text-[var(--v2-ink-3)]">{label}</span>
      <code className="v2-tabular min-w-0 flex-1 truncate rounded-md bg-[var(--v2-surface)] px-2 py-1.5 text-xs text-[var(--v2-ink-2)]">
        {value}
      </code>
      <CopyButton value={value} label={copyLabel} />
    </div>
  )
}

export default function CatalogSubmitModal({
  open,
  onClose,
  onVerifiedPayable,
}: {
  open: boolean
  onClose: () => void
  /** Called once the submission reaches verified_payable so the listing refreshes. */
  onVerifiedPayable?: () => void
}) {
  const [resourceUrl, setResourceUrl] = useState('')
  // Honeypot: visually hidden and expected to stay empty. Whatever it holds,
  // the value is never sent — the backend drops submissions that fill it.
  const [website, setWebsite] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const [phase, setPhase] = useState<Phase>('form')
  const [token, setToken] = useState<string | null>(null)
  const [submissionId, setSubmissionId] = useState<string | null>(null)
  const [status, setStatus] = useState<CatalogSubmissionStatus | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [pollError, setPollError] = useState(false)

  // Fresh form every time the modal opens; a previous run must not leak in.
  useEffect(() => {
    if (!open) return
    setPhase('form')
    setToken(null)
    setSubmissionId(null)
    setStatus(null)
    setFormError(null)
    setSubmitError(null)
    setPollError(false)
    setResourceUrl('')
    setWebsite('')
  }, [open])

  const applyStatus = useCallback(
    (next: CatalogSubmissionStatus) => {
      setStatus(next)
      setPollError(false)
      if (next.status === 'verified_payable') {
        setPhase('listed')
        onVerifiedPayable?.()
      } else if (next.status === 'failed') {
        setPhase('failed')
      } else if (next.status === 'delisted') {
        setPhase('delisted')
      } else {
        setPhase('tracking')
      }
    },
    [onVerifiedPayable],
  )

  // Poll while tracking. Terminal states (verified_payable / failed /
  // delisted) stop the loop via the phase change; a transient read failure
  // keeps polling and only surfaces a calm note.
  useEffect(() => {
    if (phase !== 'tracking' || !submissionId) return
    const timer = setInterval(async () => {
      try {
        const next = await getSubmissionStatus(submissionId)
        applyStatus(next)
      } catch {
        setPollError(true)
      }
    }, SUBMISSION_POLL_MS)
    return () => clearInterval(timer)
  }, [phase, submissionId, applyStatus])

  const handleSubmit = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault()
      const error = validateResourceUrl(resourceUrl)
      if (error) {
        setFormError(error)
        return
      }
      setFormError(null)
      setSubmitError(null)
      setPhase('submitting')
      try {
        const accepted = await submitCatalog(resourceUrl)
        setToken(accepted.verify_token ?? null)
        setSubmissionId(accepted.id)
        const next = await getSubmissionStatus(accepted.id)
        applyStatus(next)
      } catch (err) {
        setSubmitError(
          err instanceof Error ? err.message : 'We could not submit the service. Try again.',
        )
        setPhase('error')
      }
    },
    [resourceUrl, applyStatus],
  )

  const handleReset = useCallback(() => {
    setPhase('form')
    setToken(null)
    setSubmissionId(null)
    setStatus(null)
    setFormError(null)
    setSubmitError(null)
    setPollError(false)
    // Keep the URL so the merchant can resubmit the same endpoint.
  }, [])

  const instructions = status?.instructions ?? null

  const footer = (() => {
    if (phase === 'form') {
      return (
        <>
          <Button variant="tertiary" onClick={onClose}>
            Cancel
          </Button>
          <Button form="catalog-submit-form" type="submit">
            Submit for verification
          </Button>
        </>
      )
    }
    if (phase === 'submitting') {
      return (
        <>
          <Button variant="tertiary" onClick={onClose} disabled>
            Cancel
          </Button>
          <Button form="catalog-submit-form" type="submit" disabled>
            Submitting
          </Button>
        </>
      )
    }
    if (phase === 'error') {
      return (
        <>
          <Button variant="tertiary" onClick={handleReset}>
            Back to form
          </Button>
          <Button onClick={handleSubmit}>Try again</Button>
        </>
      )
    }
    if (phase === 'failed' || phase === 'delisted') {
      return (
        <>
          <Button variant="tertiary" onClick={handleReset}>
            Submit another service
          </Button>
          <Button onClick={onClose}>Close</Button>
        </>
      )
    }
    return (
      <Button variant="tertiary" onClick={onClose}>
        Close
      </Button>
    )
  })()

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="List your payable service"
      subtitle="Prove you control the endpoint, and Haven checks that it answers a payment request before listing it."
      showCloseButton
      footer={footer}
    >
      {phase === 'form' && (
        <form
          id="catalog-submit-form"
          onSubmit={handleSubmit}
          noValidate
          className="space-y-4"
          data-testid="catalog-submit-form"
        >
          <div>
            <label
              htmlFor="catalog-resource-url"
              className="mb-1 block text-xs font-medium text-[var(--v2-ink-3)]"
            >
              Resource URL
            </label>
            <div className="space-y-1.5">
              <Input
                id="catalog-resource-url"
                type="url"
                value={resourceUrl}
                onChange={(e) => setResourceUrl(e.target.value)}
                placeholder="https://your-service.example/pay"
                invalid={formError !== null}
                autoComplete="off"
                aria-describedby={formError ? 'catalog-resource-url-error' : undefined}
              />
              {formError ? (
                <InlineAlert id="catalog-resource-url-error">{formError}</InlineAlert>
              ) : (
                <p className="text-xs text-[var(--v2-ink-3)]">
                  An https endpoint that answers a payment request. No username or password in the
                  URL.
                </p>
              )}
            </div>
          </div>

          {/*
            Honeypot for form-filling bots: plausible name, visually hidden,
            never sent. The backend drops any submission that fills it.
          */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-[-9999px] top-auto h-px w-px overflow-hidden"
          >
            <label htmlFor="catalog-website">Website</label>
            <input
              id="catalog-website"
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </div>

          <p className="text-xs leading-relaxed text-[var(--v2-ink-3)]">
            Verification is free. It proves domain control and that the endpoint answers a
            payment request. It says nothing about the merchant behind it.
          </p>
        </form>
      )}

      {phase === 'submitting' && (
        <div role="status" aria-busy="true" className="space-y-3">
          <p className="text-sm text-[var(--v2-ink-2)]">Submitting your service.</p>
          <Skeleton className="h-16 rounded-lg" />
        </div>
      )}

      {phase === 'error' && (
        <div
          role="alert"
          className="rounded-xl border border-danger/20 bg-[var(--v2-danger-soft)] px-4 py-3"
        >
          <p className="text-sm font-medium text-[var(--v2-danger)]">We could not submit the service</p>
          <p className="mt-1 text-sm text-[var(--v2-danger)]">{submitError}</p>
        </div>
      )}

      {phase === 'tracking' && (
        <div className="space-y-5">
          {token && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-[var(--v2-ink-3)]">Verification token</p>
              <CodeBlock filename="Verify token">{token}</CodeBlock>
            </div>
          )}

          {instructions ? (
            <div className="space-y-5">
              <div
                data-testid="well-known-instruction"
                className="rounded-lg border border-brand/20 bg-[var(--v2-brand-soft)] px-3 py-2.5 text-sm font-medium text-[var(--v2-ink)]"
              >
                {instructions.well_known.instruction}
              </div>

              <div className="space-y-3">
                <p className="text-xs font-medium text-[var(--v2-ink)]">Well-known file</p>
                <div className="space-y-2.5 rounded-lg border border-[var(--v2-border)] p-3">
                  <InstructionRow
                    label="URL"
                    value={instructions.well_known.url}
                    copyLabel="well-known URL"
                  />
                  <InstructionRow
                    label="Content"
                    value={instructions.well_known.content}
                    copyLabel="well-known content"
                  />
                </div>
              </div>

              <div className="space-y-3">
                <p className="text-xs font-medium text-[var(--v2-ink)]">DNS TXT record (fallback)</p>
                <div className="space-y-2.5 rounded-lg border border-[var(--v2-border)] p-3">
                  <InstructionRow
                    label="Name"
                    value={instructions.dns_txt.name}
                    copyLabel="DNS TXT name"
                  />
                  <InstructionRow
                    label="Value"
                    value={instructions.dns_txt.value}
                    copyLabel="DNS TXT value"
                  />
                </div>
              </div>

              <p className="text-xs leading-relaxed text-[var(--v2-ink-3)]">
                The ownership proof expires on{' '}
                {new Date(instructions.expires_at).toLocaleDateString(undefined, {
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })}
                . Verification keeps running after you close this window.
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3">
              <p className="text-sm text-[var(--v2-ink-2)]">
                Ownership instructions are not available right now. Verification continues and
                will update here.
              </p>
            </div>
          )}

          {status && <StatusSteps status={status.status} />}

          {pollError && (
            <p role="status" className="text-xs text-[var(--v2-warning)]">
              We could not reach the latest status. Checking again shortly.
            </p>
          )}
        </div>
      )}

      {phase === 'listed' && status && (
        <div className="space-y-5">
          <div className="rounded-xl border border-success/20 bg-[var(--v2-success-soft)] px-4 py-3">
            <p className="text-sm font-medium text-[var(--v2-success)]">Verified and listed</p>
            <p className="mt-1 text-sm text-[var(--v2-success)]">
              Your service is now in the catalog and visible to agents.
            </p>
          </div>
          <StatusSteps status={status.status} />
        </div>
      )}

      {phase === 'failed' && (
        <div
          role="alert"
          className="rounded-xl border border-danger/20 bg-[var(--v2-danger-soft)] px-4 py-3"
        >
          <p className="text-sm font-medium text-[var(--v2-danger)]">Verification failed</p>
          <p className="mt-1 text-sm leading-relaxed text-[var(--v2-danger)]">
            We could not verify this service. Confirm the endpoint answers payment requests and
            submit it again.
          </p>
        </div>
      )}

      {phase === 'delisted' && (
        <div className="rounded-xl border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3">
          <p className="text-sm font-medium text-[var(--v2-ink-2)]">Removed from the catalog</p>
          <p className="mt-1 text-sm text-[var(--v2-ink-2)]">
            This listing is no longer available. You can submit the service again.
          </p>
        </div>
      )}
    </Modal>
  )
}
