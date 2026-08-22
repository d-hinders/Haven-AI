import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'

/**
 * The port this run's app server owns — per worktree, and PROVEN free (#1816).
 *
 * What was here before was `Number(process.env.PLAYWRIGHT_PORT ?? 3000)`: a
 * fixed port in every worktree, paired with `reuseExistingServer: !CI` below.
 * Locally that adopted whatever was already listening on :3000 and asserted
 * against it — so with two sessions running (this repo's normal state) a suite
 * could report green or red for a branch it never loaded. Same class as #1800,
 * one surface over, and the same answer: derive the port from the worktree
 * path, prove it bindable by binding it, and then refuse any server that
 * cannot serve THIS run's own identity token. The refusal is the part that
 * matters; the port arithmetic only makes the happy path likely.
 *
 * The reservation is a subprocess because `defineConfig` is synchronous and
 * binding a socket is not. It shells out ONCE per run: the resolved port is
 * stamped into the environment, and Playwright's workers inherit that
 * environment when they re-load this config. Without the stamp each worker
 * would reserve its own (different, because this run's server now holds the
 * first one) port and point `baseURL` at nothing.
 */
const RESOLVED_PORT_ENV = 'PLAYWRIGHT_RESOLVED_PORT'
const REUSE_EXISTING_SERVER = !process.env.CI
const PORT = resolvePort()
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${PORT}`
// Read back by `scripts/e2e-identity.mjs` in `globalSetup`, so the identity
// probe targets exactly what the tests target rather than re-deriving it.
process.env.PLAYWRIGHT_RESOLVED_BASE_URL = baseURL

function resolvePort(): number {
  const stamped = process.env[RESOLVED_PORT_ENV]
  if (stamped) return Number(stamped)

  // Note there is no early return for `PLAYWRIGHT_BASE_URL`. An external
  // target normally starts no server of ours, so the port looks irrelevant —
  // but Playwright still falls back to spawning `webServer` if that target is
  // unreachable, and the port it would spawn on has to be a real one. The
  // first draft returned `Number(PLAYWRIGHT_PORT ?? 0)` there, which is a
  // silent behaviour change from the old code's 3000 and would have spawned
  // Next on port 0. Resolving normally costs a few milliseconds and gives
  // that fallback this worktree's own port instead of either wrong answer.
  //
  // `--exclusive` mirrors `reuseExistingServer` below: when this run may not
  // adopt anything, a busy port has to be walked past (Next would silently hop
  // to another one while Playwright kept polling this one). When it MAY adopt,
  // walking past would step over this worktree's own warm dev server and
  // cold-start a second Next on every run — so the derived port is used as is
  // and the identity probe decides whether what answers is ours.
  const args = [path.join(__dirname, 'scripts', 'e2e-identity.mjs'), 'reserve-port']
  if (!REUSE_EXISTING_SERVER) args.push('--exclusive')
  const out = execFileSync(process.execPath, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim()
  const port = Number(out)
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`e2e: could not reserve a port for the app server (got ${JSON.stringify(out)})`)
  }
  process.env[RESOLVED_PORT_ENV] = String(port)
  return port
}
const webServerCommand = process.env.CI
  ? [
      'mkdir -p .next/standalone/packages/frontend/.next/static .next/standalone/packages/frontend/public',
      'cp -R .next/static/. .next/standalone/packages/frontend/.next/static',
      '[ ! -d public ] || cp -R public/. .next/standalone/packages/frontend/public',
      'node .next/standalone/packages/frontend/server.js',
    ].join(' && ')
  : `npm run dev -- --hostname 127.0.0.1 --port ${PORT}`

// Specs no project in THIS config may ever run.
//
// A project-level `testIgnore` REPLACES this list rather than extending it, so
// every project that declares one must spread `SUITE_IGNORE` back in. Getting
// that wrong is not a quiet mistake: the first draft of #1768 set
// `testIgnore: ['**/*.mobile.spec.ts']` on `chromium-desktop` alone, which
// silently re-admitted `e2e/live/**` and turned `browser_smoke` red with four
// "Live QA session needs QA_HAVEN_API_URL…" failures — the unmocked live smoke,
// running inside the fast mocked suite. Hoisted into a named constant so the
// next person adding a project inherits the answer instead of rediscovering it.
const SUITE_IGNORE = [
  // The unmocked live smoke (e2e/live) runs only via playwright.live.config.ts
  // against a real deployment — keep it out of the fast, fully-mocked suite.
  '**/live/**',
  // Visual-regression specs run only under the dedicated CI job (Linux
  // baselines) — VISUAL_REGRESSION=1 opts in. See #897.
  ...(process.env.VISUAL_REGRESSION === '1' ? [] : ['**/*.visual.spec.ts']),
]

export default defineConfig({
  testDir: './e2e',
  testIgnore: SUITE_IGNORE,
  // Refuses to run against a server that cannot prove it is this worktree's
  // app (#1816). Runs AFTER `webServer` — the web server is a Playwright
  // plugin and plugin setup precedes global setup — so it probes exactly the
  // server the tests are about to use, started or adopted.
  globalSetup: './scripts/e2e-identity.mjs',
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
    // Kept, but no longer TRUSTED (#1816). `reuseExistingServer` asks only
    // "did something answer on this URL?", and a 200 is not proof of identity
    // — that is the whole defect. What makes reuse safe now is the identity
    // probe in `globalSetup`: adoption of a foreign worktree's server fails
    // loudly instead of producing a confident verdict for the wrong branch.
    // The per-worktree reserved port above means there is normally nothing to
    // adopt in the first place, so this is the second line of defence rather
    // than the first.
    reuseExistingServer: REUSE_EXISTING_SERVER,
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
      // SUITE_IGNORE must be spread back in — see its definition above.
      testIgnore: [...SUITE_IGNORE, '**/*.mobile.spec.ts'],
    },
    {
      name: 'chromium-mobile',
      // Real device emulation — 393×727 viewport, touch points, coarse
      // pointer, Android UA, deviceScaleFactor 2.75 — not a bare viewport
      // override. Anything touch- or hit-test-dependent is only provable here.
      use: { ...devices['Pixel 5'] },
      // `testMatch` narrows; `testIgnore` still has to exclude, and a
      // project-level one replaces the config-level list.
      testMatch: ['**/*.mobile.spec.ts'],
      testIgnore: SUITE_IGNORE,
    },
  ],
})
