/**
 * Transactions' list controls against real layout (#4111, epic #4108).
 *
 * `FilterBar` measured 38px triggers and an Initiator menu hanging past the
 * right edge of a 375px screen (live on dev, 2026-10-20). This spec is the
 * proof that the move onto `ListToolbar` fixed both ON THIS PAGE, with this
 * page's facets: every control a phone user taps is 44px, and the filter
 * sheet and every desktop menu stay inside the viewport.
 *
 * The fixture is widened beyond the shared one so every facet renders:
 * accounts on two networks (so Account and Network each have two options),
 * two tokens, and agents with long names and a revoked status — the long
 * Initiator labels are what pushed `FilterBar`'s menu off-screen.
 *
 * Desktop project only, iterating its own viewports (the convention in
 * playwright.config.ts: a spec that sizes the page itself must not also run
 * under the mobile project).
 *
 * `TX_LIST_EVIDENCE=1` also writes PNGs to `.screenshots/` for the rendered
 * design review, and `TX_LIST_SCHEME=dark` renders them dark; nothing
 * compares them.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  dismissMobileSidebar,
  expectNoHorizontalOverflow,
  mockHavenApi,
  seedAuthenticatedSession,
  testSafe,
  testUser,
} from './fixtures/haven-api'

const EVIDENCE = process.env.TX_LIST_EVIDENCE === '1'
const SCHEME = process.env.TX_LIST_SCHEME === 'dark' ? 'dark' : 'light'

async function evidence(target: Page | Locator, name: string) {
  if (!EVIDENCE) return
  const suffix = SCHEME === 'dark' ? '-dark' : ''
  await target.screenshot({ path: `.screenshots/transactions-list-${name}${suffix}.png`, animations: 'disabled' })
}

/** A second account, on Base Sepolia, so Account and Network have two options. */
const sepoliaAccount = {
  ...testSafe,
  id: 'safe-sepolia',
  account_address: '0x' + '5e'.repeat(20),
  chain_id: 84532,
  name: 'Reserve',
  is_default: false,
}

const filterOptions = {
  accounts: [
    { id: testSafe.id, name: testSafe.name, address: testSafe.account_address, chainId: 8453 },
    { id: sepoliaAccount.id, name: sepoliaAccount.name, address: sepoliaAccount.account_address, chainId: 84532 },
  ],
  agents: [
    { id: 'agent-long', name: 'Quarterly procurement and vendor reconciliation agent', status: 'active' },
    { id: 'agent-paused', name: 'Atlas', status: 'paused' },
    { id: 'agent-revoked', name: 'Lovable Dev preview deployment helper', status: 'revoked' },
  ],
  tokens: [
    { key: '8453:0xusdc', symbol: 'USDC', address: '0x' + 'dd'.repeat(20), chainId: 8453, isNative: false },
    { key: '84532:native', symbol: 'ETH', address: null, chainId: 84532, isNative: true },
  ],
}

/** Registered after `mockHavenApi`, so it wins for the two reads it answers. */
async function serveTwoNetworkAccounts(page: Page) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    if (request.method() === 'GET' && path === '/auth/me') {
      await route.fulfill({ json: { ...testUser, accounts: [testSafe, sepoliaAccount] } })
      return
    }
    if (request.method() === 'GET' && path === '/transactions/filters') {
      await route.fulfill({ json: filterOptions })
      return
    }
    await route.fallback()
  })
}

async function open(page: Page, width: number, height: number, query = '') {
  await mockHavenApi(page)
  await serveTwoNetworkAccounts(page)
  await seedAuthenticatedSession(page)
  await page.emulateMedia({ colorScheme: SCHEME })
  await page.setViewportSize({ width, height })
  await page.goto(`/transactions${query}`)
  await dismissMobileSidebar(page)
  await expect(page.getByRole('heading', { name: 'Transaction history' })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
}

async function expectInsideViewport(page: Page, target: Locator, label: string) {
  const box = await target.boundingBox()
  const viewport = page.viewportSize()!
  expect(box, `${label} has a box`).not.toBeNull()
  expect(box!.x, `${label}: left edge ${box!.x}px is off-screen`).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width, `${label}: right edge ${box!.x + box!.width}px passes ${viewport.width}px`).toBeLessThanOrEqual(
    viewport.width,
  )
}

async function expectTapTarget(target: Locator, label: string) {
  const box = await target.boundingBox()
  expect(box, `${label} has a box`).not.toBeNull()
  expect(box!.height, `${label} is ${box!.height}px tall, under the 44px tap target`).toBeGreaterThanOrEqual(44)
}

