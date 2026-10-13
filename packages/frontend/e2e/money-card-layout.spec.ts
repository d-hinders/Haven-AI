/**
 * The dashboard money card's two halves line up (#3908).
 *
 * At `lg` the balance half and the spending half share one grid row, so they
 * are the same height, and the spending half is the taller one. Before #3908
 * the balance half ended in an empty band under "Add funds" / "Deposit
 * address". The sparkline now grows into that height, so the actions sit
 * level with the spending half's bottom row. Measured in rendered CSS px —
 * the visual gate is advisory on `dev`, so a baseline alone would not hold it.
 */
import { expect, test } from '@playwright/test'
import { dashboardOverview, dismissMobileSidebar, mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'

test.beforeEach(async ({ page }) => {
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
})

test('the balance half has no empty band under its actions at 1280', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/dashboard')
  const balance = page.getByRole('region', { name: 'Balance' })
  await expect(balance.getByRole('button', { name: 'Add funds' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Spending' }).getByText('Stopped by budget')).toBeVisible()
  const bottoms = await page.evaluate(() => {
    const balanceEl = document.querySelector('section[aria-label="Balance"]')
    const actions = balanceEl?.lastElementChild
    const spending = document.querySelector('section[aria-label="Spending"]')
    // The spending half's content column; its last child is the counts row.
    const counts = spending?.querySelector('[data-testid="spending-counts"]')
    const sparkline = document.querySelector('[data-testid="money-card-sparkline"] svg')
    if (!actions || !counts || !sparkline) return null
    return {
      actions: actions.getBoundingClientRect().bottom,
      actionsTop: actions.getBoundingClientRect().top,
      counts: counts.getBoundingClientRect().bottom,
      sparklineBottom: sparkline.getBoundingClientRect().bottom,
    }
  })
  expect(bottoms, 'could not find the actions row, the counts row or the sparkline').not.toBeNull()
  // The actions sit level with the counts row...
  expect(
    Math.abs(bottoms!.actions - bottoms!.counts),
    `actions bottom ${bottoms!.actions} vs counts bottom ${bottoms!.counts}`,
  ).toBeLessThanOrEqual(1)
  // ...and the spare height went to the chart drawing, not into a band above
  // the actions: only the half's own 16px gap (gap-4) plus the chart box's
  // 4px dot inset separate the svg from the actions (20px measured; 45px
  // when the chart does not fill).
  expect(
    bottoms!.actionsTop - bottoms!.sparklineBottom,
    `band between the sparkline drawing (${bottoms!.sparklineBottom}) and the actions (${bottoms!.actionsTop})`,
  ).toBeLessThanOrEqual(21)
})

test('below lg the stacked card keeps the sparkline at its fixed 40px (900)', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto('/dashboard')
  await expect(page.getByRole('region', { name: 'Balance' }).getByRole('button', { name: 'Add funds' })).toBeVisible()
  const height = await page.evaluate(
    () => document.querySelector('[data-testid="money-card-sparkline"] svg')?.getBoundingClientRect().height ?? null,
  )
  expect(height, 'no sparkline drawing rendered').not.toBeNull()
  expect(Math.abs(height! - 40), `sparkline drawing is ${height}px tall at 900`).toBeLessThanOrEqual(0.5)
})

test('at 390 every agent row keeps its name whole beside the last-payment column', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/dashboard')
  await dismissMobileSidebar(page)
  await expect(page.getByTestId('agent-row-last-payment').first()).toBeVisible()
  // #3908 design review: a 40% right column left "Research agent" as "R…".
  // The name span truncates by design when it truly cannot fit; since #3910
  // the time sits on the name line below `sm` (no merchant), so the fixture's
  // names fit whole.
  const names = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('a[href^="/agents/"] p span.truncate')).map((el) => ({
      text: el.textContent,
      clipped: el.scrollWidth > el.clientWidth + 1,
    })),
  )
  expect(names.length, 'no agent rows rendered').toBeGreaterThan(0)
  expect(names.filter((n) => n.clipped), 'agent names clipped at 390').toEqual([])
})

/**
 * #3912: every agent row's budget bar is the same length. Each row is its
 * own grid, and from `sm` the last-payment column was content-sized
 * (`fit-content(40%)`, #3910), so a long merchant host shortened that row's
 * bar. The column is now a fixed 10rem in every row; the merchant truncates
 * with a tooltip.
 *
 * The clock is frozen at the fixture's day: its budget reads end on 09-02 /
 * 09-03, and on the real clock they read as "refilled, updating", which
 * renders no bar at all — an "every bar equal" loop would pass on nothing.
 */
const FROZEN_NOW = new Date('2026-09-01T12:00:00.000Z')

