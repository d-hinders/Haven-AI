/**
 * List controls against real layout (#4110, epic #4108).
 *
 * The unit tests (`components/ui/__tests__/`) prove roles, keyboard and the
 * clamp ARITHMETIC (`menuShift`) in jsdom, which has no layout. What only a
 * browser can prove is the acceptance criterion itself: **no menu extends
 * past a 375px viewport**, and the phone sheet's rows are 44px tall. Both are
 * measured here on `/design-system`'s List controls section, the reference
 * every migration slice copies.
 *
 * Desktop project only, iterating its own viewports (the convention in
 * playwright.config.ts: a spec that sizes the page itself must not also run
 * under the mobile project).
 *
 * `LIST_CONTROLS_EVIDENCE=1` also writes PNGs to `.screenshots/` for the
 * rendered design review; nothing compares them.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { dismissMobileSidebar, mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'

const EVIDENCE = process.env.LIST_CONTROLS_EVIDENCE === '1'
/** `dark` renders the evidence run in the dark theme (paired captures). */
const SCHEME = process.env.LIST_CONTROLS_SCHEME === 'dark' ? 'dark' : 'light'

async function evidence(target: Page | Locator, name: string) {
  if (!EVIDENCE) return
  const suffix = SCHEME === 'dark' ? '-dark' : ''
  await target.screenshot({ path: `.screenshots/list-controls-${name}${suffix}.png`, animations: 'disabled' })
}

async function open(page: Page, width: number, height: number) {
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  await page.emulateMedia({ colorScheme: SCHEME })
  await page.setViewportSize({ width, height })
  await page.goto('/design-system')
  await dismissMobileSidebar(page)
  await page.evaluate(() => document.fonts.ready)
}

/** The open menu's box must sit inside [0, viewport width]. */
async function expectMenuInsideViewport(page: Page, trigger: Locator, label: string) {
  await trigger.scrollIntoViewIfNeeded()
  await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  const id = await trigger.getAttribute('aria-controls')
  expect(id, `${label}: an open trigger names its menu`).toBeTruthy()
  const panel = page.locator(`[id="${id}"]`)
  await expect(panel).toBeVisible()
  const box = await panel.boundingBox()
  const viewport = page.viewportSize()!
  expect(box, `${label}: the menu has a box`).not.toBeNull()
  expect(box!.x, `${label}: menu left edge ${box!.x}px is off-screen`).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width, `${label}: menu right edge ${box!.x + box!.width}px passes ${viewport.width}px`).toBeLessThanOrEqual(
    viewport.width,
  )
  return panel
}

/** The hit area, not the painted box (#4150) — see transactions-list-controls.spec.ts. */
async function expectHitTarget(page: Page, target: Locator, label: string) {
  const box = await target.boundingBox()
  expect(box, `${label} has a box`).not.toBeNull()
  const overlay = await target.evaluate((el) => {
    const style = getComputedStyle(el, '::after')
    return { height: parseFloat(style.height), content: style.content }
  })
  expect(overlay.content, `${label} draws a tap-target overlay`).not.toBe('none')
  expect(overlay.height, `${label}: overlay is ${overlay.height}px tall, under 44px`).toBeGreaterThanOrEqual(44)
  const point = { x: box!.x + box!.width / 2, y: box!.y - 2 }
  const hit = await target.evaluate((el, pt) => (document.elementFromPoint(pt.x, pt.y) as HTMLElement | null)?.closest('button') === el, point)
  expect(hit, `${label}: the 44px overlay does not answer a tap at its own edge`).toBe(true)
}

