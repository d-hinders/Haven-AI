import { Card } from '@/components/ui/Card'
import { StatusBadge } from '@/components/ui/StatusBadge'
import type { ManifestPackageEntry } from '@/lib/capability-manifest'
import { UpdateCommand } from './UpdateCommand'

/** One package on `/releases` (#3304): thresholds, the update command, the notes. */

// The signer and the local MCP runtime have no update command of their own:
// the connector installs both, so theirs is the connector's doctor. Said on the
// card, or three identical commands read as a mistake.
const INSTALLED_BY_CONNECTOR: ReadonlySet<string> = new Set(['@haven_ai/signer', '@haven_ai/mcp'])

/**
 * The line above a package's update command, or null. The connector's command
 * is its doctor (`upgradeCommandFor`, #3412): run alone it only diagnoses, and
 * prints a `--doctor --repair` line when something needs updating — so every
 * card that shows it names that second step (#3424), in the words the agent
 * texts use ("any repair line it prints": none prints when all is current).
 * The SDK and CLI commands update on their own and get no line.
 */
export function updateNoteFor(name: string): string | null {
  if (INSTALLED_BY_CONNECTOR.has(name)) return 'Installed by the connector: run this, then any repair line it prints.'
  if (name === '@haven_ai/connect') return 'Run this, then any repair line it prints.'
  return null
}

function Thresholds({ entry }: { entry: ManifestPackageEntry }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[13px]">
      <div>
        <dt className="text-[var(--v2-ink-3)]">Minimum accepted</dt>
        <dd className="text-[var(--v2-ink)]">
          {entry.min_version ? <span className="font-mono">{entry.min_version}</span> : 'None — every version accepted'}
        </dd>
      </div>
      <div>
        <dt className="text-[var(--v2-ink-3)]">Recommended</dt>
        <dd className="text-[var(--v2-ink)]">
          {entry.recommended_version ? <span className="font-mono">{entry.recommended_version}</span> : 'None'}
        </dd>
      </div>
    </dl>
  )
}

export function PackageCard({ entry }: { entry: ManifestPackageEntry }) {
  const updateNote = updateNoteFor(entry.name)
  return (
    <Card hover={false} className="overflow-hidden">
      <Card.Header
        as="h2"
        title={<span className="font-mono">{entry.name}</span>}
        actions={<StatusBadge tone="brand">{entry.released_version}</StatusBadge>}
      />
      <div className="px-5 py-4 space-y-4">
        <Thresholds entry={entry} />
        {entry.upgrade_command ? (
          <div className="space-y-2">
            {updateNote ? <p className="text-[13px] text-[var(--v2-ink-2)]">{updateNote}</p> : null}
            <UpdateCommand command={entry.upgrade_command} />
          </div>
        ) : null}
      </div>
      {/*
        Not `Row`: its subtitle is a one-line truncating slot, and the summary
        is the part a reader came for — it must wrap in full.
      */}
      <Card.Section divided>
        {entry.notes.map((note) => (
          <div key={note.version} className="px-5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[14px] font-medium text-[var(--v2-ink)]">
                <span className="font-mono">{note.version}</span>
                <span className="text-[var(--v2-ink-3)] font-normal"> · {note.date}</span>
              </p>
              {note.action_required ? <StatusBadge tone="warning">Update required</StatusBadge> : null}
            </div>
            {/* Segments, not `summary`: code renders as code, never as body text (#3393). */}
            <p className="mt-1 text-[13px] leading-relaxed text-[var(--v2-ink-2)]">
              {note.summary_segments.map((segment, i) =>
                segment.code ? (
                  <code key={i} className="font-mono text-[12px] text-[var(--v2-ink)]">
                    {segment.text}
                  </code>
                ) : (
                  <span key={i}>{segment.text}</span>
                ),
              )}
            </p>
          </div>
        ))}
      </Card.Section>
    </Card>
  )
}
