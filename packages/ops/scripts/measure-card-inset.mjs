#!/usr/bin/env node
/**
 * #4016 geometry measure for the ops console's flush-content cards.
 *
 *   cd packages/ops && node scripts/measure-card-inset.mjs
 *
 * A default `Card.Section` bleeds `-mx-5 md:-mx-6`, which only lines up in a
 * `p-5 md:p-6` card. The ops cards are deliberately UNPADDED
 * (`overflow-hidden` + `Card.Header padding="none"`), so their sections were
 * moved off default mode onto plain padded blocks (`px-5 py-4`, matching the
 * rows' `px-5`) and their headers given `px-5`. This script proves the
 * rendered geometry on `/ops/health` through the same harness the design
 * pass uses (packages/ops/scripts/screenshot.mjs; the mocked fixture from
 * screenshot-fixture.mjs answers every `/ops/*` call — never a real
 * backend):
 *
 * 1. Every header TITLE (the `h2` inside each card's header band) starts at
 *    least 16px inside the card's left edge, at 1280 and 390px. Before the
 *    fix the `padding="none"` band sat flush at the card edge (0px).
 * 2. Every piece of text inside each such card starts at least 16px inside
 *    the card's left edge — measured with a DOM Range over each text node,
 *    so a full-width block whose PADDING is correct and a flush one whose
 *    text sits on the edge cannot be confused.
 *
 * Exit 0 only if at least one card was found and every reading clears the
 * inset; anything else exits 1 with the offending elements printed.
 */
import { chromium } from '@playwright/test'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureRoutes, FIXTURE_BACKEND_ORIGIN, FIXTURE_TOKEN, fixtureStorageSeed } from './screenshot-fixture.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MIN_INSET = 16
const VIEWPORTS = [1280, 390]

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

// screenshot.mjs imports createHash at top level; keep the same import here.

const PORT = await reserveFreePort(derivePort(ROOT))
const BASE = `http://127.0.0.1:${PORT}`
const env = {
  ...process.env,
  NEXT_PUBLIC_OPS_ENVIRONMENTS: JSON.stringify({ dev: FIXTURE_BACKEND_ORIGIN }),
  PORT: String(PORT),
}

console.error(`measure-card-inset: starting next dev on ${BASE} (fixture backend ${FIXTURE_BACKEND_ORIGIN})`)
const child = spawn('npx', ['next', 'dev'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', (d) => process.stdout.write(`[next] ${d}`))
child.stderr.on('data', (d) => process.stderr.write(`[next] ${d}`))

try {
  if (!(await waitForServer(BASE))) {
    throw new Error('the dev server never answered')
  }

  const browser = await chromium.launch()
  const failures = []
  let cardCount = 0

  for (const width of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width, height: 900 } })
    // Route handlers run LAST-registered-FIRST: the unmocked catch-all goes
    // in FIRST (same contract as screenshot.mjs), then the fixture keys.
    await context.route(`**/ops/**`, (route) => {
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unmocked /ops route in measure run' }) })
    })
    for (const [pattern, status, body] of fixtureRoutes()) {
      await context.route(pattern, (route) => {
        const resolved = typeof body === 'function' ? body(route.request()) : body
        return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(resolved) })
      })
    }
    await context.addInitScript(([key, value]) => {
      try { window.sessionStorage.setItem(key, value) } catch { /* fresh context */ }
    }, [fixtureStorageSeed().key, FIXTURE_TOKEN])

    const page = await context.newPage()
    await page.goto(`${BASE}/health`, { waitUntil: 'networkidle' })
    await page.waitForSelector('h1', { timeout: 20000 })

    // Per overflow-hidden card: the leftmost start of every text node inside
    // it (DOM Range — the real glyph start, immune to block-level full-width
    // elements), and the header title's start, against the card's border box.
    const readings = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.overflow-hidden')].filter((c) => c.querySelector('h2'))
      return cards.map((card) => {
        const cardRect = card.getBoundingClientRect()
        const texts = []
        for (const el of card.querySelectorAll('*')) {
          for (const node of el.childNodes) {
            if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
              const range = document.createRange()
              range.selectNodeContents(node)
              const r = range.getBoundingClientRect()
              if (r.width > 0) {
                texts.push({
                  left: r.left,
                  label: `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ').slice(0, 2).join('.')}` : ''}: "${node.textContent.trim().slice(0, 40)}"`,
                })
              }
            }
          }
        }
        const h2 = card.querySelector('h2')
        const h2Range = document.createRange()
        h2Range.selectNodeContents(h2)
        const h2Rect = h2Range.getBoundingClientRect()
        return {
          cardLeft: cardRect.left,
          cardRight: cardRect.right,
          titleLeft: h2Rect.left,
          titleText: h2.textContent.trim().slice(0, 40),
          minTextLeft: texts.length ? Math.min(...texts.map((t) => t.left)) : null,
          worst: texts.sort((a, b) => a.left - b.left).slice(0, 3),
        }
      })
    })

    cardCount = Math.max(cardCount, readings.length)
    if (readings.length === 0) {
      failures.push(`[${width}] no overflow-hidden cards with a header found on /ops/health — the instrument found nothing to measure`)
    }
    for (const r of readings) {
      if (r.titleLeft < r.cardLeft + MIN_INSET) {
        failures.push(
          `[${width}] card "${r.titleText}": header title starts ${r.titleLeft.toFixed(1)}px from the card's left edge ${r.cardLeft.toFixed(1)} — under the ${MIN_INSET}px inset`,
        )
      }
      if (r.minTextLeft === null) {
        failures.push(`[${width}] card "${r.titleText}": no text found inside the card`)
      } else if (r.minTextLeft < r.cardLeft + MIN_INSET) {
        for (const t of r.worst.filter((t) => t.left < r.cardLeft + MIN_INSET)) {
          failures.push(
            `[${width}] card "${r.titleText}": text starts ${t.left.toFixed(1)}px from the card's left edge ${r.cardLeft.toFixed(1)} — under the ${MIN_INSET}px inset: ${t.label}`,
          )
        }
      }
    }
    await context.close()
  }
  await browser.close()

  if (failures.length > 0) {
    console.error(`measure-card-inset: FAILED (${failures.length} reading(s) under the ${MIN_INSET}px inset)`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exitCode = 1
  } else {
    console.error(`measure-card-inset: OK — ${cardCount} card(s) measured at ${VIEWPORTS.join('/')}px, every title and text ≥ ${MIN_INSET}px inside the card edge`)
  }
} finally {
  child.kill('SIGTERM')
}
