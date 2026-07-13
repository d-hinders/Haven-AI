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
 * authenticated routes render without a real login. Data: Haven-API requests
 * are answered by a route-keyed POPULATED dataset (a funded account, three
 * agents on both rails, transactions, one pending approval, contacts) so
 * lists, tables and amounts render realistically — that's what the
 * design-reviewer pass judges. Anything not explicitly keyed falls back to a
 * benign empty shape. `SCREENSHOT_FIXTURE=empty` reverts everything to the
 * empty shapes when you specifically want empty states. All data is fake and
 * deterministic; no live backend, no secrets.
 *
 * Console errors and page crashes are captured per route and summarised at
 * the end — a red console on a fixture render is a fixture-shape gap or a
 * real client bug; either way you want to see it, not silently ship a blank
 * screenshot.
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
import { VIEWPORTS } from './evidence-viewports.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, '.screenshots')
const PORT = Number(process.env.SCREENSHOT_PORT ?? 3111)
const BASE_URL = process.env.SCREENSHOT_BASE_URL ?? `http://127.0.0.1:${PORT}`
const OWN_SERVER = !process.env.SCREENSHOT_BASE_URL


// Exported for the parity test against src/lib/auth-storage.ts — a key rename
// there must fail a test here, not silently capture logged-out screenshots.
export const SEED_STORAGE_KEYS = {
  token: 'haven_token',
  activeSafe: 'haven_active_safe_id',
}

// Always shoot the design system; add caller routes (comma-separated).
const extra = (process.argv[2] ?? '')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean)
  .map((r) => (r.startsWith('/') ? r : `/${r}`))
const ROUTES = ['/design-system', ...extra]

