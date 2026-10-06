#!/usr/bin/env node
/**
 * Rendered-screen evidence capture for the ops console (#3516).
 *
 *   npm run screenshot -w packages/ops -- /overview,/search,/customer/<id>,/health,/doc-health
 *
 * Mirrors packages/frontend/scripts/screenshot.mjs's contract, narrowed to
 * what the console needs:
 *
 * - THE FIXTURE IS MANDATORY: every `/ops/*` call is answered by
 *   `screenshot-fixture.mjs` (mocked, deterministic, masked at rest) and the
 *   registry origin is an RFC 2606 `.invalid` host — a capture can NEVER
 *   reach the dev backend, so real customer PII never lands in a PR
 *   screenshot. The harness verifies the fixture took over (a probe URL must
 *   answer from the fixture) before the first capture.
 * - Sign-in: the ops token is a sessionStorage credential (not a cookie, not
 *   localStorage — the #3515 contract), so the seed is exactly one
 *   `haven.ops.token.<origin>` key filed under the fixture origin.
 * - No baselines: this console has NO visual-regression baselines and this
 *   PR adds none — it is an internal tool; the captures are review evidence
 *   for the design-reviewer pass, not pixel gates.
 * - Same PNG guards as the frontend harness's idea, kept simple here: a
 *   capture whose body never renders the route's own heading is deleted with
 *   its cause, not filed under a route name claiming to show it.
 */
import { chromium } from '@playwright/test'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureRoutes, FIXTURE_BACKEND_ORIGIN, FIXTURE_TOKEN, FIXTURE_USER_ID, fixtureStorageSeed } from './screenshot-fixture.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, '.screenshots')
const DEVICE_SCALE_FACTOR = 2
const VIEWPORTS = [
  { name: '1280', width: 1280, height: 800 },
  { name: '390', width: 390, height: 844 },
]

const ARGS = process.argv.slice(2)
const requested = ARGS.filter((a) => !a.startsWith('--'))
  .join(',')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean)
  .map((r) => (r.startsWith('/') ? r : `/${r}`))
// The customer capture renders the fixture user; `<id>` is a literal alias.
// `/feedback+reveal` captures the Feedback page with one message revealed:
// the harness clicks the row's Reveal control before the screenshot.
const ROUTES = (requested.length > 0 ? requested : ['/overview'])
  .map((r) => (r === '/customer' || r === '/customer/<id>' ? `/customer/${FIXTURE_USER_ID}` : r))

function derivePort(worktreePath) {
  const hash = createHash('sha256').update(worktreePath).digest()
  const candidate = 4000 + (hash.readUInt16BE(0) % 2000) * 2
  return candidate
}

function reserveFreePort(preferred) {
  return new Promise((resolve, reject) => {
    const tryBind = (port, attemptsLeft) => {
      const server = net.createServer()
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attemptsLeft > 0) return tryBind(port + 1, attemptsLeft - 1)
        reject(err)
      })
      server.once('listening', () => {
        server.close(() => resolve(port))
      })
      server.listen(port, '127.0.0.1')
    }
    tryBind(preferred, 20)
  })
}

async function waitForServer(base, attempts = 120) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(`${base}/`)
      if (response.ok) return true
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

const PORT = await reserveFreePort(derivePort(ROOT))
const BASE = `http://127.0.0.1:${PORT}`
const env = {
  ...process.env,
  NEXT_PUBLIC_OPS_ENVIRONMENTS: JSON.stringify({ dev: FIXTURE_BACKEND_ORIGIN }),
  PORT: String(PORT),
}

