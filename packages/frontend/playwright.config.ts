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
  testIgnore: [
    '**/live/**',
    // Visual-regression specs run only under the dedicated CI job (Linux
    // baselines) — VISUAL_REGRESSION=1 opts in. See #897.
    ...(process.env.VISUAL_REGRESSION === '1' ? [] : ['**/*.visual.spec.ts']),
  ],
  // Stable baseline paths (no {platform} suffix): baselines are ALWAYS
  // Linux-rendered via the CI job / update workflow, never local macOS.
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}{ext}',
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
  // Both projects GATE on every frontend pull request (#1768). Before that,
  // `chromium-mobile` existed but only a `workflow_dispatch` with
  // `ui_suite=full` ever ran it, so no mobile viewport was exercised on a PR —
  // which is a large part of why #1749 (primary navigation unreachable below
  // `lg`) survived review.
  //
  // The two projects run DISJOINT spec sets, keyed on the `*.mobile.spec.ts`
  // filename convention. That is deliberate, not an optimisation:
  //
  //   1. Specs that iterate viewports THEMSELVES must not be re-run under
  //      device emulation. `design-system.visual.spec.ts` loops
  //      `scripts/evidence-viewports.mjs` and writes baselines named
  //      `design-system-{desktop,mobile}.png` with NO project suffix, captured
  //      at deviceScaleFactor 1. Pixel 5 emulates DSF 3, so the same spec run
  //      under `chromium-mobile` would compare 3x captures against 1x
  //      baselines and fail for a reason unrelated to any real defect. (Today
  //      `testIgnore` already keeps `*.visual.spec.ts` out unless
  //      VISUAL_REGRESSION=1, and `test:visual` pins `--project=chromium-desktop`
  //      — so this is defence in depth, not the only thing standing between us
  //      and that failure.)
  //   2. Running the whole desktop suite a second time under Pixel 5 would
  //      roughly double `browser_smoke` wall time to re-assert behaviour that
  //      is not viewport-dependent. The mobile risk is layout, hit-testing and
  //      touch — write it into a `*.mobile.spec.ts` where it gates honestly,
  //      rather than into a project that never runs (the #1768 trap) or into
  //      the desktop project behind a `test.use({ viewport })` override (the
  //      #1749 workaround, which yields no touch points and no mobile UA).
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/*.mobile.spec.ts'],
    },
    {
      name: 'chromium-mobile',
      // Real device emulation — touch points, mobile UA, DSF 3 — not a bare
      // viewport override. Anything touch-dependent is only provable here.
      use: { ...devices['Pixel 5'] },
      testMatch: ['**/*.mobile.spec.ts'],
    },
  ],
})