// Authenticated-session fixture — mirrors the e2e `testUser` shape so
// `/auth/me` resolves and the app shell renders. No secrets, no live backend.
const FIXTURE_SAFE = {
  id: 'safe-fixture',
  name: 'Operating wallet',
  safe_address: '0x1111111111111111111111111111111111111111',
  chain_id: 84532,
  is_default: true,
  created_at: '2026-05-01T10:00:00.000Z',
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

// ── Populated dataset (the default) ──────────────────────────────────────────
// Fake, deterministic data shaped exactly like the hooks' response types
// (usePortfolio, useAgents, useApprovals, useTransactionsFeed, …) so richer
// routes render their real lists/tables/amounts for the design-reviewer pass.
const ADDR = {
  recipient: '0x9f8f72aA9304c8B593d555F12eF6589cC3A579A2',
  delegate: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  merchant: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  contact: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
}
const T0 = Date.parse('2026-07-10T09:00:00.000Z') / 1000 // fixed anchor, in seconds

const tx = (i, over = {}) => ({
  hash: `0x${String(i).repeat(4).padStart(8, '0')}${'ab'.repeat(28)}`.slice(0, 66),
  type: 'erc20',
  from: FIXTURE_SAFE.safe_address,
  to: ADDR.recipient,
  value: '25000000',
  valueFormatted: '25.00',
  asset: 'USDC',
  decimals: 6,
  direction: 'out',
  timestamp: T0 - i * 8_600,
  blockNumber: 18_000_000 - i * 40,
  isError: false,
  tokenSymbol: 'USDC',
  // AggregatedTransaction extras (harmless on the plain Transaction shape):
  chainId: FIXTURE_SAFE.chain_id,
  safeId: FIXTURE_SAFE.id,
  safeAddress: FIXTURE_SAFE.safe_address,
  safeName: FIXTURE_SAFE.name,
  ...over,
})
const FIXTURE_TXS = [
  tx(1, { agentName: 'Research agent', source: 'x402', x402ResourceUrl: 'https://api.example.dev/reports' }),
  tx(2, { direction: 'in', from: ADDR.contact, to: FIXTURE_SAFE.safe_address, valueFormatted: '150.00', value: '150000000' }),
  tx(3, { agentName: 'Ops agent' }),
  tx(4, { asset: 'ETH', tokenSymbol: undefined, type: 'native', decimals: 18, value: '12000000000000000', valueFormatted: '0.012' }),
  tx(5, { isError: true, agentName: 'Research agent' }),
  tx(6, { direction: 'in', from: ADDR.merchant, to: FIXTURE_SAFE.safe_address, valueFormatted: '75.50', value: '75500000' }),
]

const FIXTURE_AGENTS = [
  {
    id: 'agent-research', name: 'Research agent',
    description: 'Pays for x402 research APIs within a weekly budget',
    delegate_address: null, safe_id: FIXTURE_SAFE.id,
    safe_address: FIXTURE_SAFE.safe_address, safe_name: FIXTURE_SAFE.name,
    safe_chain_id: FIXTURE_SAFE.chain_id, account_type: 'delegator_hybrid',
    api_key_prefix: 'hvn_a1b2c3', status: 'active',
    created_at: '2026-06-02T10:00:00.000Z',
    mcp_last_seen_at: '2026-07-10T08:12:00.000Z', allowances: [],
  },
  {
    id: 'agent-ops', name: 'Ops agent',
    description: 'Recurring vendor payments',
    delegate_address: ADDR.delegate, safe_id: FIXTURE_SAFE.id,
    safe_address: FIXTURE_SAFE.safe_address, safe_name: FIXTURE_SAFE.name,
    safe_chain_id: FIXTURE_SAFE.chain_id, account_type: null,
    api_key_prefix: 'hvn_d4e5f6', status: 'active',
    created_at: '2026-05-18T10:00:00.000Z',
    mcp_last_seen_at: '2026-07-09T16:40:00.000Z',
    allowances: [{
      id: 'alw-1', agent_id: 'agent-ops',
      token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      token_symbol: 'USDC', allowance_amount: '500.000000', reset_period_min: 1440,
    }],
  },
  {
    id: 'agent-retired', name: 'Data-feed agent',
    description: 'Paused while the vendor contract renews',
    delegate_address: null, safe_id: FIXTURE_SAFE.id,
    safe_address: FIXTURE_SAFE.safe_address, safe_name: FIXTURE_SAFE.name,
    safe_chain_id: FIXTURE_SAFE.chain_id, account_type: 'delegator_hybrid',
    api_key_prefix: 'hvn_g7h8i9', status: 'paused',
    created_at: '2026-04-30T10:00:00.000Z', mcp_last_seen_at: null, allowances: [],
  },
]

const FIXTURE_APPROVALS = [{
  id: 'appr-1', agent_id: 'agent-ops', agent_name: 'Ops agent',
  safe_address: FIXTURE_SAFE.safe_address, chain_id: FIXTURE_SAFE.chain_id,
  token_symbol: 'USDC', token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  to_address: ADDR.recipient, amount_raw: '750000000', amount_human: '750.00',
  reason: 'Quarterly vendor invoice exceeds the daily budget',
  source: 'api', x402_resource_url: null, merchant_address: null,
  payment_rail: null, payment_resource_url: null,
  status: 'pending', created_at: '2026-07-10T07:45:00.000Z',
  expires_at: '2026-07-11T07:45:00.000Z',
}]

const FIXTURE_PORTFOLIO = {
  totalUsd: 12_640.55, totalEur: 11_690.21,
  breakdown: [
    { symbol: 'USDC', balance: '11890550000', formatted: '11,890.55', usdValue: 11_890.55, eurValue: 10_996.57 },
    { symbol: 'ETH', balance: '250000000000000000', formatted: '0.25', usdValue: 750.0, eurValue: 693.64 },
  ],
}
const FIXTURE_BALANCES = {
  balances: [
    { symbol: 'USDC', address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', balance: '11890550000', formatted: '11,890.55', decimals: 6, chainId: FIXTURE_SAFE.chain_id },
    { symbol: 'ETH', address: null, balance: '250000000000000000', formatted: '0.25', decimals: 18, chainId: FIXTURE_SAFE.chain_id },
  ],
}
const FIXTURE_OVERVIEW = {
  totals: { usd: 12_640.55, eur: 11_690.21 },
  change: { available: true, usdAmount: 214.3, eurAmount: 198.2, usdPercent: 1.7, eurPercent: 1.7 },
  metrics: { connectedAgents: 2, monthlyAgentSpendUsd: 482.5, monthlyAgentSpendEur: 446.3, successfulTransactions: 37, activeAccounts: 1 },
  actionableApprovals: 1, pendingApprovals: 1,
  onboardingProgress: { hasFirstAgentPayment: true },
  agents: FIXTURE_AGENTS.map((a) => ({
    id: a.id, name: a.name, status: a.status, safeId: a.safe_id,
    safeName: a.safe_name, safeChainId: a.safe_chain_id,
    allowances: a.allowances.map((x) => ({
      tokenSymbol: x.token_symbol, allowanceAmount: x.allowance_amount, resetPeriodMin: x.reset_period_min,
    })),
  })),
  transactions: FIXTURE_TXS.slice(0, 4),
}
const FIXTURE_CONTACTS = [
  { id: 'ct-1', name: 'Cloud vendor', address: ADDR.recipient, created_at: '2026-05-02T10:00:00.000Z', updated_at: '2026-05-02T10:00:00.000Z' },
  { id: 'ct-2', name: 'Data provider', address: ADDR.contact, created_at: '2026-06-11T10:00:00.000Z', updated_at: '2026-06-11T10:00:00.000Z' },
]

/**
 * Route-keyed fixture: return the populated response for a Haven-API path
 * (already stripped of the `/api` prefix), or null to fall through to the
 * generic empty shape. Pure — unit-testable without a browser.
 */
export function fixtureFor(apiPath, mode = process.env.SCREENSHOT_FIXTURE) {
  if (mode === 'empty') return null
  const [pathname] = apiPath.split('?')
  if (pathname === '/chains') return { deployable: [FIXTURE_SAFE.chain_id] }
  if (pathname === '/dashboard/overview') return FIXTURE_OVERVIEW
  if (pathname.startsWith('/portfolio/')) return FIXTURE_PORTFOLIO
  if (pathname.startsWith('/balances/')) return FIXTURE_BALANCES
  if (pathname === '/agents') return { agents: FIXTURE_AGENTS }
  if (pathname === '/approvals') {
    return { approvals: FIXTURE_APPROVALS, actionable_count: 1, pending_count: 1 }
  }
  if (pathname === '/contacts') return { contacts: FIXTURE_CONTACTS }
  if (pathname === '/transactions') {
    // The aggregated feed (useTransactionsFeed).
    return { transactions: FIXTURE_TXS, total: FIXTURE_TXS.length, offset: 0, limit: 25, hasMore: false, partialFailure: false, failedSafeIds: [] }
  }
  if (pathname === '/transactions/filters') {
    return {
      safes: [{ id: FIXTURE_SAFE.id, name: FIXTURE_SAFE.name, address: FIXTURE_SAFE.safe_address, chainId: FIXTURE_SAFE.chain_id }],
      agents: FIXTURE_AGENTS.map((a) => ({ id: a.id, name: a.name, status: a.status })),
      tokens: [
        { key: `usdc:${FIXTURE_SAFE.chain_id}`, symbol: 'USDC', address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', chainId: FIXTURE_SAFE.chain_id, isNative: false },
        { key: `eth:${FIXTURE_SAFE.chain_id}`, symbol: 'ETH', address: null, chainId: FIXTURE_SAFE.chain_id, isNative: true },
      ],
    }
  }
  if (pathname.startsWith('/transactions/')) {
    // Safe-scoped, paginated (useTransactions / useAggregatedPortfolio).
    return { transactions: FIXTURE_TXS, total: FIXTURE_TXS.length, page: 1, limit: 25, pages: 1 }
  }
  return null
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
  const consoleErrors = []
  const gotoFailures = []
  try {
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 2,
        reducedMotion: 'reduce',
      })

      // Auth fixture: seed the token before any app code runs.
      await context.addInitScript((keys) => {
        window.localStorage.setItem(keys.token, 'screenshot-fixture-token')
        window.localStorage.setItem(keys.activeSafe, 'safe-fixture')
      }, SEED_STORAGE_KEYS)

      // Data fixture: resolve the authenticated session (so the app shell
      // renders), serve the route-keyed populated dataset, and answer anything
      // unkeyed with a benign empty shape. `/auth/me` MUST return a valid user
      // or the authenticated layout renders nothing. Matched by pathname +
      // search so the API host is irrelevant.
      await context.route('**/*', async (route) => {
        const req = route.request()
        const { pathname, search } = new URL(req.url())

        // The app calls the backend same-origin through Next's `/api/*` rewrite
        // (api.ts BASE_URL = '/api'). Intercept those; everything else on the
        // frontend origin (pages, `/_next` assets) loads normally.
        const api = pathname.startsWith('/api/') ? pathname.slice(4) : null
        if (api === null) return route.continue()

        const json = (body) =>
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

        if (api === '/auth/me') return json(FIXTURE_USER)
        if (api === '/user/safes') return json({ safes: FIXTURE_USER.safes })
        const populated = fixtureFor(api + search)
        if (populated !== null) return json(populated)
        // Anything unkeyed → a benign empty shape carrying every collection
        // key the hooks read, so a missing key never throws (e.g. useApprovals
        // reads `.approvals`, which it then `.filter`s).
        return json({
          data: [], items: [], overview: {},
          safes: [], agents: [], transactions: [], approvals: [], contacts: [],
          recipients: [], delegations: [], owners: [], passkeys: [], tokens: [],
          payments: [], receipts: [], catalog: [],
        })
      })

      const page = await context.newPage()
      // A red console on a fixture render is a fixture-shape gap or a real
      // client bug — collect and summarise instead of shipping blank PNGs.
      let currentRoute = ROUTES[0]
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          consoleErrors.push({ route: currentRoute, viewport: vp.name, text: msg.text().slice(0, 300) })
        }
      })
      page.on('pageerror', (err) => {
        consoleErrors.push({ route: currentRoute, viewport: vp.name, text: `pageerror: ${String(err).slice(0, 300)}` })
      })
      for (const routePath of ROUTES) {
        currentRoute = routePath
        // A swallowed navigation failure would screenshot the PREVIOUS route's
        // content under this route's filename — record it and mark the run.
        const navError = await page
          .goto(`${BASE_URL}${routePath}`, { waitUntil: 'networkidle', timeout: 30_000 })
          .then(() => null, (err) => err)
        if (navError) {
          gotoFailures.push({ route: routePath, viewport: vp.name, text: `goto failed: ${String(navError.message ?? navError).slice(0, 200)}` })
          continue // never write a mislabeled PNG
        }
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
  if (gotoFailures.length > 0) {
    console.error(`\n✗ ${gotoFailures.length} route(s) FAILED to load — their PNGs were NOT written:`)
    for (const e of gotoFailures) console.error(`  [${e.route} · ${e.viewport}] ${e.text}`)
  }
  if (consoleErrors.length > 0) {
    console.log(`\n⚠ ${consoleErrors.length} console error(s) during capture — the PNGs may show broken screens:`)
    for (const e of consoleErrors) console.log(`  [${e.route} · ${e.viewport}] ${e.text}`)
    console.log('  (a fixture-shape gap or a real client bug — fix before trusting these screenshots)')
  }
  console.log('\nAttach these to the PR (or reference them in the Browser Verification section).')
  // Broken evidence must not exit 0 — a failed navigation means missing PNGs.
  if (gotoFailures.length > 0) process.exit(1)
}

// Run only as a CLI (fixtureFor is imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('screenshot failed:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