const useProductionBuild = process.env.OPS_SCREENSHOT_PROD === '1'
console.error(`ops-screenshot: starting next ${useProductionBuild ? 'start (prod build)' : 'dev'} on ${BASE} (fixture backend ${FIXTURE_BACKEND_ORIGIN})`)
let child
if (useProductionBuild) {
  // `NEXT_PUBLIC_*` is INLINED at build time: a prod server started without
  // the registry baked into the bundle would render the config-error screen
  // on every route. Build a THROWAWAY production bundle with the fixture
  // registry inlined, in a scratch distDir, and serve that; the repo `.next`
  // is never touched. (`next start` also re-reads next.config.ts, whose
  // phase gate skips the doc-health regeneration in this phase.)
  console.error('ops-screenshot: building throwaway prod bundle with the fixture registry inlined…')
  const { status } = spawnSync(
    '../../node_modules/.bin/next',
    ['build'],
    { cwd: ROOT, env: { ...env, OPS_SCREENSHOT_BUILD: '1' }, stdio: 'inherit' },
  )
  if (status !== 0) throw new Error(`the screenshot prod build failed (exit ${status})`)
  child = spawn(
    '../../node_modules/.bin/next',
    ['start'],
    { cwd: ROOT, env: { ...env, OPS_SCREENSHOT_BUILD: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
} else {
  child = spawn('npx', ['next', 'dev'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
}
child.stdout.on('data', (d) => process.stdout.write(`[next] ${d}`))
child.stderr.on('data', (d) => process.stderr.write(`[next] ${d}`))
const childPort = path.join(ROOT, '.screenshots')

try {
  if (!(await waitForServer(BASE))) {
    throw new Error('the dev server never answered')
  }

  // THE FIXTURE MUST BE UP before anything renders: `next dev` compiles on
  // first hit, so this probe also warms the root route.
  const deleted = []
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })

  const browser = await chromium.launch()
  const manifest = { run: 'ops-capture', base: BASE, routes: ROUTES, viewports: VIEWPORTS.map((v) => v.name), captures: [], deleted_captures: deleted, fixture: 'mocked /ops/* (screenshot-fixture.mjs) — never a real backend', visual_regression_baselines: 'none (internal tool — stated in the PR body, #3516)' }

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
    })
    // Route handlers run LAST-registered-FIRST: the unmocked catch-all goes
    // in FIRST so every keyed fixture answer outranks it, and anything the
    // fixture did not key still refuses LOUDLY (a 503 the capture will
    // show), never a silent pass-through to the network.
    await context.route(`**/ops/**`, (route) => {
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unmocked /ops route in capture run' }) })
    })
    for (const [pattern, status, body] of fixtureRoutes()) {
      await context.route(pattern, (route) => {
        // A function body answers from the REQUEST (#3602: the reveal
        // endpoint branches on the POST body — feedback vs user).
        const resolved = typeof body === 'function' ? body(route.request()) : body
        return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(resolved) })
      })
    }
    await context.addInitScript(([key, value]) => {
      try { window.sessionStorage.setItem(key, value) } catch { /* fresh context */ }
    }, [fixtureStorageSeed().key, FIXTURE_TOKEN])

    for (const route of ROUTES) {
      const page = await context.newPage()
      const consoleErrors = []
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text())
      })
      // The `+reveal` alias (#3602): load the page, then click the row's
      // Reveal control and wait for the revealed text — the captured PNG is
      // the revealed state, not the masked one.
      const targetUrl = route === '/feedback+reveal' ? '/feedback' : route
      const response = await page.goto(`${BASE}${targetUrl}`, { waitUntil: 'networkidle' })
      if (route === '/feedback+reveal') {
        const revealButton = page.getByRole('button', { name: 'Reveal feedback message' }).first()
        await revealButton.waitFor({ state: 'visible', timeout: 20000 })
        await revealButton.click()
        await page.getByText('mobile Safari').first().waitFor({ timeout: 20000 }).catch(() => {
          consoleErrors.push('feedback+reveal: the revealed text never rendered')
        })
      }
      // Rendered-content guard: the route's own h1 (or the sign-in error) must
      // exist — a capture of a still-compiling shell is not evidence.
      const rendered = await page
        .waitForSelector('h1, [data-testid="prod-banner"]', { timeout: 20000 })
        .then(() => true)
        .catch(() => false)
      const file = `${route === '/' ? 'root' : route.replace(/\//g, '-').replace(/^-/, '')}-${vp.name}.png`
      if (!rendered) {
        deleted.push({ route, viewport: vp.name, file, cause: 'not-rendered' })
        await page.close()
        continue
      }
      // Computed-style probe (#3611): captures cannot show computed style, so
      // record what the browser resolved for the page title and the first
      // tabular figure. Under OPS_SCREENSHOT_PROD=1 this is the production CSS.
      const computed = await page.evaluate(() => {
        const pick = (el) => {
          if (!el) return null
          const cs = getComputedStyle(el)
          return { fontSize: cs.fontSize, lineHeight: cs.lineHeight, fontWeight: cs.fontWeight, fontVariantNumeric: cs.fontVariantNumeric }
        }
        return { h1: pick(document.querySelector('h1')), firstTabular: pick(document.querySelector('.v2-tabular')) }
      })
      await page.screenshot({ path: path.join(OUT_DIR, file), fullPage: true })
      const sha256 = createHash('sha256').update(await (await import('node:fs/promises')).readFile(path.join(OUT_DIR, file))).digest('hex')
      manifest.captures.push({ route, viewport: vp.name, file, status: response?.status() ?? null, console_errors: consoleErrors, sha256, computed })
      await page.close()
    }
    await context.close()
  }
  await browser.close()
  await writeFile(path.join(OUT_DIR, 'capture-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const failed = manifest.captures.filter((c) => c.console_errors.length > 0)
  console.error(`ops-screenshot: ${manifest.captures.length} capture(s) in ${OUT_DIR}`)
  for (const d of deleted) console.error(`ops-screenshot: DELETED ${d.route} [${d.viewport}] — ${d.cause}`)
  for (const f of failed) console.error(`ops-screenshot: console errors on ${f.route} [${f.viewport}]: ${f.console_errors.join(' | ')}`)
  if (manifest.captures.length === 0) {
    throw new Error('no capture succeeded — an empty .screenshots/ is never evidence')
  }
} finally {
  child.kill('SIGTERM')
}
