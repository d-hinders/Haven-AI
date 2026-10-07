import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Home from '../page'
import { NewSiteHome } from '../../components/marketing/site/home/HomeSections'
import { CONNECTOR_TERMINAL } from '../../components/marketing/site/home/fixtures'

/**
 * The home page (#3574, epic #3572). It asserts over the RENDERED page, the
 * posture the legacy page's test argued for (#1954, removed with that page by
 * the switch-over, #3579): a source-level grep cannot see what a component
 * actually emitted.
 *
 * The design source is the mockup's V17 (artifact version `1791276240-c0f5`,
 * #3676): seven sections in a buyer's order. The epic's decided deviations
 * are listed on `HomeSections.tsx` and cited per assertion below.
 */

/** The mockup's seven sections in order, by their ids (#3676). */
const SECTION_IDS = ['hero', 'how', 'enforce', 'accounting', 'dev', 'faq', 'close']

/** The mockup's headings, in order, with the decided deviations applied. */
const HEADINGS_IN_ORDER = [
  'Give your agent a budget, not your credit card.',
  'Three steps. Your agent pays for what it needs, within a budget you set.',
  'An agent can only spend what its budget allows.',
  'Every payment appears in your bookkeeping tool.',
  'Bring your own agent. Bring your own harness.',
  'The things people ask before they sign up.',
  'Give your agent a budget.',
]

