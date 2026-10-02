'use client'

/**
 * The ops search page (#3516): one box for email, UUID, address or tx hash —
 * the backend detects the key type (#3512) and the page renders what came
 * back. A `system_tx` hit shows the LANE (chain, submitter, status), not a
 * user: `outbound_txs` has no user link, and inventing one would be a lie.
 * User-linked hits link to the customer page.
 */
import Link from 'next/link'
import { useState } from 'react'
import { Button, Card, EmptyState, InlineAlert, Input, PageHeader } from '@haven_ai/ui'
import { useOpsClient } from '../../components/useOpsClient'
import type { OpsReadError } from '../../lib/ops-client'
import type { OpsSearchResponse } from '../../lib/ops-types'
import { utcLine } from '../../lib/format'

/** The human line for a hit kind, as the backend defines them (#3512). */
function kindLabel(kind: OpsSearchResponse['hits'][number]['kind']): string {
  switch (kind) {
    case 'user':
      return 'User'
    case 'agent':
      return 'Agent'
    case 'payment_intent':
      return 'Payment intent'
    case 'smart_account':
      return 'Smart account'
    case 'system_tx':
      return 'System transaction (lane)'
  }
}

function SearchForm({
  value,
  onChange,
  onSubmit,
  busy,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  busy: boolean
}) {
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      {/* ui Input renders the caller's className on the NATIVE input inside
          its own div.relative wrapper — the wrapper is this flex row's child,
          so the sizing classes must sit HERE (a bare flex-1 on the input is a
          no-op and the field stays at its intrinsic ~20ch width). The input
          fills the sized wrapper with its own w-full. */}
      <div className="min-w-0 flex-1 max-w-xl">
        <Input
          aria-label="Search"
          name="q"
          placeholder="Email, UUID, address or tx hash"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="off"
        />
      </div>
      <Button type="submit" disabled={busy || value.trim() === ''}>
        Search
      </Button>
    </form>
  )
}

function HitRows({ response }: { response: OpsSearchResponse }) {
  return (
    <div className="space-y-6">
      <p className="text-xs text-[var(--v2-ink-3)]">
        Matched as {response.key_type} · {response.hits.length} hit{response.hits.length === 1 ? '' : 's'}
        {response.timed_out.length > 0
          ? ` · lookups that did not finish: ${response.timed_out.join(', ')}`
          : ''}
      </p>
      <div className="space-y-3">
        {response.hits.map((hit) => {
          const userLink = hit.user_id ? `/customer/${hit.user_id}` : null
          return (
            <Card key={`${hit.kind}-${hit.id}`} className="p-4" hover={false}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--v2-ink)]">
                    {kindLabel(hit.kind)}
                    {hit.status !== undefined ? (
                      <span className="text-[var(--v2-ink-3)]"> · {hit.status}</span>
                    ) : null}
                  </p>
                  <p className="v2-tabular mt-0.5 truncate text-xs text-[var(--v2-ink-3)]">
                    {hit.email !== undefined
                      ? hit.email
                      : hit.account_address !== undefined
                        ? hit.account_address
                        : hit.submitter !== undefined
                          ? hit.submitter
                          : hit.id}
                  </p>
                </div>
                <div className="flex items-center gap-3 text-xs text-[var(--v2-ink-3)]">
                  {hit.chain_id !== undefined ? <span className="v2-tabular">chain {hit.chain_id}</span> : null}
                  {hit.created_at !== undefined && hit.created_at !== null ? (
                    <span className="v2-tabular">{utcLine(hit.created_at)}</span>
                  ) : null}
                  {userLink !== null ? (
                    <Link href={userLink} className="text-xs font-medium text-[var(--v2-brand)] underline">
                      Open customer
                    </Link>
                  ) : (
                    <span className="text-xs text-[var(--v2-ink-3)]">No user link</span>
                  )}
                </div>
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

function SearchView({ client }: { client: ReturnType<typeof useOpsClient> }) {
  const [term, setTerm] = useState('')
  const [submitted, setSubmitted] = useState<string | null>(null)
  const [result, setResult] = useState<OpsSearchResponse | null>(null)
  const [error, setError] = useState<OpsReadError | null>(null)
  const [busy, setBusy] = useState(false)

  const run = () => {
    const query = term.trim()
    if (query === '' || busy) return
    setBusy(true)
    setError(null)
    setSubmitted(query)
    client
      .search(query)
      .then((read) => {
        if (read.ok) setResult(read.data)
        else {
          setResult(null)
          setError(read.error)
        }
      })
      .finally(() => setBusy(false))
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Search"
        subtitle="One box for what was pasted: an email, a UUID, an address or a transaction hash."
      />
      <Card className="p-6" hover={false}>
        <SearchForm value={term} onChange={setTerm} onSubmit={run} busy={busy} />
        <p className="mt-2 text-xs text-[var(--v2-ink-3)]">
          Every search is audited. The audit stores the masked term, never the raw query.
        </p>
        {error !== null ? (
          <div className="mt-4">
            <InlineAlert>{error.message}</InlineAlert>
          </div>
        ) : null}
      </Card>
      {busy ? (
        <Card className="p-6" hover={false}>
          <EmptyState
            title="Searching"
            body="The lookups run one after another and stop after five seconds."
            size="compact"
          />
        </Card>
      ) : submitted !== null && result !== null ? (
        result.hits.length === 0 ? (
          <Card className="p-6" hover={false}>
            <EmptyState
              title={`No matches for ${submitted}`}
              body="Check the term: an email needs at least three characters, and everything else must be exact."
            />
          </Card>
        ) : (
          <HitRows response={result} />
        )
      ) : null}
    </div>
  )
}

export default function SearchPage() {
  const client = useOpsClient()
  return <SearchView client={client} />
}
