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
 *   npm run screenshot -w packages/frontend -- --keep=5   # retain 5 old runs
 *
 * ── The previous run survives this one (#1888) ───────────────────────────────
 * This run writes FLAT into `.screenshots/`, exactly as before, so every literal
 * `.screenshots/<name>.png` in the playbooks, the reviewer roles and the PR
 * template still resolves to the NEWEST run. What changed is the other end: the
 * run that was there before is moved into `.screenshots/previous/<run-id>/` and
 * its manifest stamped `stale: true` + `superseded_by`, instead of being
 * `rm -rf`'d. A second pass over one scenario no longer destroys the wide run a
 * reviewer is mid-way through reading (#1879's review lost its largest claim to
 * exactly that), and a same-code control run can be held alongside the candidate
 * it is a control for. Capped at 3 previous runs; `--keep=<n>` /
 * `SCREENSHOT_KEEP_RUNS` overrides, `--keep=0` restores the old behaviour.
 * Mechanism and the rejected `latest`-symlink shape: `scripts/capture-retention.mjs`.
 *
 * ── One server per worktree, and it has to prove it (#1800) ──────────────────
 * The port is DERIVED FROM THE WORKTREE PATH and proven free before the dev
 * server is spawned, and the run then fetches `/capture-identity.json` from
 * whatever it is about to capture and refuses unless the marker matches this
 * run's random token. Both halves matter: the fixed 3111 this replaces meant a
 * second concurrent session captured the OTHER worktree's app, and a 200 OK is
 * not proof of identity. See `scripts/capture-identity.mjs`. Provenance
 * (branch, commit, worktree, port) is printed and stamped into
 * `.screenshots/capture-manifest.json`, so a PNG can be traced afterwards.
 *
 * ── Route captures are un-clipped, and checked (#1738) ───────────────────────
 * The app shell is `h-screen` + `overflow-hidden` with `<main>` as the only
 * scroller, so a plain `fullPage: true` capture paints ONE viewport and leaves
 * a very long white tail — the PNG is the right size and looks fine. Route
 * captures therefore go through `captureFullPage` (`full-page-capture.mjs`),
 * which un-clips the shell first and then reads the PNG back to prove it is not
 * blank below the fold. A blank capture is DELETED and fails the run, on the
 * same reasoning as the mislabeled-PNG case below: evidence that cannot show a
 * defect is worse than no evidence, because it gets reviewed anyway.
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
import { rm, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VIEWPORTS } from './evidence-viewports.mjs'
import { captureFullPage } from './full-page-capture.mjs'
import { CLIP_TOLERANCE_PX, measureHiddenBelowFold } from './clip-guard.mjs'
import { ARCHIVE_DIR_NAME, resolveKeepRuns, retainPreviousRun } from './capture-retention.mjs'
import {
  buildRunIdentity,
  derivePort,
  removeIdentityMarkerSync,
  reserveFreePort,
  verifyServerIdentity,
  worktreeIdentity,
  writeIdentityMarker,
} from './capture-identity.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, '.screenshots')
const PUBLIC_DIR = path.join(ROOT, 'public')
const MANIFEST = path.join(OUT_DIR, 'capture-manifest.json')

// The server this run captures. Both are resolved in `main()`, because the
// port is now derived from the WORKTREE rather than fixed (#1800): a fixed
// 3111 in every worktree meant a second concurrent session captured the other
// worktree's app and the PNGs looked plausible. `SCREENSHOT_BASE_URL` still
// points the run at an already-running server — and is identity-checked like
// every other server, so pointing it at the wrong one fails loudly.
const OWN_SERVER = !process.env.SCREENSHOT_BASE_URL
let BASE_URL = process.env.SCREENSHOT_BASE_URL ?? ''

// Retina captures, so a reviewer can zoom into type and hairlines. Named
// because the blank-capture guard needs it: it measures the fold in DEVICE
// pixels, and a drift between the two would silently move the fold.
const DEVICE_SCALE_FACTOR = 2


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
// How many PREVIOUS runs survive this one (#1888). `--keep=` is a `--` flag, so
// the route parser above already ignores it. `--keep=0` is the pre-#1888
// destructive behaviour, kept reachable for a disk-pinched machine.
const KEEP_RUNS = resolveKeepRuns(ARGS, process.env)

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
      passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2', created_at: '2026-03-03T12:00:00.000Z' }],
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
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    reducedMotion: 'reduce',
  })

  // Auth fixture: seed the token before any app code runs.
  await context.addInitScript((keys) => {
    window.localStorage.setItem(keys.token, 'screenshot-fixture-token')
    window.localStorage.setItem(keys.activeSafe, 'safe-fixture')
  }, SEED_STORAGE_KEYS)

  // Device-local state a scenario needs (#1856). Some gates read localStorage
  // rather than the API — `useSafeOperationGate` resolves the signer from the
  // passkey store the app itself writes at enrolment, and no API answer can
  // put a credential on this device. `scenario.seed()` returns the same
  // key/value pairs that store holds, seeded before any app code runs, exactly
  // like the auth token above.
  //
  // Deliberately narrow: it seeds a BROWSER-side store the product owns, so
  // the app's own read path, gate branch and rendering are all real. It is not
  // a hook for stubbing component state, and a scenario that needs one should
  // be re-examined rather than served here.
  const seeded = scenario?.seed?.()
  if (seeded) {
    await context.addInitScript((entries) => {
      for (const [key, value] of entries) window.localStorage.setItem(key, value)
    }, Object.entries(seeded))
  }

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
    // No `{ force: true }` (#1749) — see the note on the e2e twin in
    // `e2e/fixtures/haven-api.ts`. The forced click was this bug's only
    // footprint in the repo: the capture tooling had been routing around an
    // unreachable navigation toggle for months without anyone naming it.
    await close.click()
    await page.getByRole('button', { name: 'Open sidebar' }).waitFor({ state: 'visible' })
  }
}

// ── Scenario registry (#1409) ────────────────────────────────────────────────

const CONNECT_SETUP_ID = 'setup-screenshot'
const CONNECT_SETUP_TOKEN = 'hv_setup_screenshot'
const CONNECT_COMMAND = `npx -y @haven_ai/connect@alpha --setup ${CONNECT_SETUP_TOKEN} --api https://api.haven.example --ack-local-tools --runtime claude-code`

