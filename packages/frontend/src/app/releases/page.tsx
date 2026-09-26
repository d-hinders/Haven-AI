import type { Metadata } from 'next'
import { SiteHeader } from '@/components/marketing/SiteHeader'
import { SiteFooter } from '@/components/marketing/SiteFooter'
import { Section } from '@/components/marketing/Section'
import { Card } from '@/components/ui/Card'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { buildManifest, type ManifestPackageEntry } from '@/lib/capability-manifest'
import { UpdateCommand } from './UpdateCommand'

/**
 * `/releases` — "what changed, and do I need to update?" (#3304, epic #3302).
 *
 * Public, no session: an agent that hit a `client_update` hint has no login.
 * Every value comes from the capability manifest's `packages` entries, which
 * come from `@haven_ai/core`'s `buildReleaseCompat` — the same data
 * `GET /discovery` and `/.well-known/haven.json` serve — so this page cannot
 * say something the machine-readable documents do not. Rendered per request
 * because the update commands depend on the deployment's connector channel,
 * which only the backend knows; when it is unreachable the commands are
 * omitted rather than guessed (#2422).
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Releases — Haven',
  description: "What changed in Haven's client packages, and whether you need to update.",
}

// Order a reader updates in: the connector first (it reinstalls the signer and
// the local MCP runtime), then the packages people install directly.
const ORDER = ['connect', 'signer', 'mcp', 'cli', 'sdk'] as const

// The signer and the local MCP runtime have no update command of their own:
// the connector installs both, so theirs is the connector's. Said on the card,
// or three identical commands read as a mistake.
const INSTALLED_BY_CONNECTOR: ReadonlySet<string> = new Set(['@haven_ai/signer', '@haven_ai/mcp'])

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

function PackageCard({ entry }: { entry: ManifestPackageEntry }) {
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
            {INSTALLED_BY_CONNECTOR.has(entry.name) ? (
              <p className="text-[13px] text-[var(--v2-ink-2)]">Installed by the connector: update the connector to update it.</p>
            ) : null}
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
            <p className="mt-1 text-[13px] leading-relaxed text-[var(--v2-ink-2)]">{note.summary}</p>
          </div>
        ))}
      </Card.Section>
    </Card>
  )
}

export default async function ReleasesPage() {
  const manifest = await buildManifest('')
  const entries = ORDER.map((key) => manifest.packages[key]).filter(
    (entry): entry is ManifestPackageEntry => entry !== undefined,
  )

  return (
    <>
      <SiteHeader />

      <section className="max-w-6xl mx-auto px-6 pt-20 md:pt-28 pb-10">
        <div className="max-w-3xl">
          <h1 className="text-[40px] md:text-[52px] font-semibold tracking-[-0.03em] leading-[1.06] text-[var(--v2-ink)] mb-5">
            Releases
          </h1>
          <p className="text-[17px] leading-relaxed text-[var(--v2-ink-2)] max-w-[620px]">
            What changed in Haven&apos;s client packages, and whether you need to update. The same data is
            machine-readable in <code className="font-mono text-[15px]">/.well-known/haven.json</code>, under{' '}
            <code className="font-mono text-[15px]">packages</code>.
          </p>
        </div>
      </section>

      <Section
        eyebrow="Do I need to update?"
        title="Only when Haven says so."
        lede={
          <>
            If a Haven response carries <code className="font-mono">client_update</code> with{' '}
            <code className="font-mono">required: true</code>, your client is below the minimum and payments are
            refused until you update it. Without <code className="font-mono">required</code>, updating
            is recommended but nothing stops working.
          </>
        }
        className="pt-0 md:pt-0"
      >
        {/*
          One note, not one per card: the cause (the backend was unreachable)
          is page-wide, and repeating it buried the notes (#3304 design review).
        */}
        {entries.some((entry) => entry.upgrade_command === null) ? (
          <p className="mb-5 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3 text-[13px] leading-relaxed text-[var(--v2-ink-2)]">
            Update commands depend on this deployment&apos;s release channel, which could not be read just now.
            Your setup instructions name it, or reload this page.
          </p>
        ) : null}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {entries.map((entry) => (
            <PackageCard key={entry.name} entry={entry} />
          ))}
        </div>
      </Section>

      <SiteFooter />
    </>
  )
}
