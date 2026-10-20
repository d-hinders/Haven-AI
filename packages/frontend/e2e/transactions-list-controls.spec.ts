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

/**
 * The hit area, not the painted box (#4150): the `::after` overlay a control
 * paints to reach 44px while rendering smaller — the way `Button` does. The
 * overlay must exist, be 44px tall, and be LIVE: a point inside it but
 * outside the painted box still hits the control.
 */
async function expectHitTarget(page: Page, target: Locator, label: string) {
  const box = await target.boundingBox()
  expect(box, `${label} has a box`).not.toBeNull()
  const overlay = await target.evaluate((el) => {
    const style = getComputedStyle(el, '::after')
    return { height: parseFloat(style.height), content: style.content }
  })
  expect(overlay.content, `${label} draws a tap-target overlay`).not.toBe('none')
  expect(overlay.height, `${label}: overlay is ${overlay.height}px tall, under 44px`).toBeGreaterThanOrEqual(44)
  // 2px above the painted box: inside the overlay, outside the control.
  const point = { x: box!.x + box!.width / 2, y: box!.y - 2 }
  const hit = await target.evaluate((el, pt) => (document.elementFromPoint(pt.x, pt.y) as HTMLElement | null)?.closest('button') === el, point)
  expect(hit, `${label}: the 44px overlay does not answer a tap at its own edge`).toBe(true)
}

/** `text-overflow: ellipsis` on the input, so a clipped placeholder ends in "…". */
async function expectPlaceholderEllipsis(target: Locator, label: string) {
  expect(await target.evaluate((el) => getComputedStyle(el).textOverflow), `${label} placeholder does not ellipsize`).toBe('ellipsis')
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
    await expectPlaceholderEllipsis(search, 'Search input')
    for (const [control, label] of [
      [search, 'Search'],
      [filters, 'Filters'],
    ] as const) {
      await expect(control).toBeVisible()
      await expectTapTarget(control, label)
      await expectInsideViewport(page, control, label)
    }
    // Export CSV (#4150): the pattern owns its sizing — its own row on
    // phone, hugging its content (never the full-width 44px row the mockup
    // does not draw) — and its 44px target comes from the Button overlay.
    await expect(exportCsv).toBeVisible()
    await expectInsideViewport(page, exportCsv, 'Export CSV')
    const filtersBox = await filters.boundingBox()
    const exportBox = await exportCsv.boundingBox()
    expect(exportBox!.y, 'Export CSV shares the search row').toBeGreaterThan(filtersBox!.y + filtersBox!.height)
    expect(exportBox!.width, 'Export CSV is full-width on phone').toBeLessThan(150)
    await expectHitTarget(page, exportCsv, 'Export CSV')
    expect(await expectNoHorizontalOverflow(page)).toMatchObject({ hasOverflow: false })
    await evidence(page, 'toolbar-375')

    await filters.click()
    const sheet = page.getByRole('dialog', { name: 'Filters' })
    await expect(sheet).toBeVisible()
    await expectInsideViewport(page, sheet, 'Filter sheet')
    // The top groups, long Initiator names included, before any scrolling.
    await evidence(page, 'sheet-top-375')

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
    // The meta slot (#4150): the revoked agent's status shows beside its
    // long name — the row wraps, the status never truncates away.
    const revokedRow = sheet.locator('label').filter({ hasText: 'Lovable Dev preview deployment helper' })
    await revokedRow.scrollIntoViewIfNeeded()
    const status = revokedRow.getByText('Revoked')
    await expect(status).toBeVisible()
    expect(await status.evaluate((el) => el.scrollWidth > 0 && el.scrollWidth <= el.clientWidth), 'the meta slot is clipped').toBe(true)
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
      if (label === 'Initiator' || label === 'Account') {
        await evidence(page, `${label.toLowerCase()}-menu-640`)
      }
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
    }
  })

  test('a long selected label stays inside the facet row at 640px (#4150)', async ({ page }) => {
    await open(page, 640, 900)
    const toolbar = page.getByTestId('list-toolbar')
    const initiator = toolbar.getByRole('button', { name: /^Initiator:/ })
    await initiator.click()
    await page.getByRole('menuitemradio', { name: /Lovable Dev preview deployment helper/ }).click()
    await expect(initiator).toBeFocused()
    // The trigger with the long selected label either fits the facet row or
    // truncates inside it — it never stretches the row past its box.
    const rowBox = await toolbar.getByTestId('list-toolbar-facets').boundingBox()
    const box = await initiator.boundingBox()
    expect(box, 'the Initiator trigger has a box').not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(rowBox!.x)
    expect(box!.y).toBeGreaterThanOrEqual(rowBox!.y)
    expect(box!.x + box!.width, `the trigger ends at ${box!.x + box!.width}px, past the facet row`).toBeLessThanOrEqual(rowBox!.x + rowBox!.width + 1)
    expect(await expectNoHorizontalOverflow(page)).toMatchObject({ hasOverflow: false })
  })

  test('an old ?search= link applies its search and rewrites the address to q', async ({ page }) => {
    await open(page, 1280, 900, '?search=atlas&direction=out')
    await expect(page.getByRole('searchbox', { name: 'Search transactions' })).toHaveValue('atlas')
    await expect(page).toHaveURL(/[?&]q=atlas/)
    expect(new URL(page.url()).searchParams.has('search')).toBe(false)
    expect(new URL(page.url()).searchParams.get('direction')).toBe('out')
    await evidence(page, 'filtered-desktop')
  })

  test('a filtered search with no rows shows the standard no-match state in place of the list', async ({ page }) => {
    await mockHavenApi(page)
    await serveTwoNetworkAccounts(page)
    // An empty feed for the filtered read, answered after the shared mocks.
    await page.route('**/api/transactions?*', async (route) => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('search') !== 'zzz') return route.fallback()
      await route.fulfill({
        json: { transactions: [], total: 0, offset: 0, limit: 25, hasMore: false, partialFailure: false, failedAccountIds: [], truncated: false },
      })
    })
    await seedAuthenticatedSession(page)
    await page.emulateMedia({ colorScheme: SCHEME })
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/transactions?q=zzz')
    await dismissMobileSidebar(page)

    const noMatch = page.getByTestId('transactions-no-match')
    await expect(noMatch).toContainText('No transactions match these filters')
    await expect(noMatch).toContainText('Try a different search, or clear filters to see everything.')
    await expect(page.getByTestId('list-toolbar')).toBeVisible()
    await evidence(page, 'no-match-desktop')

    await noMatch.getByRole('button', { name: 'Clear filters' }).click()
    await expect(noMatch).toBeHidden()
    await expect(page).not.toHaveURL(/[?&]q=/)
  })
})
