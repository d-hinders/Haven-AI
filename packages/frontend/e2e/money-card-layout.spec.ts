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
 * #3910: from `sm` the last-payment column may take up to 40% of the row,
 * so a long merchant host shows in full where it fits. The fixture's own
 * hosts ("research.example", "Example Shop AB") already fit the old 7rem cap
 * and prove nothing, so this arm serves one agent a long host. Fails on the
 * 7rem cap: the merchant line was ~22% of the row.
 */
test('from sm a long merchant host gets up to 40% of the row (1280)', async ({ page }) => {
  const body = JSON.parse(JSON.stringify(dashboardOverview)) as typeof dashboardOverview
  // The fixture's first agent is the active research agent (`testAgent`).
  const research = body.agents[0]
  research.stats.lastCounterparty = {
    source: 'x402',
    x402ResourceUrl: 'https://demo-merchant-dev-84e4.up.railway.app/report',
    to: research.stats.lastCounterparty?.to ?? '0x' + '9'.repeat(40),
    merchantName: null,
  }
  // Registered after mockHavenApi, so it wins this path alone.
  await page.route('**/api/dashboard/overview*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
  )
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/dashboard')
  // The agents-section row, not a "Needs attention" action linking to the same page.
  const row = page.locator(`a[href="/agents/${research.id}"]`).filter({ has: page.getByTestId('agent-row-last-payment') })
  const merchant = row.getByTestId('agent-row-last-payment').locator('p').nth(1)
  await expect(merchant).toBeVisible()
  const widths = await row.evaluate((rowEl) => {
    const line = rowEl.querySelector('[data-testid="agent-row-last-payment"] p:nth-child(2)') as HTMLElement
    return {
      row: rowEl.getBoundingClientRect().width,
      merchant: line.getBoundingClientRect().width,
      whole: line.scrollWidth <= line.clientWidth + 1,
    }
  })
  // Either the host shows whole, or the column took its share: ≥35% of the
  // row (the 7rem cap gave ~23%). A wider Agents card that fits the host
  // whole must not fail this.
  expect(
    widths.whole || widths.merchant / widths.row >= 0.35,
    `merchant line ${widths.merchant}px of a ${widths.row}px row, cut short`,
  ).toBe(true)
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
