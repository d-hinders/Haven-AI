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
 *   npm run screenshot -w packages/frontend -- --scenario=connect-agent
 *
 * ── Scenarios (#1409) ────────────────────────────────────────────────────────
 * Some surfaces no URL can reach: the connect-agent modal lives behind a
 * four-step dialog AND a connection state machine that only advances on a
 * timer, so route-based capture cannot see it at all. A scenario drives the UI
 * there and holds it at each state, then shoots the dialog. Run them with
 * `--scenario=<name>` (comma-separated); `--scenario=all` runs every one.
 * See SCENARIOS below for the registry.
 *
 * ── Browsers ────────────────────────────────────────────────────────────────
 * Uses Playwright's pre-installed Chromium. When the cached build does not
 * match the pinned Playwright version — the usual symptom is a launch error
 * naming a `chromium_headless_shell-<n>` path that does not exist — point
 * PLAYWRIGHT_CHROMIUM_PATH at the Chromium that IS installed rather than
 * running `playwright install`:
 *
 *   PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
 *     npm run screenshot -w packages/frontend -- --scenario=connect-agent
 *
 * ── The fixture ──────────────────────────────────────────────────────────────
 * Auth: an `haven_token` + `haven_active_safe_id` are seeded in localStorage
 * before any script runs (the same keys the app and e2e fixtures use), so
 * authenticated routes render without a real login. Data: Haven-API requests
 * are answered by a route-keyed POPULATED dataset (a funded account, three
 * agents on both rails, transactions, one pending approval, contacts, agent
 * activity + spend stats) so
 * lists, tables and amounts render realistically — that's what the
 * design-reviewer pass judges. Anything not explicitly keyed falls back to a
 * benign empty shape — which carries every collection key the hooks read, so
 * an unkeyed endpoint degrades to "empty" instead of crashing the route
 * (#1075). `SCREENSHOT_FIXTURE=empty` reverts everything to the
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
// `--scenario=<name>` args are pulled out first so they are never mistaken
// for a route.
const ARGS = process.argv.slice(2)
const SCENARIO_ARGS = ARGS.filter((a) => a.startsWith('--scenario='))
  .flatMap((a) => a.slice('--scenario='.length).split(','))
  .map((s) => s.trim())
  .filter(Boolean)
const extra = ARGS.filter((a) => !a.startsWith('--'))
  .join(',')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean)
  .map((r) => (r.startsWith('/') ? r : `/${r}`))
const ROUTES = ['/design-system', ...extra]

// Authenticated-session fixture — mirrors the e2e `testUser` shape so
// `/auth/me` resolves and the app shell renders. No secrets, no live backend.
export const FIXTURE_SAFE = {
  id: 'safe-fixture',
  name: 'Operating wallet',
  safe_address: '0x1111111111111111111111111111111111111111',
  chain_id: 84532,
  is_default: true,
  created_at: '2026-05-01T10:00:00.000Z',
}
export const FIXTURE_USER = {
  id: 'user-fixture',
  name: 'Screenshot Fixture',
  email: 'fixture@haven.test',
  wallet_address: null,
  safe_address: FIXTURE_SAFE.safe_address,
  // Delegation-rail on the `/auth/me`-shaped safes list only — so the account
  // page's Backup & recovery card (#1089) has something real to render,
  // without perturbing FIXTURE_SAFE's identity shape (pinned against the e2e
  // fixture by fixture-shape-parity.test.ts).
  safes: [{ ...FIXTURE_SAFE, account_type: 'delegator_hybrid' }],
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
export const FIXTURE_TXS = [
  tx(1, { agentName: 'Research agent', source: 'x402', x402ResourceUrl: 'https://api.example.dev/reports' }),
  tx(2, { direction: 'in', from: ADDR.contact, to: FIXTURE_SAFE.safe_address, valueFormatted: '150.00', value: '150000000' }),
  tx(3, { agentName: 'Ops agent' }),
  tx(4, { asset: 'ETH', tokenSymbol: undefined, type: 'native', decimals: 18, value: '12000000000000000', valueFormatted: '0.012' }),
  tx(5, { isError: true, agentName: 'Research agent' }),
  tx(6, { direction: 'in', from: ADDR.merchant, to: FIXTURE_SAFE.safe_address, valueFormatted: '75.50', value: '75500000' }),
]

export const FIXTURE_AGENTS = [
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

export const FIXTURE_APPROVALS = [{
  id: 'appr-1', agent_id: 'agent-ops', agent_name: 'Ops agent',
  safe_address: FIXTURE_SAFE.safe_address, chain_id: FIXTURE_SAFE.chain_id,
  token_symbol: 'USDC', token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  to_address: ADDR.recipient, amount_raw: '750000000', amount_human: '750.00',
  reason: 'Quarterly vendor invoice exceeds the daily budget',
  source: 'api', x402_resource_url: null, merchant_address: null,
  payment_rail: null, payment_resource_url: null,
  status: 'pending', created_at: '2026-07-10T07:45:00.000Z',
  expires_at: '2026-07-11T07:45:00.000Z', tx_hash: null, reviewed_at: null,
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
export const FIXTURE_OVERVIEW = {
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
// Agent detail (#1075): the activity feed + spend stats behind
// `/agent-activity/:id/*`. Without these the route fell through to the empty
// fallback, which had no `activity` key at all — the page rendered nothing and
// the harness captured a crashed screen. Ordered created_at-DESC like the real
// route: the MCP-calls panel renders in array order without sorting.
export const FIXTURE_AGENT_ACTIVITY = [
  {
    type: 'payment', id: 'pay-1', agent_id: 'agent-research', agent_name: 'Research agent',
    token: 'USDC', token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    amount_raw: '25000000', amount: '25.00', to: ADDR.merchant,
    reason: null, status: 'executed', tx_hash: `0x${'a1'.repeat(32)}`,
    source: 'x402', x402_resource_url: 'https://api.example.dev/reports',
    x402_merchant_address: ADDR.merchant, chain_id: FIXTURE_SAFE.chain_id,
    safe_id: FIXTURE_SAFE.id, safe_address: FIXTURE_SAFE.safe_address, safe_name: FIXTURE_SAFE.name,
    explorer_url: `https://sepolia.basescan.org/tx/0x${'a1'.repeat(32)}`,
    confirmed_at: '2026-07-10T08:20:00.000Z', payment_proof_status: 'verified',
    payment_flow_status: 'paid', payment_attention_reason: null,
    created_at: '2026-07-10T08:18:00.000Z',
  },
  {
    type: 'mcp_tool_call', id: 'call-1', agent_id: 'agent-research', agent_name: 'Research agent',
    tool_name: 'haven_pay_x402_quote', payment_id: 'pay-1', result_status: 'ok',
    next_action: 'settle', error_code: null, status_code: 200,
    created_at: '2026-07-10T08:17:00.000Z',
  },
  {
    type: 'approval', id: 'appr-1', agent_id: 'agent-research', agent_name: 'Research agent',
    token: 'USDC', token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    amount_raw: '750000000', amount: '750.00', to: ADDR.recipient,
    reason: 'Quarterly vendor invoice exceeds the daily budget',
    status: 'pending', tx_hash: null, source: 'api',
    x402_resource_url: null, x402_merchant_address: null, chain_id: FIXTURE_SAFE.chain_id,
    safe_id: FIXTURE_SAFE.id, safe_address: FIXTURE_SAFE.safe_address, safe_name: FIXTURE_SAFE.name,
    explorer_url: null, confirmed_at: null, payment_proof_status: null,
    payment_flow_status: null, payment_attention_reason: null,
    created_at: '2026-07-10T07:45:00.000Z',
  },
  {
    type: 'payment', id: 'pay-2', agent_id: 'agent-research', agent_name: 'Research agent',
    token: 'USDC', token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    amount_raw: '4500000', amount: '4.50', to: ADDR.recipient,
    reason: null, status: 'executed', tx_hash: `0x${'b2'.repeat(32)}`,
    source: 'api', x402_resource_url: null, x402_merchant_address: null,
    chain_id: FIXTURE_SAFE.chain_id,
    safe_id: FIXTURE_SAFE.id, safe_address: FIXTURE_SAFE.safe_address, safe_name: FIXTURE_SAFE.name,
    explorer_url: `https://sepolia.basescan.org/tx/0x${'b2'.repeat(32)}`,
    confirmed_at: '2026-07-09T14:02:00.000Z', payment_proof_status: null,
    payment_flow_status: 'paid', payment_attention_reason: null,
    created_at: '2026-07-09T14:01:00.000Z',
  },
  {
    type: 'mcp_tool_call', id: 'call-2', agent_id: 'agent-research', agent_name: 'Research agent',
    tool_name: 'haven_get_allowances', payment_id: null, result_status: 'ok',
    next_action: null, error_code: null, status_code: 200,
    created_at: '2026-07-09T11:30:00.000Z',
  },
]
export const FIXTURE_AGENT_STATS = {
  all_time: [{ token: 'USDC', total_spent: '482.50', tx_count: 37 }],
  today: [{ token: 'USDC', total_spent: '25.00', tx_count: 1 }],
  this_week: [{ token: 'USDC', total_spent: '109.75', tx_count: 6 }],
  pending_approvals: 1,
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
  if (pathname === '/agent-activity/feed') {
    return { activity: FIXTURE_AGENT_ACTIVITY, pending_approvals: FIXTURE_AGENT_STATS.pending_approvals }
  }
  if (pathname.endsWith('/activity') && pathname.startsWith('/agent-activity/')) {
    return { activity: FIXTURE_AGENT_ACTIVITY }
  }
  if (pathname.endsWith('/stats') && pathname.startsWith('/agent-activity/')) {
    return FIXTURE_AGENT_STATS
  }
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
  if (pathname.startsWith('/accounts/hybrid/') && pathname.endsWith('/signers')) {
    // The account-scoped signer set (#1081/#1089) — one passkey, so the
    // Backup & recovery card renders its "only one way to approve" state.
    return {
      account_address: FIXTURE_SAFE.safe_address,
      chain_id: FIXTURE_SAFE.chain_id,
      owner_address: null,
      passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2' }],
    }
  }
  if (pathname.startsWith('/agents/') && pathname.endsWith('/passport')) {
    // Agent Passport status (#1072). Only agent-research carries one — the
    // other fixture agents render the "no passport, opt in" state, which is
    // the normal case since issuance is opt-in.
    if (pathname === `/agents/${FIXTURE_AGENTS[0].id}/passport`) {
      return {
        passport: {
          status: 'anchored', assurance_level: 0,
          attestation_uid: '0x' + '22'.repeat(32),
          tx_hash: `0x${'c3'.repeat(32)}`, chain_id: FIXTURE_SAFE.chain_id,
          attempts: 1, last_error: null,
          requested_at: '2026-06-02T10:05:00.000Z', anchored_at: '2026-06-02T10:05:12.000Z',
        },
        standing: {
          agentId: FIXTURE_AGENTS[0].id, standing: 'active', anchor: 'anchored',
          attestationUid: '0x' + '22'.repeat(32), chainLagging: false, revocationConfirmedAt: null,
        },
      }
    }
    return { passport: null, standing: null }
  }
  return null
}

/**
 * The shape every UNKEYED Haven-API path is answered with. It has to carry
 * every collection key the hooks read, because a hook that does
 * `setState(res.thing)` on a missing key stores `undefined` and the next
 * `.filter`/`.map` takes the whole route down (#1075 — `activity` was the
 * missing key). Exported so a test can pin the list.
 */
export const FIXTURE_EMPTY_FALLBACK = {
  data: [], items: [], overview: {},
  safes: [], agents: [], transactions: [], approvals: [], contacts: [],
  recipients: [], delegations: [], owners: [], passkeys: [], tokens: [],
  payments: [], receipts: [], catalog: [], activity: [],
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

/**
 * One browser context wired to the shared auth + data fixture.
 *
 * `scenario.api(apiPath, method)` may return a body to answer a request the
 * shared fixture does not key (or keys differently); returning `undefined`
 * falls through to the normal fixture, so a scenario only states what is
 * special about it.
 */
async function newFixtureContext(browser, vp, scenario) {
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

  // The dev server's overlay ("N · 1 Issue") renders in a `nextjs-portal` web
  // component and lands INSIDE the PNG — dev chrome in an artefact a reviewer
  // is meant to judge the product by. Hide it; it is not part of the app.
  await context.addInitScript(() => {
    const style = document.createElement('style')
    style.textContent = 'nextjs-portal { display: none !important; }'
    document.addEventListener('DOMContentLoaded', () => document.head.append(style))
  })

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

    const scenarioBody = scenario?.api?.(api, req.method())
    if (scenarioBody !== undefined) return json(scenarioBody)

    if (api === '/auth/me') return json(FIXTURE_USER)
    if (api === '/user/safes') return json({ safes: FIXTURE_USER.safes })
    const populated = fixtureFor(api + search)
    if (populated !== null) return json(populated)
    // Anything unkeyed → a benign empty shape carrying every collection
    // key the hooks read, so a missing key never throws (e.g. useApprovals
    // reads `.approvals`, which it then `.filter`s).
    return json(FIXTURE_EMPTY_FALLBACK)
  })

  return context
}

// The sidebar covers the page below `lg`; the e2e suite dismisses it the same
// way before driving mobile UI.
async function dismissMobileSidebar(page, vp) {
  if (vp.width >= 1024) return
  const close = page.getByRole('button', { name: 'Close sidebar' })
  if (await close.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await close.click({ force: true })
    await page.getByRole('button', { name: 'Open sidebar' }).waitFor({ state: 'visible' })
  }
}

// ── Scenario registry (#1409) ────────────────────────────────────────────────

const CONNECT_SETUP_ID = 'setup-screenshot'
const CONNECT_SETUP_TOKEN = 'hv_setup_screenshot'
const CONNECT_COMMAND = `npx -y @haven_ai/connect@alpha --setup ${CONNECT_SETUP_TOKEN} --api https://api.haven.example --ack-local-tools --runtime claude-code`

export const SCENARIOS = {
  'connect-agent': {
    description:
      'Connect agent modal, step 4, at each connection stage (starting → slow → recovery)',
    // The setup is PINNED at awaiting_connection for the whole run. The e2e
    // fixture deliberately flips to connected_local after the first status
    // read, which would end the waiting screen before it can be captured.
    api(apiPath, method) {
      if (apiPath === '/agent-connection-setups' && method === 'POST') {
        return {
          setup_id: CONNECT_SETUP_ID,
          status: 'awaiting_connection',
          setup_token: CONNECT_SETUP_TOKEN,
          expires_at: '2099-01-01T00:00:00.000Z',
          connector_command: CONNECT_COMMAND,
          setup_prompt: [
            'Please connect this workspace to Haven.',
            '',
            `I approve running this exact Haven setup command. It may download and execute the published npm package @haven_ai/connect@alpha, connect to Haven at https://api.haven.example, write local Haven credential files under ~/.haven, and update the local agent MCP config when supported.`,
            '',
            'Run this exact command:',
            '',
            CONNECT_COMMAND,
          ].join('\n'),
        }
      }
      if (apiPath === `/agent-connection-setups/${CONNECT_SETUP_ID}`) {
        return {
          setup_id: CONNECT_SETUP_ID,
          agent_id: null,
          status: 'awaiting_connection',
          expires_at: '2099-01-01T00:00:00.000Z',
          agent: { name: 'Research agent', description: null },
          haven_wallet: {
            id: FIXTURE_SAFE.id,
            name: FIXTURE_SAFE.name,
            address: FIXTURE_SAFE.safe_address,
            chain_id: FIXTURE_SAFE.chain_id,
            network: 'Base Sepolia',
          },
          agent_budget: [],
        }
      }
      return undefined
    },
    async run({ page, vp, shoot }) {
      // Virtual clock: the waiting screen's stages are `setTimeout`-driven
      // (AWAITING_CONNECTION_SLOW_MS / _RECOVERY_MS), so they are reached by
      // fast-forwarding rather than by waiting three real minutes.
      await page.clock.install()
      await page.goto(`${BASE_URL}/agents`, { waitUntil: 'networkidle', timeout: 30_000 })
      await dismissMobileSidebar(page, vp)

      await page.getByRole('button', { name: 'Connect agent', exact: true }).first().click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Agent name').fill('Research agent')

      // Steps 1-3 are captured too: they carry form controls (description
      // Textarea, the local-MCP and Agent Passport Checkboxes) that no other
      // capture reaches. Disclosures are opened first — a control nobody can
      // see is a control nobody reviewed (#1410).
      // Not guarded: the same principle as the manual-credential reveal below.
      // This scenario pins runtime=claude-code, for which the Advanced
      // disclosure always renders, so a missing one means the flow changed and
      // the capture should fail rather than quietly omit the control it exists
      // to show.
      await dialog.getByText('Advanced', { exact: true }).click()
      await shoot(dialog, 'step1-details')

      await dialog.getByRole('button', { name: 'Set agent budget' }).click()
      await dialog.getByPlaceholder('Amount').fill('25')
      await shoot(dialog, 'step2-policy')

      await dialog.getByRole('button', { name: 'Review agent rules' }).click()
      await shoot(dialog, 'step3-review')

      await dialog.getByRole('button', { name: 'Create setup prompt' }).click()
      await dialog.getByText('Connect your agent').waitFor({ timeout: 30_000 })

      // The stage timers are armed by the effect that runs once a POLLED GET
      // reports `awaiting_connection` — a different round-trip from the POST
      // that got us here. Fast-forwarding before it lands would advance a
      // clock with nothing scheduled on it: a silent no-op that would shoot
      // the PREVIOUS stage's screen under the next stage's filename. Wait for
      // a real status response first.
      await page.waitForResponse(
        (res) => res.url().includes(`/agent-connection-setups/${CONNECT_SETUP_ID}`),
        { timeout: 30_000 },
      )

      // Each stage is CONFIRMED by its own copy before it is captured, so a
      // stage that never arrives fails the run instead of producing a
      // convincing, wrongly-labelled PNG.
      await dialog.getByText('Waiting for the agent to run').waitFor({ timeout: 15_000 })
      await shoot(dialog, 'waiting-starting')

      await page.clock.fastForward(65_000)
      await dialog.getByText('Still going').waitFor({ timeout: 15_000 })
      await shoot(dialog, 'waiting-slow')

      await page.clock.fastForward(130_000)
      await dialog.getByText('Haven has not received a connection yet').waitFor({ timeout: 15_000 })
      await shoot(dialog, 'waiting-recovery')

      // The manual-credential path, revealed. It holds the most
      // safety-relevant string in the flow — the confirmation gating a
      // one-time private signing key — and it is behind two disclosures, so
      // it is invisible to every other capture. Revealing it shows the
      // warning and its checkbox; it creates nothing (that needs the button
      // below it, which is deliberately NOT clicked).
      // #1391 folded both fallbacks under one recessive disclosure, and kept
      // the manual path nested one level deeper — so the outer one has to be
      // opened first. The previous selector timed out rather than silently
      // shooting the wrong screen, which is the guard working.
      await dialog.getByText('Having trouble connecting?').click()
      await dialog.getByText('Manual credential fallback').click()
      const revealManual = dialog.getByRole('button', { name: /show the manual path/i })
      await revealManual.waitFor({ timeout: 10_000 })
      await revealManual.click()
      await dialog.getByText(/one-time private signing key/i).first().waitFor({ timeout: 10_000 })
      await shoot(dialog, 'manual-credential-warning')
    },
  },
  'connect-agent-approved': {
    description: 'Connect agent modal, step 4, the APPROVED ending (#1394)',
    // Separate scenario rather than a stage of `connect-agent`: that one pins
    // the setup at awaiting_connection for its whole run, which is what makes
    // the three waiting stages capturable at all. The ending needs the
    // opposite pin, and a run cannot hold both.
    api(apiPath, method) {
      if (apiPath === '/agent-connection-setups' && method === 'POST') {
        return {
          setup_id: CONNECT_SETUP_ID,
          status: 'active',
          setup_token: CONNECT_SETUP_TOKEN,
          expires_at: '2099-01-01T00:00:00.000Z',
          connector_command: CONNECT_COMMAND,
          setup_prompt: 'Please connect this workspace to Haven.',
        }
      }
      if (apiPath === `/agent-connection-setups/${CONNECT_SETUP_ID}`) {
        return {
          setup_id: CONNECT_SETUP_ID,
          agent_id: 'agent-fixture-1',
          status: 'active',
          expires_at: '2099-01-01T00:00:00.000Z',
          agent: { name: 'Research agent', description: null },
          haven_wallet: {
            id: FIXTURE_SAFE.id,
            name: FIXTURE_SAFE.name,
            address: FIXTURE_SAFE.safe_address,
            chain_id: FIXTURE_SAFE.chain_id,
            network: 'Base Sepolia',
          },
          // A REAL grant, in atomic units: 25.00 USDC per day. The screen's
          // whole point is naming the authority concretely, so an empty budget
          // here would capture only the fallback line and prove nothing.
          agent_budget: [
            {
              id: 'budget-1',
              token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
              token_symbol: 'USDC',
              allowance_amount: '25000000',
              reset_period_min: 1440,
            },
          ],
          delegate_address: '0x3333333333333333333333333333333333333333',
          // skill_installed false ON PURPOSE: it is the richer of the two
          // rows, carrying the download control this issue restyled. The
          // installed variant is strictly a subset (one more check glyph).
          install_status: {
            runtime_mcp_mode: 'local_stdio',
            local_mcp_configured: true,
            local_mcp_acknowledged: true,
            credential_files_written: true,
            skill_installed: false,
            restart_required: true,
          },
          approval: { status: 'active', safe_tx_hash: null, tx_hash: null },
        }
      }
      return undefined
    },
    async run({ page, vp, shoot }) {
      await page.goto(`${BASE_URL}/agents`, { waitUntil: 'networkidle', timeout: 30_000 })
      await dismissMobileSidebar(page, vp)

      await page.getByRole('button', { name: 'Connect agent', exact: true }).first().click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Agent name').fill('Research agent')
      await dialog.getByRole('button', { name: 'Set agent budget' }).click()
      await dialog.getByPlaceholder('Amount').fill('25')
      await dialog.getByRole('button', { name: 'Review agent rules' }).click()
      await dialog.getByRole('button', { name: 'Create setup prompt' }).click()

      // Confirmed by the sentence this issue exists to produce, not by a bare
      // timeout — a run that lands on any other sub-state fails here rather
      // than shooting it under the approved screen's filename.
      await dialog
        .getByText(/Research agent can now spend up to .* from /)
        .waitFor({ timeout: 30_000 })
      await shoot(dialog, 'approved')
    },
  },
  'modal-migrations': {
    description: 'InfoModal and ComingSoonModal rendered from the design-system reference',
    api() {
      return undefined
    },
    async run({ page, vp, shoot }) {
      await page.goto(`${BASE_URL}/design-system`, { waitUntil: 'networkidle', timeout: 30_000 })
      await dismissMobileSidebar(page, vp)

      await page.getByRole('button', { name: 'Open paged explainer' }).click()
      const infoDialog = page.getByRole('dialog')
      await infoDialog.getByRole('heading', { name: 'Modal patterns' }).waitFor({ timeout: 15_000 })
      await infoDialog.getByRole('button', { name: 'Next' }).click()
      await infoDialog.getByRole('heading', { name: 'Paged explainers' }).waitFor({ timeout: 15_000 })
      await shoot(infoDialog, 'info-modal')
      await infoDialog.getByRole('button', { name: 'Close' }).click()

      await page.getByRole('button', { name: 'Open compact dialog' }).click()
      const comingSoonDialog = page.getByRole('dialog')
      await comingSoonDialog.getByRole('heading', { name: 'Add funds is coming soon' }).waitFor({ timeout: 15_000 })
      await shoot(comingSoonDialog, 'coming-soon-modal')
    },
  },
}

function resolveScenarios(names) {
  const wanted = names.includes('all') ? Object.keys(SCENARIOS) : names
  return wanted.map((name) => {
    const scenario = SCENARIOS[name]
    if (!scenario) {
      throw new Error(
        `Unknown --scenario "${name}". Available: ${Object.keys(SCENARIOS).join(', ')}, all`,
      )
    }
    return { name, ...scenario }
  })
}

async function main() {
  // Validate BEFORE acquiring anything: a typo'd --scenario name throws, and
  // doing that after the dev server is spawned and the browser is launched
  // leaks both (the try/finally that cleans them up starts further down).
  const scenarios = resolveScenarios(SCENARIO_ARGS)

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
  const clipped = []
  try {
    for (const vp of VIEWPORTS) {
      const context = await newFixtureContext(browser, vp, null)
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

      // Scenarios get their own context per viewport: a virtual clock and
      // scenario-specific API answers must not leak into the route captures.
      for (const scenario of scenarios) {
        const label = `scenario:${scenario.name}`
        const scenarioContext = await newFixtureContext(browser, vp, scenario)
        const scenarioPage = await scenarioContext.newPage()
        scenarioPage.on('console', (msg) => {
          if (msg.type() === 'error') {
            consoleErrors.push({ route: label, viewport: vp.name, text: msg.text().slice(0, 300) })
          }
        })
        scenarioPage.on('pageerror', (err) => {
          consoleErrors.push({ route: label, viewport: vp.name, text: `pageerror: ${String(err).slice(0, 300)}` })
        })

        // A scenario drives real UI, so a selector drift or a state that never
        // arrives must FAIL LOUDLY rather than silently write fewer PNGs — a
        // missing stage is exactly the evidence gap this exists to close.
        const shoot = async (target, name) => {
          await scenarioPage.waitForTimeout(300) // settle the transition
          const base = `${scenario.name}-${name}-${vp.name}`
          const file = path.join(OUT_DIR, `${base}.png`)
          await target.screenshot({ path: file })
          captured.push(path.relative(ROOT, file))

          // An element screenshot captures the VISIBLE box. A dialog that caps
          // itself (max-h + overflow-y-auto) therefore drops everything below
          // the fold — and its rounded bottom edge renders cleanly at the clip,
          // so the PNG LOOKS complete. That is worse than a missing capture: a
          // reviewer would judge a screen they have only partly seen. Record
          // the shortfall and shoot the whole thing alongside it.
          const hidden = await target
            .evaluate((el) => el.scrollHeight - el.clientHeight)
            .catch(() => 0)
          if (hidden > 4) {
            clipped.push({ capture: base, hidden })
            await scenarioPage.setViewportSize({
              width: vp.width,
              height: vp.height + hidden + 48,
            })
            await scenarioPage.waitForTimeout(200)
            const fullFile = path.join(OUT_DIR, `${base}-full.png`)
            await target.screenshot({ path: fullFile })
            captured.push(path.relative(ROOT, fullFile))
            await scenarioPage.setViewportSize({ width: vp.width, height: vp.height })
            await scenarioPage.waitForTimeout(200)
          }
        }
        try {
          await scenario.run({ page: scenarioPage, vp, shoot })
        } catch (err) {
          gotoFailures.push({
            route: label,
            viewport: vp.name,
            text: `scenario failed: ${String(err?.message ?? err).slice(0, 300)}`,
          })
        }
        await scenarioContext.close()
      }
    }
  } finally {
    await browser.close()
    if (server) server.kill('SIGTERM')
  }

  console.log(`\nscreenshot: wrote ${captured.length} PNGs to .screenshots/`)
  for (const f of captured) console.log(`  ${f}`)
  if (gotoFailures.length > 0) {
    console.error(`\n✗ ${gotoFailures.length} capture(s) FAILED — their PNGs were NOT written:`)
    for (const e of gotoFailures) console.error(`  [${e.route} · ${e.viewport}] ${e.text}`)
  }
  if (clipped.length > 0) {
    console.log(
      `\n⚠ ${clipped.length} capture(s) had content BELOW THE FOLD — the plain PNG shows only what a user sees without scrolling:`,
    )
    for (const c of clipped) console.log(`  ${c.capture}: ${c.hidden}px hidden → also wrote ${c.capture}-full.png`)
    console.log('  (judge content from the -full PNG; judge what is reachable without scrolling from the other)')
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
