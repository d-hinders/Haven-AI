#!/usr/bin/env node
/**
 * Ops console render smoke (#3583). Proves, in a real browser, that the
 * console's production build actually RENDERS under its enforcing CSP.
 *
 * #3515 shipped a blank production page (#3581): every unit test was green,
 * because the CSP header string was fine and nothing ever ran the page under
 * it. This script is the check that would have caught it.
 *
 *   npm run build -w packages/ops   # with NEXT_PUBLIC_OPS_ENVIRONMENTS set (below)
 *   npm run smoke -w packages/ops
 *   (OPS_SMOKE_CHROMIUM=/path/to/chrome overrides the browser binary)
 *
 * It serves the EXISTING `.next` build with `next start` and, in one Chromium:
 *
 * 1. Renders `/` signed out and waits for "Continue with GitHub". That button
 *    exists only after the client hydrates (OpsClientRoot renders nothing
 *    before the session hook settles), so it is the signal a blank page fails.
 * 2. Asserts ZERO CSP violations on that load, counted after hydration and
 *    before anything is injected.
 * 3. In a SEPARATE page, injects an INLINE script without the nonce into the
 *    served HTML and asserts it is refused: its window flag stays unset and a
 *    `securitypolicyviolation` event fires. Inline, not `src`: under
 *    'strict-dynamic' a non-parser-inserted `src` script may be allowed, so a
 *    `src` probe would prove nothing.
 *
 * The browser phase is offline: every browser HTTP request and WebSocket to
 * anything but this server is aborted, and an aborted one fails the run (the
 * server runs with NEXT_TELEMETRY_DISABLED=1; its own egress is not routed).
 * `npm ci`, the browser install and the build may use the network; this phase
 * may not.
 *
 * Blind spot: under `next start`, Next's router copies middleware RESPONSE
 * headers onto the request (resolve-routes.js), so dropping the middleware's
 * request-header `set` stays green here. Whether Vercel's edge does the same
 * is unverified; src/__tests__/csp.test.ts is the guard for that line.
 *
 * The build must have a registry inlined (`NEXT_PUBLIC_OPS_ENVIRONMENTS` is
 * build-time); without one the console shows its server-rendered config-error
 * screen and step 1 fails, which is correct: CI sets it on the build step.
 */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NEXT_BIN = path.resolve(ROOT, '../../node_modules/.bin/next')
const SIGN_IN = 'Continue with GitHub'
const INJECTED_FLAG = '__opsSmokeInjected'

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function waitForServer(base, attempts = 120) {
  for (let i = 0; i < attempts; i++) {
    if (serverExited) return false
    try {
      const response = await fetch(`${base}/`)
      if (response.status < 500) return true
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

/** Abort every request that leaves this server; record them so the run fails. */
async function offline(context, base, escaped) {
  await context.route('**/*', (route) => {
    const url = route.request().url()
    if (url.startsWith(`${base}/`) || url === base) return route.continue()
    escaped.push(url)
    return route.abort('blockedbyclient')
  })
  const wsBase = base.replace(/^http/, 'ws')
  await context.routeWebSocket(/.*/, (ws) => {
    if (ws.url().startsWith(`${wsBase}/`)) return ws.connectToServer()
    escaped.push(ws.url())
    return ws.close()
  })
}

/** Count CSP violations from inside the page, so none can be missed. */
async function recordViolations(context) {
  await context.addInitScript(() => {
    window.__opsSmokeViolations = []
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__opsSmokeViolations.push(`${event.violatedDirective} ${event.blockedURI}`)
    })
  })
}

const failures = []
const fail = (message) => {
  failures.push(message)
  console.error(`ops-smoke: FAIL ${message}`)
}

const port = await freePort()
const base = `http://127.0.0.1:${port}`
const server = spawn(NEXT_BIN, ['start', '-p', String(port), '-H', '127.0.0.1'], {
  cwd: ROOT,
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', (d) => process.stdout.write(`[next] ${d}`))
server.stderr.on('data', (d) => process.stderr.write(`[next] ${d}`))
// A server that dies (no build, port taken) ends the wait at once, so the run
// never polls a stranger on the port for a minute and calls it the console.
let serverExited = null
server.once('exit', (code, signal) => {
  serverExited = `next start exited (code ${code}, signal ${signal})`
})

let browser
try {
  if (!(await waitForServer(base))) {
    throw new Error(serverExited ?? `next start never answered on ${base} — is there a build in ${ROOT}/.next?`)
  }
  // CI launches the Chromium `npx playwright install` fetched. A machine with
  // a different preinstalled build can point at it instead.
  browser = await chromium.launch({ executablePath: process.env.OPS_SMOKE_CHROMIUM || undefined })

  // 1 + 2: the console renders, with no CSP violation.
  {
    const escaped = []
    const context = await browser.newContext()
    await offline(context, base, escaped)
    await recordViolations(context)
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.goto(`${base}/`, { waitUntil: 'networkidle' })
    const rendered = await page
      .getByText(SIGN_IN)
      .first()
      .waitFor({ state: 'visible', timeout: 20000 })
      .then(() => true)
      .catch(() => false)
    if (!rendered) {
      const body = (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ').slice(0, 160)
      fail(`"${SIGN_IN}" never rendered: the client did not hydrate (body: ${JSON.stringify(body)})`)
    }
    const violations = await page.evaluate(() => window.__opsSmokeViolations ?? [])
    if (violations.length > 0) fail(`CSP violations on a plain load: ${violations.join(' | ')}`)
    if (pageErrors.length > 0) fail(`page errors on a plain load: ${pageErrors.join(' | ')}`)
    if (escaped.length > 0) fail(`requests left the local server: ${escaped.join(' ')}`)
    if (rendered && violations.length === 0) console.error('ops-smoke: ok  the console hydrated and rendered sign-in, with 0 CSP violations')
    await context.close()
  }

  // 3: an inline script without the nonce is refused, in a separate page.
  {
    const escaped = []
    const context = await browser.newContext()
    await recordViolations(context)
    // offline() is registered BEFORE the document route below: Playwright runs
    // the LAST-registered route first, so the document route wins for `/` and
    // everything else still goes through the offline guard.
    await offline(context, base, escaped)
    await context.route(`${base}/`, async (route) => {
      const response = await route.fetch()
      const html = await response.text()
      const injected = html.replace('</body>', `<script>window.${INJECTED_FLAG} = 1</script></body>`)
      // A throw here is an uncaught exception that skips `finally`; record it.
      if (injected === html) fail('could not inject the probe: the served HTML has no </body>')
      await route.fulfill({ response, body: injected })
    })
    const page = await context.newPage()
    await page.goto(`${base}/`, { waitUntil: 'networkidle' })
    const ran = await page.evaluate((flag) => window[flag] ?? null, INJECTED_FLAG)
    const violations = await page.evaluate(() => window.__opsSmokeViolations ?? [])
    if (ran !== null) fail('an inline script WITHOUT the nonce ran: the CSP is not enforcing script-src')
    if (!violations.some((v) => v.startsWith('script-src'))) fail('no script-src securitypolicyviolation fired for the un-nonced inline probe')
    if (escaped.length > 0) fail(`requests left the local server: ${escaped.join(' ')}`)
    if (ran === null && violations.length > 0) console.error('ops-smoke: ok  an inline script without the nonce was refused')
    await context.close()
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  await browser?.close()
  server.kill('SIGTERM')
}

if (failures.length > 0) {
  console.error(`ops-smoke: ${failures.length} failure(s)`)
  process.exit(1)
}
console.error('ops-smoke: passed')