test.describe('list controls — layout', () => {
  test('no menu extends past a 375px viewport', async ({ page }) => {
    await open(page, 375, 812)
    const primitives = page.getByTestId('ds-list-controls-primitives')
    const triggers = primitives.locator('button[aria-haspopup="menu"]')
    await expect(triggers).toHaveCount(2)
    for (const [i, label] of ['Network', 'Period'].entries()) {
      const trigger = triggers.nth(i)
      await expect(trigger).toHaveAccessibleName(new RegExp(`^${label}:`))
      const box = await trigger.boundingBox()
      expect(box!.height, `${label} trigger is a 44px tap target on a phone`).toBeGreaterThanOrEqual(44)
      await expectMenuInsideViewport(page, trigger, `${label} @ 375px`)
      if (i === 1) await evidence(page, 'period-menu-375')
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
    }

    // The responsive toolbar collapses below sm: no facet chip is visible,
    // the Filters button is.
    const responsive = page.getByTestId('ds-list-controls-default')
    await expect(responsive.getByTestId('list-toolbar-facets')).toBeHidden()
    await expect(responsive.getByRole('button', { name: /^Filters/ })).toBeVisible()
  })

  test('the phone sheet fits the viewport, its rows are 44px, and taps apply live', async ({ page }) => {
    await open(page, 375, 812)
    const phone = page.getByTestId('ds-list-controls-phone')
    await phone.scrollIntoViewIfNeeded()
    await phone.getByRole('button', { name: 'Filters (1)' }).click()
    const sheet = page.getByRole('dialog', { name: 'Filters' })
    await expect(sheet).toBeVisible()
    const box = await sheet.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(375)

    const paused = sheet.getByRole('checkbox', { name: /Paused/ })
    // Scoped through the checkbox: a `hasText: 'Paused'` label filter would
    // also match the Initiator row whose META slot reads "Paused" (#4150).
    // The `has` locator must be page-rooted — a `sheet`-rooted one would be
    // re-rooted INSIDE the label and never match.
    const row = sheet.locator('label').filter({ has: page.getByRole('checkbox', { name: /Paused/ }) })
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await evidence(page, 'phone-sheet-375')

    await expect(sheet.getByRole('button', { name: 'Show 3 agents' })).toBeVisible()
    await paused.check()
    // Live: the count behind the sheet — on the list summary line (#4196) —
    // moved with the tap.
    await expect(sheet.getByRole('button', { name: 'Show 4 agents' })).toBeVisible()
    await expect(phone.getByTestId('list-summary').getByTestId('list-toolbar-count')).toHaveText('4 of 5 agents')
    await sheet.getByRole('button', { name: 'Show 4 agents' }).click()
    await expect(sheet).toBeHidden()
    await expect(phone.getByRole('button', { name: 'Filters (1)' })).toBeFocused()
  })

  test('long labels reveal their tail: the meta slot in the sheet and the chip, no hover (#4150)', async ({ page }) => {
    await open(page, 375, 812)
    const phone = page.getByTestId('ds-list-controls-phone')
    await phone.scrollIntoViewIfNeeded()
    await phone.getByRole('button', { name: 'Filters (1)' }).click()
    const sheet = page.getByRole('dialog', { name: 'Filters' })
    await expect(sheet).toBeVisible()

    // The long Initiator row: the label wraps (line-clamped), the meta slot
    // shows the status in full — nothing reveals by hover.
    const row = sheet.locator('label').filter({ hasText: 'Lovable Dev preview deployment helper' })
    await row.scrollIntoViewIfNeeded()
    const status = row.getByText('Revoked')
    await expect(status).toBeVisible()
    expect(await status.evaluate((el) => el.scrollWidth > 0 && el.scrollWidth <= el.clientWidth), 'the meta slot is clipped').toBe(true)
    const label = row.getByText('Lovable Dev preview deployment helper')
    expect(await label.evaluate((el) => getComputedStyle(el).webkitLineClamp)).toBe('2')
    await evidence(page, 'meta-sheet-375')

    // Selecting it puts the full label + status on the status-row chip.
    await row.getByRole('radio').check()
    await sheet.getByRole('button', { name: /^Show / }).click()
    await expect(sheet).toBeHidden()
    const chipLabel = phone.getByText('Initiator: Lovable Dev preview deployment helper (Revoked)')
    await expect(chipLabel).toBeVisible()

    // The chip's remove control: painted 24px, a live 44px hit area.
    const remove = phone.getByRole('button', { name: 'Remove Initiator: Lovable Dev preview deployment helper (Revoked)' })
    await expect(remove).toBeVisible()
    const box = await remove.boundingBox()
    expect(box!.height, 'the remove control is painted 24px').toBeLessThanOrEqual(28)
    await expectHitTarget(page, remove, 'Chip remove')
  })

  test('the search placeholder ellipsizes and the phone actions slot hugs its content (#4150)', async ({ page }) => {
    await open(page, 375, 812)
    const phone = page.getByTestId('ds-list-controls-phone')
    const search = phone.getByRole('searchbox', { name: 'Search agents' })
    await expect(search).toBeVisible()
    expect(await search.evaluate((el) => getComputedStyle(el).textOverflow), 'placeholder does not ellipsize').toBe('ellipsis')

    // The server-filtered example's Export CSV: its own row on phone,
    // content-width — the pattern owns the sizing, not the page.
    const server = page.getByTestId('ds-list-controls-server')
    const exportCsv = server.getByRole('button', { name: 'Export CSV' })
    await exportCsv.scrollIntoViewIfNeeded()
    await expect(exportCsv).toBeVisible()
    const exportBox = await exportCsv.boundingBox()
    expect(exportBox!.width, 'Export CSV is full-width on phone').toBeLessThan(150)
    await expectHitTarget(page, exportCsv, 'Export CSV')
  })

  test('desktop menus stay inside the viewport and states render', async ({ page }) => {
    await open(page, 1280, 900)
    const section = page.getByTestId('ds-list-controls')
    await section.scrollIntoViewIfNeeded()
    const toolbar = page.getByTestId('ds-list-controls-default')
    for (const name of [/^Status:/, /^Budget:/, /^Sort:/]) {
      const trigger = toolbar.getByRole('button', { name })
      await expectMenuInsideViewport(page, trigger, String(name))
      if (String(name).includes('Status')) await evidence(toolbar, 'status-menu-desktop')
      await page.keyboard.press('Escape')
    }
    const server = page.getByTestId('ds-list-controls-server')
    await expectMenuInsideViewport(page, server.getByRole('button', { name: /^Period:/ }), 'Period (server)')
    await evidence(server, 'period-menu-desktop')
    await page.keyboard.press('Escape')

    await expect(page.getByTestId('ds-list-controls-no-match')).toContainText('No agents match these filters')
    await expect(
      page.getByTestId('ds-list-controls-filtered').getByTestId('list-summary').getByTestId('list-toolbar-count'),
    ).toHaveText('1 of 5 agents')
    // #4196: no filter, no status row; the paging button sits below its card.
    await expect(page.getByTestId('ds-list-controls-default').getByTestId('list-toolbar-status')).toHaveCount(0)
    await expect(page.getByTestId('ds-list-controls-paging').getByRole('button', { name: 'Show 24 more' })).toBeVisible()
    if (EVIDENCE) {
      for (const state of ['default', 'filtered', 'no-match', 'loading', 'phone', 'server', 'paging', 'primitives']) {
        await evidence(page.getByTestId(`ds-list-controls-${state}`), `${state}-desktop`)
      }
    }
  })

  test('a server-filtered search sends one request per pause', async ({ page }) => {
    await open(page, 1280, 900)
    const server = page.getByTestId('ds-list-controls-server')
    await server.scrollIntoViewIfNeeded()
    const requests = server.getByTestId('ds-list-controls-requests')
    await expect(requests).toHaveText('Requests sent: 1')
    await server.getByRole('searchbox', { name: 'Search transactions' }).pressSequentially('savings', { delay: 30 })
    await expect(requests).toHaveText('Requests sent: 2')
    await page.waitForTimeout(500)
    await expect(requests).toHaveText('Requests sent: 2')
  })
})