/** The fixture overview with a long host on the research agent and no payment on the watcher. */
function overviewWithLongHostAndNoPayment() {
  const body = JSON.parse(JSON.stringify(dashboardOverview)) as typeof dashboardOverview
  const research = body.agents[0]
  research.stats.lastCounterparty = {
    source: 'x402',
    x402ResourceUrl: 'https://demo-merchant-dev-84e4.up.railway.app/report',
    to: research.stats.lastCounterparty?.to ?? '0x' + '9'.repeat(40),
    merchantName: null,
  }
  const watcher = body.agents.find((agent) => agent.id === 'agent-e2e-watcher')!
  watcher.stats.lastPaymentAt = null
  return { body, researchId: research.id }
}

async function serveOverview(page: import('@playwright/test').Page, body: unknown) {
  // Registered after mockHavenApi, so it wins this path alone.
  await page.route('**/api/dashboard/overview*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
  )
}

test('from sm every agent row\'s budget bar has the same length and right edge (1280)', async ({ page }) => {
  await page.clock.setFixedTime(FROZEN_NOW)
  const { body } = overviewWithLongHostAndNoPayment()
  await serveOverview(page, body)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/dashboard')
  await expect(page.locator('a[href^="/agents/"] [role="progressbar"]').nth(1)).toBeVisible()
  const bars = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href^="/agents/"] [role="progressbar"]')).map((el) => {
      const r = el.getBoundingClientRect()
      return { width: r.width, right: r.right }
    }),
  )
  // Guard first: at least two bars, or "all equal" proves nothing.
  expect(bars.length, 'fewer than two budget bars rendered').toBeGreaterThanOrEqual(2)
  for (const bar of bars) {
    expect(Math.abs(bar.width - bars[0].width), `bar widths ${bars.map((b) => b.width).join(', ')}`).toBeLessThanOrEqual(1)
    expect(Math.abs(bar.right - bars[0].right), `bar right edges ${bars.map((b) => b.right).join(', ')}`).toBeLessThanOrEqual(1)
  }
})

test('from sm a setup row\'s body ends where the other rows\' bodies end (1280)', async ({ page }) => {
  await page.clock.setFixedTime(FROZEN_NOW)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/dashboard')
  await expect(page.locator('a[href="/agents/agent-e2e-pending"]').filter({ hasText: 'Connecting agent' })).toBeVisible()
  // The fixture's setup row has no bar, so the proof is structural: the body
  // cell (the `[grid-area:body]` div, the second child after the name line)
  // ends at the same right edge as every other row's body.
  const rights = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/agents/"]'))
      .filter((a) => a.firstElementChild?.getAttribute('aria-hidden') === 'true' && a.querySelector('p span.truncate'))
      .map((a) => ({
        href: a.getAttribute('href'),
        right: (a.children[2] as HTMLElement).getBoundingClientRect().right,
      })),
  )
  expect(rights.length, 'fewer than two agent rows').toBeGreaterThanOrEqual(2)
  const setup = rights.find((r) => r.href === '/agents/agent-e2e-pending')!
  const other = rights.find((r) => r.href !== '/agents/agent-e2e-pending')!
  expect(Math.abs(setup.right - other.right), `setup body ends at ${setup.right}, others at ${other.right}`).toBeLessThanOrEqual(1)
})

test('from sm a long host truncates with its full name as a tooltip, and "No payments yet" fits (1280)', async ({ page }) => {
  await page.clock.setFixedTime(FROZEN_NOW)
  const { body, researchId } = overviewWithLongHostAndNoPayment()
  await serveOverview(page, body)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/dashboard')
  const research = page.locator(`a[href="/agents/${researchId}"]`).filter({ has: page.getByTestId('agent-row-last-payment') })
  const merchant = research.getByTestId('agent-row-last-payment').locator('p').nth(1)
  await expect(merchant).toBeVisible()
  await expect(merchant).toHaveAttribute('title', 'demo-merchant-dev-84e4.up.railway.app')
  expect(await merchant.evaluate((el) => el.scrollWidth > el.clientWidth + 1), 'the long host is not truncated').toBe(true)
  const none = page.locator('a[href="/agents/agent-e2e-watcher"]').filter({ has: page.getByTestId('agent-row-last-payment') }).getByText('No payments yet')
  await expect(none).toBeVisible()
  expect(await none.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), '"No payments yet" is clipped').toBe(true)
})

test('at 390 a budget bar still spans the row (frozen clock)', async ({ page }) => {
  await page.clock.setFixedTime(FROZEN_NOW)
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/dashboard')
  await dismissMobileSidebar(page)
  const row = page.locator('a[href^="/agents/"]').filter({ has: page.getByRole('progressbar') }).first()
  await expect(row).toBeVisible()
  const ratio = await row.evaluate((rowEl) => {
    const icon = rowEl.firstElementChild as HTMLElement
    const chev = rowEl.lastElementChild as Element
    const bar = rowEl.querySelector('[role="progressbar"]') as HTMLElement
    return bar.getBoundingClientRect().width / (chev.getBoundingClientRect().left - icon.getBoundingClientRect().right)
  })
  expect(ratio, 'the bar does not span the row at 390').toBeGreaterThanOrEqual(0.85)
})

