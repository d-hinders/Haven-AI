import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HowItWorksPage } from '../HowItWorksPage'
import { ProtocolsPage } from '../ProtocolsPage'

/**
 * The redesigned How it works page and its protocols sub-page (#3576, epic
 * #3572). These pin what the issue's acceptance criteria name; the rendered
 * look is pinned by `e2e/how-it-works.visual.spec.ts`.
 */

const notFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND')
})
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  notFound: () => notFound(),
}))

afterEach(() => {
  vi.unstubAllEnvs()
  notFound.mockClear()
})

/**
 * Every destination these pages may link to, each one an existing route or
 * public file today. `/developers` joined with its page in #3577 (epic rule
 * "Entries land with their page").
 */
const KNOWN_DESTINATIONS = new Set([
  '/',
  '/how-it-works',
  '/how-it-works/protocols',
  '/developers',
  '/developers#packages',
  '/for-agents',
  '/signup',
  '/login',
  '/exit',
  '/for-agents.md',
  '/api/openapi.json',
  '/docs/security-model.md',
])

function hrefsIn(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '')
}

describe.each([
  ['How it works', HowItWorksPage],
  ['Protocols', ProtocolsPage],
] as const)('%s page', (_name, Page) => {
  it('links only to destinations that exist, and never to "#"', () => {
    const { container } = render(<Page />)
    const hrefs = hrefsIn(container)
    expect(hrefs.length).toBeGreaterThan(0)
    expect(hrefs).not.toContain('#')
    for (const href of hrefs) expect(KNOWN_DESTINATIONS, href).toContain(href)
  })

  it('hides every svg inside a link from the accessibility tree', () => {
    const { container } = render(<Page />)
    const svgs = Array.from(container.querySelectorAll('a svg'))
    expect(svgs.length).toBeGreaterThan(0)
    for (const svg of svgs) expect(svg.getAttribute('aria-hidden')).toBe('true')
  })

  it('renders product frames as pictures: inert bodies with no controls inside', () => {
    const { container } = render(<Page />)
    for (const body of Array.from(container.querySelectorAll('[data-product-frame-body]'))) {
      expect(body.hasAttribute('inert')).toBe(true)
      expect(body.querySelectorAll('a, button, input, select, textarea')).toHaveLength(0)
    }
  })

  it('never shows the agent signing a bare hash or Haven sponsoring every settlement', () => {
    const { container } = render(<Page />)
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/sign_hash/)
    expect(text).not.toMatch(/gas sponsored/i)
  })
})

describe('How it works', () => {
  it('renders the mockup sections in order', () => {
    render(<HowItWorksPage />)
    const main = screen.getByRole('main')
    expect(within(main).getByRole('heading', { level: 1 }).textContent).toBe(
      'From an empty account to an agent that pays for what it needs.',
    )
    expect(within(main).getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'An account only you control.',
      'A budget per agent, not a card for all of them.',
      'One command wires any agent in.',
      'Seconds from paywall to result. No human in the loop.',
      'Every payment explains itself.',
      'Built so that Haven cannot be the weak point.',
      'x402 today. MPP next. One budget either way.',
      'Set up your first agent.',
    ])
  })

  it('links Security model, the exit page and the protocols teaser to their destinations', () => {
    const { container } = render(<HowItWorksPage />)
    const security = container.querySelector('#security') as HTMLElement
    expect(security).not.toBeNull()
    expect(security.querySelectorAll('h3')).toHaveLength(6)
    expect(within(security).getByRole('link', { name: 'Security model' })).toHaveAttribute(
      'href',
      '/docs/security-model.md',
    )
    expect(within(security).getByRole('link', { name: 'Open the exit page' })).toHaveAttribute('href', '/exit')
    expect(screen.getByRole('link', { name: 'Compare the protocols' })).toHaveAttribute(
      'href',
      '/how-it-works/protocols',
    )
    expect(screen.getByRole('link', { name: 'How the protocols fit' })).toHaveAttribute(
      'href',
      '/how-it-works/protocols',
    )
  })

  it('names the clients per epic decision 13, never "your own harness"', () => {
    const { container } = render(<HowItWorksPage />)
    const text = container.textContent ?? ''
    expect(text).toContain('Claude, Codex, Cursor or any other agent harness')
    expect(text).not.toContain('your own harness')
  })

  it('shows settlement after the retry in the payment walk-through', () => {
    const { container } = render(<HowItWorksPage />)
    const steps = Array.from(container.querySelectorAll('ol > li b')).map((b) => b.textContent ?? '')
    const retry = steps.findIndex((t) => t.startsWith('The agent retries'))
    const settled = steps.findIndex((t) => t.startsWith('Settled from your account'))
    expect(retry).toBeGreaterThan(-1)
    expect(settled).toBeGreaterThan(retry)
  })

  it('discloses that rotation does not move a balance already in the agent wallet', () => {
    const { container } = render(<HowItWorksPage />)
    const security = container.querySelector('#security') as HTMLElement
    // copy-guidelines.md: x402 copy discloses that the key controls funds already in the agent wallet.
    expect(security.textContent).toContain("A balance already in the agent's own wallet is controlled by its key")
    expect(security.textContent).not.toContain('Nothing for an agent to leak')
  })

  it("shows the runbook's connector command, including --api", () => {
    const { container } = render(<HowItWorksPage />)
    const code = container.querySelector('pre')?.textContent ?? ''
    expect(code).toContain('npx -y @haven_ai/connect@<channel>')
    expect(code).toContain('--setup hv_setup_…')
    expect(code).toContain('--api <api-url> --ack-local-tools')
  })
})

