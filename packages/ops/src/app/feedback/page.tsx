'use client'

/**
 * The Feedback page (#3602): the last 7 days of `haven feedback submit`
 * messages (#3597), one read, one page of 50.
 *
 * The message text arrives MASKED (a character count — the backend leaks no
 * content in the list) and each row has its own audited reveal: clicking
 * reveal calls `POST /ops/reveal` for that one message (`target_type
 * feedback`, `field text`), whose answer lives in this component's state
 * only and disappears when the row unmounts, exactly like the customer
 * page's MaskedField. The submitter's email arrives masked.
 *
 * Every read is audited server-side; the page adds nothing writable.
 */
import { useEffect, useState } from 'react'
import { Button, Card, EmptyState, PageHeader, StatusBadge } from '@haven_ai/ui'
import { useOpsClient } from '../../components/useOpsClient'
import { PageStates } from '../../components/PageStates'
import type { OpsReadError, OpsRead } from '../../lib/ops-client'
import type { OpsFeedbackList } from '../../lib/ops-types'
import { utcLine } from '../../lib/format'

/**
 * One message row. The masked text and the revealed answer are separate:
 * a failed reveal keeps the count, and Hide drops the revealed text.
 */
function FeedbackRow({
  item,
  reveal,
}: {
  item: OpsFeedbackList['feedback'][number]
  reveal: ReturnType<typeof useOpsClient>['reveal']
}) {
  const [revealed, setRevealed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Re-mask on unmount is not an action to take — the state IS the revealed
  // value, so unmount destroys it (the MaskedField contract, #3516).
  useEffect(() => {
    return () => {
      setRevealed(null)
      setError(null)
    }
  }, [])

  const revealIt = () => {
    if (busy) return
    setBusy(true)
    setError(null)
    // One call per click, no retries: the reveal is audited server-side, and
    // repeating a refusal would only re-audit the same refusal.
    reveal({ target_type: 'feedback', target_id: item.id, field: 'text' })
      .then((read: OpsRead<{ target_type: string; target_id: string; field: string; value: string | null }>) => {
        if (read.ok && read.data.value !== null) {
          setRevealed(read.data.value === '' ? '(empty)' : read.data.value)
        } else if (read.ok) {
          setError('The message could not be revealed.')
        } else {
          setError(read.error.message)
        }
      })
      .catch(() => setError('The console could not reach the backend.'))
      .finally(() => setBusy(false))
  }

  return (
    <div className="flex flex-col gap-2 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="v2-tabular text-xs text-[var(--v2-ink-3)]">
          from {item.email} · received {utcLine(item.created_at)}
        </p>
        <StatusBadge tone="neutral">expires {utcLine(item.expires_at)}</StatusBadge>
      </div>
      <p className="text-sm text-[var(--v2-ink)]">{revealed ?? item.text}</p>
      {revealed === null ? (
        <Button variant="ghost" size="sm" disabled={busy} onClick={revealIt} aria-label="Reveal feedback message">
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
          aria-label="Hide feedback message"
        >
          Hide
        </Button>
      )}
      {error !== null ? (
        <p role="alert" className="text-xs text-[var(--v2-danger)]">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function FeedbackView({ client }: { client: ReturnType<typeof useOpsClient> }) {
  const [list, setList] = useState<OpsFeedbackList | null>(null)
  const [error, setError] = useState<OpsReadError | null>(null)

  useEffect(() => {
    let cancelled = false
    client.feedback().then((read) => {
      if (cancelled) return
      if (read.ok) setList(read.data)
      else setError(read.error)
    })
    return () => {
      cancelled = true
    }
  }, [client])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Feedback"
        subtitle="What customers sent with haven feedback submit in the last 7 days. Messages are masked; revealing one is audited."
      />
      <PageStates
        loading={list === null && error === null}
        empty={list !== null && list.feedback.length === 0}
        error={error}
        emptyTitle="No feedback in the last 7 days"
        emptyBody="Messages sent with haven feedback submit appear here for 7 days."
      >
        {list !== null ? (
          <Card className="overflow-hidden" hover={false}>
            <Card.Header
              as="h2"
              padding="none"
              title="Messages"
              description="Newest first. A message disappears from this page when it expires; the count is the only content shown until you reveal one."
              actions={
                <StatusBadge tone={list.feedback.length > 0 ? 'success' : 'neutral'}>
                  {list.feedback.length} item{list.feedback.length === 1 ? '' : 's'}
                </StatusBadge>
              }
            />
            <Card.Section divided>
              {list.feedback.map((item) => (
                <FeedbackRow key={item.id} item={item} reveal={client.reveal} />
              ))}
            </Card.Section>
          </Card>
        ) : null}
      </PageStates>
    </div>
  )
}

export default function FeedbackPage() {
  const client = useOpsClient()
  return <FeedbackView client={client} />
}
