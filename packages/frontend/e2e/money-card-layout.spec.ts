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
import { dismissMobileSidebar, mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'

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
  // The name span truncates by design when it truly cannot fit; with the
  // column capped at 7rem the fixture's names fit whole.
  const names = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('a[href^="/agents/"] p span.truncate')).map((el) => ({
      text: el.textContent,
      clipped: el.scrollWidth > el.clientWidth + 1,
    })),
  )
  expect(names.length, 'no agent rows rendered').toBeGreaterThan(0)
  expect(names.filter((n) => n.clipped), 'agent names clipped at 390').toEqual([])
})
