import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3000)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${PORT}`
const webServerCommand = process.env.CI
  ? [
      'mkdir -p .next/standalone/packages/frontend/.next/static .next/standalone/packages/frontend/public',
      'cp -R .next/static/. .next/standalone/packages/frontend/.next/static',
      '[ ! -d public ] || cp -R public/. .next/standalone/packages/frontend/public',
      'node .next/standalone/packages/frontend/server.js',
    ].join(' && ')
  : `npm run dev -- --hostname 127.0.0.1 --port ${PORT}`

export default defineConfig({
  testDir: './e2e',
  // The unmocked live smoke (e2e/live) runs only via playwright.live.config.ts
  // against a real deployment — keep it out of the fast, fully-mocked suite.
  testIgnore: ['**/live/**'],
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  outputDir: '../../output/playwright/test-results',
  reporter: [
    ['list'],
    ['html', { outputFolder: '../../output/playwright/html-report', open: 'never' }],
  ],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: webServerCommand,
    cwd: __dirname,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: 'playwright-placeholder',
      NEXT_TELEMETRY_DISABLED: '1',
      HOSTNAME: '127.0.0.1',
      PORT: String(PORT),
    },
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium-mobile',
      use: { ...devices['Pixel 5'] },
    },
  ],
})
