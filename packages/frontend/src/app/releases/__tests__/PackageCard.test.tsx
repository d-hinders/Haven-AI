import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { buildReleaseCompat, type PublishedClientPackage } from '@haven_ai/core'
import { buildManifestFrom, type ManifestPackageEntry } from '@/lib/capability-manifest'
import { PackageCard } from '../PackageCard'

/**
 * #3424: the connector's update command is its doctor, which only diagnoses
 * and prints the `--doctor --repair` line that updates. Every card showing it
 * names that second step; the SDK and CLI commands update on their own.
 *
 * The visual spec cannot pin this: it runs with no backend, so no channel and
 * no update command, and the whole block (this line included) is hidden. Here
 * the entries carry a real channel's commands, built by the same
 * `buildReleaseCompat` the page's manifest uses.
 */
const REPAIR_STEP = /then the repair command it prints/
const releases = buildReleaseCompat('alpha')
const withChannel = (key: string): ManifestPackageEntry => {
  const entry = buildManifestFrom('', null).packages[key]
  return { ...entry, ...releases[entry.name as PublishedClientPackage] }
}

describe('PackageCard update note (#3424)', () => {
  it.each(['signer', 'mcp'])('names the repair step for the connector-installed %s', (key) => {
    const entry = withChannel(key)
    expect(entry.upgrade_command).toBe('npx -y @haven_ai/connect@alpha --doctor')
    render(<PackageCard entry={entry} />)
    expect(screen.getByText('Installed by the connector: run this, then the repair command it prints.')).toBeTruthy()
  })

  it('names the repair step on the connector card itself', () => {
    const entry = withChannel('connect')
    expect(entry.upgrade_command).toBe('npx -y @haven_ai/connect@alpha --doctor')
    render(<PackageCard entry={entry} />)
    expect(screen.getByText('Run this, then the repair command it prints.')).toBeTruthy()
    expect(screen.queryByText(/Installed by the connector/)).toBeNull()
  })

  it.each(['sdk', 'cli'])('adds no note for %s, whose command updates on its own', (key) => {
    const entry = withChannel(key)
    expect(entry.upgrade_command).not.toMatch(/--doctor/)
    render(<PackageCard entry={entry} />)
    expect(screen.queryByText(REPAIR_STEP)).toBeNull()
  })

  it('shows no note when there is no command (the no-channel state the visual spec renders)', () => {
    const entry = buildManifestFrom('', null).packages.signer
    expect(entry.upgrade_command).toBeNull()
    render(<PackageCard entry={entry} />)
    expect(screen.queryByText(REPAIR_STEP)).toBeNull()
  })

  it('never says the retired "update the connector to update it"', () => {
    render(<PackageCard entry={withChannel('signer')} />)
    expect(screen.queryByText(/update the connector to update it/)).toBeNull()
  })
})