test.describe('transactions list controls — 375px', () => {
  test('every control is a 44px target, and the filter sheet stays on screen', async ({ page }) => {
    await open(page, 375, 812)
    const toolbar = page.getByTestId('list-toolbar')

    // The facet row is collapsed into the Filters button below `sm`.
    await expect(toolbar.getByTestId('list-toolbar-facets')).toBeHidden()
    const search = toolbar.getByRole('searchbox', { name: 'Search transactions' })
    const filters = toolbar.getByRole('button', { name: /^Filters/ })
    const exportCsv = toolbar.getByRole('button', { name: 'Export CSV' })
    for (const [control, label] of [
      [search, 'Search'],
      [filters, 'Filters'],
      [exportCsv, 'Export CSV'],
    ] as const) {
      await expect(control).toBeVisible()
      await expectTapTarget(control, label)
      await expectInsideViewport(page, control, label)
    }
    expect(await expectNoHorizontalOverflow(page)).toMatchObject({ hasOverflow: false })
    await evidence(page, 'toolbar-375')

    await filters.click()
    const sheet = page.getByRole('dialog', { name: 'Filters' })
    await expect(sheet).toBeVisible()
    await expectInsideViewport(page, sheet, 'Filter sheet')

    // Every facet this page declares is in the sheet — Network included,
    // which sat outside the bar as a separate select before #4111.
    for (const group of ['Account', 'Initiator', 'Token', 'Direction', 'Network', 'Period']) {
      await expect(sheet.getByRole('group', { name: group })).toBeVisible()
    }
    // Every row a phone user taps is 44px and inside the viewport, the long
    // agent names included.
    const rows = sheet.locator('label')
    const rowCount = await rows.count()
    expect(rowCount).toBeGreaterThan(10)
    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i)
      await row.scrollIntoViewIfNeeded()
      const text = (await row.innerText()).trim()
      await expectTapTarget(row, `Sheet row "${text}"`)
      await expectInsideViewport(page, row, `Sheet row "${text}"`)
    }
    await evidence(page, 'sheet-375')

    // Live, as on desktop: the tap applies and reaches the URL at once.
    await sheet.getByRole('group', { name: 'Direction' }).getByRole('radio', { name: 'Outgoing' }).check()
    await expect(page).toHaveURL(/direction=out/)
    await sheet.getByRole('button', { name: /^Show / }).click()
    await expect(sheet).toBeHidden()
    await expect(toolbar.getByRole('button', { name: 'Remove Direction: Outgoing' })).toBeVisible()
    await expect(toolbar.getByRole('button', { name: 'Filters (1)' })).toBeFocused()
  })
})

test.describe('transactions list controls — desktop menus', () => {
  test('at the narrowest facet-row width, every menu stays inside the viewport', async ({ page }) => {
    // 640px is `sm`, the first width the facet row shows: the tightest room
    // a menu gets, and the width class where FilterBar's menus overflowed.
    await open(page, 640, 900)
    const toolbar = page.getByTestId('list-toolbar')
    const triggers = toolbar.locator('button[aria-haspopup="menu"]')
    const labels = ['Account', 'Initiator', 'Token', 'Direction', 'Network', 'Period']
    await expect(triggers).toHaveCount(labels.length)
    for (const [i, label] of labels.entries()) {
      const trigger = triggers.nth(i)
      await expect(trigger).toHaveAccessibleName(new RegExp(`^${label}:`))
      await trigger.click()
      await expect(trigger).toHaveAttribute('aria-expanded', 'true')
      const panel = page.locator(`[id="${await trigger.getAttribute('aria-controls')}"]`)
      await expect(panel).toBeVisible()
      await expectInsideViewport(page, panel, `${label} menu @ 640px`)
      if (label === 'Initiator') await evidence(page, 'initiator-menu-640')
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
    }
  })

  test('an old ?search= link applies its search and rewrites the address to q', async ({ page }) => {
    await open(page, 1280, 900, '?search=atlas&direction=out')
    await expect(page.getByRole('searchbox', { name: 'Search transactions' })).toHaveValue('atlas')
    await expect(page).toHaveURL(/[?&]q=atlas/)
    expect(new URL(page.url()).searchParams.has('search')).toBe(false)
    expect(new URL(page.url()).searchParams.get('direction')).toBe('out')
    await evidence(page, 'filtered-desktop')
  })
})
