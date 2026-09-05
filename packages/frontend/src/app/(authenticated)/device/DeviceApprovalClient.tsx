'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { PageHeader } from '@/components/ui/PageHeader'
import { api, ApiRequestError } from '@/lib/api'

type Outcome = { kind: 'idle' } | { kind: 'approved' } | { kind: 'denied' } | { kind: 'error'; message: string }

/**
 * The approval screen for a device-code CLI login (#2526).
 *
 * What it must get right is the SENTENCE, not the layout: a human is granting
 * a session to something they cannot see, so the screen says plainly what that
 * session can and cannot do. The scope is not a summary of the allow-list — it
 * is the two halves that matter to the person deciding.
 */
export default function DeviceApprovalClient() {
  const searchParams = useSearchParams()
  const [code, setCode] = useState(searchParams.get('code') ?? '')
  const [submitting, setSubmitting] = useState<'approve' | 'deny' | null>(null)
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' })

  async function decide(deny: boolean) {
    setSubmitting(deny ? 'deny' : 'approve')
    setOutcome({ kind: 'idle' })
    try {
      await api.post('/auth/device/approve', { user_code: code, ...(deny ? { deny: true } : {}) })
      setOutcome({ kind: deny ? 'denied' : 'approved' })
    } catch (err) {
      // The backend answers 404 for a wrong, expired or already-decided code
      // alike, so codes cannot be enumerated. The copy here has to be equally
      // undiscriminating, or the screen leaks what the API refused to.
      setOutcome({
        kind: 'error',
        message:
          err instanceof ApiRequestError && err.status === 404
            ? 'That code is not waiting for approval. It may have expired, already been used, or been typed wrong — ask for a fresh one.'
            : 'Something went wrong. Try again.',
      })
    } finally {
      setSubmitting(null)
    }
  }

  if (outcome.kind === 'approved' || outcome.kind === 'denied') {
    return (
      <>
        <PageHeader
          title={outcome.kind === 'approved' ? 'CLI access approved' : 'CLI access denied'}
          subtitle={
            outcome.kind === 'approved'
              ? 'You can close this page. The command line picks it up within a few seconds.'
              : 'Nothing was granted. You can close this page.'
          }
        />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Approve command-line access"
        subtitle="Something is asking to manage agents from a terminal on your behalf."
      />

      <Card>
        <Card.Section>
          <form
            className="flex flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault()
              void decide(false)
            }}
          >
            {/* `Input` carries no `label` prop; the pattern here is the one
                login/page.tsx uses — an explicit label bound by `htmlFor`. */}
            <div>
              <label
                htmlFor="device-user-code"
                className="block text-xs font-medium text-[var(--v2-ink-2)] mb-1.5"
              >
                Code shown in the terminal
              </label>
              <Input
                id="device-user-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="XXXX-XXXX"
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            {/*
              The scope, in the two halves a person deciding actually needs.
              Not a restatement of the allow-list: a list of twenty routes is
              not something anyone reads before clicking Approve.
            */}
            <div className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
              <p className="mb-2">
                <strong className="text-[var(--v2-ink)]">It can</strong> create and manage agents,
                set up a connection, and read your account — wallets, activity and transactions.
              </p>
              <p>
                <strong className="text-[var(--v2-ink)]">It cannot</strong> sign anything, approve a
                budget, change your signers, re-key an agent, move funds, or change your
                credentials. Approving a budget stays with you, here.
              </p>
            </div>

            {outcome.kind === 'error' && (
              <p role="alert" className="text-sm text-[var(--v2-danger)]">
                {outcome.message}
              </p>
            )}

            <div className="flex gap-3">
              <Button type="submit" disabled={!code.trim() || submitting !== null}>
                {submitting === 'approve' ? 'Approving…' : 'Approve'}
              </Button>
              <Button
                type="button"
                variant="tertiary"
                disabled={!code.trim() || submitting !== null}
                onClick={() => void decide(true)}
              >
                {submitting === 'deny' ? 'Denying…' : 'Deny'}
              </Button>
            </div>
          </form>
        </Card.Section>
      </Card>
    </>
  )
}
