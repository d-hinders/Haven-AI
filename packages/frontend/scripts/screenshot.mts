#!/usr/bin/env node
/**
 * Screenshot evidence capture (#896, epic #904).
 *
 * Boots the frontend against the SAME mocked auth/data fixture the Playwright
 * e2e suite uses (`e2e/fixtures/haven-api.ts`) and captures desktop (1280) +
 * mobile (390) PNGs of `/design-system` plus any caller-supplied routes into a
 * gitignored `.screenshots/`. This is the foundation for the visual-regression
 * job (#897) and the screenshot-driven design-reviewer pass (#900).
 *
 * The fixture: `seedAuthenticatedSession` writes the auth token + active-safe id
 * to localStorage so `ProtectedRoute` renders, and `mockHavenApi` intercepts
 * every `/api` call with the deterministic `testUser` / `testSafe` / `testAgent`
 * data. No live backend, no wallet, no network — same inputs every run. Because
 * it reuses the one fixture, screenshots never drift from what the e2e tests
 * assert.
 *
 * Usage (from repo root):
 *   npm run screenshot -w packages/frontend                    # just /design-system
 *   npm run screenshot -w packages/frontend -- /dashboard /agents
 *
 * Env:
 *   SCREENSHOT_BASE_URL   capture against an already-running server (skips boot)
 *   SCREENSHOT_PORT       port for the auto-booted dev server (default 3100)
 *
 * Runs under tsx so it can import the TypeScript fixture directly; uses the
 * pre-installed Chromium via PLAYWRIGHT_BROWSERS_PATH (no `playwright install`).
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
// The e2e fixture is CJS-classified (the frontend package has no
// "type":"module"), so from this ESM script its exports arrive under the
// default binding rather than as named imports. Bridging here lets us reuse
// the one shared fixture instead of duplicating the mock.
import havenApiFixture from '../e2e/fixtures/haven-api'
const { mockHavenApi, seedAuthenticatedSession } = havenApiFixture

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(scriptDir, '..')
const OUT_DIR = path.join(pkgRoot, '.screenshots')

const PORT = Number(process.env.SCREENSHOT_PORT ?? 3100)
const BASE_URL = (process.env.SCREENSHOT_BASE_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, '')

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]

// Kill CSS transitions/animations and the text caret so a capture taken a few
// ms earlier or later is pixel-identical — determinism the #897 job depends on.
const FREEZE_CSS = `*,*::before,*::after{
  animation-duration:0s!important;animation-delay:0s!important;
  transition-duration:0s!important;transition-delay:0s!important;
  caret-color:transparent!important;scroll-behavior:auto!important;
}`

/**
 * Resolve the pre-installed full Chromium so we never trigger a download.
 * When the local `playwright` version expects a browser build that isn't the
 * one baked into the environment, `chromium.launch()` errors and prints
 * "run playwright install". The full `chromium-<build>` under
 * PLAYWRIGHT_BROWSERS_PATH renders headless fine and its build number floats,
 * so we resolve it rather than hardcode. Returns undefined when nothing is
 * pre-installed (e.g. CI with a version-matched browser) so Playwright's own
 * resolution takes over.
 */
function resolveChromiumExecutable(): string | undefined {
  const override = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  if (override && existsSync(override)) return override
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (!root || !existsSync(root)) return undefined
  const build = readdirSync(root).find((d) => /^chromium-\d+$/.test(d))
  if (!build) return undefined
  const exe = path.join(root, build, 'chrome-linux', 'chrome')
  return existsSync(exe) ? exe : undefined
}

/** `/design-system` → `design-system`, `/` → `root`, `/agents/x` → `agents-x`. */
function slug(route) {
  return route.replace(/^\//, '').replace(/\/+$/, '').replace(/\//g, '-').replace(/[^\w-]/g, '_') || 'root'
}

function normalizeRoute(route) {
  return route.startsWith('/') ? route : `/${route}`
}

async function isUp(url) {
  try {
    // A redirect (login gate) still means the server answered.
    await fetch(url, { redirect: 'manual' })
    return true
  } catch {
    return false
  }
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isUp(url)) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`Server at ${url} did not come up within ${timeoutMs / 1000}s`)
}

async function main() {
  const routes = [...new Set(['/design-system', ...process.argv.slice(2).map(normalizeRoute)])]

  // Reuse an already-running server (explicit base URL or one that answers);
  // otherwise boot `next dev`. Everything after the spawn runs inside a
  // try/finally so the child is always torn down — including when the readiness
  // wait itself times out.
  const bootOwnServer = !process.env.SCREENSHOT_BASE_URL && !(await isUp(BASE_URL))
  let devServer = null
  if (bootOwnServer) {
    console.log(`screenshot: booting dev server on ${BASE_URL} …`)
    devServer = spawn(
      'npm',
      ['run', 'dev', '--', '--hostname', '127.0.0.1', '--port', String(PORT)],
      {
        cwd: pkgRoot,
        stdio: 'inherit',
        // Own process group so teardown can signal the whole tree. `npm run dev`
        // spawns `next dev` as a grandchild; SIGTERM to npm alone orphans it and
        // leaks a server holding the port. `detached` makes the child a group
        // leader we can kill as `-pid`.
        detached: true,
        env: {
          ...process.env,
          NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: 'screenshot-placeholder',
          NEXT_TELEMETRY_DISABLED: '1',
          PORT: String(PORT),
        },
      },
    )
  } else {
    console.log(`screenshot: using existing server at ${BASE_URL}`)
  }

  const written = []
  let browser = null
  try {
    if (devServer) await waitForServer(BASE_URL, 120_000)

    await rm(OUT_DIR, { recursive: true, force: true })
    await mkdir(OUT_DIR, { recursive: true })

    browser = await chromium.launch({
      headless: true,
      executablePath: resolveChromiumExecutable(),
    })

    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        reducedMotion: 'reduce',
      })
      const page = await context.newPage()
      await mockHavenApi(page)
      await seedAuthenticatedSession(page)

      for (const route of routes) {
        await page.goto(`${BASE_URL}${route}`, { waitUntil: 'load', timeout: 60_000 })
        // Best-effort settle — polling endpoints may never go fully idle.
        await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {})
        await page.addStyleTag({ content: FREEZE_CSS })
        // Wait for web fonts but return nothing (FontFaceSet isn't serializable).
        await page.evaluate(async () => { await document.fonts?.ready }).catch(() => {})

        const file = path.join(OUT_DIR, `${viewport.name}__${slug(route)}.png`)
        await page.screenshot({ path: file, fullPage: true })
        written.push(path.relative(pkgRoot, file))
      }
      await context.close()
    }
  } finally {
    if (browser) await browser.close()
    if (devServer?.pid) {
      // Negative pid signals the whole process group (see `detached` above).
      try {
        process.kill(-devServer.pid, 'SIGTERM')
      } catch {
        devServer.kill('SIGTERM')
      }
    }
  }

  console.log(`screenshot: wrote ${written.length} PNG(s) to ${path.relative(pkgRoot, OUT_DIR)}/`)
  for (const f of written) console.log(`  ${f}`)
}

main().catch((err) => {
  console.error('screenshot: failed —', err?.message ?? err)
  process.exit(1)
})
