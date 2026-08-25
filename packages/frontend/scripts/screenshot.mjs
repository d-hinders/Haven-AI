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
 *   npm run screenshot -w packages/frontend -- --viewport=320x568 /dashboard
 *   npm run screenshot -w packages/frontend -- --keep=5   # retain 5 old runs
 *
 * ── Looking at a width outside the committed set (#2006) ─────────────────────
 * `--viewport=<W>[xH]` (repeatable/comma-separated, or `SCREENSHOT_VIEWPORTS`)
 * shoots the requested widths INSTEAD OF the committed pair, for that run only.
 * Nothing a gate compares changes: the four gate consumers import `VIEWPORTS`
 * from `evidence-viewports.mjs` and never the override. Overridden viewports
 * are named after their dimensions, so the PNG filenames and the manifest's
 * `viewports` / `viewport_source` state the widths the run actually used.
 * The reasoning — and why 320 is deliberately NOT in the committed set — is in
 * `evidence-viewports.mjs`.
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
 * ── A deletion is never silent (#1936 / #1939 / #1943) ───────────────────────
 * That deletion used to be the whole report: three different defects — a
 * marketing route with no app shell at all, an authenticated shell that had not
 * mounted YET, and a page that never finished compiling — printed one sentence
 * blaming the shell selector, and left an empty `.screenshots/` behind. An
 * absence of a result then reads exactly like a clean result. So: every removed
 * PNG is now named, with its cause, on stderr AND in
 * `.screenshots/capture-manifest.json` (`deleted_captures`); marketing routes
 * capture for real, with `captured_without_unclip` saying so; and a shell that
 * arrived late is reported under `shell_waits` rather than failing at random.
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
// The chain FACTS (token addresses) come from the shared registry the app
// itself reads, never restated here — a fixture that hard-codes a contract
// address is a fixture that silently stops matching the product the day the
// registry moves.
import { resolveToken } from '@haven_ai/core'
// The on-chain read seam's encoder (#1935/#1971), extracted by #1930 so the
// visual-regression spec can answer the same reads without importing this CLI.
// Re-exported below, beside the shared fixture that is built from it.
import { makeAllowanceChainFixture } from './allowance-chain-fixture.mjs'
import { spawn } from 'node:child_process'
import { rm, stat, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCaptureViewports } from './evidence-viewports.mjs'
import { SHELL_MODE, captureFullPage } from './full-page-capture.mjs'
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

/**
 * Turn a failed capture into a RECORD of the PNG that was removed (#1936/#1939/
 * #1943).
 *
 * Exported and pure so the reporting half can be tested — it is the half that
 * was actually broken. The capture failures were three different defects, but
 * what a reader got was one sentence about a selector and an empty
 * `.screenshots/`, which is indistinguishable from a run that had nothing to
 * capture. `cause` is the machine-readable discriminator:
 *
 *   'missing-scroll-root'  the shell is there and no longer matches — real
 *   'not-rendered'         cold `next dev` / failed hydration — not a selector
 *   'blank-below-fold'     the PNG came back empty below the first viewport
 *   'unknown'              anything else, never silently folded into the above
 */
export function describeDeletedCapture(err, { route, viewport, file, written = true }) {
  const message = String(err?.message ?? err)
  const cause =
    err?.shellCause ??
    err?.captureCause ??
    // A `page.screenshot` timeout on a 36,000px image is a LOADED MACHINE, not
    // a blank capture — observed on this very change, on the same box that had
    // just spent 315s compiling `/` under agent contention. Folding it into 'blank-below-fold'
    // would recreate the defect being fixed one level up.
    (/Timeout \d+ms exceeded|timeout/i.test(message) ? 'capture-timeout' : 'unknown')
  return {
    route,
    viewport,
    file,
    // "Deleted" and "never written" are different facts, and a change whose
    // entire subject is precise causal reporting should not blur them: a shell
    // verdict throws BEFORE `page.screenshot`, so there was no PNG to remove.
    disposition: written ? 'deleted' : 'never written',
    cause,
    shell_mode: err?.shell?.mode ?? null,
    waited_ms: err?.waitedMs ?? err?.shell?.waitedMs ?? null,
    // Never dropped: the message is the only place the specific measurement
    // (painted ratio, offending box, wait duration) survives.
    text: message.slice(0, 600),
  }
}

/**
 * Every PNG this run wrote must be named after a viewport this run RESOLVED
 * (#2006).
 *
 * The failure it exists to catch is the one a viewport override is most likely
 * to have: the widths are parsed, printed and stamped into the manifest, and
 * the capture loop quietly iterates something else. Nothing about that is
 * visible in a PNG — a 390px render is a perfectly good-looking image — so the
 * manifest would claim 320 over a set of files that are not 320. Filenames
 * carry `vp.name`, so a disagreement between the resolved set and the written
 * names is exactly that defect.
 *
 * What it does NOT cover, stated because the obvious reading is wider than the
 * truth: a run that captured NOTHING has no filenames to disagree, so this
 * returns empty. That case is already fatal through `gotoFailures` /
 * `deletedCaptures`, which is why this guard is scoped to the wrong-width one.
 *
 * Pure and exported so it can be tested without booting a browser.
 */
export function findViewportMismatches(files, viewports) {
  const names = viewports.map((vp) => vp.name)
  // `<slug>-<vp.name>.png`, and the taller re-shoot `<base>-<vp.name>-full.png`.
  const suffixes = names.flatMap((name) => [`-${name}.png`, `-${name}-full.png`])
  return files
    .filter((file) => !suffixes.some((suffix) => file.endsWith(suffix)))
    .map((file) => ({ file, expected: names }))
}

/**
 * The lines printed for deleted captures. One per PNG, each naming the FILE
 * that no longer exists and WHY — "we deleted something and will not say what"
 * is the failure this whole change is about.
 */
export function formatDeletionReport(deleted) {
  if (deleted.length === 0) return []
  return [
    `\n✗ ${deleted.length} capture(s) FAILED and produced NO usable PNG:`,
    ...deleted.flatMap((e) => [
      `  [${e.route} · ${e.viewport}] ${
        e.disposition === 'never written' ? 'NEVER WRITTEN' : 'DELETED'
      } ${e.file} — cause: ${e.cause}`,
      `    ${e.text}`,
    ]),
    '  (these are recorded in .screenshots/capture-manifest.json under "deleted_captures" —\n' +
      '   an empty .screenshots/ is never evidence that there was nothing to capture)',
  ]
}

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
// #2017 approver-badge fixture addresses. Three owners, one per branch of
// `classifyApprover`: an enrolled passkey, the user's own wallet, and an
// address Haven holds no record of.
export const APPROVER_PASSKEY = '0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2'
export const APPROVER_WALLET = '0x5B1869D9A4C187F2Eaa108F3062412ECf0526B24'
export const APPROVER_UNKNOWN = '0x9A7f6E2b1c4D8e05F3a2B9c6D1e8F40b3C5a7D91'

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
    // #1878: a NAMED pair — the case multi-agent wiring exists for.
    mcp_server_name: 'haven-research',
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
    // #1878: the BARE pair, reported — must not read like the agent below,
    // which reported nothing at all.
    mcp_server_name: 'haven',
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
  // `/approvals` still answers here even though the route is deleted (#1989):
  // the fixture is keyed by API path, and `GET /approvals` remains a live,
  // READABLE backend endpoint under the epic's accounts-and-history boundary.
  // No capture navigates to it any more.
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
 * A non-2xx answer for ONE route, returnable from a scenario's `api()` (#1725).
 *
 * Until this existed the harness could express exactly one thing — a 200 with a
 * body — so every ERROR state in the app was out of reach of the capture
 * tooling, however cheap it was to reach in the product. `AccountSignersCard`'s
 * `loadError` branch is the case that forced it: the branch is entered when
 * `api.get('/accounts/hybrid/:addr/signers')` THROWS (`useAccountSigners.ts`
 * `reload`), and `api.request` throws only on `!response.ok` (`lib/api.ts`).
 * No 200 body of any shape reaches it, so there was no honest fixture for the
 * one state of that card a reviewer most needs to see.
 *
 * A class rather than a `{ status, body }` shape, because the route handler has
 * to be able to tell "the scenario is seeding a failure" apart from "the
 * scenario is serving a body that happens to have a `status` field" — a
 * duck-typed marker would misfire on the first fixture whose payload carries
 * one, and misfire SILENTLY, by serving a 200. `instanceof` cannot.
 *
 * The failure is served to the app's real fetch, so the app's real error path
 * runs: the console will carry the browser's own "failed to load resource"
 * line for that request. That is expected noise for a scenario that seeds a
 * failure, not a fixture gap — the run reports console errors as advisory.
 */
export class ScenarioHttpError {
  constructor(status, body = { error: 'Screenshot fixture: seeded failure' }) {
    this.status = status
    this.body = body
  }
}

/** Sugar for the above, so a scenario reads `return httpError(500)`. */
export const httpError = (status, body) => new ScenarioHttpError(status, body)

/**
 * ── The on-chain read seam (#1935) ──────────────────────────────────────────
 *
 * `scenario.api()` above answers the HAVEN BACKEND. A second class of state is
 * populated from the CHAIN instead, and until this existed the harness could
 * not reach any of it: `EditAgentModal`'s "Current agent budgets" list — the
 * rows carrying the per-row remove control #1923 resized — is
 * `existingOnChainAllowances`, which is `useOnChainAllowances` reading the
 * Safe AllowanceModule through viem. No `/api/*` body of any shape puts a row
 * in that list, exactly as no 200 body could reach `loadError` in #1725.
 *
 * The seam is the same one #1725 found: state the harness cannot express, added
 * to the harness rather than approximated by a cleverer payload. And it is a
 * NETWORK seam, not a component stub — which is what makes the capture
 * evidence. viem's transport for the app's chain is `fallback()` over a handful
 * of plain `http(url)` endpoints (`lib/wagmi.ts`), so the reads leave the
 * browser as ordinary JSON-RPC POSTs that Playwright routes like anything else
 * — and the route matches on pathname across every origin, so which endpoint
 * the fallback happens to pick does not matter. Answering them runs
 * the app's REAL read path end to end: viem encodes the call, the fixture
 * returns ABI-encoded return data, viem decodes it, `useOnChainAllowances` maps
 * it, and `EditAgentModal` renders the rows. Every line between the wire and
 * the pixel is production code. Nothing is passed to a component by hand.
 *
 * `scenario.chain(method, params)` returns the JSON-RPC `result` for one call,
 * or `undefined` to say it has no answer. The harness takes over ALL chain
 * traffic: an unanswered method is served a JSON-RPC error rather than being let
 * out to a public node, because a capture whose data came from the live internet
 * is not deterministic evidence. The gap is recorded and FAILS THE RUN — see
 * `CHAIN_READ_GAPS`.
 *
 * ── Every capture, not only the ones that opt in (#1971) ─────────────────────
 *
 * #1935 applied this only to a scenario that declared `chain`; everything else
 * fell through to `route.continue()`. That was safe for one reason and it was
 * not the reason it looked like: the shared fixture sat on chain 84532, which
 * `lib/wagmi.ts` had no transport for, so no chain request was ever made and
 * there was nothing to let out. Every chain-fed capture was painting its empty
 * branch instead. #1971 gave 84532 a transport — the app OFFERS it, and the dev
 * deployment DEFAULTS to it, so the missing transport was a product defect, not
 * a fixture one — and the reads are now real. A scenario that declares nothing
 * therefore inherits `answerSharedChainRead`, the shared fixture's own Safe on
 * the shared fixture's own chain, so no capture reaches a public node and no
 * capture is a picture of a read that never happened.
 */

/**
 * Chain reads a scenario left unanswered, recorded per call and fatal at the
 * end of the run.
 *
 * Fatal rather than advisory, and that is the point rather than strictness for
 * its own sake. An unanswered read does not blank the screen — viem throws,
 * `useOnChainAllowances` swallows it into an empty map (its `catch` logs and
 * moves on), and the modal renders WITHOUT the budget list. That is a
 * plausible, well-formed, completely wrong PNG: the empty state of the very
 * surface the capture exists to show. This is the `deleted_captures` rule one
 * layer down — evidence that cannot show the defect is worse than no evidence.
 */
const CHAIN_READ_GAPS = []

/**
 * ── The silent half: a chain-fed capture whose reads NEVER HAPPENED (#1971) ──
 *
 * `CHAIN_READ_GAPS` above catches "the app asked and this fixture had no
 * answer". It cannot catch the failure that hid #1971 for the entire life of
 * this harness, because that one produces no request to be unanswered.
 *
 * The mechanism: `@wagmi/core`'s `getClient` CATCHES `ChainNotConfiguredError`
 * and returns `undefined`, so a fixture chain the app has no transport for
 * makes `usePublicClient({ chainId })` `undefined`, and every consumer guards
 * on exactly that and returns at its first line —
 * `if (!publicClient || !safeAddress) { setLoading(false); return }`. Nothing
 * throws, nothing is logged, no request is issued, and the surface paints its
 * empty branch. Every PNG of an on-chain surface this harness has ever produced
 * was that, and none of them looked wrong.
 *
 * So the harness measures the thing it could not previously distinguish: for a
 * capture whose page visited a route that reads the chain at render, it asserts
 * the app ACTUALLY ASKED. Zero observed reads on a chain-fed route is fatal,
 * the same stance `deleted_captures` takes one layer down — a photogenic wrong
 * answer is worse than a failed run.
 *
 * Only routes that read the chain AT RENDER belong here, and `/dashboard` was
 * wrongly in this list until review checked it against the component tree.
 * Nothing on `/dashboard` mounts `useOnChainAllowances` -- `AgentPanel` lives on
 * `/agents` and `ApprovalQueue` on `/approvals`, and `ApprovalQueue`'s
 * `usePublicClient` only GATES a button: calling the hook issues no request,
 * only a `readContract` on the returned client does. Five scenarios land on
 * `/dashboard` before opening their modal, so the mistake would have made
 * `npm run screenshot -- --scenario=all` red on unchanged `dev` -- precisely the
 * always-on alarm this file's own `stillClipped` note warns about. A gating
 * `usePublicClient` is NOT the signal; a render-time read is, and
 * `chain-fed-route-coverage.test.ts` now derives that fact from the app's own
 * import graph rather than from a second hand-maintained list.
 *
 * Keyed on ROUTE rather than on scenario, deliberately. A scenario list would
 * need an entry per scenario and would silently under-report the day someone
 * adds the sixteenth; routes change rarely, and the property being asserted is
 * a property of the screen, not of the story told about it.
 */
export const CHAIN_FED_ROUTES = [
  {
    pattern: /^\/agents(\/|$)/,
    reads: 'useOnChainAllowances — via useAgentPanelState (AgentPanel, unmanaged-delegate ' +
      'discovery) and AgentDetailClient/EditAgentModal (the budget list)',
  },
  {
    pattern: /^\/custody(\/|$)/,
    reads: 'useOnChainAllowances — SafeControlCard reads the module and delegates at render',
  },
]

/** Chain-fed captures where the app issued no chain read at all. Fatal. */
export const CHAIN_SILENT_CAPTURES = []

/**
 * Live counters for the context currently being captured, keyed PER PAGE.
 *
 * Per-page rather than per-context, and that distinction is the whole guard —
 * caught by independent review before this shipped. One context sweeps several
 * routes (`npm run screenshot -- /agents /dashboard` is ONE browser context and
 * two screens), so a single shared counter answers "did this context read the
 * chain anywhere", which is not the question. If `/agents` regressed to zero
 * reads while `/dashboard` still read fine, a context-wide counter is non-zero
 * and the regression is swallowed — the exact failure this guard exists to
 * catch, missed by the guard. In the other direction it would flag every
 * chain-fed page in the sweep when only one was broken, and a report that names
 * four screens for one defect is the kind nobody trusts twice.
 */
let chainWatch = null

export function beginChainWatch(label, viewport) {
  chainWatch = { label, viewport, current: null, pages: new Map() }
}

export function noteChainReadObserved(method) {
  if (!chainWatch) return
  const page = chainWatch.pages.get(chainWatch.current)
  if (!page) return
  page.observed += 1
  page.methods.add(method)
}

/**
 * Record a main-frame navigation.
 *
 * Sets the page reads are attributed to from here on, and opens a tally the
 * first time a chain-fed route is seen. A page is registered once: re-navigating
 * to the same pathname (a scenario that returns to a screen) keeps the reads it
 * already made rather than resetting them to zero.
 */
export function noteChainWatchNavigation(url) {
  if (!chainWatch) return
  let pathname
  try {
    pathname = new URL(url).pathname
  } catch {
    return
  }
  const fed = CHAIN_FED_ROUTES.find((route) => route.pattern.test(pathname))
  chainWatch.current = fed ? pathname : null
  if (fed && !chainWatch.pages.has(pathname)) {
    chainWatch.pages.set(pathname, { reads: fed.reads, observed: 0, methods: new Set() })
  }
}

/**
 * Withdraw a page from the watch — its capture never got far enough to be
 * judged (#1971 review, and observed live on the authoring run).
 *
 * A `goto` that times out still fires `framenavigated`, so the page enters the
 * watch, renders nothing, issues no chain read, and is reported as a silent
 * chain-fed capture. On a loaded machine that is a *machine* failure wearing the
 * diagnosis of a *transport* failure — printed directly beneath the `goto
 * failed:` line that already says what really happened, and pointing the reader
 * at `lib/wagmi.ts` for a bug that is not there. The run still exits 1 on the
 * navigation failure, so nothing is let through by staying quiet here; what is
 * avoided is a confident wrong cause, which is the same defect this whole
 * change is about, one level up.
 */
export function forgetChainWatchPage(url) {
  if (!chainWatch) return
  let pathname
  try {
    pathname = new URL(url).pathname
  } catch {
    return
  }
  chainWatch.pages.delete(pathname)
  if (chainWatch.current === pathname) chainWatch.current = null
}

/**
 * Discard the whole watch — this capture failed for a reason of its own.
 *
 * Same reasoning as `forgetChainWatchPage`, for a scenario that threw: its
 * `scenario failed:` line is already on the record and already exits the run 1.
 * The cost is real and is accepted deliberately: a scenario that failed BECAUSE
 * its chain data never arrived (a `waitFor` on a budget row) loses the sharper
 * diagnosis. The exchange is that a scenario failing for any of a dozen other
 * reasons no longer accuses the transport.
 */
export function abortChainWatch() {
  chainWatch = null
}

export function endChainWatch() {
  const watch = chainWatch
  chainWatch = null
  if (!watch) return
  for (const [pathname, page] of watch.pages) {
    if (page.observed > 0) continue
    CHAIN_SILENT_CAPTURES.push({
      capture: watch.label,
      viewport: watch.viewport,
      route: pathname,
      reads: page.reads,
    })
  }
}

/**
 * Answer one JSON-RPC request from `scenario.chain`, or decline it.
 *
 * Returns `true` when the request was fulfilled here, `false` when the caller
 * should fall through to its normal handling. Deliberately conservative about
 * what it claims: a POST is only treated as chain traffic when its body parses
 * as a JSON-RPC 2.0 envelope (or a batch of them), so a scenario declaring
 * `chain` cannot accidentally capture an unrelated POST to some other host.
 */
async function answerChainRead(route, req, scenario) {
  // Every capture gets a chain fixture, not only a scenario that opts in
  // (#1971). Before #1971 this line was `if (typeof scenario?.chain !==
  // 'function') return false` and the request fell through to
  // `route.continue()` — which was harmless only because the fixture chain had
  // no transport and no request was ever made. Now that it does, an
  // un-intercepted read would reach a public node and the capture would stop
  // being deterministic evidence.
  const answer = typeof scenario?.chain === 'function' ? scenario.chain : answerSharedChainRead
  if (req.method() !== 'POST') return false
  let payload
  try {
    payload = req.postDataJSON()
  } catch {
    return false
  }
  const batched = Array.isArray(payload)
  const calls = batched ? payload : [payload]
  if (calls.length === 0) return false
  const isRpc = (c) => c && c.jsonrpc === '2.0' && typeof c.method === 'string'
  if (!calls.every(isRpc)) return false

  // Observed — recorded BEFORE any answer is computed, because the guard this
  // feeds is about whether the app ASKED, not about whether we could reply.
  for (const call of calls) noteChainReadObserved(call.method)

  const answers = calls.map((call) => {
    let result
    try {
      result = answer(call.method, call.params ?? [])
    } catch (err) {
      // A throw from a scenario's own answer is a fixture bug, and it must not
      // read like a chain that declined — record it in the same place.
      CHAIN_READ_GAPS.push({
        scenario: scenario?.name ?? 'shared fixture',
        method: call.method,
        reason: `threw: ${String(err?.message ?? err).slice(0, 200)}`,
      })
      return {
        jsonrpc: '2.0',
        id: call.id ?? null,
        error: { code: -32000, message: `screenshot fixture: ${String(err?.message ?? err)}` },
      }
    }
    if (result === undefined) {
      CHAIN_READ_GAPS.push({
        scenario: scenario?.name ?? 'shared fixture',
        method: call.method,
        reason: 'the scenario returned undefined — no answer was declared for this read',
      })
      return {
        jsonrpc: '2.0',
        id: call.id ?? null,
        error: { code: -32601, message: `screenshot fixture: no answer for ${call.method}` },
      }
    }
    return { jsonrpc: '2.0', id: call.id ?? null, result }
  })

  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(batched ? answers : answers[0]),
  })
  return true
}

