import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DevelopersPage } from '../DevelopersPage'
import { buildManifestFrom } from '@/lib/capability-manifest'

/**
 * The redesigned For developers page (#3577, epic #3572). These pin what the
 * issue's acceptance criteria name; the rendered look is pinned by
 * `e2e/dev-agent-pages.visual.spec.ts`.
 */

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
}))

afterEach(() => {
  vi.unstubAllEnvs()
})

/** The manifest's static half: no fetch, the same call the page makes. */
const STATIC_MANIFEST = buildManifestFrom('', null)

describe('Developers page', () => {
  it('renders the mockup sections in order', () => {
    render(<DevelopersPage />)
    const main = screen.getByRole('main')
    expect(main.querySelector('h1')?.textContent).toBe('Bring your own agent. Bring your own harness.')
    expect(Array.from(main.querySelectorAll('h2')).map((h) => h.textContent)).toEqual([
      'Three steps to a paying agent.',
      'Keyless where it is hosted. Keyed where it runs.',
      'Quote, sign, pay.',
      'Five packages on npm.',
      'Machine-readable, on the host you use.',
      'Give your agent a budget.',
    ])
  })

  it('lists the five published packages BY NAME from the manifest, with no version', () => {
    render(<DevelopersPage />)
    // The names come from `buildManifestFrom('', null)` — the static half,
    // no fetch. Pinned to the manifest here, so a package rename on the
    // manifest side turns up as this table following it.
    const manifestNames = Object.values(STATIC_MANIFEST.packages).map((entry) => entry.name)
    expect(manifestNames).toHaveLength(5)
    for (const name of manifestNames) {
      expect(screen.getByText(name)).toBeDefined()
    }
    // No version number anywhere in the table: versions live on /releases.
    const table = document.querySelector('[data-package-table]')!
    expect(table.textContent).not.toMatch(/\b\d+\.\d+\.\d+/)
  })

  it('links /releases for versions', () => {
    render(<DevelopersPage />)
    expect(screen.getByRole('link', { name: '/releases' })).toHaveAttribute('href', '/releases')
  })

  it('shows the connector command with --api, as the runbook publishes it', () => {
    const { container } = render(<DevelopersPage />)
    const code = Array.from(container.querySelectorAll('pre')).map((pre) => pre.textContent ?? '').join('\n')
    expect(code).toContain('npx -y @haven_ai/connect@<channel> --setup hv_setup_… --api <api-url> --ack-local-tools')
  })

  it('builds the CLI login from the manifest one_liner shape, never name+channel', () => {
    const { container } = render(<DevelopersPage />)
    const code = Array.from(container.querySelectorAll('pre')).map((pre) => pre.textContent ?? '').join('\n')
    // The runbook's template form: composed with packages.cli.one_liner it
    // is runnable; appending `channel` to the bare name would double the
    // spec (`@@`, the #3430 defect).
    expect(code).toContain('<packages.cli.one_liner> login --api <api-url>')
    expect(code).not.toContain('npx @haven_ai/cli@<channel>')
    expect(code).not.toContain('@@')
  })

  it('shows the real hosted x402 tool names', () => {
    const { container } = render(<DevelopersPage />)
    const text = container.textContent ?? ''
    expect(text).toContain('haven_quote_x402')
    expect(text).toContain('haven_sign_x402')
    expect(text).toContain('haven_pay_x402')
  })

  it('names the packages section #packages', () => {
    render(<DevelopersPage />)
    expect(document.getElementById('packages')).not.toBeNull()
  })

  it('links every machine-readable file to its real path, never "#"', () => {
    const { container } = render(<DevelopersPage />)
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '')
    expect(hrefs.length).toBeGreaterThan(0)
    expect(hrefs).not.toContain('#')
    for (const href of ['/api/openapi.json', '/.well-known/haven.json', '/llms.txt', '/exit', '/docs/security-model.md', '/docs/agent-key-rotation.md']) {
      expect(hrefs, href).toContain(href)
    }
  })

  it('never calls the fetching manifest builder: the page stays static', () => {
    // The criterion that keeps the visual baseline release-proof. The page
    // module imports only the static-half builder (`buildManifestFrom`);
    // the fetching variant would hit the backend per request and make the
    // page dynamic — spelled in the regex below without naming it, so the
    // assertion cannot trip on its own comment.
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    const page = readFileSync(
      join(__dirname, '..', '..', '..', '..', '..', '..', 'src/app/developers/page.tsx'),
      'utf8',
    )
    const component = readFileSync(
      join(__dirname, '..', '..', '..', '..', '..', '..', 'src/components/marketing/site/developers/DevelopersPage.tsx'),
      'utf8',
    )
    const fixtures = readFileSync(join(__dirname, '..', 'fixtures.ts'), 'utf8')
    const FETCHING_BUILDER = new RegExp('\\bbuildManifest(?!From)\\b')
    for (const [name, source] of [['page', page], ['component', component], ['fixtures', fixtures]] as const) {
      expect(source, name).not.toMatch(FETCHING_BUILDER)
      expect(source, name).not.toContain("dynamic = 'force-dynamic'")
    }
  })
})
