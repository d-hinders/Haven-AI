/**
 * `/accounts` on a real touch device: the card is a link and nothing else.
 *
 * ## History, stated so the absences below read as decisions
 *
 * This file measured the card's actions: first a PAIR (a `Set as default`
 * star and `Set active`, #2241), then `Set active` alone after #2374 removed
 * the star by owner decision (setting a default lives on `/accounts/<id>`).
 * #3719 removed the global active account, and `Set active` with it, so the
 * card holds no action at all. Its tap-target and paint geometry checks are
 * GONE rather than weakened — there is nothing left to measure.
 *
 * What survives:
 *
 *  - an ABSENCE pin for both removed controls, with its own non-vacuity: the
 *    same page-wide scan that must find nothing matching /default/ or
 *    /set .* as active/ must find the card's own name link, or it is proving
 *    that the page failed to render;
 *  - a set-default write must never leave the page (#2374, network level);
 *  - a real tap on the card body, and Enter on the name link, open the
 *    account through the stretched link without a full reload.
 */
import { expect, test, type Page } from '@playwright/test'
import { dismissMobileSidebar, mockHavenApi, seedAuthenticatedSession, testSafe, testUser } from './fixtures/haven-api'

const SECOND_CARD = 'Imported Safe'
const DEFAULT_CARD = 'Operating wallet'

type ControlScan = {
  /** Every button or link on the page, by accessible name + visible text. */
  all: string[]
  setDefaultControls: string[]
  setActiveControls: string[]
}

/**
 * Scan the WHOLE document, not one card: a reintroduction that landed on any
 * card must fail here. The `default` BADGE is a `span`, so it is not swept up.
 */
async function scanControls(page: Page): Promise<ControlScan> {
  return page.evaluate(() => {
    const nameOf = (el: Element) =>
      `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`.trim()
    const all = Array.from(document.querySelectorAll('button, a')).map(nameOf)
    return {
      all,
      setDefaultControls: all.filter((n) => /default/i.test(n)),
      setActiveControls: all.filter((n) => /set .* as active|set active/i.test(n)),
    }
  })
}

async function serveAccounts(page: Page, accounts: unknown[]) {
  await page.route('**/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      // One envelope key. `safes` was the deprecated twin here until #2914
      // retired it; sending it now would make this fixture describe a
      // response the backend cannot produce.
      body: JSON.stringify({ ...testUser, accounts }),
    })
  })
}

async function openAccountsWithBothCards(page: Page) {
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  await serveAccounts(page, [
    { ...testSafe, name: DEFAULT_CARD, is_default: true },
    {
      ...testSafe,
      id: 'safe-second',
      account_address: '0x4444444444444444444444444444444444444444',
      name: SECOND_CARD,
      is_default: false,
      created_at: '2026-04-20T10:00:00.000Z',
    },
  ])
  await page.goto('/accounts')
  await page.waitForSelector('[data-testid="account-card"] h3 a', { timeout: 60_000 })
  /*
    Below `lg` the nav drawer overlays the grid and would own every
    `elementFromPoint` reading underneath it (#1749). The established call, and
    the same one `accounts-name-measure.spec.ts` and
    `tooltip-reachability.spec.ts` make before their own hit-dependent reads.
  */
  await dismissMobileSidebar(page)
  await page.getByTestId('account-card').filter({ hasText: SECOND_CARD }).scrollIntoViewIfNeeded()
}

test('/accounts: the card offers neither a set-default nor a set-active control', async ({ page }) => {
  test.slow()
  await openAccountsWithBothCards(page)
  const scan = await scanControls(page)

  // Non-vacuity FIRST: the same scan, on the same page, must find the control
  // that IS meant to be there — the card's own name link. Without this an
  // empty `/accounts` is a green run.
  expect(
    scan.all.some((n) => n.includes(SECOND_CARD)),
    `the scan found no account link — this run proves nothing about an absence. It saw ${JSON.stringify(scan.all)}`,
  ).toBe(true)

  expect(
    scan.setDefaultControls,
    `the page renders ${JSON.stringify(scan.setDefaultControls)} — #2374 removed the set-default control from /accounts; it lives on /accounts/<id> only`,
  ).toEqual([])
  expect(
    scan.setActiveControls,
    `the page renders ${JSON.stringify(scan.setActiveControls)} — #3719 removed the global active account and its Set active control`,
  ).toEqual([])
  expect(
    await page.getByTestId('account-card').locator('button').count(),
    'an account card renders a button again — the card is a link and holds no action since #3719',
  ).toBe(0)
})

test('/accounts: a real tap on the card body opens the account, with no set-default write', async ({
  page,
}) => {
  test.slow()
  await openAccountsWithBothCards(page)

  /*
    The write the REMOVED star used to make (#2374). Intercepted so that a
    reintroduced control — or any tap that reaches one — shows up here as a
    network event rather than as a silent success.
  */
  let defaultWrite: string | null = null
  await page.route('**/user/accounts/*/default', async (route, request) => {
    defaultWrite = `${request.method()} ${new URL(request.url()).pathname}`
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })

  const card = page.getByTestId('account-card').filter({ hasText: SECOND_CARD })
  // Use the token row rather than the footer: at 390px the fixed bottom nav
  // can overlap the footer after scrolling, which would test that nav instead
  // of the stretched card link.
  const bodyText = card.getByText('USDC', { exact: true }).first()
  const box = await bodyText.boundingBox()
  if (!box) throw new Error('the account-card body point has no rendered box')
  await page.evaluate(() => {
    ;(window as unknown as { __cardClientNavigation?: string }).__cardClientNavigation = 'alive'
  })
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)

  await page.waitForURL('**/accounts/safe-second')
  expect(
    await page.evaluate(
      () => (window as unknown as { __cardClientNavigation?: string }).__cardClientNavigation,
    ),
    'account-card body navigation performed a full reload',
  ).toBe('alive')
  expect(
    defaultWrite,
    `tapping the card sent ${defaultWrite} — a set-default write left a page that has no set-default control (#2374)`,
  ).toBeNull()
})

test('/accounts: Enter on the account name link opens the account', async ({ page }) => {
  await openAccountsWithBothCards(page)

  const nameLink = page.getByRole('link', { name: SECOND_CARD, exact: true })
  await nameLink.focus()
  await expect(nameLink).toBeFocused()
  await page.keyboard.press('Enter')

  await page.waitForURL('**/accounts/safe-second')
})
