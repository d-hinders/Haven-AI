'use client'

/**
 * The doc-health page (#3516): a table from the build-time JSON (#3511),
 * filterable by flag, with the link to the weekly docs-audit issue — the
 * build-time report CANNOT carry commit-based staleness (a Vercel build runs
 * on a shallow clone), so `unverified-90d` is age only and the audit issue is
 * the commit-based signal.
 */
import { useEffect, useMemo, useState } from 'react'
import { Card, EmptyState, FilterPill, PageHeader, StatusBadge } from '@haven_ai/ui'
import { useOpsClient } from '../../components/useOpsClient'
import { PageStates } from '../../components/PageStates'
import type { DocHealthJson, OpsReadError } from '../../lib/ops-client'
import { utcLine } from '../../lib/format'

/** The flags in the order the generator reports them (#3511). */
const FLAGS = ['no-front-matter', 'no-owner', 'empty-covers', 'unverified-90d'] as const

/** The weekly docs-audit issue — upserted by `.github/workflows/docs-audit.yml`. */
const DOCS_AUDIT_ISSUE_URL = 'https://github.com/d-hinders/Haven-AI/issues/3413'

function DocHealthView({ client }: { client: ReturnType<typeof useOpsClient> }) {
  const [report, setReport] = useState<DocHealthJson | null>(null)
  const [error, setError] = useState<OpsReadError | null>(null)
  const [activeFlags, setActiveFlags] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    client.docHealth().then((read) => {
      if (cancelled) return
      if (read.ok) setReport(read.data)
      else setError(read.error)
    })
    return () => {
      cancelled = true
    }
  }, [client])

  const rows = useMemo(() => {
    if (report === null) return []
    if (activeFlags.size === 0) return report.docs
    return report.docs.filter((doc) => doc.flags.some((flag) => activeFlags.has(flag)))
  }, [report, activeFlags])

  const toggleFlag = (flag: string) => {
    setActiveFlags((current) => {
      const next = new Set(current)
      if (next.has(flag)) next.delete(flag)
      else next.add(flag)
      return next
    })
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Doc health"
        subtitle="Front-matter state of the doc surface, computed at build time. Commit-based staleness lives in the weekly audit issue."
        actions={
          <a
            href={DOCS_AUDIT_ISSUE_URL}
            target="_blank"
            rel="noreferrer"
            className="text-sm font-medium text-[var(--v2-brand)] underline"
          >
            Weekly docs audit
          </a>
        }
      />
      <PageStates
        loading={report === null && error === null}
        empty={report !== null && report.total === 0}
        error={error}
        emptyTitle="No docs in the report"
        emptyBody="The build produced a report with no entries — check the build's doc-health step."
      >
        {report !== null ? (
          <div className="space-y-6">
            <Card className="p-6" hover={false}>
              <div className="flex flex-wrap items-center gap-2">
                {FLAGS.map((flag) => (
                  <FilterPill key={flag} active={activeFlags.has(flag)} onClick={() => toggleFlag(flag)}>
                    {flag} ({report.counts[flag] ?? 0})
                  </FilterPill>
                ))}
              </div>
              <p className="mt-3 text-xs text-[var(--v2-ink-3)]">
                {report.total} docs · generated {utcLine(report.generatedAt)} ·{' '}
                {activeFlags.size === 0 ? 'showing all' : `filtered to ${activeFlags.size} flag(s)`}
              </p>
              <div className="mt-4 space-y-2">
                {report.notes.map((note, index) => (
                  <p key={index} className="text-xs text-[var(--v2-ink-2)]">
                    {note}
                  </p>
                ))}
              </div>
            </Card>
            <Card className="overflow-hidden" hover={false}>
              <Card.Header
                as="h2"
                padding="none"
                title="Docs"
                actions={<span className="v2-tabular text-xs text-[var(--v2-ink-3)]">{rows.length}</span>}
              />
              {rows.length === 0 ? (
                <div className="p-5">
                  <EmptyState title="No docs match the filter" size="compact" />
                </div>
              ) : (
                <Card.Section divided>
                  {rows.map((doc) => (
                    <div key={doc.path} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                      <div className="min-w-0">
                        <p className="v2-tabular truncate text-sm text-[var(--v2-ink)]">{doc.path}</p>
                        <p className="v2-tabular mt-0.5 text-xs text-[var(--v2-ink-3)]">
                          owner {doc.owner ?? '—'} · status {doc.status ?? '—'} · last verified{' '}
                          {doc.lastVerified ?? '—'}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {doc.flags.length === 0 ? (
                          <StatusBadge tone="success">clean</StatusBadge>
                        ) : (
                          doc.flags.map((flag) => (
                            <StatusBadge key={flag} tone={flag === 'unverified-90d' ? 'warning' : 'danger'}>
                              {flag}
                            </StatusBadge>
                          ))
                        )}
                      </div>
                    </div>
                  ))}
                </Card.Section>
              )}
            </Card>
          </div>
        ) : null}
      </PageStates>
    </div>
  )
}

export default function DocHealthPage() {
  const client = useOpsClient()
  return <DocHealthView client={client} />
}