/**
 * #3910: below `sm` the time sits on the name line and the body (bar,
 * caption, paused line) spans the row; the merchant is hidden. Structural,
 * so it holds on any fixture: the paused Watcher row's paused line spans the
 * space between the icon and the chevron, and the time is level with the name.
 */
test('at 390 the paused row body spans the row and the time sits on the name line', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/dashboard')
  await dismissMobileSidebar(page)
  // The agents-section row, not a "Needs attention" action linking to the same page.
  const row = page.locator('a[href="/agents/agent-e2e-watcher"]').filter({ has: page.getByTestId('agent-row-last-payment') })
  await expect(row.getByText(/Payments paused in Haven/)).toBeVisible()
  const m = await row.evaluate((rowEl) => {
    // The row's first child is the robot mark, its last the chevron.
    const icon = rowEl.firstElementChild as HTMLElement
    const chev = rowEl.lastElementChild as Element
    const paused = Array.from(rowEl.querySelectorAll('p')).find((p) => p.textContent?.startsWith('Payments paused')) as HTMLElement
    const name = rowEl.querySelector('p span.truncate') as HTMLElement
    const time = rowEl.querySelector('[data-testid="agent-row-last-payment"] p') as HTMLElement
    const merchant = rowEl.querySelector('[data-testid="agent-row-last-payment"] p:nth-child(2)') as HTMLElement | null
    const span = chev.getBoundingClientRect().left - icon.getBoundingClientRect().right
    return {
      ratio: paused.getBoundingClientRect().width / span,
      topDelta: Math.abs(time.getBoundingClientRect().top - name.getBoundingClientRect().top),
      merchantShown: merchant ? merchant.getBoundingClientRect().width > 0 : false,
    }
  })
  expect(m.ratio, 'the paused line does not span the row').toBeGreaterThanOrEqual(0.85)
  expect(m.topDelta, 'the time is not on the name line').toBeLessThanOrEqual(2)
  expect(m.merchantShown, 'the merchant is visible at 390').toBe(false)
})

/**
 * #3910 design review: a setup row has no time cell. Its name now spans the
 * empty column and that column's gap, so at 390 "Needs setup" stays on the
 * name's line instead of wrapping under it (~20px taller row).
 */
test('at 390 a setup row\'s name line spans the empty time column', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/dashboard')
  await dismissMobileSidebar(page)
  const row = page
    .locator('a[href="/agents/agent-e2e-pending"]')
    .filter({ hasNot: page.getByTestId('agent-row-last-payment') })
    .filter({ hasText: 'Connecting agent' })
  await expect(row.getByText('Needs setup')).toBeVisible()
  // Structural, so it holds whatever the font metrics: with no time cell the
  // name line spans everything between the icon and the chevron except their
  // two 12px gaps. On the old template the empty column kept a third gap,
  // which on CI's Linux fonts wrapped "Needs setup" under the name.
  const m = await row.evaluate((rowEl) => {
    const icon = rowEl.firstElementChild as HTMLElement
    const chev = rowEl.lastElementChild as Element
    const nameLine = rowEl.querySelector('p') as HTMLElement
    const span = chev.getBoundingClientRect().left - icon.getBoundingClientRect().right
    return { span, name: nameLine.getBoundingClientRect().width }
  })
  expect(m.name, `name line ${m.name}px in a ${m.span}px span`).toBeGreaterThanOrEqual(m.span - 24 - 1)
})

/**
 * #3912: from `sm` the name line spans the row (the time column sits beside
 * the body only), so a badge such as "92% used" stays on the name's line
 * instead of wrapping under a name squeezed into the 1fr track.
 */
test('from sm every agent row\'s name line spans the row (1280)', async ({ page }) => {
  await page.clock.setFixedTime(FROZEN_NOW)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/dashboard')
  await expect(page.getByTestId('agent-row-last-payment').first()).toBeVisible()
  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/agents/"]'))
      .filter((a) => a.firstElementChild?.getAttribute('aria-hidden') === 'true' && a.querySelector('p span.truncate'))
      .map((a) => {
        const span = (a.lastElementChild as Element).getBoundingClientRect().left - (a.firstElementChild as HTMLElement).getBoundingClientRect().right
        return { span, name: (a.children[1] as HTMLElement).getBoundingClientRect().width }
      }),
  )
  expect(rows.length, 'fewer than two agent rows').toBeGreaterThanOrEqual(2)
  for (const r of rows) expect(r.name, `name line ${r.name}px in a ${r.span}px span`).toBeGreaterThanOrEqual(r.span - 24 - 1)
})