/**
 * One browser context wired to the shared auth + data fixture.
 *
 * `scenario.api(apiPath, method)` may return a body to answer a request the
 * shared fixture does not key (or keys differently); returning `undefined`
 * falls through to the normal fixture, so a scenario only states what is
 * special about it. Returning a `ScenarioHttpError` answers that one route
 * with a failure instead (#1725).
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
    if (api === null) {
      // Chain reads leave the browser as JSON-RPC POSTs to a public node, not
      // through `/api/*` — so they land here, in the `route.continue()` branch
      // that used to let them onto the real internet (#1935).
      if (await answerChainRead(route, req, scenario)) return
      return route.continue()
    }

    const json = (body) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

    const scenarioBody = scenario?.api?.(api, req.method())
    // A scenario may answer ONE route with a failure (#1725). Checked before
    // the 200 branch, because a `ScenarioHttpError` is a perfectly ordinary
    // object and `json()` would happily serve it as a 200 body — a fixture
    // that looks like it is seeding an error state and is not.
    if (scenarioBody instanceof ScenarioHttpError) {
      return route.fulfill({
        status: scenarioBody.status,
        contentType: 'application/json',
        body: JSON.stringify(scenarioBody.body),
      })
    }
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

/**
 * Refuse to shoot when something that must NOT be on screen is (#1725).
 *
 * The positive waits a scenario already does prove the state it seeded is
 * present; they cannot prove the state it did NOT seed is absent. That matters
 * whenever one surface has several states and they share copy or a container:
 * a fixture change that quietly moved the card to a neighbouring branch would
 * still satisfy every `waitFor` the scenario has, and the PNG would land under
 * the other state's filename. This is the cheap half of #1873's rule — assert
 * the rendered result, not the seed — expressed for the capture harness, which
 * has no `expect`.
 */
