import type { Metadata } from 'next'
import { SiteHeader } from '@/components/marketing/SiteHeader'
import { SiteFooter } from '@/components/marketing/SiteFooter'
import { Section } from '@/components/marketing/Section'
import { buildManifest, type ManifestPackageEntry } from '@/lib/capability-manifest'
import { PackageCard } from './PackageCard'
import { releasesFixtureFrom, withFixtureReleases } from './release-source'

/**
 * `/releases` — "what changed, and do I need to update?" (#3304, epic #3302).
 *
 * Public, no session: an agent that hit a `client_update` hint has no login.
 * Every value comes from the capability manifest's `packages` entries, which
 * come from `@haven_ai/core`'s `buildReleaseCompat` — the same data
 * `GET /discovery` and `/.well-known/haven.json` serve — so this page cannot
 * say something the machine-readable documents do not. (The one exception is
 * the visual spec's fixture, behind a server-only variable no deployment sets;
 * see `release-source.ts`, #3393.) Rendered per request
 * because the update commands depend on the deployment's connector channel,
 * which only the backend knows; when it is unreachable the commands are
 * omitted rather than guessed (#2422).
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Releases — Haven',
  description: "What changed in Haven's client packages, and whether you need to update.",
}

// Order a reader updates in: the connector first (its doctor repairs the signer
// and the local MCP runtime it installed), then the packages people install
// directly.
const ORDER = ['connect', 'signer', 'mcp', 'cli', 'sdk'] as const

export default async function ReleasesPage() {
  const manifest = await buildManifest('')
  // The visual spec's fixture, when its server-only variable is set (#3393);
  // never set in a deployment, so this is the live data everywhere else.
  const fixture = releasesFixtureFrom()
  const packages = fixture ? withFixtureReleases(manifest.packages, fixture) : manifest.packages
  const entries = ORDER.map((key) => packages[key]).filter(
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