describe('Protocols', () => {
  it('shows one payment flow and the two protocol cards', () => {
    const { container } = render(<ProtocolsPage />)
    expect(screen.getByRole('heading', { level: 2, name: 'One payment, four actors.' })).toBeDefined()
    expect(container.querySelectorAll('ol')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 3, name: 'Pay-per-request over HTTP' })).toBeDefined()
    expect(screen.getByRole('heading', { level: 3, name: 'Agent-initiated commerce' })).toBeDefined()
  })

  it('describes MPP as next, never as available today', () => {
    const { container } = render(<ProtocolsPage />)
    const mpp = within(container.querySelector('table') as HTMLElement)
      .getAllByRole('row')
      .map((row) => Array.from(row.querySelectorAll('td')).map((td) => td.textContent))
      .filter((cells) => cells.length === 2)
      .map(([, mppCell]) => mppCell)
    expect(mpp).toContain('Next')
    expect(mpp).toContain('Not yet supported at Haven')
    expect(container.textContent).not.toMatch(/MPP[^.]*\blive\b/i)
  })

  it('names ERC-7710 as preferred and the EIP-3009 bridge as the open-budget fallback', () => {
    const { container } = render(<ProtocolsPage />)
    const text = container.textContent ?? ''
    expect(text).toMatch(/prefers the ERC-7710 scheme.*an agent with an open budget pays through an\s+EIP-3009 bridge/s)
    // A pinned budget cannot take the bridge (delegation-authorize.ts refuses 3009 for it).
    expect(text).toMatch(/pinned to one recipient pays by ERC-7710 only/)
  })

  it('shows settlement after the retry, as the labelled ERC-7710 path does it', () => {
    const { container } = render(<ProtocolsPage />)
    const steps = Array.from(container.querySelectorAll('ol > li b')).map((b) => b.textContent ?? '')
    const retry = steps.findIndex((t) => t.startsWith('Agent retries'))
    const settle = steps.findIndex((t) => t.includes('settles'))
    expect(retry).toBeGreaterThan(-1)
    expect(settle).toBeGreaterThan(retry)
  })

  it('names the x402 v2 retry header, never X-PAYMENT, on the ERC-7710 path', () => {
    const { container } = render(<ProtocolsPage />)
    // sdk tools.ts: X-PAYMENT is never sent on erc7710 (HTTP 431); the retry carries PAYMENT-SIGNATURE.
    const text = container.textContent ?? ''
    expect(text).toContain('PAYMENT-SIGNATURE header')
    expect(text).not.toContain('X-PAYMENT')
  })

  it('labels the flow as the ERC-7710 path whose order it shows', () => {
    const { container } = render(<ProtocolsPage />)
    // A non-breaking hyphen keeps the standard's name on one line on phones.
    expect(container.textContent).toContain('x402 payment flow · ERC\u20117710')
  })

  it('stacks the comparison on phones with every aspect and both protocols', () => {
    const { container } = render(<ProtocolsPage />)
    const stacked = container.querySelector('[data-comparison-stacked]') as HTMLElement
    expect(stacked.className.split(/\s+/)).toContain('sm:hidden')
    const tableWrap = container.querySelector('table')!.parentElement!.className.split(/\s+/)
    expect(tableWrap).toEqual(expect.arrayContaining(['hidden', 'sm:block']))
    const items = within(stacked).getAllByRole('listitem')
    expect(items).toHaveLength(container.querySelectorAll('tbody tr').length)
    for (const item of items) {
      expect(Array.from(item.querySelectorAll('dt')).map((dt) => dt.textContent)).toEqual(['x402', 'Stripe MPP'])
    }
  })

  it('links back to How it works from the breadcrumb', () => {
    render(<ProtocolsPage />)
    const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(crumb).getByRole('link', { name: 'How it works' })).toHaveAttribute('href', '/how-it-works')
  })
})

describe('the routes (no gate since the switch-over, #3579)', () => {
  it('serves /how-it-works/protocols in a production-shaped build (unit-test default)', async () => {
    const { default: Protocols } = await import('@/app/how-it-works/protocols/page')
    expect(() => Protocols()).not.toThrow()
  })

  it('renders the redesigned /how-it-works', async () => {
    const { default: HowItWorks } = await import('@/app/how-it-works/page')
    render(<HowItWorks />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'From an empty account to an agent that pays for what it needs.',
    )
  })
})
