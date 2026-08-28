import { expect, test } from '@playwright/test'
import {
  collectBrowserErrors,
  dismissMobileSidebar,
  expectNoHorizontalOverflow,
  mockHavenApi,
  seedAuthenticatedSession,
  unexpectedBrowserErrors,
} from './fixtures/haven-api'

test.describe('authentication flows', () => {
  test('redirects protected routes to login when there is no session', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)

    await page.goto('/dashboard')

    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible()
    // `/login` is OUTSIDE the authenticated shell, so it has no
    // `#main-content` and no clipping ancestor: the document metric is the one
    // that works here, and this is the only call site in the repo where it was
    // already gating on its own (#1771). Deliberately does not assert
    // `contentRegionFound` — there is legitimately no content region.
    expect(await expectNoHorizontalOverflow(page)).toMatchObject({ hasOverflow: false })
    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })

  test('logs in with mocked backend data and lands on the dashboard', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)
    await mockHavenApi(page)

    await page.goto('/login')
    await page.getByLabel('Email').fill('ada@haven.test')
    await page.getByLabel('Password').fill('correct horse battery staple')
    await page.getByRole('button', { name: 'Log in' }).click()

    await expect(page).toHaveURL(/\/dashboard$/)
    await dismissMobileSidebar(page)
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(page.getByText('$1,250.00')).toBeVisible()
    await expect(page.getByRole('link', { name: /Research agent Connected/ })).toBeVisible()
    // #1989: the "Open approvals" alert link is DELETED with the Safe rail.
    // #2120 set this fixture's `actionableApprovals` to 0 — the value the real
    // route hardcodes — so this absence no longer rests on an impossible seed.
    // Its non-vacuity now rests where an adversarial value belongs: the
    // labelled probe in `DashboardClient.test.tsx` ("offers neither a Send
    // affordance nor an approvals route, even for a funded legacy Safe with
    // pending approvals") renders the component with a non-zero count and
    // fails if either affordance returns. The three assertions above remain
    // the positive control that the dashboard really loaded.
    await expect(page.getByRole('link', { name: 'Open approvals' })).toHaveCount(0)
    expect(await expectNoHorizontalOverflow(page)).toMatchObject({
      hasOverflow: false,
      contentRegionFound: true,
    })
    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })

  test('renders an authenticated dashboard session without signing in again', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)

    await page.goto('/dashboard')
    await dismissMobileSidebar(page)

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(page.getByText('Total balance')).toBeVisible()
    // #1989: the dashboard hero's Send button is gone — it opened `SendModal`,
    // deleted with the Safe rail. `canSend` is now constantly false, so the
    // affordance is HIDDEN rather than disabled (#1079's pattern). Receive is
    // the positive control: the hero still renders its action row.
    await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Receive' })).toBeVisible()
    expect(await expectNoHorizontalOverflow(page)).toMatchObject({
      hasOverflow: false,
      contentRegionFound: true,
    })
    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })
})
