import { defineConfig, devices } from '@playwright/test'

/**
 * Live QA smoke (#576, epic #573 Layer 1).
 *
 * Runs the `e2e/live` specs **unmocked** against a real Vercel deployment URL
 * (`PLAYWRIGHT_BASE_URL`) using the seeded QA identity — proving the deployed
 * stack is actually wired (frontend ↔ backend ↔ Postgres). No local `webServer`:
 * it only ever targets an already-deployed URL. Kept separate from
 * `playwright.config.ts` so the fast, fully-mocked `browser_smoke` suite is
 * unaffected. Manual-only (workflow_dispatch / local) — never money-moving.
 */

const baseURL = process.env.PLAYWRIGHT_BASE_URL
if (!baseURL) {
  throw new Error(
    'playwright.live.config.ts requires PLAYWRIGHT_BASE_URL (the deployed frontend URL).',
  )
}

export default defineConfig({
  testDir: './e2e/live',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  outputDir: '../../output/playwright-live/test-results',
  reporter: [
    ['list'],
    ['html', { outputFolder: '../../output/playwright-live/html-report', open: 'never' }],
  ],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  // No webServer — this config only runs against a deployed URL.
  projects: [
    {
      name: 'live-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