/**
 * Assert `EditAgentModal`'s budget list is the SEEDED list, before it is shot
 * (#1935).
 *
 * #1873's rule, which this file already applies to API-seeded state and which
 * chain-seeded state needs more, not less: seeding a state is not rendering the
 * branch. The failure this exists to make impossible is specific and quiet — if
 * `getTokenAllowance` came back wrong, or came back once and was reused for both
 * rows, the list still renders, still has two rows, still has two remove
 * controls, and the PNG still looks like a budget list. So:
 *
 *  1. the row SYMBOLS are an exact ordered array over the seeded pair, which
 *     also proves the ERC-20 and native-token branches of `tokenSymbolFromAddr`
 *     both resolved rather than falling through to a truncated address;
 *  2. the row PERIODS must DIFFER between the two rows. `resetTimeMin` is the
 *     third word of the `uint256[5]` each row decodes independently, so two
 *     matching periods is the exact signature of one answer being served twice
 *     — the silent duplicate a positional fixture would produce;
 *  3. every row carries exactly one remove control, addressed by its ARIA name.
 *
 * The icon fit is deliberately measured rather than left to the pixels, on
 * #1924's reasoning: an overflowing glyph photographs perfectly happily, so a
 * capture is exactly as consistent with the bug as with the fix. Measured as a
 * DIFFERENCE between two boxes on the same render (#1875/#1909), never as an
 * absolute local pixel claim.
 */
