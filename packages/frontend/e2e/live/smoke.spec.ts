import { test, expect } from '@playwright/test'
import { establishLiveSession } from '../fixtures/live-session'
import { collectBrowserErrors, unexpectedBrowserErrors } from '../fixtures/haven-api'

/**
 * Layer 1 live smoke (#576, epic #573) — UNMOCKED, against a real deployment.
 *
 * Proves the deployed stack is wired (frontend ↔ backend ↔ Postgres) using the
 * seeded QA identity. Assertions are deterministic on *structure* (headings load,
 * no error state, no console errors) but lenient on *data* (real balances /
 * transactions are unpredictable). Read-only — never moves funds.
 */

const h1 = (name: string) => ({ name, level: 1 as const })

test.describe('live smoke — deployed dev stack', () => {
  test.beforeEach(async ({ page }) => {
    await establishLiveSession(page)
  })

  test('loads authenticated against the real backend with the DEV badge', async ({ page }) => {
    const errors = collectBrowserErrors(page)

    await page.goto('/dashboard')

    await expect(page.getByRole('heading', h1('Dashboard'))).toBeVisible()
    // EnvBadge renders only when NEXT_PUBLIC_HAVEN_ENV is a non-prod value —
    // confirms we hit the dev deploy, not a stray prod build.
    await expect(page.getByText(/dev/i).first()).toBeVisible()
    // A wired deploy renders clean; surface any real integration error.
    expect(unexpectedBrowserErrors(errors)).toEqual([])
  })

  test('dashboard renders real balances, not a load-failure state', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByRole('heading', h1('Dashboard'))).toBeVisible()
    await expect(page.getByText(/could not load|failed to load/i)).toHaveCount(0)
  })

  test('transaction history loads from the real backend', async ({ page }) => {
    await page.goto('/transactions')
    await expect(page.getByRole('heading', h1('Transaction history'))).toBeVisible()
    // Either real rows or the honest empty state — never the load-failure state.
    await expect(page.getByText(/could not load|failed to load/i)).toHaveCount(0)
  })

  test('agent list renders and never leaks a raw secret', async ({ page }) => {
    await page.goto('/agents')
    await expect(page.getByRole('heading', h1('Agents'))).toBeVisible()
    // No raw agent API secret should ever be rendered in the page body.
    const body = await page.locator('body').innerText()
    expect(body).not.toMatch(/sk_(live|test)_/)
  })
})
