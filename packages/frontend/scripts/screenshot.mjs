#!/usr/bin/env node
/**
 * Rendered-screen evidence capture (#896, epic #904).
 *
 * Boots the app against a known auth/data fixture and captures desktop (1280)
 * + mobile (390) PNGs of `/design-system` plus any caller-supplied routes,
 * into a gitignored `.screenshots/`. This is the foundation for the
 * visual-regression job (#897) and the design-reviewer pass (#900).
 *
 *   npm run screenshot -w packages/frontend                 # /design-system only
 *   npm run screenshot -w packages/frontend -- /dashboard,/agents
 *
 * ── The fixture ──────────────────────────────────────────────────────────────
 * Auth: an `haven_token` + `haven_active_safe_id` are seeded in localStorage
 * before any script runs (the same keys the app and e2e fixtures use), so
 * authenticated routes render without a real login. Data: every Haven-API
 * request is fulfilled with a benign empty-shape JSON so pages render their
 * empty/loading-resolved state deterministically without a live backend.
 * `/design-system` is a self-contained showcase (no data fetching), so it
 * renders fully from auth alone; richer routes show their empty state.
 *
 * ── The browser ──────────────────────────────────────────────────────────────
 * Uses Playwright's pre-installed Chromium (no `playwright install`). Override
 * with PLAYWRIGHT_CHROMIUM_PATH if the cached browser isn't auto-resolved.
 *
 * Deterministic: animations disabled, network idle awaited, fixed viewports.
 */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, '.screenshots')
const PORT = Number(process.env.SCREENSHOT_PORT ?? 3111)
const BASE_URL = process.env.SCREENSHOT_BASE_URL ?? `http://127.0.0.1:${PORT}`
const OWN_SERVER = !process.env.SCREENSHOT_BASE_URL

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
]

// Always shoot the design system; add caller routes (comma-separated).
const extra = (process.argv[2] ?? '')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean)
  .map((r) => (r.startsWith('/') ? r : `/${r}`))
const ROUTES = ['/design-system', ...extra]

// Minimal authenticated-session fixture — mirrors the e2e `testUser` shape so
// `/auth/me` resolves and the app shell renders. No secrets, no live backend.
const FIXTURE_SAFE = {
  id: 'safe-fixture',
  name: 'Operating wallet',
  safe_address: '0x1111111111111111111111111111111111111111',
  chain_id: 84532,
  is_default: true,
}
const FIXTURE_USER = {
  id: 'user-fixture',
  name: 'Screenshot Fixture',
  email: 'fixture@haven.test',
  wallet_address: null,
  safe_address: FIXTURE_SAFE.safe_address,
  safes: [FIXTURE_SAFE],
  currency_preference: 'USD',
  created_at: '2026-05-01T10:00:00.000Z',
}

function slug(route) {
  return route.replace(/^\//, '').replace(/\//g, '_') || 'root'
}

async function waitForServer(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' })
      if (res.status < 500) return
    } catch {
      /* not up yet */
    }
    await sleep(1000)
  }
  throw new Error(`dev server did not become ready at ${url} within ${timeoutMs}ms`)
}

async function main() {
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })

  let server
  if (OWN_SERVER) {
    console.log(`screenshot: starting dev server on :${PORT}…`)
    server = spawn('npm', ['run', 'dev', '--', '--hostname', '127.0.0.1', '--port', String(PORT)], {
      cwd: ROOT,
      stdio: 'ignore',
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    })
    server.on('exit', (code) => {
      if (code && code !== 0 && code !== null) console.error(`dev server exited ${code}`)
    })
    await waitForServer(BASE_URL)
  }

  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  })
  const captured = []
  try {
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 2,
        reducedMotion: 'reduce',
      })

      // Auth fixture: seed the token before any app code runs.
      await context.addInitScript(() => {
        window.localStorage.setItem('haven_token', 'screenshot-fixture-token')
        window.localStorage.setItem('haven_active_safe_id', 'safe-fixture')
      })

      // Data fixture: resolve the authenticated session (so the app shell
      // renders) and answer every other Haven-API call with a benign empty
      // shape. `/auth/me` MUST return a valid user or the authenticated layout
      // renders nothing. Matched by pathname so the API host is irrelevant.
      await context.route('**/*', async (route) => {
        const req = route.request()
        const { pathname } = new URL(req.url())

        // The app calls the backend same-origin through Next's `/api/*` rewrite
        // (api.ts BASE_URL = '/api'). Intercept those; everything else on the
        // frontend origin (pages, `/_next` assets) loads normally.
        const api = pathname.startsWith('/api/') ? pathname.slice(4) : null
        if (api === null) return route.continue()

        const json = (body) =>
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

        if (api === '/auth/me') return json(FIXTURE_USER)
        if (api === '/user/safes') return json({ safes: FIXTURE_USER.safes })
        // Any other Haven-API GET → a benign empty shape carrying every
        // collection key the hooks read, so a missing key never throws
        // (e.g. useApprovals reads `.approvals`, which it then `.filter`s).
        return json({
          data: [], items: [], overview: {},
          safes: [], agents: [], transactions: [], approvals: [], contacts: [],
          recipients: [], delegations: [], owners: [], passkeys: [], tokens: [],
          payments: [], receipts: [], catalog: [],
        })
      })

      const page = await context.newPage()
      for (const routePath of ROUTES) {
        await page.goto(`${BASE_URL}${routePath}`, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {})
        await page.waitForTimeout(400) // settle late paints
        const file = path.join(OUT_DIR, `${slug(routePath)}-${vp.name}.png`)
        await page.screenshot({ path: file, fullPage: true })
        captured.push(path.relative(ROOT, file))
      }
      await context.close()
    }
  } finally {
    await browser.close()
    if (server) server.kill('SIGTERM')
  }

  console.log(`\nscreenshot: wrote ${captured.length} PNGs to .screenshots/`)
  for (const f of captured) console.log(`  ${f}`)
  console.log('\nAttach these to the PR (or reference them in the Browser Verification section).')
}

main().catch((err) => {
  console.error('screenshot failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