async function assertBudgetRows(list, expected = { symbols: ['USDC', 'ETH'] }) {
  const rows = await list.evaluate((el) =>
    Array.from(el.querySelectorAll('button[aria-label^="Remove "]')).map((button) => {
      const row = button.closest('div.flex.items-center.justify-between')
      const svg = button.querySelector('svg')
      const b = button.getBoundingClientRect()
      const s = svg?.getBoundingClientRect()
      return {
        label: button.getAttribute('aria-label') ?? '',
        symbol: row?.firstElementChild?.textContent?.trim() ?? '',
        text: row?.textContent?.trim() ?? '',
        hasIcon: Boolean(svg),
        overflowX: s ? Math.round((s.width - b.width) * 100) / 100 : null,
        overflowY: s ? Math.round((s.height - b.height) * 100) / 100 : null,
      }
    }),
  )

  const symbols = rows.map((r) => r.symbol)
  if (symbols.length !== expected.symbols.length || symbols.some((sym, i) => sym !== expected.symbols[i])) {
    throw new Error(
      `budget list: rendered rows [${symbols.join(', ')}] but the chain fixture seeded ` +
        `[${expected.symbols.join(', ')}] — the capture would be filed as the budget list ` +
        'while showing something else',
    )
  }
  for (const row of rows) {
    if (row.label !== `Remove ${row.symbol} budget`) {
      throw new Error(
        `budget list: the ${row.symbol} row's remove control is labelled "${row.label}" — ` +
          'a row and its control disagree about which budget it removes',
      )
    }
    if (!row.hasIcon) {
      throw new Error(`budget list: the ${row.symbol} row's remove control rendered no glyph`)
    }
    if (row.overflowX > 0 || row.overflowY > 0) {
      throw new Error(
        `budget list: the ${row.symbol} remove glyph OVERFLOWS its button by ` +
          `+${row.overflowX}x+${row.overflowY}px. The button does not clip, so every capture ` +
          'photographs the overflow happily — size the glyph to the control (#1858/#1923).',
      )
    }
  }

  // Period, read off the row's own text. Two rows seeded with different reset
  // periods MUST render differently; identical text means one on-chain answer
  // was served for both tokens and the second row is a lie.
  const periods = rows.map((r) => r.text.split('/').pop()?.trim() ?? '')
  if (new Set(periods).size !== periods.length) {
    throw new Error(
      `budget list: both rows report the same period (${periods.join(' / ')}), but the fixture ` +
        'seeds a different resetTimeMin per token — one getTokenAllowance answer was reused ' +
        'for both rows, so the list is not per-token data',
    )
  }
}

async function refuseIfPresent(locator, what) {
  const found = await locator.count()
  if (found > 0) {
    throw new Error(
      `${what}: found ${found} match(es) that must not be on screen for this state — ` +
        'the capture would be filed under the wrong state\'s name',
    )
  }
}

// ── Scenario registry (#1409) ────────────────────────────────────────────────

const CONNECT_SETUP_ID = 'setup-screenshot'
const CONNECT_SETUP_TOKEN = 'hv_setup_screenshot'
const CONNECT_COMMAND = `npx -y @haven_ai/connect@alpha --setup ${CONNECT_SETUP_TOKEN} --api https://api.haven.example --ack-local-tools --runtime claude-code`

/**
 * The three signer sets `account-backup-recovery` shoots (#1725).
 *
 * `null` means "answer this route with a failure" — see the scenario for why
 * `loadError` cannot be reached by any 200 body. Hoisted out of the scenario
 * so the fixture-contract test can pin all three shapes without driving a
 * browser, which is what #1409 asks a scenario to be checkable by.
 */
