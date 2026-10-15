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
import { dashboardOverview, dismissMobileSidebar, mockHavenApi, seedAuthenticatedSession, serveSekUser } from './fixtures/haven-api'

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

test('at 390 every agent row keeps its name whole beside its badge (#3989)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/dashboard')
  await dismissMobileSidebar(page)
  await expect(page.getByTestId('agent-row-last-payment').first()).toBeVisible()
  // #3989: the last-payment time no longer sits on the name line at any
  // width — it lives on the caption line under the bar. The name line carries
  // only the name and its badge, so nothing wraps under the name at 390 and
  // the fixture's names fit whole.
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
 * #3989: the fixture keeps a long x402 host and a resolved merchant on the
 * wire (the fields are required), but the row renders NEITHER — the merchant
 * is gone from the dashboard agent row. The watcher never paid, so its time
 * reads "No payments yet".
 *
 * The clock is frozen at the fixture's day: its budget reads end on 09-02 /
 * 09-03, and on the real clock they read as "refilled, updating", which
 * renders no bar at all — a layout loop over the caption line would pass on
 * nothing.
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

test('at every width each agent row\'s bar ends at the row\'s content edge (1280)', async ({ page }) => {
  await page.clock.setFixedTime(FROZEN_NOW)
  const { body } = overviewWithLongHostAndNoPayment()
  await serveOverview(page, body)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/dashboard')
  await expect(page.locator('a[href^="/agents/"] [role="progressbar"]').nth(1)).toBeVisible()
  // #3989: no 10rem time column any more — the body (bar, caption line) spans
  // the row between the icon and the chevron at EVERY width. The bar's right
  // edge sits exactly one 12px grid gap short of the chevron's left edge.
  // Measured on the row that USED to carry the long host, whose bar used to
  // stop ~10rem short.
  const gaps = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/agents/"]'))
      .filter((a) => a.querySelector('[role="progressbar"]'))
      .map((a) => {
        const bar = (a.querySelector('[role="progressbar"]') as HTMLElement).getBoundingClientRect()
        const chev = (a.lastElementChild as Element).getBoundingClientRect()
        return { gap: chev.left - bar.right }
      }),
  )
  expect(gaps.length, 'fewer than two budget bars rendered').toBeGreaterThanOrEqual(2)
  for (const { gap } of gaps) {
    expect(gap, `bar right edge sits ${gap}px from the chevron (want 12px grid gap)`).toBeGreaterThanOrEqual(11)
    expect(gap, `bar right edge sits ${gap}px from the chevron (want 12px grid gap)`).toBeLessThanOrEqual(13)
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

test('no merchant or counterparty renders in any agent row; the time stays labelled (1280)', async ({ page }) => {
  await page.clock.setFixedTime(FROZEN_NOW)
  const { body, researchId } = overviewWithLongHostAndNoPayment()
  await serveOverview(page, body)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/dashboard')
  // #3989: the research row's counterparty is the long x402 host, the
  // watcher's is 'Example Shop AB' over a 0x… address — the wire carries
  // both, the row renders neither.
  const research = page
    .locator(`a[href="/agents/${researchId}"]`)
    .filter({ has: page.getByTestId('agent-row-last-payment') })
  await expect(research.getByTestId('agent-row-last-payment')).toBeVisible()
  await expect(research).not.toContainText('demo-merchant-dev-84e4.up.railway.app')
  await expect(research).not.toContainText(/0x[0-9a-f]{8}/i)
  const watcher = page
    .locator('a[href="/agents/agent-e2e-watcher"]')
    .filter({ has: page.getByTestId('agent-row-last-payment') })
  await expect(watcher).not.toContainText('Example Shop AB')
  await expect(watcher).not.toContainText(/0x[0-9a-f]{8}/i)
  // What the row DOES show: the labelled time, under the bar. The watcher
  // never paid.
  await expect(research.getByTestId('agent-row-last-payment')).toHaveText(/^Last paid /)
  await expect(watcher.getByTestId('agent-row-last-payment')).toHaveText('No payments yet')
})

test('at 390 a budget bar still spans the row (frozen clock)', async ({ page }) => {
  await page.clock.setFixedTime(FROZEN_NOW)
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/dashboard')
  await dismissMobileSidebar(page)
  const row = page.locator('a[href^="/agents/"]').filter({ has: page.getByRole('progressbar') }).first()
  await expect(row).toBeVisible()
  // #3989: the bar spans the row at every width — no time column to stop
  // short of. Measured as the gap: exactly the 12px grid gap short of the
  // chevron (a ratio to the icon-chevron span can never reach 1 — the span
  // includes the gap itself).
  const ratio = await row.evaluate((rowEl) => {
    const chev = rowEl.lastElementChild as Element
    const bar = rowEl.querySelector('[role="progressbar"]') as HTMLElement
    // Expressed as the GAP, not a ratio: the bar's right edge sits exactly one
    // 12px grid gap short of the chevron (a ratio can never reach 1 — the
    // span includes the gap).
    return chev.getBoundingClientRect().left - bar.getBoundingClientRect().right
  })
  expect(ratio, `the bar does not span the row at 390 (gap ${ratio}px, want 12)`).toBeGreaterThanOrEqual(11)
  expect(ratio, `the bar does not span the row at 390 (gap ${ratio}px, want 12)`).toBeLessThanOrEqual(13)
})

/**
 * #3989: at 390 the last-payment time sits on the caption line UNDER the bar,
 * right-aligned to the content edge, and the name line is free of it — so the
 * row's badge ("Paused" here) stays beside the name instead of wrapping.
 */
test('at 390 the time sits under the bar, right-aligned, and the name line stays free of it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/dashboard')
  await dismissMobileSidebar(page)
  // The agents-section row, not a "Needs attention" action linking to the same page.
  const row = page.locator('a[href="/agents/agent-e2e-watcher"]').filter({ has: page.getByTestId('agent-row-last-payment') })
  await expect(row.getByTestId('agent-row-last-payment')).toBeVisible()
  const m = await row.evaluate((rowEl) => {
    const icon = rowEl.firstElementChild as HTMLElement
    const chev = rowEl.lastElementChild as Element
    const nameLine = rowEl.querySelector('p') as HTMLElement
    const name = rowEl.querySelector('p span.truncate') as HTMLElement
    const badge = nameLine.querySelector('span:not(.truncate)') as HTMLElement | null
    const time = rowEl.querySelector('[data-testid="agent-row-last-payment"]') as HTMLElement
    const bar = rowEl.querySelector('[role="progressbar"]') as HTMLElement | null
    return {
      nameHasTime: nameLine.contains(time),
      timeTop: time.getBoundingClientRect().top,
      nameBottom: nameLine.getBoundingClientRect().bottom,
      barBottom: bar ? bar.getBoundingClientRect().bottom : null,
      badgeTop: badge ? badge.getBoundingClientRect().top : null,
      nameTop: name.getBoundingClientRect().top,
      rightEdge: chev.getBoundingClientRect().left - 12 - time.getBoundingClientRect().right,
    }
  })
  expect(m.nameHasTime, 'the time renders inside the name line').toBe(false)
  expect(m.timeTop, 'the time is not below the name line').toBeGreaterThanOrEqual(m.nameBottom - 2)
  if (m.barBottom !== null) {
    expect(m.timeTop, 'the time is not below the bar').toBeGreaterThanOrEqual(m.barBottom - 2)
  }
  expect(m.badgeTop, 'no badge beside the name').not.toBeNull()
  expect(
    Math.abs(m.badgeTop! - m.nameTop),
    'the badge does not sit beside the name',
  ).toBeLessThanOrEqual(2)
  expect(Math.abs(m.rightEdge), `time right edge ${m.rightEdge}px off the content edge`).toBeLessThanOrEqual(1)
})