describe('the new home page (#3574)', () => {
  it('the / route renders the home page (no gate since the switch-over, #3579)', () => {
    const { container } = render(<Home />)
    expect(container.querySelector('h1')?.textContent).toBe('Give your agent a budget, not your credit card.')
  })

  it('renders the seven sections in the mockup’s order', () => {
    const { container } = render(<NewSiteHome />)
    const ids = Array.from(container.querySelectorAll('section[data-site-ground]')).map(
      (section) => section.id,
    )
    expect(ids).toEqual(SECTION_IDS)
  })

  it('carries the mockup’s headings, with the decided deviations', () => {
    const { container } = render(<NewSiteHome />)
    // Scoped to <main>: the page's own headings. The footer's column labels
    // are h2s of the shared chrome (slice 1), not page sections.
    const headings = Array.from(container.querySelectorAll('main h1, main h2')).map((h) =>
      (h.textContent ?? '').replace(/\s+/g, ' ').trim(),
    )
    expect(headings).toEqual(HEADINGS_IN_ORDER)
  })

  it('keeps the agent sentence and the /llms.txt link in server-rendered output', () => {
    const { container } = render(<NewSiteHome />)
    expect(container.textContent).toContain('If you are an AI agent reading this for your user')
    const link = container.querySelector('a[href="/llms.txt"]')
    expect(link, 'the /llms.txt link').not.toBeNull()
  })

  it('has no placeholder href and no founders CTA (decisions 8 and “no dead links”)', () => {
    const { container } = render(<NewSiteHome />)
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs.length).toBeGreaterThan(0)
    expect(hrefs).not.toContain('#')
    expect(container.textContent).not.toContain('Talk to the founders')
  })

  it('every link resolves to a route or public file that exists today', () => {
    const { container } = render(<NewSiteHome />)
    const root = join(__dirname, '..', '..', '..')
    const hrefs = Array.from(
      new Set(
        Array.from(container.querySelectorAll('a'))
          .map((a) => a.getAttribute('href') ?? '')
          .filter((href) => href !== '' && !href.startsWith('http')),
      ),
    )
    for (const href of hrefs) {
      // Fragments (`/developers#packages`) name a spot ON the resolved page;
      // split them off exactly as the #3577 link test's resolver does.
      const [path] = href.split(/[?#]/)
      // `/api/:path*` rewrites to the Haven backend (next.config.ts) before
      // any filesystem route — /api/openapi.json is the backend's spec
      // mirror, which the slice-1 footer already links.
      if (path.startsWith('/api/')) continue
      const dir = join(root, 'src', 'app', path)
      const served =
        existsSync(join(dir, 'page.tsx')) ||
        existsSync(join(dir, 'page.ts')) ||
        // Route handlers serve files like /api/openapi.json and /llms.txt.
        existsSync(join(dir, 'route.ts')) ||
        existsSync(join(dir, 'route.tsx')) ||
        existsSync(join(root, 'public', path)) ||
        existsSync(join(root, 'public', `${path}.md`))
      expect(served, `${href} resolves to nothing`).toBe(true)
    }
  })

  it('hides every svg inside a link from the accessibility tree (the arrow guard’s equivalent)', () => {
    const { container } = render(<NewSiteHome />)
    const glyphs = Array.from(container.querySelectorAll('a svg'))
    // Guard the guard: an empty set would pass the loop below in silence. The hero CTA ships one trailing arrow.
    expect(glyphs.length).toBeGreaterThanOrEqual(1)
    for (const glyph of glyphs) {
      expect(glyph).toHaveAttribute('aria-hidden', 'true')
      expect(glyph).toHaveAttribute('focusable', 'false')
    }
  })

  it('keeps the product frames decorative: hidden from AT and non-interactive', () => {
    const { container } = render(<NewSiteHome />)
    // Every frame-ish body sits inside an aria-hidden region.
    for (const selector of [
      '[data-product-frame-body]',
      '[data-connector-terminal]',
    ]) {
      const node = container.querySelector(selector)
      expect(node, selector).not.toBeNull()
    }
    const decorativeRoots = Array.from(container.querySelectorAll('[aria-hidden="true"]'))
    expect(decorativeRoots.length).toBeGreaterThanOrEqual(4)
    // No frame content is reachable as a control: nothing inside any
    // aria-hidden root is a button or a link.
    for (const root of decorativeRoots) {
      expect(root.querySelectorAll('button, a')).toHaveLength(0)
    }
  })

  it('step 3 names the supported clients (decision 13) and “your own harness” stays in the dev band', () => {
    const { container } = render(<NewSiteHome />)
    expect(container.textContent).toContain(
      'One command wires in Claude, Codex, Cursor or any other agent harness.',
    )
    const harnessTexts = Array.from(container.querySelectorAll('h2, p, h3')).filter((node) =>
      (node.textContent ?? '').includes('your own harness'),
    )
    expect(harnessTexts).toHaveLength(1)
    expect(harnessTexts[0].textContent).toContain('Bring your own agent')
  })

  it('the step-3 terminal tells the short setup story, keeping the published command prefix', () => {
    const { container } = render(<NewSiteHome />)
    const terminal = container.querySelector('[data-connector-terminal]')
    expect(terminal).not.toBeNull()
    const text = (terminal!.textContent ?? '').replace(/\s+/g, ' ')
    // The command node's own text is the fixture's: the published prefix
    // verbatim (copy-guidelines: `npx -y @haven_ai/connect@<channel>`) and a
    // trailing `…` for the flags left out (#3644).
    const command = terminal!.querySelector('[data-terminal-command]')?.textContent ?? ''
    expect(command).toBe(CONNECTOR_TERMINAL.command)
    expect(command.startsWith('npx -y @haven_ai/connect@alpha ')).toBe(true)
    // The mockup's bare one-liner stays out: it exits with an argument error.
    expect(command).not.toMatch(/npx @haven_ai\/connect(?![-@\w])/)
    // No real-looking setup token on a marketing page.
    expect(text).not.toMatch(/hv_setup_[A-Za-z0-9]/)
    // Every scripted line renders, ✓ marks included (the mockup's own marks,
    // index.html:161 — illustrative, not connector stdout).
    for (const line of CONNECTOR_TERMINAL.output) {
      expect(text).toContain(line)
    }
    expect(text).toContain('✓')
    // Short enough that no line wraps at 1280 (about 41 characters fit).
    const lines = [
      CONNECTOR_TERMINAL.comment,
      `$ ${CONNECTOR_TERMINAL.command}`,
      ...CONNECTOR_TERMINAL.output,
      ...CONNECTOR_TERMINAL.tailComment,
    ]
    for (const line of lines) {
      expect(line.length, line).toBeLessThanOrEqual(38)
    }
  })

  it('the fixture data is the mockup’s: Atlas, Iris, 250 USDC, Ada Lovelace AB, invoice 1042', () => {
    const { container } = render(<NewSiteHome />)
    const text = (container.textContent ?? '').replace(/\s+/g, ' ')
    for (const needle of [
      'Atlas',
      'Iris',
      '201.50 of 250.00 USDC',
      'Ada Lovelace AB',
      'Fortnox invoice 1042',
    ]) {
      expect(text).toContain(needle)
    }
  })

  it('the animated regions render their settled states', () => {
    const { container } = render(<NewSiteHome />)
    const text = (container.textContent ?? '').replace(/\s+/g, ' ')
    // Hero activity: the mockup's animation ends back on these three rows.
    expect(text).toContain('Paid data.example over x402')
    // Accounting: the mockup's retry returns the row to Failed — the state
    // the section settles on.
    expect(text).toContain('Fortnox answered 503 · will retry')
    // Spending limits: the receipt fully assembled, refusal box at the end.
    expect(text).toContain('Refused: over budget')
    // Budget mini card: settled at the fixture budget, not the animation's
    // 0.00 start.
    expect(text).toContain('250.00')
    // Step 3 terminal: every scripted output line is already "on".
    expect(text).toContain('✓ Setup complete')
  })

  it('navy and indigo bands are dark sections; white and tint are not', () => {
    const { container } = render(<NewSiteHome />)
    const darkOf = (id: string) =>
      container.querySelector<HTMLElement>(`section[id="${id}"]`)?.hasAttribute('data-v2-dark-section')
    // Grounds top to bottom: navy, tint, navy, white, navy, white, indigo —
    // no two dark bands touch (#3676).
    expect(darkOf('hero')).toBe(true)
    expect(darkOf('how')).toBe(false)
    expect(darkOf('enforce')).toBe(true)
    expect(darkOf('accounting')).toBe(false)
    expect(darkOf('dev')).toBe(true)
    expect(darkOf('faq')).toBe(false)
    expect(darkOf('close')).toBe(true)
    const grounds = Array.from(container.querySelectorAll('section[data-site-ground]')).map((section) =>
      section.getAttribute('data-site-ground'),
    )
    expect(grounds).toEqual(['navy', 'tint', 'navy', 'white', 'navy', 'white', 'indigo'])
  })

  it('the home page no longer mentions MPP, so it cannot describe it as live (decision 4)', () => {
    const { container } = render(<NewSiteHome />)
    const text = (container.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).not.toContain('MPP')
  })

  it('the spending-limits band says the budget message in plain words (#3676 decision 3)', () => {
    const { container } = render(<NewSiteHome />)
    const band = container.querySelector<HTMLElement>('section[id="enforce"]')!
    const text = (band.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('Spending limits')
    // Scoped to payments from the user's account (copy-guidelines).
    expect(text).toContain(
      'Every payment from your account is checked against the agent’s budget before anything is paid. Over the limit, it is refused: nothing is charged, and nothing waits for your approval.',
    )
    expect(Array.from(band.querySelectorAll('h3')).map((h) => h.textContent)).toEqual([
      'Your money stays yours',
      'The limit holds even if Haven doesn’t',
      'Change it whenever you like',
    ])
    expect(text).toContain(
      'If an agent’s credential leaks, it still cannot spend your account past its budget.',
    )
    // #3722: the control copy names stopping a budget and replacing the key, never pausing.
    expect(text).toContain('Raise, lower or stop a budget at any time.')
    expect(text).toContain('You can replace its signing key.')
    expect(text).not.toMatch(/pause the agent/i)
    expect(text).toContain('Nothing was paid. Nothing is waiting for your approval.')
    // No chain or mechanism vocabulary in the band, and nothing describes a
    // refused payment as pending or queued.
    // Word boundaries: "spending" must not count as "pending".
    expect(text).not.toMatch(/\bon-chain\b|\brevert|\bexecution\b|\bqueued\b|\bpending\b/i)
  })

  it('carries the three questions as h3 cards on a white ground (#3676 decision 4)', () => {
    const { container } = render(<NewSiteHome />)
    const faq = container.querySelector<HTMLElement>('section[id="faq"]')!
    expect(faq.getAttribute('data-site-ground')).toBe('white')
    expect(faq.textContent).toContain('Three questions')
    const questions = Array.from(faq.querySelectorAll('h3')).map((h) => h.textContent)
    expect(questions).toEqual([
      'Do you hold my money?',
      'Which agents work with Haven?',
      'What can an agent pay for?',
    ])
    const text = (faq.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain(
      'No. Funds stay in an account only you control. Haven prepares payments within the budgets you set and cannot move money on its own.',
    )
    expect(text).toContain(
      'Any agent that can run a command: Claude, Codex, Cursor or any other agent harness. One command connects it, and you approve its budget with your passkey.',
    )
    expect(text).toContain(
      'Anything sold over x402 today: APIs, data, compute, paywalled content. Every purchase gets a receipt and lands in your bookkeeping tool.',
    )
    // Haven is never the one holding, transferring or relaying.
    expect(text).not.toMatch(/relay/i)
  })
})