const BACKUP_RECOVERY_STAGES = {
  healthy: {
    account_address: FIXTURE_SAFE.safe_address,
    chain_id: FIXTURE_SAFE.chain_id,
    owner_address: '0x' + 'ee'.repeat(20),
    // Both dates are noon UTC so the rendered day cannot slide either way with
    // the runner's timezone — the label IS the evidence here. March 3 is the
    // exact case #1679's review saw wrap to two lines at 390px; September 12
    // is longer still, so a regression that unwraps one would have to unwrap
    // both to go unnoticed.
    passkeys: [
      { key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2', created_at: '2026-03-03T12:00:00.000Z' },
      { key_id: '0x' + '22'.repeat(32), x: '0x3', y: '0x4', created_at: '2026-09-12T12:00:00.000Z' },
    ],
  },
  // ONE way to approve: one passkey and no wallet. `wayCount` is
  // `passkeys.length + (owner_address ? 1 : 0)` and the banner is `< 2`, so
  // this is the minimum that renders it — and `owner_address: null` rather
  // than an omitted key, because the absence is the claim.
  'one-way': {
    account_address: FIXTURE_SAFE.safe_address,
    chain_id: FIXTURE_SAFE.chain_id,
    owner_address: null,
    passkeys: [
      { key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2', created_at: '2026-03-03T12:00:00.000Z' },
    ],
  },
  'load-error': null,
}

let backupRecoveryStage = 'healthy'

/** Move `account-backup-recovery` onto one of its three states. */
function setBackupRecoveryStage(next) {
  if (!(next in BACKUP_RECOVERY_STAGES)) {
    throw new Error(
      `account-backup-recovery: unknown stage "${next}" — expected one of ` +
        Object.keys(BACKUP_RECOVERY_STAGES).join(', '),
    )
  }
  backupRecoveryStage = next
}

// ── The AllowanceModule chain fixture (#1935, generalised by #1971) ──────────
//
// The factory itself now lives in `allowance-chain-fixture.mjs` (#1930) so the
// visual-regression spec can answer the same reads without importing this CLI
// — imported at the top with the rest. The move was mechanical; the reasoning
// that shaped it — multicall unwrapping, the per-chain Multicall3 assertion,
// why an unanswered read must be loud — travelled with the code and is
// documented there. Re-exported because `screenshot-fixture.test.ts` and the
// scenarios below both reach for it through this module.
export { makeAllowanceChainFixture }

// ── The SHARED fixture's chain answers (#1971) ───────────────────────────────
//
// On the shared fixture's own chain (84532), for the shared fixture's own Safe,
// seeded from the shared fixture's own agent. `agent-ops` is the one fixture
// agent on the LEGACY rail (`account_type: null`) with a `delegate_address`, and
// both are required: `EditAgentModal` hides the whole budget half on
// `delegator_hybrid` (#1079, `showBudgetFields`) and `useOnChainAllowances` keys
// its map by delegate.
//
// The USDC row deliberately MATCHES `agent-ops`'s API allowance (500.000000 /
// 1440min, `FIXTURE_AGENTS`) rather than inventing a second number. The two
// sources render side by side on AgentPanel, and a fixture whose chain and API
// disagree would photograph a contradiction the product cannot actually produce.
// The delegate set is exactly the managed one for the same reason — seeding a
// stranger here would render an "unmanaged delegate" warning in every capture.
export const SHARED_CHAIN_ROWS = [
  {
    token: resolveToken(FIXTURE_SAFE.chain_id, 'USDC').address,
    amount: 500_000000n,
    spent: 137_500000n,
    resetTimeMin: 1440,
  },
]
export const answerSharedChainRead = makeAllowanceChainFixture({
  chainId: FIXTURE_SAFE.chain_id,
  safeAddress: FIXTURE_SAFE.safe_address,
  delegates: [ADDR.delegate],
  rows: SHARED_CHAIN_ROWS,
})

// ── EditAgentModal's on-chain budget list (#1935) ────────────────────────────
//
// Kept on Base MAINNET and scenario-local, unchanged by #1971. Two rows rather
// than one, on purpose: one row cannot tell "the list rendered" apart from "the
// list rendered ONE row and dropped the rest", and the remove control is per
// row. An ERC-20 and the native token, because they take different branches
// through `tokenSymbolFromAddr` / `tokenDecimalsFromAddr`
// (`EditAgentModal.tsx:843-863`) — the zero address is special-cased — so the
// pair exercises both and the capture shows both symbols resolved. Keeping it on
// 8453 also keeps this scenario's evidence a CONTROL for the shared fixture's:
// two different chains, two different answer sets, one factory.
const BUDGET_CHAIN_ID = 8453
const BUDGET_USDC = resolveToken(BUDGET_CHAIN_ID, 'USDC').address
const BUDGET_NATIVE = '0x0000000000000000000000000000000000000000'

const BUDGET_FIXTURE_SAFE = { ...FIXTURE_SAFE, chain_id: BUDGET_CHAIN_ID }

/** The shared fixture's LEGACY-rail agent, moved onto the same chain as its account. */
const BUDGET_FIXTURE_AGENT = {
  ...FIXTURE_AGENTS.find((a) => a.id === 'agent-ops'),
  safe_chain_id: BUDGET_CHAIN_ID,
}

const BUDGET_ROWS = [
  // amount / spent are atomic; resetTimeMin matches RESET_PERIODS so the row
  // reads "Daily" rather than a raw "1440m" fallthrough.
  { token: BUDGET_USDC, amount: 500_000000n, spent: 137_500000n, resetTimeMin: 1440 },
  { token: BUDGET_NATIVE, amount: 250000000000000000n, spent: 0n, resetTimeMin: 10080 },
]

const answerBudgetChainRead = makeAllowanceChainFixture({
  chainId: BUDGET_CHAIN_ID,
  safeAddress: BUDGET_FIXTURE_SAFE.safe_address,
  delegates: [BUDGET_FIXTURE_AGENT.delegate_address],
  rows: BUDGET_ROWS,
})

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
      'Backup & recovery card at both viewports, in all three of its rendered states — the healthy multi-signer layout, the one-way-to-approve warning, and the load failure',
    // ── The three states, and why they are one scenario (#1693, #1725) ───────
    //
    // #1693 evidenced the HEALTHY layout only, and #1725's review found the
    // other two states resting on improvisation. They are all the same card, so
    // they stay one scenario per the registry's convention — one scenario per
    // surface, not per state — and are driven by re-serving `/signers` and
    // reloading between shots, the way `connect-agent` holds one dialog at
    // three stages.
    //
    //   healthy    wallet + two dated passkeys. The row layout, the labels that
    //              WRAP at 390px (#1679), the enrolment button and its subtext.
    //   one-way    one passkey, no wallet — the amber "only one way to approve"
    //              banner. This is a money-adjacent safety affordance: it is
    //              the ONLY thing telling a user their account has no recovery.
    //              The shared fixture has served exactly this shape all along
    //              and nothing ever shot it, which is the cheaper and more
    //              embarrassing half of the gap. Served explicitly here anyway
    //              rather than by falling through to the shared fixture: a
    //              later change that gave that fixture a wallet would silently
    //              turn this capture into a second healthy render filed under
    //              the one-way name.
    //   loadError  the signer fetch FAILS. Where the card's copy has to work
    //              hardest, and the state a reviewer most needs to see.
    //
    // ── Reachability of `loadError`, checked against source, not assumed ─────
    //
    // `AccountSignersCard.tsx` enters it on `loadError`, which
    // `useAccountSigners.ts`'s `reload` sets only in its `catch` — so the
    // branch is gated on `api.get` THROWING, and `lib/api.ts` throws only on
    // `!response.ok`. No 200 body reaches it, which is why this needed the
    // `httpError` plumbing above rather than a cleverer payload. 500 rather
    // than 4xx because the branch does not discriminate and a server fault is
    // the honest thing a reviewer is judging the copy against.
    stages: BACKUP_RECOVERY_STAGES,
    /** Exposed so the fixture-contract test can pin each stage (#1409). */
    stage: setBackupRecoveryStage,
    api(apiPath) {
      if (apiPath.startsWith('/accounts/hybrid/') && apiPath.endsWith('/signers')) {
        const signers = BACKUP_RECOVERY_STAGES[backupRecoveryStage]
        return signers === null ? httpError(500) : signers
      }
      return undefined
    },
    async run({ page, vp, shoot }) {
      // The stage is MODULE state and `run` is called once per viewport, so a
      // reset here is load-bearing rather than tidy: without it the mobile
      // pass would open on `load-error`, where the desktop pass left it, and
      // shoot a failure under the healthy capture's name.
      setBackupRecoveryStage('healthy')

      const heading = page.getByRole('heading', { name: 'Backup & recovery' })

      /**
       * Get the account page onto the currently-served stage and let it settle.
       *
       * The first load keeps `networkidle`, for continuity with every other
       * scenario. The RELOADS below use `domcontentloaded` plus the two
       * explicit waits here, because a reload only has to get this card
       * re-mounted and re-fetched and those waits are the condition that
       * actually matters — idleness of the app's wallet sockets is neither
       * necessary nor sufficient for "the card has rendered its branch".
       *
       * Both waits exist because a cheaper `waitUntil` has to buy back what
       * `networkidle` was incidentally covering, or it trades a timeout for a
       * race that shoots a plausible-looking WRONG PNG:
       *
       *   fonts   an element screenshot taken before the webfont swaps in is
       *           the wrong type at the wrong metrics, and it does not look
       *           broken — it looks like a design change.
       *   sidebar `(authenticated)/layout.tsx` mounts `Sidebar` with
       *           `dynamic(ssr: false)`. Until that chunk lands `<main>` spans
       *           the full viewport, so the card is ~240px WIDER. Three states
       *           captured at two different widths would read as a layout
       *           regression between them and would be neither.
       *
       * Recorded because it cost a diagnosis: `networkidle` was suspected of
       * being the flake when three consecutive runs timed out here, and it was
       * NOT — swapping the first goto to `domcontentloaded` timed out exactly
       * the same, and the untouched `/design-system` route capture was failing
       * in the same runs. It is a cold `next dev` compile outrunning the 30s
       * goto budget on a first boot, which the retention line above makes easy
       * to misread as a change in this scenario. Warm the server once before
       * judging a failure here.
       */
      const settleOnStage = async (navigate) => {
        await navigate()
        await page.evaluate(() => document.fonts.ready)
        // The sidebar's own ARIA contract — the handle the visual specs use for
        // this widget. Its presence is the proof the chunk mounted and `<main>`
        // has settled to its final width.
        await page.locator('button[aria-label="User menu"]').waitFor({ timeout: 15_000 })
        await dismissMobileSidebar(page, vp)
        await heading.waitFor({ timeout: 15_000 })
      }

      await settleOnStage(() =>
        page.goto(`${BASE_URL}/accounts/${FIXTURE_SAFE.id}`, {
          waitUntil: 'networkidle',
          timeout: 30_000,
        }),
      )

      // The Card root that owns the heading. Card does not forward props, so
      // there is no testid to target without changing a shared primitive;
      // this couples to Card's own radius class instead. If that changes the
      // locator finds nothing and the run FAILS — which is the behaviour you
      // want from a capture whose entire purpose is trustworthy evidence.
      const card = page.locator('div.rounded-\\[10px\\]', { has: heading })

      // The three states' distinguishing copy, as locators. Regexes, not exact
      // strings: the banner and the confirmations are authored across several
      // JSX lines, so the rendered text carries collapsed whitespace that an
      // exact match would have to reproduce by hand. Each fragment is long
      // enough to belong to exactly one state.
      const oneWayBanner = card.getByText(/only one way to approve\. Add a backup now/)
      const loadErrorCopy = card.getByText(/Haven could not load how this account is approved/)
      const walletRow = card.getByText('Wallet', { exact: true })
      const addBackup = card.getByRole('button', { name: 'Add a backup passkey' })

      /** Re-serve `/signers` at `stage` and reload the page onto it. */
      const openStage = async (stage) => {
        setBackupRecoveryStage(stage)
        await settleOnStage(() => page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }))
      }

      // ── healthy ───────────────────────────────────────────────────────────
      // Wait for the ROWS, not just the heading. The card short-circuits to
      // null until the signer fetch settles, so there is no empty-shell phase
      // to race — but the heading renders in the loadError branch too, where
      // the rows and the button do not. Waiting on the heading alone would
      // therefore accept "Haven could not load how this account is approved"
      // as the capture. These two waits are what make the error state time
      // out instead of quietly becoming the evidence.
      await walletRow.waitFor({ timeout: 15_000 })
      await addBackup.waitFor({ timeout: 15_000 })
      // And the negative half (#1725): a wallet row proves a wallet, it does
      // not prove the warning is gone. If a regression rendered the banner
      // alongside a healthy signer set, every wait above would still pass.
      await refuseIfPresent(oneWayBanner, 'account-backup-recovery · healthy · one-way banner')
      await refuseIfPresent(loadErrorCopy, 'account-backup-recovery · healthy · load-error copy')
      await card.scrollIntoViewIfNeeded()
      await shoot(card, 'card')

      // ── one way to approve ────────────────────────────────────────────────
      await openStage('one-way')
      await oneWayBanner.waitFor({ timeout: 15_000 })
      // The banner is the subject; these two are what prove the card is in the
      // SIGNERS branch showing one signer, rather than in some other branch
      // that happens to contain the copy. `Wallet` absent is the fixture's own
      // claim read back off the render.
      await addBackup.waitFor({ timeout: 15_000 })
      await refuseIfPresent(walletRow, 'account-backup-recovery · one-way · wallet row')
      await refuseIfPresent(loadErrorCopy, 'account-backup-recovery · one-way · load-error copy')
      await card.scrollIntoViewIfNeeded()
      await shoot(card, 'one-way')

      // ── load failure ──────────────────────────────────────────────────────
      await openStage('load-error')
      await loadErrorCopy.waitFor({ timeout: 15_000 })
      // `Try again` is the whole affordance of this state, and it is the half a
      // reviewer judges: the copy admits a failure, the button is the way out.
      await card.getByRole('button', { name: 'Try again' }).waitFor({ timeout: 15_000 })
      // Nothing from the loaded branch may survive into it. `addBackup` absent
      // is the strongest of these — it is rendered by the `signers ?` arm, so
      // its presence would mean the card is showing both branches at once.
      await refuseIfPresent(addBackup, 'account-backup-recovery · load-error · enrolment button')
      await refuseIfPresent(walletRow, 'account-backup-recovery · load-error · wallet row')
      await refuseIfPresent(oneWayBanner, 'account-backup-recovery · load-error · one-way banner')
      await card.scrollIntoViewIfNeeded()
      await shoot(card, 'load-error')
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
  'approver-type-badges': {
    description:
      'Approvers list on a legacy Safe — all three badge states in one PNG: Passkey, Wallet, and the Unknown that #2017 replaced an absence-inferred "Wallet" with',
    // No route capture can show this. The SHARED fixture's account is
    // `delegator_hybrid`, so `useSafeDetails` is deliberately passed null
    // (#1107) and the Approvers section never renders at all. This scenario
    // serves a LEGACY Safe with three owners chosen so each one lands in a
    // different branch of `classifyApprover`, which is the whole point: a
    // capture that could only ever show one badge state cannot evidence a
    // change about the other two.
    api(apiPath) {
      const LEGACY_SAFE = { ...FIXTURE_SAFE, account_type: 'safe' }
      const user = {
        ...FIXTURE_USER,
        wallet_address: APPROVER_WALLET,
        safes: [LEGACY_SAFE],
      }
      if (apiPath === '/auth/me') return user
      if (apiPath === '/user/safes') return { safes: [LEGACY_SAFE] }
      // Keyed, not left to the empty fallback: the fallback serves
      // `passkeys: []`, under which EVERY owner would render Unknown and the
      // PNG would evidence nothing about the Passkey branch.
      if (apiPath === '/passkeys') {
        return {
          passkeys: [
            {
              id: 'passkey-fixture',
              credential_id: 'approver-badge-credential',
              signer_address: APPROVER_PASSKEY,
              chain_id: FIXTURE_SAFE.chain_id,
              safe_address: FIXTURE_SAFE.safe_address,
              created_at: '2026-03-03T12:00:00.000Z',
            },
          ],
        }
      }
      if (apiPath === `/safe/${FIXTURE_SAFE.safe_address}/details`) {
        return {
          address: FIXTURE_SAFE.safe_address,
          // Order is the render order, and it is deliberate: Passkey (known),
          // Wallet (the user's own, positively matched), Unknown (an owner
          // Haven holds no record for — a rotated passkey, one enrolled
          // outside Haven, or a wallet; the badge no longer guesses which).
          owners: [APPROVER_PASSKEY, APPROVER_WALLET, APPROVER_UNKNOWN],
          threshold: 2,
          nonce: 7,
        }
      }
      return undefined
    },
    async run({ page, vp, shoot }) {
      await page.goto(`${BASE_URL}/accounts/${FIXTURE_SAFE.id}`, { waitUntil: 'networkidle', timeout: 30_000 })
      await dismissMobileSidebar(page, vp)

      const heading = page.getByText('Approvers', { exact: true })
      await heading.waitFor({ timeout: 15_000 })

      const card = page.locator('div.rounded-\\[10px\\]', { has: heading })

      // Wait on the BADGES, not the heading. The section renders as soon as
      // `details.owners` is non-empty, so waiting on the heading alone would
      // happily capture a half-settled list. All three are waited for
      // explicitly, so a capture missing any state fails the run instead of
      // becoming the evidence.
      await card.getByText('Passkey', { exact: true }).waitFor({ timeout: 15_000 })
      await card.getByText('Wallet', { exact: true }).waitFor({ timeout: 15_000 })
      await card.getByText('Unknown', { exact: true }).waitFor({ timeout: 15_000 })

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
      // agent-research has an anchored passport, so the #1699 disclosure renders.
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
  'retired-rail-account': {
    description:
      'Account detail for a LEGACY Safe account after the rail retirement (#1989) — RetiredRailNotice present, no Send action',
    // #1989's design review named this gap: `RetiredRailNotice` is the one
    // surface the slice ADDS, and no existing capture can show it. Every other
    // account fixture is `delegator_hybrid`, which by construction renders the
    // Send button and never renders the notice — so the shared fixture proves
    // the opposite of what this scenario is for.
    //
    // The ONE override is `account_type: 'safe'`, spread from the shared
    // fixture, exactly as `connect-agent-approve-legacy` above does it. The
    // account is otherwise identical, which is what makes the pair readable:
    // the same account on the other rail.
    api(apiPath) {
      if (apiPath === '/auth/me') {
        return { ...FIXTURE_USER, safes: [{ ...FIXTURE_SAFE, account_type: 'safe' }] }
      }
      if (apiPath === '/user/safes') {
        return { safes: [{ ...FIXTURE_SAFE, account_type: 'safe' }] }
      }
      return undefined
    },
    async run({ page, vp, shoot }) {
      await page.goto(`${BASE_URL}/accounts/${FIXTURE_SAFE.id}`, {
        waitUntil: 'networkidle',
        timeout: 60_000,
      })
      await dismissMobileSidebar(page, vp)

      const main = page.locator('main')
      await main.waitFor({ timeout: 30_000 })

      // The subject.
      await page
        .getByText(/Haven no longer sends payments from this account/)
        .waitFor({ timeout: 20_000 })

      // The READ boundary, asserted on the render rather than argued: the
      // account is still fully readable next to the notice. Without these the
      // capture could be filed for a page that failed to load its data and
      // showed the notice over skeletons.
      await page.getByRole('heading', { name: FIXTURE_SAFE.name }).waitFor({ timeout: 20_000 })
      await page.getByRole('button', { name: 'Receive' }).waitFor({ timeout: 20_000 })

      // The negative half, and the reason this scenario is evidence at all.
      // A notice proves a notice; it does not prove the spend affordance is
      // gone. If a regression rendered Send ALONGSIDE the notice, every wait
      // above would still pass and the PNG would be filed under this name.
      await refuseIfPresent(
        page.getByRole('button', { name: 'Send', exact: true }),
        'retired-rail-account · Send button',
      )

      await shoot(main, 'account')
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
  'edit-agent-budget': {
    description:
      "EditAgentModal's on-chain budget list and its per-row remove control (#1935)",
    // ── What this closes ─────────────────────────────────────────────────────
    //
    // #1923 resized this modal's remove glyph from 12px to 14px, and said so
    // honestly: the control "has never been captured at any commit", because
    // the rows come from an on-chain read no HTTP fixture reaches. #1935 is that
    // gap. The seam it needed is `scenario.chain` (see `answerChainRead`) — the
    // same shape #1725 arrived at for `loadError`: when a state is out of reach
    // because the harness cannot express its INPUT, the harness grows, it does
    // not get a cleverer payload.
    //
    // Nothing here is stubbed above the wire. The fixture answers JSON-RPC; the
    // app's own viem client, `useOnChainAllowances`, `AgentDetailClient` and
    // `EditAgentModal` do everything from there. The list in the PNG is the
    // product's, rendered from the product's own decode of ABI-encoded bytes.
    api(apiPath) {
      // All three, though the detail page reads agents from `/agents` and the
      // safe from `/auth/me`: two safe-serving endpoints that disagree about
      // which CHAIN an account is on would be a trap for the next scenario that
      // reaches for the other one, and the disagreement would be invisible
      // (the reasoning `add-funds-unresolved-chain` records).
      if (apiPath === '/auth/me') return { ...FIXTURE_USER, safes: [BUDGET_FIXTURE_SAFE] }
      if (apiPath === '/user/safes') return { safes: [BUDGET_FIXTURE_SAFE] }
      if (apiPath === '/agents') return { agents: [BUDGET_FIXTURE_AGENT] }
      return undefined
    },
    chain: answerBudgetChainRead,
    async run({ page, vp, shoot }) {
      // `domcontentloaded`, not `networkidle`: this is the first scenario whose
      // page holds a LIVE on-chain poll (`useOnChainAllowances` re-reads every
      // 30s), so the quiet window the other scenarios rely on is not guaranteed
      // to arrive here. Every state below is waited for by its own subject
      // instead, which is the condition that actually matters.
      await page.goto(`${BASE_URL}/agents/${BUDGET_FIXTURE_AGENT.id}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      })
      await dismissMobileSidebar(page, vp)

      await page.getByRole('button', { name: 'Agent options' }).click({ timeout: 30_000 })
      await page.getByRole('menuitem', { name: 'Update budget' }).click({ timeout: 15_000 })

      const dialog = page.getByRole('dialog', { name: 'Edit agent' })
      // The heading pins the MODE. `openUpdateBudget` sets `mode: 'budget'`, and
      // 'all' mode renders the same list under a different heading — so waiting
      // on the list alone would happily photograph the wrong entry point's
      // modal under this scenario's name.
      await dialog.getByRole('heading', { name: 'Update budget' }).waitFor({ timeout: 30_000 })

      const list = dialog.getByText('Current agent budgets').locator('xpath=..')
      await list.waitFor({ timeout: 30_000 })
      await assertBudgetRows(list)
      await shoot(list, 'budget-list')

      // The confirm step the remove control opens. Captured because it is the
      // other half of the same control and is equally unreachable without the
      // chain read — the dialog names the specific token, which only exists
      // because a real row was clicked.
      await list.getByRole('button', { name: 'Remove USDC budget' }).click()
      const confirm = page.getByRole('dialog', { name: 'Remove USDC budget?' })
      await confirm.waitFor({ timeout: 15_000 })
      await shoot(confirm, 'remove-confirm')
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
  // 'send-review' (#1856) is DELETED with its subject (#1989, epic #1440): it
  // drove the legacy `SendModal` to step 2, and that modal is gone with the
  // Safe rail. Its `TransactionMovement` evidence gap is closed differently now
  // — `/transactions` and `/design-system` both render the primitive and are
  // captured, and the mobile geometry sweep in
  // `e2e/transaction-row.mobile.spec.ts` measures it at 320/390/393px.
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

  // The widths THIS run shoots (#2006). Same stance as the scenario check
  // above: a malformed `--viewport=` throws before a server or a browser is
  // acquired. With no override this is the committed set, unchanged — see
  // `evidence-viewports.mjs` for why the gates must keep importing VIEWPORTS
  // directly and never this.
  const { viewports: captureViewports, source: viewportSource } = resolveCaptureViewports(
    ARGS,
    process.env,
  )

  // Provenance, printed before anything is captured and stamped into the
  // manifest afterwards: a PNG on its own cannot say which branch it shows.
  // Resolved BEFORE retention runs, because the archived run's manifest records
  // which branch/commit displaced it.
  const identity = buildRunIdentity(worktreeIdentity(ROOT))
  console.log(`screenshot: worktree ${identity.worktree}`)
  console.log(
    `screenshot: branch ${identity.branch} @ ${identity.commit.slice(0, 12)}${identity.dirty ? ' (dirty working tree)' : ''}`,
  )
  // Printed for both cases on purpose. "Which widths did this run shoot" is a
  // question a reviewer reading a PNG in a thread has to be able to answer, and
  // an override that announces itself only when something goes wrong is one
  // more silent capture path.
  console.log(
    `screenshot: viewports ${captureViewports.map((vp) => `${vp.name} (${vp.width}x${vp.height})`).join(', ')}` +
      (viewportSource === 'committed'
        ? ' — the committed evidence set'
        : ` — OVERRIDE via ${viewportSource}, this run only; no baseline is affected`),
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
  // Every capture whose PNG was REMOVED, with the reason it was removed and
  // which of the three causes it was (#1936/#1939/#1943). A deletion that is
  // not recorded leaves an absence that reads as "nothing to capture", which
  // is how three different defects produced one indistinguishable symptom.
  const deletedCaptures = []
  // Routes captured WITHOUT un-clipping because they legitimately have no app
  // shell (marketing). Reported, so "no un-clip" is a stated fact rather than
  // something a reader has to infer from silence.
  const shellless = []
  // Captures that only succeeded after waiting for the shell to mount — the
  // ProtectedRoute race, made visible instead of intermittent (#1936).
  const raced = []
  try {
    for (const vp of captureViewports) {
      const context = await newFixtureContext(browser, vp, null)
      const page = await context.newPage()
      beginChainWatch(`routes · ${vp.name}`, vp.name)
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) noteChainWatchNavigation(frame.url())
      })
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
          // The navigation fired `framenavigated` before it timed out, so this
          // route is in the chain watch and would be reported as a SILENT
          // chain-fed capture — a machine failure wearing a transport
          // failure's diagnosis (#1971).
          forgetChainWatchPage(`${BASE_URL}${routePath}`)
          continue // never write a mislabeled PNG
        }
        await page.waitForTimeout(400) // settle late paints
        const file = path.join(OUT_DIR, `${slug(routePath)}-${vp.name}.png`)
        // Un-clips the h-screen/overflow-hidden shell so `fullPage` paints the
        // whole route, then reads the PNG back and refuses a blank one (#1738).
        try {
          const { shell } = await captureFullPage(page, {
            path: file,
            label: `${routePath} · ${vp.name}`,
            viewportDevicePx: vp.height * DEVICE_SCALE_FACTOR,
          })
          captured.push(path.relative(ROOT, file))
          if (shell.mode === SHELL_MODE.NO_SCROLL_SHELL) {
            shellless.push({ route: routePath, viewport: vp.name, height: shell.height })
          } else if (shell.raced) {
            raced.push({ route: routePath, viewport: vp.name, waitedMs: shell.waitedMs })
          }
        } catch (err) {
          // Same stance as the navigation failure above: a PNG that looks like
          // evidence and is not is worse than no PNG, so remove it rather than
          // leave it for someone to attach to a PR.
          //
          // But NEVER delete silently. The deletion, the file it removed and
          // the cause all go on the record — in the console AND in the
          // manifest — so an empty `.screenshots/` can be read as "this is why
          // there is nothing here" rather than "there was nothing to capture".
          // Was there anything to remove? A shell verdict throws before
          // `page.screenshot` runs, so reporting that one as DELETED would be
          // a small lie in the middle of the honesty this change is about.
          const written = await stat(file).then(
            () => true,
            () => false,
          )
          await rm(file, { force: true })
          deletedCaptures.push(
            describeDeletedCapture(err, {
              route: routePath,
              viewport: vp.name,
              file: path.relative(ROOT, file),
              written,
            }),
          )
          continue
        }
      }
      endChainWatch()
      await context.close()

      // Scenarios get their own context per viewport: a virtual clock and
      // scenario-specific API answers must not leak into the route captures.
      for (const scenario of scenarios) {
        const label = `scenario:${scenario.name}`
        const scenarioContext = await newFixtureContext(browser, vp, scenario)
        const scenarioPage = await scenarioContext.newPage()
        beginChainWatch(label, vp.name)
        scenarioPage.on('framenavigated', (frame) => {
          if (frame === scenarioPage.mainFrame()) noteChainWatchNavigation(frame.url())
        })
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
          // Its own failure is already on the record and already exits the run
          // 1; a silent-chain-read verdict on top would name the wrong cause
          // (#1971).
          abortChainWatch()
        }
        endChainWatch()
        await scenarioContext.close()
      }
    }
  } finally {
    await browser.close()
    teardown()
  }

  // Did the run shoot the widths it resolved? Computed BEFORE the manifest is
  // written, and recorded in it, so a contradiction between the claim and the
  // files is on the record rather than only on a console someone scrolled past.
  const viewportMismatches = findViewportMismatches(captured, captureViewports)

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
        // The widths these PNGs were ACTUALLY shot at, and where that came
        // from (#2006). Without this a 320px capture is indistinguishable from
        // a 390px one once the PNG is attached to a review thread.
        viewports: captureViewports.map(({ name, width, height }) => ({ name, width, height })),
        viewport_source: viewportSource,
        // Empty on every honest run. Non-empty means the files and the
        // `viewports` claim above disagree — see `findViewportMismatches`.
        viewport_mismatches: viewportMismatches,
        scenarios: scenarios.map((s) => s.name),
        files: captured,
        // The absences, on the record. A capture that was written and then
        // removed is a different fact from a capture that was never attempted,
        // and the manifest is the only place a later reader can tell them apart
        // (#1936/#1939/#1943).
        deleted_captures: deletedCaptures,
        // Chain reads a scenario declared `chain` for and then had no answer
        // for (#1935). Non-empty means at least one capture in this run shows a
        // surface whose on-chain data silently failed to load.
        unanswered_chain_reads: CHAIN_READ_GAPS,
        // Captures of a chain-fed route where the app issued NO chain read at
        // all (#1971) — the failure `unanswered_chain_reads` structurally
        // cannot see, because it produces no request to go unanswered.
        silent_chain_fed_captures: CHAIN_SILENT_CAPTURES,
        captured_without_unclip: shellless,
        shell_waits: raced,
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
  if (shellless.length > 0) {
    console.log(
      `\nℹ ${shellless.length} capture(s) had NO app scroll shell and were captured directly (#1939):`,
    )
    for (const e of shellless) {
      console.log(
        `  [${e.route} · ${e.viewport}] no "#main-content" on this route, and nothing is clipping ` +
          `content — the page scrolls natively (${e.height}px). Un-clipping was skipped, the PNG is complete.`,
      )
    }
  }
  if (raced.length > 0) {
    console.log(
      `\nℹ ${raced.length} capture(s) had to WAIT for the app shell to mount (ProtectedRoute race, #1936):`,
    )
    for (const e of raced) console.log(`  [${e.route} · ${e.viewport}] shell appeared after ${e.waitedMs}ms`)
  }
  for (const line of formatDeletionReport(deletedCaptures)) console.error(line)
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
  // (#1879 review). `deletedCaptures` deletes its file and exits 1; this does
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
  if (CHAIN_READ_GAPS.length > 0) {
    console.error(
      `\n✗ ${CHAIN_READ_GAPS.length} on-chain read(s) went UNANSWERED — any capture of a chain-fed ` +
        'surface in this run is showing an empty state, not the state it is filed under (#1935):',
    )
    for (const g of CHAIN_READ_GAPS) {
      console.error(`  [scenario:${g.scenario}] ${g.method} — ${g.reason}`)
    }
    console.error(
      '  (a scenario that declares `chain` owns ALL of its chain traffic — nothing is allowed out\n' +
        '   to a public node, so an undeclared read resolves to a JSON-RPC error and the hook\n' +
        '   swallows it into an empty result. Declare the method, or stop declaring `chain`.)',
    )
  }
  if (CHAIN_SILENT_CAPTURES.length > 0) {
    console.error(
      `\n✗ ${CHAIN_SILENT_CAPTURES.length} capture(s) of a CHAIN-FED route issued ZERO on-chain ` +
        'reads — the data did not arrive empty, it was never asked for (#1971):',
    )
    for (const c of CHAIN_SILENT_CAPTURES) {
      console.error(`  [${c.capture} · ${c.viewport}] ${c.route} — expected: ${c.reads}`)
    }
    console.error(
      '  (the usual cause is a fixture chain the app has no wagmi transport for. `getClient`\n' +
        "   CATCHES ChainNotConfiguredError and returns undefined, so usePublicClient is\n" +
        '   undefined and every consumer returns at its first line — silently. Check that\n' +
        `   FIXTURE_SAFE.chain_id (${FIXTURE_SAFE.chain_id}) is registered in lib/wagmi.ts, which\n` +
        '   derives its chains from SUPPORTED_CHAINS in lib/chains.ts.)',
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
  if (viewportMismatches.length > 0) {
    console.error(
      `\n✗ ${viewportMismatches.length} PNG(s) are NOT named after any viewport this run resolved ` +
        `(${captureViewports.map((vp) => vp.name).join(', ')}) — the run captured something other than ` +
        'what it was asked for, and the manifest would have claimed otherwise:',
    )
    for (const m of viewportMismatches) console.error(`  ${m.file}`)
  }
  if (
    viewportMismatches.length > 0 ||
    gotoFailures.length > 0 ||
    deletedCaptures.length > 0 ||
    CHAIN_READ_GAPS.length > 0 ||
    CHAIN_SILENT_CAPTURES.length > 0
  ) {
    process.exit(1)
  }
}

// Run only as a CLI (fixtureFor is imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('screenshot failed:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