export const SCENARIOS = {
  'design-system-buttons': {
    description:
      'The Buttons and badges card on /design-system — variants, the size scale, and the tap-target note',
    // Route capture cannot evidence this card. `/design-system` is ~32000px
    // tall at 1280 and ~52000px at 390, and a fullPage screenshot past
    // Chromium's surface cap (~16384px) comes back BLANK below the fold — not
    // truncated, blank, which is far worse because the PNG still looks like a
    // real capture and its file size looks plausible. #1726's design review
    // caught exactly that: the whole Primitives section was white canvas.
    // An element capture sidesteps the cap entirely.
    //
    // No fixture overrides: `/design-system` renders static showcase markup, so
    // the shared fixture is exactly right and this scenario has nothing special
    // to say about the data. Stated explicitly rather than omitted, because
    // `ScenarioShape` requires it — an absent `api` is indistinguishable from a
    // forgotten one.
    api() {
      return undefined
    },
    async run({ page, vp, shoot }) {
      await page.goto(`${BASE_URL}/design-system`, { waitUntil: 'networkidle', timeout: 60_000 })
      await dismissMobileSidebar(page, vp)

      const heading = page.getByRole('heading', { name: 'Buttons and badges' })
      await heading.waitFor({ timeout: 20_000 })

      // The Card root owning the heading — same coupling to Card's radius class
      // as account-backup-recovery, and the same intent: if Card's shape
      // changes, this FAILS rather than quietly shooting the wrong box.
      const card = page.locator('div.rounded-\\[10px\\]', { has: heading })

      // Wait for both button rows, not just the heading. The size row is the
      // thing under review, so a capture that raced it would be evidence of
      // nothing. `Small`/`Large` bracket the scale; `Primary` proves the
      // variants row above it painted too.
      await card.getByRole('button', { name: 'Primary' }).waitFor({ timeout: 20_000 })
      await card.getByRole('button', { name: 'Small' }).waitFor({ timeout: 20_000 })
      await card.getByRole('button', { name: 'Large' }).waitFor({ timeout: 20_000 })

      await card.scrollIntoViewIfNeeded()
      await shoot(card, 'card')
    },
  },
  'account-backup-recovery': {
    description:
      'Backup & recovery card unobstructed at both viewports — wallet + two dated passkeys',
    // The SHARED fixture serves one passkey and no wallet, which renders the
    // "only one way to approve" state — the right default for route capture,
    // but it shows neither the Wallet row nor a second passkey. This scenario
    // serves the healthy multi-signer set instead, so one PNG carries every
    // element the row layout has to get right: the Wallet row, the dated
    // passkey labels that WRAP at 390px (#1679), and the enrolment button with
    // its anchor subtext.
    api(apiPath) {
      if (apiPath.startsWith('/accounts/hybrid/') && apiPath.endsWith('/signers')) {
        return {
          account_address: FIXTURE_SAFE.safe_address,
          chain_id: FIXTURE_SAFE.chain_id,
          owner_address: '0x' + 'ee'.repeat(20),
          // Both dates are noon UTC so the rendered day cannot slide either
          // way with the runner's timezone — the label IS the evidence here.
          // March 3 is the exact case #1679's review saw wrap to two lines at
          // 390px; September 12 is longer still, so a regression that unwraps
          // one would have to unwrap both to go unnoticed.
          passkeys: [
            { key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2', created_at: '2026-03-03T12:00:00.000Z' },
            { key_id: '0x' + '22'.repeat(32), x: '0x3', y: '0x4', created_at: '2026-09-12T12:00:00.000Z' },
          ],
        }
      }
      return undefined
    },
    async run({ page, vp, shoot }) {
      await page.goto(`${BASE_URL}/accounts/${FIXTURE_SAFE.id}`, { waitUntil: 'networkidle', timeout: 30_000 })
      await dismissMobileSidebar(page, vp)

      const heading = page.getByRole('heading', { name: 'Backup & recovery' })
      await heading.waitFor({ timeout: 15_000 })

      // The Card root that owns the heading. Card does not forward props, so
      // there is no testid to target without changing a shared primitive;
      // this couples to Card's own radius class instead. If that changes the
      // locator finds nothing and the run FAILS — which is the behaviour you
      // want from a capture whose entire purpose is trustworthy evidence.
      const card = page.locator('div.rounded-\\[10px\\]', { has: heading })

      // Wait for the ROWS, not just the heading. The card short-circuits to
      // null until the signer fetch settles, so there is no empty-shell phase
      // to race — but the heading renders in the loadError branch too, where
      // the rows and the button do not. Waiting on the heading alone would
      // therefore accept "Haven could not load how this account is approved"
      // as the capture. These two waits are what make the error state time
      // out instead of quietly becoming the evidence.
      await card.getByText('Wallet', { exact: true }).waitFor({ timeout: 15_000 })
      await card.getByRole('button', { name: 'Add a backup passkey' }).waitFor({ timeout: 15_000 })

      await card.scrollIntoViewIfNeeded()
      await shoot(card, 'card')
    },
  },
  'passport-reanchoring': {
    description:
      'Agent Passport card during the re-key window (#1699) — the anchor names the retired key while standing stays Active',
    // No URL reaches this: `re_anchoring` is a transient backend state between
    // the retire and the re-issue, so nothing a route-based capture can wait
    // for produces it. Without a fixture the state has ZERO rendered evidence,
    // which is precisely the gap #1894's design pass found on the neighbouring
    // re-key flow and #1890 had to close afterwards. Cheaper to seed it here.
    //
    // What a reviewer is judging: whether the card keeps the two layers apart
    // when they DISAGREE. Standing is `active` and the anchor is behind, so a
    // card that collapsed them would have to pick one and would be wrong
    // either way — "Issued" claims a retired key's credential is current,
    // "Revoking…" tells the owner a live agent lost its authority.
    api(apiPath) {
      if (apiPath === `/agents/${FIXTURE_AGENTS[0].id}/passport`) {
        return {
          passport: {
            status: 'anchored', assurance_level: 0,
            attestation_uid: '0x' + '22'.repeat(32),
            tx_hash: `0x${'c3'.repeat(32)}`, chain_id: FIXTURE_SAFE.chain_id,
            attempts: 1, last_error: null,
            requested_at: '2026-06-02T10:05:00.000Z', anchored_at: '2026-06-02T10:05:12.000Z',
          },
          standing: {
            agentId: FIXTURE_AGENTS[0].id, standing: 'active', anchor: 're_anchoring',
            attestationUid: '0x' + '22'.repeat(32),
            // False on purpose, and it is an assertion rather than a default:
            // `chainLagging` is the REVOKED-agent warning, and a card that
            // showed "treat the agent as revoked now" here would invert the
            // meaning of the whole state.
            chainLagging: false, revocationConfirmedAt: null,
          },
        }
      }
      return undefined
    },
    async run({ page, vp, shoot }) {
      await page.goto(`${BASE_URL}/agents/${FIXTURE_AGENTS[0].id}`, {
        waitUntil: 'networkidle',
        timeout: 30_000,
      })
      await dismissMobileSidebar(page, vp)

      const heading = page.getByRole('heading', { name: 'Agent Passport' })
      await heading.waitFor({ timeout: 15_000 })
      const card = page.locator('div.rounded-\\[10px\\]', { has: heading })

      // Wait for the BADGE and the NOTE, not just the heading. The heading
      // renders in the loading skeleton and the load-error branch too, so
      // waiting on it alone would happily accept either as the evidence —
      // the same trap the Backup & recovery scenario documents above.
      await card.getByText('Updating on-chain').waitFor({ timeout: 15_000 })
      await card.getByText(/signing key was replaced/).waitFor({ timeout: 15_000 })

      await card.scrollIntoViewIfNeeded()
      await shoot(card, 'card')
    },
  },
  'replace-signing-key': {
    description:
      'Replace signing key modal at each step — reason (lost + compromised), address, the point-of-no-return gate both unacknowledged and armed, the no-signer refusal, and the legacy-rail refusal',
    // No URL reaches this: the modal is behind the agent detail page's options
    // menu, and its interesting screens are three clicks deep. Every stage
    // below is a distinct decision a reviewer has to judge as rendered copy.
    //
    // ── The account is PASSKEY-OWNED, and that is the fix (#1890) ───────────
    //
    // This note used to warn reviewers that every capture carried the refusal
    // banner and a dead destructive button, because the harness has no
    // connected wallet (`useActiveSigner` is wagmi-driven, so `pickSigningPath`
    // could not return 'eoa') and the client refused every non-EOA path
    // outright. #1894's design pass recorded the consequence: **the ENABLED
    // danger button had no rendered evidence anywhere.** No fixture could
    // reach the state where it is live.
    //
    // #1890 is what makes that state reachable. A passkey-owned account needs
    // no wallet connection to be signable, so giving the fixture one passkey
    // both removes the refusal banner and puts the flow on the exact path this
    // issue unblocks — the primary path now, not a workaround for the harness.
    // The armed capture below is the evidence that was missing.
    api(apiPath) {
      // agent-research carries the passport, so the #1847 disclosure renders.
      // The shared fixture gives it a null delegate; re-key needs one to be
      // replacing, so the scenario supplies it.
      if (apiPath === '/agents') {
        return {
          agents: FIXTURE_AGENTS.map((a) =>
            a.id === 'agent-research' || a.id === 'agent-retired'
              ? { ...a, delegate_address: ADDR.delegate }
              : a,
          ),
        }
      }
      // agent-retired's account has NO reachable signer, so it renders the one
      // refusal that is still real. Keyed per agent rather than per scenario so
      // the armed path and the refusal can both be captured in one run: making
      // the fixture signable is what unblocked the armed capture, and it would
      // otherwise have DELETED the refusal's only rendered evidence.
      if (apiPath === '/agents/agent-retired/account-signers') {
        return {
          account_address: FIXTURE_SAFE.safe_address,
          chain_id: FIXTURE_SAFE.chain_id,
          owner_address: '0x' + 'ee'.repeat(20),
          passkeys: [],
        }
      }
      if (apiPath.endsWith('/account-signers')) {
        return {
          account_address: FIXTURE_SAFE.safe_address,
          chain_id: FIXTURE_SAFE.chain_id,
          owner_address: '0x' + 'ee'.repeat(20),
          passkeys: [
            { key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2', created_at: '2026-03-03T12:00:00.000Z' },
          ],
        }
      }
      // The preflight, so the consequences step renders its real shape rather
      // than an error. Residual zero — the stranded-funds branch has its own
      // coverage in the unit tests and would displace this capture.
      if (apiPath === '/agents/agent-research/rekey') {
        return {
          rekey_id: 'rk-fixture-1',
          stage: 'preflight',
          old_delegate_address: ADDR.delegate,
          new_delegate_address: '0x' + '77'.repeat(20),
          residual: {
            atomic: '0',
            token_address: null,
            disposition: 'none',
            recoverable_after_rekey: false,
          },
          delegations_to_revoke: ['0x' + 'ab'.repeat(32)],
        }
      }
      return undefined
    },
    async run({ page, vp, shoot }) {
      // `shoot()` measures the deepest scrolling box in the target's subtree
      // (#1879), so this scenario no longer needs its own `shootWhole()` to see
      // past `ui/Modal`'s non-scrolling `fixed inset-0` wrapper. The stages
      // below that clip — `point-of-no-return` worst, at 1060px on mobile —
      // now get the generic record-and-re-shoot every scenario gets.

      // ── The delegation-rail agent: the whole flow ────────────────────────
      await page.goto(`${BASE_URL}/agents/agent-research`, {
        waitUntil: 'networkidle',
        timeout: 30_000,
      })
      await dismissMobileSidebar(page, vp)

      await page.getByRole('button', { name: 'Agent options' }).click()
      await page.getByRole('menuitem', { name: 'Replace signing key' }).click()

      const dialog = page.getByRole('dialog')
      // Wait for the CHOICE, not just the dialog: the two reasons are the
      // first thing under review, and a capture that raced them would show an
      // empty shell that still looks like a finished screen.
      await dialog.getByRole('radio', { name: /it is lost/i }).waitFor({ timeout: 15_000 })
      await dialog.getByRole('radio', { name: /someone else/i }).waitFor({ timeout: 15_000 })
      await shoot(dialog, 'reason')

      // Compromised surfaces the spend list — a different screen, not a
      // different toggle state, so it gets its own capture.
      await dialog.getByRole('radio', { name: /someone else/i }).click()
      await dialog.getByText(/recent spending to review/i).waitFor({ timeout: 15_000 })
      await shoot(dialog, 'reason-compromised')

      await dialog.getByRole('radio', { name: /it is lost/i }).click()
      await dialog.getByRole('button', { name: 'Continue' }).click()
      await dialog.getByText(/haven never receives the private key/i).waitFor({ timeout: 15_000 })
      await shoot(dialog, 'address')

      await dialog.getByLabel(/new signing address/i).fill('0x' + '77'.repeat(20))
      await dialog.getByRole('button', { name: 'Continue' }).click()

      // THE screen this issue exists to get right. Wait on the irreversibility
      // gate itself — if the acknowledgement ever stops rendering, this run
      // fails instead of shooting a flow that lost its safety catch.
      await dialog.getByText(/the next step cannot be undone/i).waitFor({ timeout: 15_000 })
      await dialog.getByRole('checkbox').waitFor({ timeout: 15_000 })
      await shoot(dialog, 'point-of-no-return')

      // The state that had no rendered evidence anywhere (#1894, closed here).
      // Ticking the acknowledgement is the ONLY thing that arms the red button,
      // and until #1890 no fixture could reach a signable account, so every
      // prior capture showed it dead. Both states are worth having side by
      // side: the disabled one proves the gate holds, and only this one shows
      // what the owner is actually about to press.
      await dialog.getByRole('checkbox').click()
      await dialog
        .getByRole('button', { name: /switch off the old key/i })
        .waitFor({ state: 'visible', timeout: 15_000 })
      await shoot(dialog, 'point-of-no-return-armed')

      // ── The no-signer agent: the ONE refusal that is still real ─────────
      // Its copy changed in #1890 (it no longer blames passkeys), and the
      // fixture that made the armed capture possible would otherwise have
      // removed every render of this banner from the evidence set.
      await page.goto(`${BASE_URL}/agents/agent-retired`, {
        waitUntil: 'networkidle',
        timeout: 30_000,
      })
      await dismissMobileSidebar(page, vp)
      await page.getByRole('button', { name: 'Agent options' }).click()
      await page.getByRole('menuitem', { name: 'Replace signing key' }).click()

      const noSigner = page.getByRole('dialog')
      await noSigner
        .getByText(/cannot replace this key from this device/i)
        .waitFor({ timeout: 15_000 })
      await shoot(noSigner, 'no-signer-refusal')

      // ── The legacy-rail agent: the refusal ──────────────────────────────
      await page.goto(`${BASE_URL}/agents/agent-ops`, {
        waitUntil: 'networkidle',
        timeout: 30_000,
      })
      await dismissMobileSidebar(page, vp)
      await page.getByRole('button', { name: 'Agent options' }).click()
      await page.getByRole('menuitem', { name: 'Replace signing key' }).click()

      const refusal = page.getByRole('dialog')
      await refusal.getByText(/not available for this agent/i).waitFor({ timeout: 15_000 })
      await shoot(refusal, 'legacy-rail-refusal')
    },
  },
  'account-signer-removal': {
    description: 'Account backup-removal consequence dialog with exactly two approval ways',
    api(apiPath) {
      if (apiPath.startsWith('/accounts/hybrid/') && apiPath.endsWith('/signers')) {
        return {
          account_address: FIXTURE_SAFE.safe_address,
          chain_id: FIXTURE_SAFE.chain_id,
          owner_address: '0x' + 'ee'.repeat(20),
          passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2', created_at: '2026-03-03T12:00:00.000Z' }],
        }
      }
      return undefined
    },
    async run({ page, vp, shoot }) {
      await page.goto(`${BASE_URL}/accounts/${FIXTURE_SAFE.id}`, { waitUntil: 'networkidle', timeout: 30_000 })
      await dismissMobileSidebar(page, vp)

      await page.getByRole('heading', { name: 'Backup & recovery' }).waitFor({ timeout: 15_000 })
      // The wallet row is first; this opens the confirmation for the remaining
      // Face ID / Touch ID without executing any signer change.
      await page.getByRole('button', { name: 'Remove', exact: true }).nth(1).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('heading', { name: 'Remove this approval?' }).waitFor({ timeout: 15_000 })
      await dialog.getByText(/this account will have no recovery/i).waitFor({ timeout: 15_000 })
      await shoot(dialog, 'confirmation')
    },
  },
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
      // #1720: this used to pin runtime=claude-code, the one row for which the
      // Advanced disclosure rendered. There is no runtime to pin now and the
      // disclosure renders for everyone, so a missing one means the flow
      // changed and the capture should fail rather than quietly omit the
      // control it exists to show.
      await dialog.getByText('Advanced', { exact: true }).click()
      await shoot(dialog, 'step1-details')

      await dialog.getByRole('button', { name: 'Set agent budget' }).click()
      await dialog.getByPlaceholder('Amount').fill('25')
      await shoot(dialog, 'step2-policy')

      await dialog.getByRole('button', { name: 'Review agent budget' }).click()
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
  'connect-agent-approve': {
    description: 'Connect agent modal, step 4, the APPROVE screen on the delegation rail (#1684)',
    // The third pin the other two connect scenarios cannot hold: `connect-agent`
    // pins awaiting_connection for its whole run and `connect-agent-approved`
    // pins active, so the screen BETWEEN them — where the user actually grants
    // spend authority — had no rendered evidence at all.
    api(apiPath, method) {
      if (apiPath === '/agent-connection-setups' && method === 'POST') {
        return {
          setup_id: CONNECT_SETUP_ID,
          status: 'connected_local',
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
          status: 'connected_local',
          expires_at: '2099-01-01T00:00:00.000Z',
          agent: { name: 'Research agent', description: 'Pays for research APIs' },
          haven_wallet: {
            id: FIXTURE_SAFE.id,
            name: FIXTURE_SAFE.name,
            address: FIXTURE_SAFE.safe_address,
            chain_id: FIXTURE_SAFE.chain_id,
            network: 'Base Sepolia',
          },
          // 25.00 USDC per day, atomic — the Budget row is the whole reason
          // the description no longer restates the per-period amount (#1684).
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
          install_status: {
            runtime_mcp_mode: 'local_stdio',
            local_mcp_configured: true,
            local_mcp_acknowledged: true,
            credential_files_written: true,
            skill_installed: true,
            restart_required: true,
          },
          approval: { status: 'pending', safe_tx_hash: null, tx_hash: null },
        }
      }
      // A reachable signer, or `ready` is false and the screen shows the
      // connect-wallet fallback instead of the Approve button this issue is about.
      if (apiPath === '/agents/agent-fixture-1/account-signers') {
        return {
          account_address: FIXTURE_SAFE.safe_address,
          chain_id: FIXTURE_SAFE.chain_id,
          owner_address: null,
          passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2', created_at: '2026-03-03T12:00:00.000Z' }],
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
      await dialog.getByRole('button', { name: 'Review agent budget' }).click()
      await dialog.getByRole('button', { name: 'Create setup prompt' }).click()

      // Confirmed by the money-authority action itself, not a bare timeout — a
      // run that lands on any other sub-state fails here rather than shooting
      // it under the approve screen's filename.
      await dialog.getByRole('button', { name: 'Approve budget' }).waitFor({ timeout: 30_000 })
      await shoot(dialog, 'approve')

      // ...and again with the verification disclosure open, since #1684 made
      // that one row the collapsed state: both halves need evidence.
      await dialog.getByText(/Local connection verified/).click()
      await dialog.getByText('Public address').waitFor({ timeout: 10_000 })
      await shoot(dialog, 'approve-verification-open')
    },
  },
  'connect-agent-approve-legacy': {
    description: 'Connect agent modal, step 4, the APPROVE screen on the LEGACY rail (#1684)',
    // The delegation twin of this (`connect-agent-approve`) cannot reach this
    // screen: the rail branch reads `account_type` off `/auth/me`, and the
    // shared fixture's account is `delegator_hybrid`. #1684 changes BOTH
    // approve screens — the card heading, the one-row verification footer and
    // the `Cancel` label are shared — so the legacy one needs its own capture
    // rather than an argument by symmetry.
    //
    // A fixture has no wallet to connect, so the reachable state is the
    // approval-blocked one (`approvalBlockReason` → `no_signer`). That is
    // honest rather than convenient: every element this issue changed renders
    // in it, and the blocked branch is itself a state worth having evidence
    // for.
    api(apiPath, method) {
      if (apiPath === '/auth/me') {
        // Same account, LEGACY rail. Spread rather than rebuilt so this
        // scenario states only the one field that puts it on the other rail.
        return {
          ...FIXTURE_USER,
          safes: [{ ...FIXTURE_SAFE, account_type: 'safe' }],
        }
      }
      if (apiPath === '/user/safes') {
        return { safes: [{ ...FIXTURE_SAFE, account_type: 'safe' }] }
      }
      if (apiPath === '/agent-connection-setups' && method === 'POST') {
        return {
          setup_id: CONNECT_SETUP_ID,
          status: 'connected_local',
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
          status: 'connected_local',
          expires_at: '2099-01-01T00:00:00.000Z',
          agent: { name: 'Research agent', description: 'Pays for research APIs' },
          haven_wallet: {
            id: FIXTURE_SAFE.id,
            name: FIXTURE_SAFE.name,
            address: FIXTURE_SAFE.safe_address,
            chain_id: FIXTURE_SAFE.chain_id,
            network: 'Base Sepolia',
          },
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
          install_status: {
            runtime_mcp_mode: 'local_stdio',
            local_mcp_configured: true,
            local_mcp_acknowledged: true,
            credential_files_written: true,
            skill_installed: true,
            restart_required: true,
          },
          approval: { status: 'pending', safe_tx_hash: null, tx_hash: null },
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
      await dialog.getByRole('button', { name: 'Review agent budget' }).click()
      await dialog.getByRole('button', { name: 'Create setup prompt' }).click()

      // Confirmed by the LEGACY rail's own description copy — "You sign to
      // give…" against the delegation rail's "You sign once to give…". A run
      // that lands on the delegation screen fails here rather than shooting it
      // under the legacy filename, which is the whole point of the scenario.
      await dialog
        .getByText(/You sign to give Research agent authority to spend/)
        .waitFor({ timeout: 30_000 })
      await shoot(dialog, 'approve')
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
      await dialog.getByRole('button', { name: 'Review agent budget' }).click()
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
  'add-funds': {
    description: 'Add funds modal with a RESOLVED chain — the normal path (#1844)',
    // Route capture cannot see this: it is a dialog behind the dashboard hero's
    // "Add funds" button. The chain data is the shared fixture's, untouched —
    // its safe carries chain_id 84532, which is the whole point of the
    // "resolved" capture.
    //
    // The ONE override is the rail marker, and it is about reachability rather
    // than about this issue: the shared fixture's safe is a `delegator_hybrid`
    // whose hydrated signer set holds a passkey that is not on this device, so
    // the hero renders `PasskeyOtherDeviceNotice` INSTEAD of the action buttons
    // and "Add funds" is unclickable. Measured, not assumed — the first run of
    // this scenario timed out waiting for the button while the unresolved
    // counterpart found it, because a missing chain_id happens to route the
    // gate down a different branch. Dropping `account_type` puts the account on
    // the Safe rail with no stored passkey, i.e. `no_signer`, which is a hero
    // that offers its actions. Nothing about the modal under capture changes.
    api(apiPath) {
      if (apiPath === '/auth/me') return { ...FIXTURE_USER, safes: [{ ...FIXTURE_SAFE }] }
      // Same both-endpoints reasoning as the unresolved twin below.
      if (apiPath === '/user/safes') return { safes: [{ ...FIXTURE_SAFE }] }
      return undefined
    },
    async run({ page, vp, shoot }) {
      await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle', timeout: 60_000 })
      await dismissMobileSidebar(page, vp)

      await page.getByRole('button', { name: 'Add funds', exact: true }).first().click()
      const dialog = page.getByRole('dialog')
      // Confirmed by the RESOLVED sentence, not by a bare timeout. A run that
      // somehow lands on the unknown-network state fails here rather than
      // shooting it under the resolved filename — which is the whole point of
      // having two scenarios.
      await dialog
        .getByText('Send USDC to your account address on Base Sepolia.')
        .waitFor({ timeout: 20_000 })
      await shoot(dialog, 'resolved')
    },
  },
  'add-funds-unresolved-chain': {
    description:
      'Add funds modal with an UNRESOLVED chain — names no network, offers no onramp (#1844)',
    // A separate scenario rather than a second state of `add-funds`: the two
    // need opposite pins on the SAME endpoints for their whole run, and one run
    // cannot hold both (same reason `connect-agent-approved` is split out).
    //
    // The state is not reachable through the UI today — the hero only renders
    // "Add funds" when the user has at least one account, and `defaultSafe`
    // falls through to `safes[0]`, so `selectedActionSafe` is never absent
    // while the button exists. What IS reachable is the wire condition #1844
    // names as the thing that makes the hazard live: a safe that arrives
    // WITHOUT `chain_id`. That is what this scenario serves — a partially
    // loaded safe, at the API boundary, with no component code mutated. The
    // capture is therefore evidence of the real fallback path, not of a
    // hand-edited render.
    //
    // It carries the same rail override as `add-funds` for the same
    // reachability reason, so the two captures differ by EXACTLY one field —
    // `chain_id` — and the pair is therefore evidence about the chain and
    // nothing else.
    // Both safe-serving endpoints are overridden even though the dashboard reads
    // only `/auth/me` (`DashboardClient.tsx:633` → `user?.safes`). Deliberate,
    // not over-mocking: a fixture whose two safe endpoints disagree about
    // whether an account HAS a chain is a trap for the next scenario that
    // reaches for the other one, and the disagreement would be invisible.
    api(apiPath) {
      const safeWithoutChain = { ...FIXTURE_SAFE }
      delete safeWithoutChain.chain_id
      if (apiPath === '/auth/me') return { ...FIXTURE_USER, safes: [safeWithoutChain] }
      if (apiPath === '/user/safes') return { safes: [safeWithoutChain] }
      return undefined
    },
    async run({ page, vp, shoot }) {
      await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle', timeout: 60_000 })
      await dismissMobileSidebar(page, vp)

      await page.getByRole('button', { name: 'Add funds', exact: true }).first().click()
      const dialog = page.getByRole('dialog')
      await dialog
        .getByText(/We can't confirm which network this account uses/)
        .waitFor({ timeout: 20_000 })
      await shoot(dialog, 'unresolved')
    },
  },
  'receive-funds': {
    description: 'Receive funds modal with a RESOLVED chain — the normal path (#1852)',
    // The resolved half of the #1852 pair. Same construction as `add-funds`
    // above and for the same reasons: the chain data is the shared fixture's
    // (84532), and the ONE override is dropping `account_type` so the hero
    // renders its action buttons instead of `PasskeyOtherDeviceNotice`.
    api(apiPath) {
      if (apiPath === '/auth/me') return { ...FIXTURE_USER, safes: [{ ...FIXTURE_SAFE }] }
      if (apiPath === '/user/safes') return { safes: [{ ...FIXTURE_SAFE }] }
      return undefined
    },
    async run({ page, vp, shoot }) {
      await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle', timeout: 60_000 })
      await dismissMobileSidebar(page, vp)

      // The hero labels this button "Receive" when funded and "Receive funds"
      // when not — both branches exist and which one renders depends on the
      // fixture's balances, which this scenario deliberately does not pin.
      await page.getByRole('button', { name: /^Receive( funds)?$/ }).first().click()
      const dialog = page.getByRole('dialog')
      // Confirmed by the RESOLVED sentence rather than by a bare timeout, so a
      // run that lands on the refusal fails here instead of being shot under
      // the resolved filename.
      await dialog
        .getByText('Send supported tokens to this Haven wallet on Base Sepolia.')
        .waitFor({ timeout: 20_000 })
      // The QR is half of what this screen refuses in the other state, so the
      // resolved capture has to actually show one for the pair to be evidence
      // about the QR at all.
      await dialog.getByRole('button', { name: 'Show QR code' }).click()
      await dialog.getByAltText(/^QR code for /).waitFor({ timeout: 20_000 })
      await shoot(dialog, 'resolved')
    },
  },
  'receive-funds-unresolved-chain': {
    description:
      'Receive funds modal with an UNRESOLVED chain — names no network, shows no address or QR (#1852)',
    // Separate scenario rather than a second state of `receive-funds`, for the
    // same reason as the add-funds pair: the two need opposite pins on the SAME
    // endpoints for their whole run.
    //
    // The state is not reachable through the UI today (`chain_id` is
    // non-nullable in `UserSafe`, and the hero only offers Receive when an
    // account exists). What IS reachable is the wire condition: a safe that
    // arrives WITHOUT `chain_id`. That is what this serves — at the API
    // boundary, with no component code mutated — so the capture evidences the
    // real refusal path rather than a hand-edited render.
    //
    // Same rail override as its twin, so the two differ by EXACTLY one field.
    api(apiPath) {
      const safeWithoutChain = { ...FIXTURE_SAFE }
      delete safeWithoutChain.chain_id
      if (apiPath === '/auth/me') return { ...FIXTURE_USER, safes: [safeWithoutChain] }
      if (apiPath === '/user/safes') return { safes: [safeWithoutChain] }
      return undefined
    },
    async run({ page, vp, shoot }) {
      await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle', timeout: 60_000 })
      await dismissMobileSidebar(page, vp)

      await page.getByRole('button', { name: /^Receive( funds)?$/ }).first().click()
      const dialog = page.getByRole('dialog')
      await dialog
        .getByText(/can't confirm which network this account uses/)
        .waitFor({ timeout: 20_000 })
      await shoot(dialog, 'unresolved')
    },
  },
  'send-review': {
    description:
      "Send modal STEP 2 (review) — the only TransactionMovement consumer never captured (#1856)",
    // `TransactionMovement` is a shared primitive with five call sites.
    // `SendModal.tsx:848` is the one no PNG has ever shown: no URL reaches
    // step 2, and #1835 could only close the GEOMETRY half of the gap with a
    // headless width guard. This scenario closes the picture half.
    //
    // Two fixture overrides, and the honesty of the capture rests on both
    // being at boundaries the PRODUCT itself writes, so every line of app code
    // between the boundary and the pixels is the real one:
    //
    //  1. `account_type` dropped → the Safe rail. Same override, for the same
    //     reachability reason, as `add-funds`/`receive-funds`: the shared
    //     fixture's `delegator_hybrid` safe has a hydrated passkey that is not
    //     on this device, and the dashboard hero hides Send entirely for a
    //     non-Safe-rail account (`DashboardClient.tsx:907`).
    //  2. `seed` writes the device-local passkey record (see `seed()` below).
    //     `useSafeOperationGate` returns `no_signer` without it, and
    //     `SendModal.tsx:821` disables Continue while `signingUnavailable` —
    //     which is precisely the blocker #1856 was filed on.
    //
    // Why that is FAITHFUL rather than a screen the product cannot enter: a
    // stored passkey signer is the ordinary state of any user who enrolled a
    // passkey on the device they are sending from — it is the majority path,
    // not an exotic one. Nothing is stubbed downstream of it. The gate runs its
    // real branch and returns `ready`; `useActiveSigner` resolves a real
    // `passkey` signer, which is what makes "Approve with · Device approval"
    // and "Network fees are paid by Haven (ETH)" render the words a passkey
    // user actually reads; `OnchainActionGate` takes its unblocked path and
    // `NetworkGate` renders children because no wallet is connected — again
    // the real branch for a passkey user, not a bypass. No component is
    // patched and no step state is forced: the run TYPES an amount and a
    // recipient and CLICKS Continue, so `handleReview`'s own validation is
    // what admits the capture.
    //
    // What the capture is therefore NOT evidence about: pressing Send. The
    // seeded credential is not a real WebAuthn credential, so this scenario
    // stops at review — which is all #1856 asks for, and the reason it stops
    // is worth stating rather than discovering later.
    //
    // Per #1835's measurement the primitive gets ~310px here, roughly double
    // the ~150px below which the arrow strands, so no defect is expected. This
    // closes an evidence gap; it is not a bug hunt.
    seed() {
      // Exactly the record `setStoredPasskeySigner` writes, under exactly the
      // key `passkeyStorageKey` computes. `getStoredPasskeySigner` VALIDATES
      // every field and returns null on anything it does not recognise — a
      // wrong `schemaVersion`, a non-address `address`, a public-key half
      // without its twin — and a null there puts the gate silently back on
      // `no_signer`. `screenshot-fixture.test.ts` runs this record through
      // that parser and asserts it round-trips every field, so a schema bump
      // or a dropped field fails a test rather than quietly un-reaching this
      // capture. It does NOT pin the literal values below — they are fixture
      // data, free to change, as long as the parser still accepts them.
      return {
        [`haven_passkey_${FIXTURE_SAFE.safe_address.toLowerCase()}_${FIXTURE_SAFE.chain_id}`]:
          JSON.stringify({
            schemaVersion: 1,
            address: '0x5B1869D9A4C187F2Eaa108F3062412ECf0526B24',
            credentialId: 'screenshot-fixture-credential',
            publicKey: { x: `0x${'11'.repeat(32)}`, y: `0x${'22'.repeat(32)}` },
            chainId: FIXTURE_SAFE.chain_id,
            safeAddress: FIXTURE_SAFE.safe_address.toLowerCase(),
            createdAt: Date.parse('2026-05-01T12:00:00.000Z'),
          }),
      }
    },
    api(apiPath) {
      if (apiPath === '/auth/me') return { ...FIXTURE_USER, safes: [{ ...FIXTURE_SAFE }] }
      if (apiPath === '/user/safes') return { safes: [{ ...FIXTURE_SAFE }] }
      // Keyed explicitly rather than left to the generic empty fallback. That
      // fallback happens to be truthy, so `!safeDetails` passes and Continue
      // enables — by accident. `threshold` then reads `undefined ?? 1`, and a
      // threshold of 1 vs 2 is the difference between the review screen under
      // capture and one carrying an extra "will wait for approval" banner. A
      // capture whose layout depends on an accident is not evidence.
      if (apiPath === `/safe/${FIXTURE_SAFE.safe_address}/details`) {
        return {
          address: FIXTURE_SAFE.safe_address,
          owners: ['0x5B1869D9A4C187F2Eaa108F3062412ECf0526B24'],
          threshold: 1,
          nonce: 7,
        }
      }
      return undefined
    },
    async run({ page, vp, shoot }) {
      await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle', timeout: 60_000 })
      await dismissMobileSidebar(page, vp)

      await page.getByRole('button', { name: 'Send', exact: true }).first().click()
      const dialog = page.getByRole('dialog')

      const amount = dialog.getByPlaceholder('0.00')
      await amount.waitFor({ timeout: 20_000 })
      await amount.fill('25.50')
      // `ADDR.merchant`, deliberately, and NOT `ADDR.recipient`: the latter is
      // `FIXTURE_CONTACTS[0]`'s address, so `handleRecipientChange` resolves it
      // to "Cloud vendor" and the movement line renders a NAME. Both are real
      // product states, but a pasted unknown address is the plain path and the
      // one whose `To` half is a truncated address — the same shape the
      // `ApprovalQueue` capture already evidences, so the two are comparable.
      // Measured, not assumed: the first run of this scenario used
      // `ADDR.recipient` and failed on the `To 0x9f8f…79A2` assertion because
      // the screen said "To Cloud vendor".
      await dialog
        .getByPlaceholder('Paste address or choose a saved recipient')
        .fill(ADDR.merchant)

      // Asserted, not assumed. If the seed ever stops satisfying the gate this
      // is where the run fails — loudly, with "Continue is disabled" as the
      // message — instead of timing out somewhere downstream with a reason
      // nobody can read. It is the blocker #1856 names, so it gets its own
      // check rather than being inferred from a later failure.
      const cont = dialog.getByRole('button', { name: 'Continue' })
      if (await cont.isDisabled()) {
        throw new Error(
          'Continue is disabled on the send form — the operation gate is not `ready`, ' +
            'so the review step cannot be driven (see this scenario\'s `seed()`).',
        )
      }
      await cont.click()

      // Confirmed by the review step's OWN copy and by the primitive this
      // capture exists for. A run that shot a dialog without the movement line
      // would be an evidence gap wearing a PNG, which is the exact failure
      // #1856 is about.
      await dialog.getByText('You are sending').waitFor({ timeout: 20_000 })
      // `.first()` because the primitive nests its halves: three ancestors
      // contain "From Operating wallet" as a substring, and a bare locator
      // would trip strict mode rather than assert anything.
      await dialog.getByText(`From ${FIXTURE_SAFE.name}`).first().waitFor({ timeout: 20_000 })
      await dialog
        .getByText(`To ${truncateFixtureAddress(ADDR.merchant)}`)
        .first()
        .waitFor({ timeout: 20_000 })
      await shoot(dialog, 'review')
    },
  },
}

// Mirror of `truncate` in `src/lib/format.ts` — the review step renders the
// recipient through it, so the assertion above has to spell the same string.
function truncateFixtureAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
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

  // Provenance, printed before anything is captured and stamped into the
  // manifest afterwards: a PNG on its own cannot say which branch it shows.
  // Resolved BEFORE retention runs, because the archived run's manifest records
  // which branch/commit displaced it.
  const identity = buildRunIdentity(worktreeIdentity(ROOT))
  console.log(`screenshot: worktree ${identity.worktree}`)
  console.log(
    `screenshot: branch ${identity.branch} @ ${identity.commit.slice(0, 12)}${identity.dirty ? ' (dirty working tree)' : ''}`,
  )

  // This used to be `rm -rf OUT_DIR`, which destroyed the previous run
  // unconditionally — including the case that motivated #1888, a narrow
  // `--scenario=X` run after a wide one. The previous run is now moved aside
  // into `.screenshots/previous/<run-id>/` and stamped stale, and THIS run still
  // writes flat into `.screenshots/` so every literal `.screenshots/<name>.png`
  // reference in the playbooks and reviewer roles keeps resolving to the newest
  // run. See `scripts/capture-retention.mjs` for why the `latest`-symlink shape
  // was rejected.
  const retention = await retainPreviousRun(OUT_DIR, { identity, keep: KEEP_RUNS })
  if (retention.archived) {
    console.log(
      `screenshot: previous run (${retention.files.length} file(s)) archived to ` +
        `.screenshots/${ARCHIVE_DIR_NAME}/${retention.archived}/ — its manifest is stamped stale`,
    )
  }
  if (retention.pruned.length > 0) {
    console.log(
      `screenshot: pruned ${retention.pruned.length} archived run(s) beyond --keep=${retention.keep}: ${retention.pruned.join(', ')}`,
    )
  }
  if (retention.keep <= 0) {
    console.log('screenshot: --keep=0 — no previous run was retained (destructive mode)')
  }

  // The marker the server serves back at /capture-identity.json. Written
  // BEFORE the server starts so it is on disk for the first probe, and torn
  // down again on EVERY exit — success, throw, or signal.
  await writeIdentityMarker(PUBLIC_DIR, identity)

  // Declared before the teardown that has to reach it. `server` is assigned
  // further down; a signal handler registered above it would close over a
  // binding it can never see, which is how an interrupted run orphans a Next
  // process holding this worktree's port.
  let server
  let port = null

  // Sync on purpose: an awaited promise does not settle before the process
  // leaves on a throw or a signal, and the first refusal this guard ever
  // produced left the marker sitting in `public/` for exactly that reason.
  // `public/` is copied verbatim into a production build, so a marker that
  // outlives its run is a worktree path and commit hash shipped at the site
  // root — the `exit` hook is what keeps that to a hard kill only.
  const teardown = () => {
    if (server) {
      server.kill('SIGTERM')
      server = null
    }
    try {
      removeIdentityMarkerSync(PUBLIC_DIR)
    } catch {
      /* nothing to clean up */
    }
  }
  process.on('exit', teardown)
  process.once('SIGINT', () => {
    teardown()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    teardown()
    process.exit(143)
  })

  try {
    if (OWN_SERVER) {
      // Per-worktree, and PROVEN free by binding it — never inherited from
      // whatever happens to answer on a fixed port. `SCREENSHOT_PORT` still
      // overrides the derived value, and gets the same free-port and identity
      // treatment, so it cannot reintroduce the collision either.
      const preferred = process.env.SCREENSHOT_PORT ? Number(process.env.SCREENSHOT_PORT) : derivePort(identity.worktree)
      port = await reserveFreePort(preferred)
      BASE_URL = `http://127.0.0.1:${port}`
      console.log(`screenshot: starting dev server on :${port} (derived from this worktree)…`)
      server = spawn('npm', ['run', 'dev', '--', '--hostname', '127.0.0.1', '--port', String(port)], {
        cwd: ROOT,
        stdio: 'ignore',
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
      })
      server.on('exit', (code) => {
        if (code && code !== 0 && code !== null) console.error(`dev server exited ${code}`)
      })
      await waitForServer(BASE_URL)
    } else {
      console.log(`screenshot: capturing an already-running server at ${BASE_URL}`)
    }

    // A 200 is not proof of identity (#1800). Refuse anything that cannot
    // prove it is THIS worktree's app, before a single PNG exists.
    if (process.env.SCREENSHOT_ALLOW_UNVERIFIED_SERVER === '1') {
      identity.identity_verified = false
      console.warn(
        `\n⚠ SCREENSHOT_ALLOW_UNVERIFIED_SERVER=1 — capturing ${BASE_URL} WITHOUT proving it is this worktree's app.\n` +
          '  The PNGs may show a different branch. Say so wherever you attach them.\n',
      )
    } else {
      await verifyServerIdentity(BASE_URL, identity)
      identity.identity_verified = true
      console.log(`screenshot: server identity verified — ${BASE_URL} is this worktree's app`)
    }
  } catch (err) {
    teardown()
    throw err
  }

  // Inside its own guard: a launch failure here is not hypothetical (the
  // docblock names the recurring Chromium-version cause), and it happens with
  // the dev server already spawned and the marker already on disk.
  let browser
  try {
    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    })
  } catch (err) {
    teardown()
    throw err
  }
  const captured = []
  const consoleErrors = []
  const gotoFailures = []
  const clipped = []
  const blankCaptures = []
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
        // Un-clips the h-screen/overflow-hidden shell so `fullPage` paints the
        // whole route, then reads the PNG back and refuses a blank one (#1738).
        try {
          await captureFullPage(page, {
            path: file,
            label: `${routePath} · ${vp.name}`,
            viewportDevicePx: vp.height * DEVICE_SCALE_FACTOR,
          })
          captured.push(path.relative(ROOT, file))
        } catch (err) {
          // Same stance as the navigation failure above: a PNG that looks like
          // evidence and is not is worse than no PNG, so remove it rather than
          // leave it for someone to attach to a PR.
          await rm(file, { force: true })
          blankCaptures.push({
            route: routePath,
            viewport: vp.name,
            text: String(err?.message ?? err).slice(0, 400),
          })
          continue
        }
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
          const before = await measureHiddenBelowFold(target)
          if (before.hidden > CLIP_TOLERANCE_PX) {
            await scenarioPage.setViewportSize({
              width: vp.width,
              height: vp.height + before.hidden + 48,
            })
            await scenarioPage.waitForTimeout(200)
            // Re-measure BEFORE re-shooting. Growing the viewport only helps a
            // scroller whose cap is viewport-relative (`ui/Modal`'s
            // `max-h-[calc(100vh-2rem)]`, `ui/SidePanel`'s full-height body). A
            // box with its own fixed `max-h` keeps clipping however tall the
            // window gets, and the whole point of this change is that the
            // difference must be visible instead of assumed.
            const after = await measureHiddenBelowFold(target)
            const fullFile = path.join(OUT_DIR, `${base}-full.png`)
            await target.screenshot({ path: fullFile })
            captured.push(path.relative(ROOT, fullFile))
            clipped.push({
              capture: base,
              hidden: before.hidden,
              offender: before.offender,
              offenderCount: before.offenderCount,
              residual: after.hidden,
              // The box still clipping AFTER the growth, which is usually not
              // the one that was worst BEFORE it (#1887). Recorded separately
              // because the two answer different questions and the report was
              // printing the first one under the second one's heading.
              residualOffender: after.offender,
            })
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
    teardown()
  }

  // Provenance an artifact can be traced by after the fact — which branch and
  // commit these PNGs actually show, and that the server was proven to be this
  // worktree's before they were taken.
  await writeFile(
    MANIFEST,
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        worktree: identity.worktree,
        branch: identity.branch,
        commit: identity.commit,
        dirty: identity.dirty,
        base_url: BASE_URL,
        port,
        own_server: OWN_SERVER,
        identity_verified: identity.identity_verified === true,
        routes: ROUTES,
        scenarios: scenarios.map((s) => s.name),
        files: captured,
        // Retention, recorded so the live manifest can be read as "this is the
        // current run, and here is where the one before it went" (#1888). A
        // reader who finds PNGs under `previous/` can tell from HERE that they
        // were displaced by this commit, without opening the archived manifest.
        stale: false,
        keep_runs: retention.keep,
        previous_run: retention.archived
          ? `${ARCHIVE_DIR_NAME}/${retention.archived}`
          : null,
        pruned_runs: retention.pruned,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  console.log(`\nscreenshot: wrote ${captured.length} PNGs to .screenshots/`)
  for (const f of captured) console.log(`  ${f}`)
  if (retention.archived) {
    console.log(
      `  (the previous run is still on disk at .screenshots/${ARCHIVE_DIR_NAME}/${retention.archived}/ — ` +
        'stamped stale, so do not attach it as evidence for this commit)',
    )
  }
  if (gotoFailures.length > 0) {
    console.error(`\n✗ ${gotoFailures.length} capture(s) FAILED — their PNGs were NOT written:`)
    for (const e of gotoFailures) console.error(`  [${e.route} · ${e.viewport}] ${e.text}`)
  }
  if (blankCaptures.length > 0) {
    console.error(
      `\n✗ ${blankCaptures.length} capture(s) came back BLANK below the fold — their PNGs were DELETED:`,
    )
    for (const e of blankCaptures) console.error(`  [${e.route} · ${e.viewport}] ${e.text}`)
  }
  if (clipped.length > 0) {
    console.log(
      `\n⚠ ${clipped.length} capture(s) had content BELOW THE FOLD — the plain PNG shows only what a user sees without scrolling:`,
    )
    for (const c of clipped) {
      console.log(
        `  ${c.capture}: ${c.hidden}px hidden in ${c.offender ?? 'the target'}` +
          `${c.offenderCount > 1 ? ` (${c.offenderCount} boxes report it)` : ''}` +
          ` → also wrote ${c.capture}-full.png`,
      )
    }
    console.log('  (judge content from the -full PNG; judge what is reachable without scrolling from the other)')
  }
  // Split out of the advisory list on purpose. "We grew the viewport and it is
  // STILL clipped" means the -full PNG is not actually full, so it is the one
  // artifact in this run that looks like complete evidence and is not.
  //
  // It is REPORTED, not fatal, and that is a decision rather than an oversight
  // (#1879 review). `blankCaptures` deletes its file and exits 1; this does
  // neither, because the two are not the same situation. A blank PNG has no
  // evidentiary value at all. A `-full.png` that is 203px short is still the
  // most complete render of that screen this run can produce, and deleting it
  // would leave the reviewer with less. More decisively: 8 of the 16 residuals
  // on `dev` today are a `pre.max-h-48` code block and a modal body that are
  // SELF-CAPPED by design — no viewport is tall enough, so folding this into
  // `process.exit(1)` would make `npm run screenshot` fail permanently, on
  // every branch, for a layout nobody intends to change. A gate that is red on
  // an unchanged `dev` is one people learn to ignore, which is how this repo
  // ends up with guards that flag everything.
  //
  // What that costs: #1701's scenario-local `shootWhole()` THREW on a non-zero
  // residual, and generalising the measurement to all 21 call sites means that
  // one hard assertion becomes a warning. The exchange is deliberate — every
  // capture gains a measurement that 19 of 21 never had, and one scenario loses
  // a hard stop. Making the residual gating needs an allowlist of the
  // legitimately self-capped selectors first; filed rather than guessed at.
  //
  // Names the box that is STILL clipping, which is not usually the box that
  // was worst before the growth (#1887). This line printed `c.offender` — the
  // BEFORE offender — against `c.residual`, an AFTER number, so it credited
  // one box's shortfall to another box's name for every residual since #1879
  // generalised the measurement. Diagnosed by arithmetic before it was fixed:
  // four `connect-agent` mobile captures with before-values of 203/203/295/1020
  // all reported a residual of exactly 203, which is `CopyBlock`'s
  // `pre.max-h-48` (192px cap, ~395px of command text at 390px) showing through
  // under the modal body's name. Desktop's 66px is the same `pre` at the wider
  // `max-w-xl` wrap: 192 + 66 = 258px of content.
  //
  // This is not cosmetic. The allowlist the note above asks for — the one that
  // would let this become gating — would have been built from these strings,
  // and would therefore have exempted `div.min-h-0 flex-1 overflow-y-auto …`:
  // `ui/Modal`'s body, shared by every dialog in the app, and the one box whose
  // clipping must never be waved through. An allowlist is only as honest as the
  // selector it is keyed on.
  const stillClipped = clipped.filter((c) => c.residual > CLIP_TOLERANCE_PX)
  if (stillClipped.length > 0) {
    console.error(
      `\n⚠ ${stillClipped.length} of those are STILL clipped after growing the viewport — their -full.png is NOT full:`,
    )
    for (const c of stillClipped) {
      console.error(
        `  ${c.capture}-full.png: ${c.residual}px still hidden in ${c.residualOffender ?? 'the target'}` +
          `${
            c.residualOffender && c.residualOffender !== c.offender
              ? `\n    (a DIFFERENT box from the one that was worst before the growth: ${c.offender})`
              : ''
          }`,
      )
    }
    console.error(
      '  (a box with its own fixed max-height cannot be un-clipped by a taller window — either\n' +
        '   the scroller is legitimately self-capped, or the content genuinely does not fit. Say\n' +
        '   which one wherever you attach these, and do NOT attach them as a whole screen.)',
    )
  }
  if (consoleErrors.length > 0) {
    console.log(`\n⚠ ${consoleErrors.length} console error(s) during capture — the PNGs may show broken screens:`)
    for (const e of consoleErrors) console.log(`  [${e.route} · ${e.viewport}] ${e.text}`)
    console.log('  (a fixture-shape gap or a real client bug — fix before trusting these screenshots)')
  }
  console.log(
    `\nProvenance: branch ${identity.branch} @ ${identity.commit.slice(0, 12)}${identity.dirty ? ' (dirty)' : ''}, ` +
      `captured from ${BASE_URL}${identity.identity_verified === true ? ' (identity verified)' : ' (identity NOT verified)'}.`,
  )
  console.log(`  Full record: ${path.relative(ROOT, MANIFEST)}`)
  console.log('\nAttach these to the PR (or reference them in the Browser Verification section).')
  // Broken evidence must not exit 0 — a failed navigation means missing PNGs,
  // and a blank capture means the run produced something that LOOKS like
  // evidence (#1738).
  if (gotoFailures.length > 0 || blankCaptures.length > 0) process.exit(1)
}

// Run only as a CLI (fixtureFor is imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('screenshot failed:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