/**
 * #3989, the long-caption case: at 390 with the SEK fixture the caption and
 * the time do not fit on one line, so the time wraps to its OWN right-aligned
 * line and the caption is not narrowed to make room.
 */
test('at 390 a long SEK caption wraps the time to its own right-aligned line', async ({ page }) => {
  await page.clock.setFixedTime(FROZEN_NOW)
  await serveSekUser(page)
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/dashboard')
  await dismissMobileSidebar(page)
  const row = page.locator('a[href^="/agents/"]').filter({ has: page.getByRole('progressbar') }).first()
  await expect(row.getByTestId('agent-row-last-payment')).toBeVisible()
  const m = await row.evaluate((rowEl) => {
    const caption = (rowEl.querySelector('[role="progressbar"]') as HTMLElement).parentElement!.querySelector('p') as HTMLElement
    const time = rowEl.querySelector('[data-testid="agent-row-last-payment"]') as HTMLElement
    const line = time.parentElement as HTMLElement
    return {
      wrapped: time.getBoundingClientRect().top >= caption.getBoundingClientRect().bottom - 1,
      captionNotNarrowed:
        Math.abs(caption.getBoundingClientRect().width - line.getBoundingClientRect().width) <= 1,
      rightEdge: line.getBoundingClientRect().right - time.getBoundingClientRect().right,
    }
  })
  expect(m.wrapped, 'the time did not wrap below the caption').toBe(true)
  expect(m.captionNotNarrowed, 'the caption was narrowed').toBe(true)
  expect(Math.abs(m.rightEdge), `time right edge ${m.rightEdge}px off the content edge`).toBeLessThanOrEqual(1)
})

/**
 * #3989: with no time column in the grid at all, a setup row's name line
 * spans the row exactly like every other row's — the badge ("Needs setup")
 * never wraps under the name, at any width.
 */
test('at 390 a setup row\'s name line spans the row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/dashboard')
  await dismissMobileSidebar(page)
  const row = page
    .locator('a[href="/agents/agent-e2e-pending"]')
    .filter({ hasNot: page.getByTestId('agent-row-last-payment') })
    .filter({ hasText: 'Connecting agent' })
  await expect(row.getByText('Needs setup')).toBeVisible()
  // Structural, so it holds whatever the font metrics: the name line spans
  // everything between the icon and the chevron except the two 12px gaps.
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
 * #3989: the grid has no time column, so the name line spans the row at every
 * width — a badge such as "92% used" stays on the name's line instead of
 * wrapping under a squeezed name. (Under #3912 this needed the fixed 10rem
 * column and two grid flows; #3989 removed the column entirely.)
 */
test('at every width each agent row\'s name line spans the row (1280)', async ({ page }) => {
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
