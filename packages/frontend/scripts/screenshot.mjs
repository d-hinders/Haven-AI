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
 * ── And the route has to have actually RENDERED (#2036) ─────────────────────
 * A capture that succeeds while showing nothing is worse than one that fails.
 * `/dashboard` was captured twice on both viewports showing the app shell and a
 * body containing only `Loading...`, and the run exited 0 — the PNGs are
 * well-formed, plausible, and filed under a name claiming they show the route.
 * Neither neighbouring guard could see it: `blank-below-fold` needs a capture
 * taller than a viewport and a loading state is short, and the shell guards ask
 * whether `#main-content` mounted — it did; the `next/dynamic` chunk inside it
 * did not. So `captureFullPage` now also demands POSITIVE evidence that the
 * route's own content region filled (`resolveContentSettled`), waits for it,
 * and on failure removes the PNG with cause `still-loading` exactly like a
 * blank one. The margin it cleared is recorded per capture in the manifest
 * under `content_settle`, so a green run says what it measured.
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
 * agents on both rails, transactions, contacts, agent activity + spend
 * stats) so
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
import net from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCaptureViewports } from './evidence-viewports.mjs'
import {
  MIN_CONTENT_CHARS,
  MIN_CONTENT_ELEMENTS,
  SCROLL_SHELL_ROOT,
  SHELL_MODE,
  busyToleranceFor,
  captureFullPage,
} from './full-page-capture.mjs'
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
 *   'still-loading'        the shell mounted, the ROUTE never did (#2036) — the
 *                          one cause whose PNG looks entirely healthy
 *   'partially-loading'    the route rendered but part of it is still loading
 *                          (#2204) — the PNG looks healthy AND clears the #2036
 *                          floor; the only tell is that it is short
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
  // #2264: the rail marker belongs on the object itself. Every consumer below
  // already spreads an explicit `account_type` over it, so this changes no
  // capture — what it removes is the raw object being a shape the backend
  // cannot serve: migration `041_hybrid_accounts.ts` declares the column NOT
  // NULL, so a `user_safes` row without one does not exist (#2202). It also
  // keeps `fixture-shape-parity.test.ts`'s strict key comparison honest now
  // that the e2e `testSafe` carries the field.
  account_type: 'delegator_hybrid',
  created_at: '2026-05-01T10:00:00.000Z',
}
// #2017 approver-badge fixture addresses. Three owners, one per branch of
// `classifyApprover`: an enrolled passkey, the user's own wallet, and an
// address Haven holds no record of.
export const APPROVER_PASSKEY = '0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2'
export const APPROVER_WALLET = '0x5B1869D9A4C187F2Eaa108F3062412ECf0526B24'
export const APPROVER_UNKNOWN = '0x9A7f6E2b1c4D8e05F3a2B9c6D1e8F40b3C5a7D91'

/**
 * `agent-ops`'s OWN account — a genuinely legacy-rail Safe (#2202).
 *
 * Why this exists rather than a second `account_type` on the shared safe:
 * `account_type` is not an agent column. Every agent-row read selects it as
 * `us.account_type` off the joined `user_safes` row
 * (`LIST_AGENTS_FOR_USER_ALL_STATUSES_SQL` and
 * `FIND_AGENT_FOR_USER_ALL_STATUSES_SQL`,
 * `infra/repositories/agents.ts:183`/`:203` with `LEFT JOIN user_safes us ON
 * a.safe_id = us.id` at `:194`/`:214`; likewise
 * `FIND_DELEGATE_AGENT_FOR_USER_SQL` at `:226-228`). ONE safe answers ONE
 * `account_type`, so three agents sharing `FIXTURE_SAFE.id` cannot report two
 * different values — which is what they did until #2202.
 *
 * And the value is `'safe'`, not `null`. Migration
 * `041_hybrid_accounts.ts:29` adds the column `VARCHAR(32) NOT NULL DEFAULT
 * 'safe'` with `CHECK (account_type IN ('safe','delegator_hybrid'))` at `:38`,
 * so `null` is not in the column's domain at all. The only way `us.account_type`
 * comes back null is the LEFT JOIN finding no row — `agents.safe_id` is
 * nullable (`000_initial.ts:209`) — and then `us.safe_address`, `us.name` and
 * `us.chain_id` are null in the SAME row. `agent-ops` populated all three while
 * claiming a null `account_type`, so its old value was impossible independently
 * of the shared-safe contradiction. `railOf` reads anything-but-`delegator_hybrid`
 * as the legacy rail (`lib/custody-rail.ts:37-38`), which is why the lie was
 * invisible: `null` and `'safe'` render identically.
 *
 * A second account is a REACHABLE state, not a workaround: `user_safes` is
 * per-user with an `is_default` flag, and the active-account switcher (#625)
 * is how a user moves between them.
 */
export const FIXTURE_LEGACY_SAFE = {
  id: 'safe-legacy-fixture',
  name: 'Imported Safe',
  safe_address: '0x3333333333333333333333333333333333333333',
  chain_id: FIXTURE_SAFE.chain_id,
  is_default: false,
  created_at: '2026-04-20T10:00:00.000Z',
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
  //
  // #2202: the legacy account is listed BESIDE it rather than replacing it.
  // `agent-ops` lives on that one, so the user really does hold the safe its
  // agent row names — the join above has a row to find, and it answers 'safe'.
  safes: [
    { ...FIXTURE_SAFE, account_type: 'delegator_hybrid' },
    { ...FIXTURE_LEGACY_SAFE, account_type: 'safe' },
  ],
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
  // #2194: agent-research's OWN delegate EOA. A SECOND address rather than a
  // reuse of `delegate` above, because the DB refuses the reuse:
  // `017_agent_connection_setups.ts:55-56` puts a partial UNIQUE index on
  // `(user_id, lower(delegate_address)) WHERE delegate_address IS NOT NULL AND
  // status != 'revoked'`, and both fixture agents are active under the one
  // FIXTURE_USER.
  researchDelegate: '0x7A3f5c1E9b2D4A86F0c7e5138D9A4b62c0e1F37d',
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
    // #2194: a REAL delegate address, and the null it replaces was not a
    // neutral placeholder — it was a state no write path can produce, which
    // silently made this agent's recovery banner unreachable in production
    // while the capture showed one.
    //
    //   Nothing can create it. Every writer of `agents.delegate_address`
    //   requires a non-null one: `POST /agents` 400s on a missing or invalid
    //   address (`routes/agents.ts:180-182`) before `INSERT_AGENT_WITH_KEY_SQL`
    //   (`infra/repositories/agents.ts:384`), and the connector path types
    //   `delegateAddress: string` on `insertPendingAgent`
    //   (`infra/repositories/agent-connection-setups.ts:378-390`). No UPDATE
    //   anywhere sets the column back to NULL — not revoke, not pause, not
    //   archive; the re-key path swaps one address for another
    //   (`infra/repositories/agent-rekeys.ts:517`). The column is nullable only
    //   because migration `000_initial.ts:40` added it to a table that already
    //   had rows, so NULL is a pre-column legacy artefact — which is what the
    //   route's 422 exists for, and what `agent-retired` below keeps carrying.
    //
    //   This agent in particular cannot be one. It is seeded with CONFIRMED
    //   x402 payment intents (`pay-1`, `pay-4`), and `payment_intents`
    //   declares `delegate_address VARCHAR(42) NOT NULL`
    //   (`000_initial.ts:82` — NOT the same-named column on the legacy
    //   `self_sign_payment_intents` table) — an intent records the delegate it
    //   was signed for. An agent that has paid provably had one.
    //
    //   What the null actually did: `routes/agents.ts:140-142` answers 422
    //   "Agent has no delegate address" for it, `useDelegateBalance`'s catch
    //   turns that into `balance = null`, and `hasRecoverableUsdc` is false —
    //   so PRODUCTION renders no "Recoverable funds" banner on this agent at
    //   all. The capture rendered one only because
    //   `/agents/:id/delegate-balance` was unkeyed in `fixtureFor` and
    //   `FIXTURE_EMPTY_FALLBACK` has no `usdc_atomic`, making `undefined !== '0'`
    //   true. Both halves are fixed together, below and in `fixtureFor`.
    delegate_address: ADDR.researchDelegate, safe_id: FIXTURE_SAFE.id,
    safe_address: FIXTURE_SAFE.safe_address, safe_name: FIXTURE_SAFE.name,
    safe_chain_id: FIXTURE_SAFE.chain_id, account_type: 'delegator_hybrid',
    api_key_prefix: 'hvn_a1b2c3', status: 'active',
    created_at: '2026-06-02T10:00:00.000Z',
    // #1878: a NAMED pair — the case multi-agent wiring exists for.
    mcp_server_name: 'haven-research',
    mcp_last_seen_at: '2026-07-10T08:12:00.000Z',
    // #2147: NOT decoration and not a second switch — the SAME open
    // `merchant_retry_rejected_after_payment` reconciliation event that gives
    // `pay-4` its `payment_attention_reason` below. Both routes that serve an
    // agent row compute this as `EXISTS(… mpre.event_type = '…' AND
    // mpre.status = 'open')` over that agent's payment intents
    // (`infra/repositories/agents.ts:186-192` list, `:206-212` single), so a
    // fixture seeding the activity row and leaving this false would claim the
    // event both exists and does not — a contradiction no backend can serve.
    // It renders `AgentCard`'s "Recoverable funds in agent wallet" notice
    // (`components/agent-panel/AgentCard.tsx`) on /agents. #2195 renamed that
    // notice from "Stranded funds on delegate" and moved its title and cause
    // clause into `lib/stranded-funds-copy.ts`, shared with the agent-detail
    // banner this same event drives.
    has_stranded_funds: true,
    // #2106: the DERIVED projection of this agent's active delegation, exactly
    // as `rails/delegation-budget-view.ts` builds it on the delegation rail
    // (250 USDC / 604800s → `allowance_amount` + `reset_period_min` in
    // minutes). Not decoration: `AgentDetailClient` derives the token list it
    // hands `DelegationBudgetCard` from THIS array, so an agent with a
    // delegation but an empty `allowances` renders its budget as raw atomic
    // units ("250000000 per week") — a state the product cannot produce,
    // because the projection is what fills the array in the first place.
    allowances: [{
      id: 'alw-research', agent_id: 'agent-research',
      token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      token_symbol: 'USDC', allowance_amount: '250.000000', reset_period_min: 10080,
    }],
  },
  {
    id: 'agent-ops', name: 'Ops agent',
    description: 'Recurring vendor payments',
    // #2202: the LEGACY-rail agent, now on a legacy-rail ACCOUNT. It used to
    // carry `account_type: null` while pointing at `FIXTURE_SAFE` — the safe
    // the two `delegator_hybrid` agents share and that `FIXTURE_USER.safes`
    // independently calls `delegator_hybrid`. All four `us.*` fields below come
    // from ONE joined row, so they must describe one account; see
    // `FIXTURE_LEGACY_SAFE` for why the value is `'safe'` and why `null` was
    // impossible rather than merely inconsistent.
    delegate_address: ADDR.delegate, safe_id: FIXTURE_LEGACY_SAFE.id,
    safe_address: FIXTURE_LEGACY_SAFE.safe_address, safe_name: FIXTURE_LEGACY_SAFE.name,
    safe_chain_id: FIXTURE_LEGACY_SAFE.chain_id, account_type: 'safe',
    api_key_prefix: 'hvn_d4e5f6', status: 'active',
    created_at: '2026-05-18T10:00:00.000Z',
    // #1878: the BARE pair, reported — must not read like the agent below,
    // which reported nothing at all.
    mcp_server_name: 'haven',
    mcp_last_seen_at: '2026-07-09T16:40:00.000Z',
    // #2224: EMPTY, and this is derived rather than chosen. A legacy-rail
    // agent's `allowances` array is filled by nothing: `GET /agents` returns
    // `agent.account_type === 'delegator_hybrid' ? derived : []`
    // (`backend/src/routes/agents.ts:92-98`), `GET /agents/:id` does the same
    // (`:113-121`), and the `agent_allowances` read surface it used to mirror
    // is RETIRED — the four LIST_* projections are deleted
    // (`infra/repositories/agents.ts:232-237`, #1440/#2020) and the write
    // routes answer 410. So the 500 USDC / daily row this used to carry was
    // path-impossible for the same reason `account_type: null` was (#2202):
    // union-legal on the wire type, emitted by nothing.
    //
    // It was also RENDERED — that is what makes it the #2205 shape rather than
    // dead data. `AgentCard.showConfiguredFallback` turned it into a budget row
    // on `/agents`, and #2224's own evidence table was built on that row. The
    // card now shows "No agent budget configured" for this agent, which is what
    // the retired rail actually looks like.
    //
    // The delegation-rail agents keep their arrays: theirs are the derived
    // projection of an active delegation, which is the one thing that fills
    // this field (see the note on `agent-research`).
    allowances: [],
  },
  {
    id: 'agent-retired', name: 'Data-feed agent',
    description: 'Paused while the vendor contract renews',
    // #2194: the null STAYS here, deliberately, and it is the only one left.
    // `routes/agents.ts:140-142` answers 422 "Agent has no delegate address"
    // for exactly this row, and `fixtureFor` now serves that 422 rather than
    // letting the generic fallback answer 200 — so both branches of
    // `useDelegateBalance` are seeded by the fixture instead of one being
    // reached by accident. See the note on `agent-research` above for why the
    // state is a pre-column legacy artefact (`000_initial.ts:40`) rather than
    // something a current write path can produce: this agent is seeded with no
    // payment intents, so nothing else contradicts it.
    delegate_address: null, safe_id: FIXTURE_SAFE.id,
    safe_address: FIXTURE_SAFE.safe_address, safe_name: FIXTURE_SAFE.name,
    safe_chain_id: FIXTURE_SAFE.chain_id, account_type: 'delegator_hybrid',
    api_key_prefix: 'hvn_g7h8i9', status: 'paused',
    created_at: '2026-04-30T10:00:00.000Z', mcp_last_seen_at: null,
    // #2106: a PAUSED agent whose on-chain delegation is still live. That
    // combination is deliberate evidence, not an oversight — pausing an agent
    // in Haven does not revoke what it signed, so `/custody` must still show
    // the budget as constraining spend. Projection matches its delegation
    // (500 USDC / 86400s), same rule as agent-research above.
    allowances: [{
      id: 'alw-retired', agent_id: 'agent-retired',
      token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      token_symbol: 'USDC', allowance_amount: '500.000000', reset_period_min: 1440,
    }],
  },
]

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
  // #2120: 0, not 1. `routes/dashboard.ts:84` hardcodes `actionableApprovals
  // = 0` (and mirrors it into `pendingApprovals`) — the queue died with the
  // AllowanceModule rail and `approval_requests` is dropped. Both fields
  // survive only for wire compatibility, so any non-zero seed here
  // photographs a number the product cannot produce.
  actionableApprovals: 0, pendingApprovals: 0,
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
    // #2120: 'confirmed', not 'executed'. `payment_intents.status` is only
    // ever written pending_signature | submitted | confirmed | failed |
    // expired; 'executed' was an `approval_requests` status, and it only
    // rendered "Sent" here because the deleted APPROVAL_STATUS map caught it.
    reason: null, status: 'confirmed', tx_hash: `0x${'a1'.repeat(32)}`,
    source: 'x402', x402_resource_url: 'https://api.example.dev/reports',
    x402_merchant_address: ADDR.merchant, chain_id: FIXTURE_SAFE.chain_id,
    safe_id: FIXTURE_SAFE.id, safe_address: FIXTURE_SAFE.safe_address, safe_name: FIXTURE_SAFE.name,
    explorer_url: `https://sepolia.basescan.org/tx/0x${'a1'.repeat(32)}`,
    // #2126: BOTH fields were fabricated. `payment_proof_status` mirrors
    // `machine_payment_evidence.proof_status`, whose only constructible values
    // are `payment_confirmed | merchant_response_observed |
    // protocol_receipt_attached` (`modules/mpp/evidence.ts:38-41`; the column
    // default is `'payment_confirmed'`, `db/migrations/014_machine_payment_evidence.ts:13`).
    // 'verified' is not one of them and no write site can produce it.
    // `payment_flow_status` is DERIVED per row by the route, never read —
    // `routes/agent-activity.ts:50-55` feeds `machinePaymentLifecycle` with
    // rail=source, paymentStatus=status, paymentProofStatus, and
    // reconciliationEventType. For rail 'x402' (in MACHINE_PAYMENT_RAILS,
    // `packages/core/src/machine-payment-lifecycle.ts:9`), status 'confirmed',
    // no reconciliation event, and a proof status that is neither
    // 'protocol_receipt_attached' nor 'merchant_response_observed' (:44-49),
    // the function falls through to `:51` and returns 'confirming_merchant'.
    confirmed_at: '2026-07-10T08:20:00.000Z', payment_proof_status: 'payment_confirmed',
    payment_flow_status: 'confirming_merchant', payment_attention_reason: null,
    created_at: '2026-07-10T08:18:00.000Z',
  },
  {
    type: 'mcp_tool_call', id: 'call-1', agent_id: 'agent-research', agent_name: 'Research agent',
    tool_name: 'haven_pay_x402_quote', payment_id: 'pay-1', result_status: 'ok',
    next_action: 'settle', error_code: null, status_code: 200,
    created_at: '2026-07-10T08:17:00.000Z',
  },
  // #2120: the `type: 'approval'` / `status: 'pending'` row that stood here is
  // deleted. `routes/agent-activity.ts` has built this list from
  // `payment_intents` + MCP tool invocations only since #2055 — the
  // approval feed entries went with the dropped table — so the row seeded an
  // activity kind no backend can emit, and every design-review capture of
  // /agents/[agentId] rendered it as an "Approval request … Needs approval".
  // #2120: a REACHABLE failure, seeded where the fabricated approval row used
  // to sit. `haven-design-reviewer` observed that with the approval row gone
  // the standing capture only ever showed success badges, so the danger tone
  // and `activityTitle`'s `status === 'failed'` branch had no rendered
  // evidence. Every field is what the route would emit for a failed intent:
  // no tx hash, no confirmation, and `payment_flow_status: null` because
  // `machinePaymentLifecycle` returns null for a non-machine rail AND for any
  // status other than 'confirmed' (packages/core/src/machine-payment-lifecycle.ts:30-35).
  {
    type: 'payment', id: 'pay-3', agent_id: 'agent-research', agent_name: 'Research agent',
    token: 'USDC', token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    amount_raw: '12000000', amount: '12.00', to: ADDR.recipient,
    reason: null, status: 'failed', tx_hash: null, source: 'api',
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
    reason: null, status: 'confirmed', tx_hash: `0x${'b2'.repeat(32)}`,  // #2120: see pay-1
    source: 'api', x402_resource_url: null, x402_merchant_address: null,
    chain_id: FIXTURE_SAFE.chain_id,
    safe_id: FIXTURE_SAFE.id, safe_address: FIXTURE_SAFE.safe_address, safe_name: FIXTURE_SAFE.name,
    explorer_url: `https://sepolia.basescan.org/tx/0x${'b2'.repeat(32)}`,
    // #2126: null, not 'paid'. `source: 'api'` is not in
    // `MACHINE_PAYMENT_RAILS` (`x402 | mpp_demo | mpp_crypto | spt`,
    // `packages/core/src/machine-payment-lifecycle.ts:9`), so the first branch
    // (`:30-32`) returns `{ paymentFlowStatus: null, … }` before any proof
    // status is consulted. A non-machine rail can NEVER carry a non-null flow
    // status — 'paid' was unreachable for this row by construction.
    confirmed_at: '2026-07-09T14:02:00.000Z', payment_proof_status: null,
    payment_flow_status: null, payment_attention_reason: null,
    created_at: '2026-07-09T14:01:00.000Z',
  },
  {
    type: 'mcp_tool_call', id: 'call-2', agent_id: 'agent-research', agent_name: 'Research agent',
    tool_name: 'haven_get_allowances', payment_id: null, result_status: 'ok',
    next_action: null, error_code: null, status_code: 200,
    created_at: '2026-07-09T11:30:00.000Z',
  },
  // #2147: the `needs_attention` state, which NO row seeded — leaving both its
  // badge AND a second rendered surface (the "Recoverable funds" banner's
  // specific copy branch, `AgentDetailClient.tsx:634-636`) unphotographed
  // anywhere in the capture suite. The mirror of #2120/#2126: those two seeded
  // states the product cannot reach; this one is a state the product CAN reach
  // that the evidence rig never rendered, so the reviewer judging that banner
  // had only ever seen half of it.
  //
  // Every field is derived from the code that produces it, not chosen to make
  // the badge appear. The state is ONE open `merchant_retry_rejected_after_payment`
  // reconciliation event — an x402 payment that settled on-chain while the
  // merchant refused the retry (`packages/sdk/src/merchant-completion.ts:127-136`
  // posts it with a literal `rail: 'x402'`) — and the reconciliation endpoint
  // that records it refuses everything else:
  //
  //   status  'confirmed' — `modules/mpp/reconciliation.ts:40-48` answers 409
  //                         ("Reconciliation events require a confirmed payment")
  //                         for any other status. Also what `machinePaymentLifecycle`
  //                         needs to get past `machine-payment-lifecycle.ts:33-35`.
  //   tx_hash  non-null   — same guard, same 409; the event stores
  //                         `payment.tx_hash.toLowerCase()` (`reconciliation.ts:73`),
  //                         so an attention row without a hash cannot exist.
  //   source  'x402'      — `COALESCE(pi.payment_rail, pi.source, 'direct')`
  //                         (`infra/repositories/agent-activity.ts:96`), and a
  //                         machine rail per `machine-payment-lifecycle.ts:9`.
  //                         The event's `rail` must equal the intent's
  //                         (`reconciliation.ts:54-58`, else 409).
  //   payment_proof_status
  //           'payment_confirmed' — the settlement-time base row writes that
  //                         literal (`infra/repositories/machine-payments.ts:49`;
  //                         column default, migration `014:13`). The only writer
  //                         that raises it is the agent-reported attach
  //                         (`modules/mpp/evidence.ts:196-200`), and on this path
  //                         the SDK throws instead of attaching
  //                         (`merchant-completion.ts:137-145`). It is also inert
  //                         for the derivation: `:37-42` returns before the
  //                         proof-status branch at `:44-49`.
  //   payment_flow_status / payment_attention_reason — NOT restated: they are
  //                         what `machinePaymentLifecycle` returns at
  //                         `machine-payment-lifecycle.ts:37-41` for the inputs
  //                         above, and `screenshot-fixture.test.ts` re-derives
  //                         them with that same shared function.
  //   explorer_url        — `routes/agent-activity.ts:78` builds it from
  //                         `tx_hash`, so a hash without a link is impossible.
  //
  // The same open event is what `LIST_AGENTS_FOR_USER_ALL_STATUSES_SQL` /
  // `FIND_AGENT_FOR_USER_ALL_STATUSES_SQL` compute `has_stranded_funds` from
  // (`infra/repositories/agents.ts:186-192`, `:206-212`), which is why
  // `agent-research` carries that flag above — one event, both consequences.
  {
    type: 'payment', id: 'pay-4', agent_id: 'agent-research', agent_name: 'Research agent',
    token: 'USDC', token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    amount_raw: '8000000', amount: '8.00', to: ADDR.merchant,
    reason: null, status: 'confirmed', tx_hash: `0x${'c3'.repeat(32)}`,
    source: 'x402', x402_resource_url: 'https://api.example.dev/datasets',
    x402_merchant_address: ADDR.merchant, chain_id: FIXTURE_SAFE.chain_id,
    safe_id: FIXTURE_SAFE.id, safe_address: FIXTURE_SAFE.safe_address, safe_name: FIXTURE_SAFE.name,
    explorer_url: `https://sepolia.basescan.org/tx/0x${'c3'.repeat(32)}`,
    confirmed_at: '2026-07-09T09:16:00.000Z', payment_proof_status: 'payment_confirmed',
    payment_flow_status: 'needs_attention',
    payment_attention_reason: 'merchant_retry_rejected_after_payment',
    created_at: '2026-07-09T09:15:00.000Z',
  },
]

// ── The delegate EOA's on-chain balance (#2194) ──────────────────────────────
//
// `GET /agents/:id/delegate-balance` (`routes/agents.ts:127-168`) is what
// `useDelegateBalance` reads and what the "Recoverable funds in agent wallet"
// banner is gated on (`AgentDetailClient.tsx:630`, via
// `hasRecoverableUsdc = Boolean(balance && balance.usdc_atomic !== '0')`,
// `hooks/useDelegateBalance.ts:88`). It was NOT keyed in `fixtureFor`, so it
// fell through to `FIXTURE_EMPTY_FALLBACK` — which carries neither
// `usdc_atomic` nor `usdc` — and `undefined !== '0'` is true. The banner
// rendered from a body with no balance in it, on an agent the real route
// would have answered 422 for. The screenshot looked exactly right; that is
// the whole difficulty of this defect class, and why the guard below asserts
// the response SHAPE rather than the rendered outcome.
//
// The amount is DERIVED, not chosen. Both fields come off the same seeded
// event that gives `agent-research` its attention row and its
// `has_stranded_funds` flag:
//
//   usdc_atomic  = the intent's `amount_raw`. On the EIP-3009 two-leg x402
//                  shape, `payTo` IS the agent's own delegate EOA — that is
//                  what selects the funding leg (`deriveFundingShape`,
//                  `modules/x402/scheme-selection.ts:56-58`) — so the Safe
//                  transfers the intent amount TO the delegate and the
//                  merchant then pulls it. On
//                  `merchant_retry_rejected_after_payment` the merchant never
//                  pulls: the SDK throws "x402 retry failed after Haven funded
//                  the delegate wallet" (`packages/sdk/src/merchant-completion.ts:137-145`)
//                  after recording the event. The funded amount stays put.
//   usdc         = the intent's `amount` (`amount_human`), and they are equal
//                  by CONSTRUCTION rather than by coincidence: the route
//                  formats with `formatTokenValue(usdcAtomic, 6)`
//                  (`routes/agents.ts:165`) and the intent's human string is
//                  `formatTokenValue(amountRaw, tokenConfig.decimals)`
//                  (`modules/x402/authorize.ts:66`) on the same atomic value
//                  and the same 6 decimals. One function, one input.
//
// `eth` / `eth_atomic` are zero. The recovery path this banner points at is
// the gasless `haven_sweep_delegate` (see `useDelegateBalance`'s own note),
// and nothing on the x402 funding leg sends native value to the delegate —
// so a delegate that has ONLY ever been funded by a rejected x402 retry holds
// USDC and nothing else. Note the human string is `'0'`, not `'0.00'`:
// `formatTokenValue` returns early on a zero raw value
// (`domain/tokens.ts:37`), and the two-decimal padding at `:44` is never
// reached.
const STRANDED_INTENT = FIXTURE_AGENT_ACTIVITY.find(
  (row) => row.payment_attention_reason === 'merchant_retry_rejected_after_payment',
)
if (!STRANDED_INTENT) {
  // A fixture that lost the attention row would otherwise seed `undefined`
  // amounts here and re-create the exact defect #2194 is about, one layer in.
  throw new Error(
    'screenshot fixture: no open merchant_retry_rejected_after_payment row in ' +
      'FIXTURE_AGENT_ACTIVITY — the delegate balance below is derived from it (#2194)',
  )
}

/** The route's 422, verbatim (`routes/agents.ts:140-142`). */
export const DELEGATE_BALANCE_NO_DELEGATE = { error: 'Agent has no delegate address' }

/**
 * Keyed by agent id. Every agent in `FIXTURE_AGENTS` has an entry, so the
 * generic fallback can never answer this endpoint again — which is the
 * mechanism that produced the bug, not just this instance of it.
 */
export const FIXTURE_DELEGATE_BALANCES = {
  // The recoverable-funds incident, and the ONLY agent that renders the banner.
  'agent-research': {
    delegate_address: ADDR.researchDelegate,
    safe_address: FIXTURE_SAFE.safe_address,
    chain_id: FIXTURE_SAFE.chain_id,
    eth: '0',
    eth_atomic: '0',
    usdc: STRANDED_INTENT.amount,
    usdc_atomic: STRANDED_INTENT.amount_raw,
    usdc_address: resolveToken(FIXTURE_SAFE.chain_id, 'USDC').address,
  },
  // A delegate that holds nothing — the ordinary steady state, and the
  // CONTROL for the row above: `hasRecoverableUsdc` is false here for the
  // reason the product says it is ('0' === '0'), not because a key is missing.
  // #2202: `safe_address` and `chain_id` follow the agent to its OWN account.
  // The route echoes `agent.safe_address` off the joined `user_safes` row
  // (`routes/agents.ts:160`) and answers `chain_id` as
  // `agent.safe_chain_id ?? DEFAULT_CHAIN_ID` (`:143`, echoed at `:161`) — the
  // coalesce never fires for a real account, which always has a chain, but the
  // read is not a bare echo and the citation should not say it is
  // (`haven-reviewer`). So this body must
  // name the safe THIS agent is on — the shared one would claim the delegate
  // belongs to an account it has nothing to do with. Caught by #2205's own
  // echoed-field guard when `agent-ops` moved, which is what that guard is for.
  'agent-ops': {
    delegate_address: ADDR.delegate,
    safe_address: FIXTURE_LEGACY_SAFE.safe_address,
    chain_id: FIXTURE_LEGACY_SAFE.chain_id,
    eth: '0',
    eth_atomic: '0',
    usdc: '0',
    usdc_atomic: '0',
    usdc_address: resolveToken(FIXTURE_LEGACY_SAFE.chain_id, 'USDC').address,
  },
  // `agent-retired` has no delegate address, so the route never reaches the
  // balance reads — it answers 422 at `routes/agents.ts:140-142`. Served as a
  // real 422 by `fixtureFor` below.
  'agent-retired': null,
}

export const FIXTURE_AGENT_STATS = {
  all_time: [{ token: 'USDC', total_spent: '482.50', tx_count: 37 }],
  today: [{ token: 'USDC', total_spent: '25.00', tx_count: 1 }],
  this_week: [{ token: 'USDC', total_spent: '109.75', tx_count: 6 }],
  // #2120: 0, not 1 — `routes/agent-activity.ts:129` hardcodes it.
  pending_approvals: 0,
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
  // `/approvals` is NOT keyed here. #1989 deleted the route and #2055
  // deregistered the backend endpoint outright — the "still a live, READABLE
  // endpoint" this fixture used to claim stopped being true with the table
  // drop. Unkeyed paths fall through to FIXTURE_EMPTY_FALLBACK (#1993).
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
  if (pathname === `/safe/${FIXTURE_LEGACY_SAFE.safe_address}/details`) {
    // #2202. `/custody` renders `SafeControlCard` for the legacy account, and
    // that card reads its owners and threshold from here (`useSafeDetails`).
    // Unkeyed, it fell to `FIXTURE_EMPTY_FALLBACK` and the card photographed
    // "Threshold: of 0" — an owner-less Safe, which is not a state a Safe can
    // be in: `000_initial.ts` never creates one, and a deployed Safe with a
    // zero threshold could not have been deployed. Same mechanism #2194/#2205
    // fixed for `/agents/:id/delegate-balance`, on the endpoint this issue's
    // own second account newly reaches — the fallback cannot say "not seeded",
    // it says 200 with the fields missing and the UI renders the gap as data.
    //
    // Two owners at threshold 2, matching what `custody-legacy-rail` seeds for
    // the same card, so the two captures of one card agree.
    return {
      address: FIXTURE_LEGACY_SAFE.safe_address,
      owners: [APPROVER_WALLET, APPROVER_UNKNOWN],
      threshold: 2,
      nonce: 12,
    }
  }
  if (pathname.startsWith('/agents/') && pathname.endsWith('/delegate-balance')) {
    // #2194. Keyed for EVERY fixture agent — the point is not that this one
    // path now answers correctly, it is that the generic fallback can no
    // longer answer it at all. `FIXTURE_EMPTY_FALLBACK` cannot say "this
    // endpoint is not seeded": it says 200 with a body that has no
    // `usdc_atomic`, and `undefined !== '0'` reads as YES.
    const agentId = pathname.slice('/agents/'.length, -'/delegate-balance'.length)
    if (!(agentId in FIXTURE_DELEGATE_BALANCES)) return null
    const balance = FIXTURE_DELEGATE_BALANCES[agentId]
    // A seeded null is the route's OWN 422, not an absent fixture. Served as a
    // real failure so the app's real error path runs — `useDelegateBalance`'s
    // catch, which turns it into "nothing to recover" (`:52-54`).
    return balance ?? httpError(422, DELEGATE_BALANCE_NO_DELEGATE)
  }
  if (pathname.startsWith('/agents/') && pathname.endsWith('/delegations')) {
    // #2106: the delegation rail's actual spend authority, as
    // `GET /agents/:id/delegations` returns it. `/custody` renders this on a
    // `delegator_hybrid` account instead of the retired AllowanceModule read,
    // so the capture has to carry both recipient states — PINNED (an
    // AllowedCalldataEnforcer caveat) and open — or the rendered review never
    // sees the branch that was wrong.
    if (pathname === `/agents/${FIXTURE_AGENTS[0].id}/delegations`) {
      return {
        delegations: [{
          id: 'dlg-1', chain_id: FIXTURE_SAFE.chain_id,
          token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          recipient_address: ADDR.merchant,
          delegation_hash: '0x' + '4d'.repeat(32),
          version: 1, status: 'active',
          budget_atomic: '250000000', period_seconds: 604_800,
          start_date: '2026-06-02T10:00:00.000Z',
          expires_at: Math.floor(Date.UTC(2027, 5, 2) / 1000),
          created_at: '2026-06-02T10:00:00.000Z',
        }],
      }
    }
    if (pathname === `/agents/${FIXTURE_AGENTS[2].id}/delegations`) {
      return {
        delegations: [{
          id: 'dlg-2', chain_id: FIXTURE_SAFE.chain_id,
          token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          recipient_address: null,
          delegation_hash: '0x' + '5e'.repeat(32),
          version: 2, status: 'active',
          budget_atomic: '500000000', period_seconds: 86_400,
          start_date: '2026-05-18T10:00:00.000Z',
          expires_at: Math.floor(Date.UTC(2027, 4, 18) / 1000),
          created_at: '2026-05-18T10:00:00.000Z',
        }],
      }
    }
    return { delegations: [] }
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
  // No `approvals` key (#2264). It was the last trace of `/approvals` in this
  // file: #1989 deleted the screen, #2055 deregistered the endpoint, and the
  // route is deliberately unkeyed in `fixtureFor` above — so no hook reads it,
  // and a collection key for an endpoint that answers 404 reads as coverage of
  // a flow the product cannot reach.
  safes: [], agents: [], transactions: [], contacts: [],
  recipients: [], delegations: [], owners: [], passkeys: [], tokens: [],
  payments: [], receipts: [], catalog: [], activity: [],
}

function slug(route) {
  return route.replace(/^\//, '').replace(/\//g, '_') || 'root'
}

export function firstLine(text) {
  return String(text).split('\n')[0].trim()
}

/**
 * The one line that says whether this run produced evidence (#2108).
 *
 * It exists because of how the harness is actually invoked. `npm run screenshot
 * ... | tail -30` reports **`tail`'s** exit code, so the shell sees 0 while the
 * run failed — a false green that has now misled several sessions, including
 * the one that filed this issue. An exit code does not survive a pipe; a line
 * of stdout does. `RESULT` is greppable on purpose, and it is the LAST thing
 * printed so a `tail` of any depth catches it.
 *
 * Pure and exported so a test can pin both colours — a formatter that can only
 * produce "ok" would restate the defect it is here to remove.
 */
export function formatRunResult(ok, detail) {
  return ok ? `screenshot: RESULT ok — ${detail}` : `screenshot: RESULT FAILED — ${detail}`
}

function printRunResult(ok, detail) {
  const line = formatRunResult(ok, detail)
  // Deliberately stdout in both cases: a reader piping to `tail` or `head` is
  // usually capturing stdout only, and the failing colour is the one they most
  // need to survive that pipe.
  console.log(line)
}

/**
 * The measured cold `next dev` compile in this repo, in seconds (#2108).
 *
 * Not a guess and not a round number: repeated first-boot runs on a worktree
 * with no `.next/` land between these two values under normal agent load. It
 * is exported because three things have to agree about it — the default
 * budget, the failure message that tells the reader what "too slow" is being
 * measured against, and the test that pins the default above it. A constant
 * that lives in one of the three and is retyped into the other two drifts.
 */
export const COLD_COMPILE_RANGE_S = { min: 315, max: 448 }

/**
 * Two budgets, because readiness is two events, not one (#2108).
 *
 * The bug this replaces was a SINGLE 90s deadline covering both, set roughly
 * 3.5–5x below the thing it was measuring, so the capture harness could not
 * succeed on a cold worktree at all. The lazy fix is a bigger constant, and it
 * is wrong in the other direction: one 500s deadline makes a dev server that
 * will NEVER come up take eight minutes to say so, and the message it finally
 * prints is the same one a slow-but-healthy compile prints.
 *
 * They are separated because the two events have different orders of
 * magnitude AND different causes:
 *
 *   listenTimeoutMs   `next dev` BINDING its port. This is process startup —
 *                     seconds, cold or warm, because binding happens before
 *                     any compilation. 90s was always the right order of
 *                     magnitude for this; it was only ever the wrong one for
 *                     the event below. Exceeding it means a startup failure,
 *                     which is a different remedy from "wait longer".
 *
 *   readyTimeoutMs    that listening server ANSWERING, which is the webpack
 *                     compile. This is the 315–448s event. The budget is
 *                     ~2.2x the measured maximum: enough headroom for a
 *                     genuinely contended machine, and affordable ONLY
 *                     because the failures that are not slowness — the
 *                     process dying, the port never opening — are detected by
 *                     progress rather than by waiting this budget out.
 *
 * Both are overridable (`SCREENSHOT_LISTEN_TIMEOUT_MS`,
 * `SCREENSHOT_READY_TIMEOUT_MS`) so a slower machine needs no code edit.
 */
export const READINESS_DEFAULTS = {
  listenTimeoutMs: 90_000,
  // Rounded to whole seconds: `COLD_COMPILE_RANGE_S.max * 2.2 * 1000` is 985600.0000000001
  // in float, and a budget that prints with a fractional millisecond invites the
  // reader to wonder what else about it is accidental.
  readyTimeoutMs: Math.round(COLD_COMPILE_RANGE_S.max * 2.2) * 1_000,
  progressIntervalMs: 15_000,
}

/**
 * A budget that cannot fit the thing it measures, named as such.
 *
 * Returns the problems as strings rather than throwing, so the same predicate
 * is usable as a warning at runtime and as an assertion in a test. It has to
 * be able to say NO for a plausible-looking number — a floor that only ever
 * says yes is the defect this whole issue is an instance of — so the test
 * feeds it the old 90_000 and requires it to object.
 */
export function readinessBudgetProblems(budgets) {
  const problems = []
  if (budgets.readyTimeoutMs < COLD_COMPILE_RANGE_S.max * 1000) {
    problems.push(
      `readyTimeoutMs=${budgets.readyTimeoutMs}ms is below the MEASURED cold \`next dev\` compile ` +
        `in this repo (${COLD_COMPILE_RANGE_S.min}–${COLD_COMPILE_RANGE_S.max}s) — a cold worktree ` +
        'will fail during compilation, for a reason that has nothing to do with the page being captured',
    )
  }
  if (budgets.listenTimeoutMs >= budgets.readyTimeoutMs) {
    problems.push(
      `listenTimeoutMs=${budgets.listenTimeoutMs}ms is not shorter than readyTimeoutMs=${budgets.readyTimeoutMs}ms — ` +
        'a dev server that never binds its port would then take the full cold-start budget to report, ' +
        'which is the failure mode the split exists to avoid',
    )
  }
  return problems
}

/**
 * Resolve the budgets from the environment. Pure in `env` so it is testable.
 *
 * A malformed override THROWS rather than falling back to the default: silently
 * ignoring `SCREENSHOT_READY_TIMEOUT_MS=6OO000` (letter O) would produce exactly
 * the confusing timeout this issue is about, with the reader certain they had
 * raised it.
 */
export function resolveReadinessBudgets(env = process.env) {
  const read = (name, fallback) => {
    const raw = env[name]
    if (raw === undefined || raw === '') return fallback
    const n = Number(raw)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error(`${name} must be a positive whole number of milliseconds; got ${JSON.stringify(raw)}`)
    }
    return n
  }
  return {
    listenTimeoutMs: read('SCREENSHOT_LISTEN_TIMEOUT_MS', READINESS_DEFAULTS.listenTimeoutMs),
    readyTimeoutMs: read('SCREENSHOT_READY_TIMEOUT_MS', READINESS_DEFAULTS.readyTimeoutMs),
    progressIntervalMs: READINESS_DEFAULTS.progressIntervalMs,
  }
}

/**
 * The failure messages, as data, in one place.
 *
 * Every one of them names the CAUSE and the REMEDY, because the message this
 * replaces named neither: "did not become ready within 90000ms" sent several
 * sessions looking for a broken page, a port collision, or Playwright — the
 * three things it was NOT. Pure and exported so the tests can pin the words a
 * reader is going to act on, rather than trusting that a message exists.
 */
export function describeReadinessFailure(kind, ctx) {
  const prewarm =
    'Or pre-warm a server yourself and point the harness at it:\n' +
    `      npm run dev -w packages/frontend -- --hostname 127.0.0.1 --port ${ctx.port ?? '<port>'}\n` +
    `      SCREENSHOT_BASE_URL=http://127.0.0.1:${ctx.port ?? '<port>'} npm run screenshot -w packages/frontend -- <route>\n` +
    '    The #1800 identity check still runs on that server, so the PNGs are still provably this worktree.'
  if (kind === 'process-exited') {
    return (
      `dev server PROCESS EXITED (code ${ctx.exitCode}) after ${ctx.elapsedS}s — this is NOT a timeout.\n` +
      `    Cause: \`npm run dev\` in ${ctx.cwdLabel ?? 'packages/frontend'} could not stay up. Nothing was ever listening on ${ctx.url}.\n` +
      '    Remedy: run that command by hand in this worktree and read its output. A missing `npm install`, an\n' +
      '    unbuilt `@haven_ai/core` (`npm run build -w packages/core`), or an occupied port are the usual reasons.'
    )
  }
  if (kind === 'never-listened') {
    return (
      `dev server never opened a socket on ${ctx.url} within ${ctx.budgetMs}ms (${Math.round(ctx.budgetMs / 1000)}s).\n` +
      '    Cause: the `next dev` process is alive but has not BOUND its port. That is a startup failure, not a slow\n' +
      `    compile — a compiling server binds its port within seconds and only then spends ${COLD_COMPILE_RANGE_S.min}–${COLD_COMPILE_RANGE_S.max}s compiling.\n` +
      '    Remedy: run `npm run dev -w packages/frontend` by hand and read its output. If this machine really is that\n' +
      '    slow to start, raise SCREENSHOT_LISTEN_TIMEOUT_MS.'
    )
  }
  if (kind === 'stopped-listening') {
    return (
      `dev server at ${ctx.url} accepted a connection and then STOPPED listening after ${ctx.elapsedS}s.\n` +
      '    Cause: the server died mid-compile — an out-of-memory kill or a crash in `next dev`, not a slow page.\n' +
      '    Remedy: run `npm run dev -w packages/frontend` by hand; the crash prints there and is discarded here\n' +
      '    (the harness spawns it with stdio ignored).'
    )
  }
  return (
    `dev server at ${ctx.url} is LISTENING but did not answer within ${ctx.budgetMs}ms (${Math.round(ctx.budgetMs / 1000)}s).\n` +
    `    Cause: a cold \`next dev\` compile in this repo measures ${COLD_COMPILE_RANGE_S.min}–${COLD_COMPILE_RANGE_S.max}s. This run exceeded even the\n` +
    '    budget above it, so the compile is either far slower than measured (a contended machine) or genuinely stuck.\n' +
    '    Remedy: raise SCREENSHOT_READY_TIMEOUT_MS.\n' +
    `    ${prewarm}`
  )
}

/**
 * The port to dial for `url`, defaulted by scheme.
 *
 * `new URL('http://127.0.0.1').port` is the empty string, and `Number('')` is
 * **0** — not NaN. `net.connect({ port: 0 })` can never succeed, so a portless
 * `SCREENSHOT_BASE_URL` would have failed with `never opened a socket` against a
 * server that was listening perfectly well: this fix's own defect class, from the
 * other side. Neither live caller can hit it today (the spawn path always builds
 * `http://127.0.0.1:${port}`, and every documented pre-warm example carries a
 * port) — but nothing forbids a portless override, so it is defaulted rather
 * than left to depend on that. Exported for the guard, because an edge this
 * quiet is only real if something drives it.
 */
export function portOf(url) {
  const parsed = new URL(url)
  if (parsed.port) return Number(parsed.port)
  return parsed.protocol === 'https:' ? 443 : 80
}

/** Is anything accepting TCP connections there? Deliberately not an HTTP request:
 *  a bare connect does not ask a compiling Next dev server to do any work. */
export function probeListeningDefault(url, timeoutMs = 2000) {
  const { hostname, port } = new URL(url)
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port: portOf(url) })
    const done = (answer) => {
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * Ask the server for an answer, but only for `timeoutMs`.
 *
 * The bound is not politeness, it is what makes progress reporting possible.
 * A `fetch` to a Next dev server that is mid-compile does not fail and does not
 * return — it HANGS until the compile finishes. An unbounded call therefore
 * parks the readiness loop inside one await for the entire compile, so nothing
 * ticks, nothing re-checks the socket, and the run is silent for five minutes:
 * exactly the "is it working or is it hung?" ambiguity #2108 is about, faithfully
 * reproduced by the code meant to remove it.
 *
 * Caught by running it, NOT by the unit tests — the injected `probeAnswering`
 * in `capture-readiness.test.ts` threw instantly, so the fake was more
 * cooperative than the real thing and the progress assertion passed against a
 * loop that could not tick in production. Hence `probeAnsweringIsBounded` below,
 * which tests the real probe rather than a stand-in.
 *
 * Re-requesting a route that is still compiling is safe: Next dev dedupes
 * compilation per route, so each attempt joins the same in-flight build.
 */
async function probeAnsweringDefault(url, timeoutMs = 10_000) {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
  return res.status
}

/**
 * Does the real answering probe give up in bounded time? Exported so the guard
 * can assert it against a socket that accepts and then says nothing forever —
 * the shape a compiling `next dev` presents. A progress ticker downstream of an
 * unbounded await is a ticker that never ticks.
 */
export async function probeAnsweringIsBounded(url, timeoutMs) {
  const startedAt = Date.now()
  try {
    await probeAnsweringDefault(url, timeoutMs)
    return { threw: false, elapsedMs: Date.now() - startedAt }
  } catch {
    return { threw: true, elapsedMs: Date.now() - startedAt }
  }
}

/**
 * Wait for the spawned dev server, measuring PROGRESS rather than only a deadline (#2108).
 *
 * The sequence, and why each step is a step:
 *
 *   1. The child process is watched THROUGHOUT. If it exits, the wait ends
 *      immediately with `process-exited` — a dead server is reported in
 *      seconds, whatever budget was configured. This is what makes a large
 *      cold-compile budget affordable.
 *   2. Phase A waits for the port to accept a connection, on the SHORT budget.
 *      Binding is startup, not compilation.
 *   3. Phase B waits for that listening server to answer, on the LONG budget,
 *      and re-checks the socket between attempts so a mid-compile crash is
 *      reported as `stopped-listening` rather than waiting the budget out.
 *   4. Progress is printed on a fixed interval in both phases, so a five-minute
 *      wait is visibly a wait. The old version printed nothing for 90 seconds
 *      and then failed, which is indistinguishable from a hang and is part of
 *      why this kept being misdiagnosed.
 *
 * Every collaborator is injectable so the phases are testable without a real
 * server: a readiness check that can only be exercised by waiting five minutes
 * for a real compile is a check nobody runs.
 */
export async function waitForServer(url, opts = {}) {
  const {
    child = null,
    budgets = resolveReadinessBudgets(),
    probeListening = probeListeningDefault,
    probeAnswering = probeAnsweringDefault,
    pollIntervalMs = 1000,
    sleepFn = sleep,
    now = Date.now,
    log = console.log,
    cwdLabel,
  } = opts

  const port = (() => {
    try {
      return new URL(url).port || undefined
    } catch {
      return undefined
    }
  })()
  const started = now()
  const elapsedS = () => Math.round((now() - started) / 1000)
  let lastProgressAt = started
  const progress = (line) => {
    if (now() - lastProgressAt < budgets.progressIntervalMs) return
    lastProgressAt = now()
    log(`screenshot: ${line} (${elapsedS()}s elapsed)`)
  }
  const fail = (kind, ctx) => {
    const err = new Error(describeReadinessFailure(kind, { url, port, cwdLabel, elapsedS: elapsedS(), ...ctx }))
    err.readinessFailure = kind
    return err
  }
  // `exitCode` is non-null once the child has exited; `signalCode` covers a kill.
  const childDead = () => child && (child.exitCode !== null || child.signalCode != null)

  // Phase A — did it bind a port?
  const listenDeadline = started + budgets.listenTimeoutMs
  let listening = false
  while (now() < listenDeadline) {
    if (childDead()) throw fail('process-exited', { exitCode: child.exitCode ?? child.signalCode })
    if (await probeListening(url)) {
      listening = true
      break
    }
    progress(`waiting for \`next dev\` to bind ${url}`)
    await sleepFn(pollIntervalMs)
  }
  if (!listening) {
    if (childDead()) throw fail('process-exited', { exitCode: child.exitCode ?? child.signalCode })
    throw fail('never-listened', { budgetMs: budgets.listenTimeoutMs })
  }
  log(
    `screenshot: dev server is listening on ${url} after ${elapsedS()}s — now waiting for the first compile ` +
      `(measured cold: ${COLD_COMPILE_RANGE_S.min}–${COLD_COMPILE_RANGE_S.max}s, budget ${Math.round(budgets.readyTimeoutMs / 1000)}s)`,
  )

  // Phase B — is it answering?
  const readyDeadline = started + budgets.readyTimeoutMs
  while (now() < readyDeadline) {
    if (childDead()) throw fail('process-exited', { exitCode: child.exitCode ?? child.signalCode })
    try {
      const status = await probeAnswering(url)
      if (status < 500) {
        log(`screenshot: dev server answered ${status} after ${elapsedS()}s`)
        return
      }
    } catch {
      /* still compiling, or the connection was dropped — the socket check below decides which */
    }
    if (childDead()) throw fail('process-exited', { exitCode: child.exitCode ?? child.signalCode })
    if (!(await probeListening(url))) throw fail('stopped-listening', {})
    progress('dev server is listening and still compiling — this is the cold `next dev` compile, not a hang')
    await sleepFn(pollIntervalMs)
  }
  throw fail('not-answering', { budgetMs: budgets.readyTimeoutMs })
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
/**
 * Declared-tolerant captures that held no busy element — the declaration is
 * stale, and that FAILS THE RUN (#2204).
 *
 * The registry itself lives in `full-page-capture.mjs` beside the guard, not
 * here: `captureFullPage` has TWO consumers (this CLI and
 * `e2e/capture-integrity.spec.ts`), and the first draft kept the exemption in
 * the CLI only — so the spec captured `/design-system` with no tolerance at
 * all and CI refused it. An exemption that one caller knows about is not an
 * exemption, it is a divergence. `busyToleranceFor` is now derived from the
 * page's own URL inside `captureFullPage`, so a third consumer cannot forget it.
 */
export const STALE_BUSY_DECLARATIONS = []

export const CHAIN_FED_ROUTES = [
  {
    pattern: /^\/agents(\/|$)/,
    reads: 'useOnChainAllowances — via useAgentPanelState (AgentPanel, unmanaged-delegate ' +
      'discovery) and AgentDetailClient/EditAgentModal (the budget list)',
  },
  {
    pattern: /^\/custody(\/|$)/,
    reads: 'useOnChainAllowances — SafeControlCard reads the module and delegates at render',
    // #2106: `/custody` became CONDITIONALLY chain-fed. It renders one of two
    // cards per account, and only the legacy Safe one mounts
    // `useOnChainAllowances`; the delegation-rail card reads
    // `/accounts/hybrid/:address/signers` and `/agents/:id/delegations` over
    // the API and touches the chain not at all. So on an all-delegation-rail
    // account — which, since #1984, is every new account — zero chain reads is
    // the CORRECT observation, not the empty-surface defect this guard exists
    // to catch.
    //
    // The route stays listed rather than being deleted: the legacy branch
    // still reads at render, and dropping the entry would retire the guard for
    // the rail that still needs it. Instead a capture may declare itself
    // legitimately silent, and must say which rail makes it so.
    silentWhen: 'every account rendered is on the delegation rail (account_type ' +
      "'delegator_hybrid'), whose card issues no chain read",
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

/**
 * End the watch and report every chain-fed page that issued no read.
 *
 * `expectedSilentRoutes` (#2106) lets ONE capture declare that a specific
 * chain-fed route is legitimately silent for it. It exists because `/custody`
 * stopped being unconditionally chain-fed: it renders a per-account card, and
 * only the legacy Safe branch reads the chain at render.
 *
 * Deliberately narrow, so it cannot become a way to wave the guard through:
 *
 *  - It is per capture AND per route — never a global flag, and never "this
 *    scenario reads no chain at all".
 *  - The route must still be declared chain-fed AND carry a `silentWhen`
 *    reason, so the exemption is anchored to a written explanation of which
 *    state makes silence correct rather than to a bare boolean.
 *  - A declared-silent route that DID read is reported too (below). That
 *    direction matters as much: it catches the day the delegation card starts
 *    reading the chain and this declaration quietly stops being true.
 */
export function endChainWatch(expectedSilentRoutes = []) {
  const watch = chainWatch
  chainWatch = null
  if (!watch) return
  const expected = (pathname) =>
    expectedSilentRoutes.some((p) => (p instanceof RegExp ? p.test(pathname) : p === pathname))
  for (const [pathname, page] of watch.pages) {
    const declaredSilent = expected(pathname)
    if (page.observed > 0) {
      if (declaredSilent) {
        CHAIN_SILENT_CAPTURES.push({
          capture: watch.label,
          viewport: watch.viewport,
          route: pathname,
          reads: page.reads,
          unexpectedRead: `declared chain-silent, but issued ${page.observed} read(s) ` +
            `(${[...page.methods].join(', ')}) — the declaration is stale`,
        })
      }
      continue
    }
    if (declaredSilent) continue
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
  // ── The lever that makes the #2204 race happen on demand ──────────────────
  //
  // A guard that has only ever been seen to pass is not evidence. This
  // reproduces the genuinely-unpainted page the busy check exists to refuse:
  // it stalls each JSON-RPC read CLIENT-SIDE, before the request is issued.
  //
  // The stall has to be on THIS side of the wire, and finding that out cost a
  // diagnosis worth recording. Delaying the ANSWER (inside the route handler)
  // reproduces nothing at all: the request is in flight the whole time, so
  // `waitUntil: 'networkidle'` simply waits it out and the capture is correct
  // — measured at 500 / 2000 / 6000ms, all three came back at the healthy
  // 1936px. Stalling BEFORE the fetch leaves the page creates a window with no
  // in-flight request, `networkidle` fires into it, and the shutter lands on
  // `useOnChainAllowances` still loading. That is also the real mechanism: the
  // hook issues four SEQUENTIAL reads, and under load the client-side gap
  // between two of them can exceed networkidle's 500ms threshold on its own —
  // which is why the bad run is 1 in 4 on a busy machine and 0 in 10 on an
  // idle one.
  //
  // Diagnostic only, and it says so: it is off unless asked for, and it is
  // deliberately not a `scenario` field, because nothing committed should ever
  // capture through it.
  const chainStallMs = Number(process.env.SCREENSHOT_CHAIN_STALL_MS ?? 0)
  if (chainStallMs > 0) {
    await context.addInitScript((ms) => {
      const original = window.fetch
      window.fetch = async (input, init) => {
        const body = typeof init?.body === 'string' ? init.body : ''
        if (body.includes('"jsonrpc"')) {
          await new Promise((resolve) => setTimeout(resolve, ms))
        }
        return original(input, init)
      }
    }, chainStallMs)
  }

  const seeded = scenario?.seed?.()
  if (seeded) {
    await context.addInitScript((entries) => {
      for (const [key, value] of entries) window.localStorage.setItem(key, value)
    }, Object.entries(seeded))
  }

  // A CONNECTED wallet, through the real wagmi path (#2073). Same posture as
  // `scenario.seed()` above: this stubs the BROWSER-side seam the product
  // reads (an EIP-1193 provider on `window.ethereum`), so wagmi's own
  // `injected()` connector reconnect, `useAccount`, `useSafeOperationGate`
  // and the header render are all real. The two seeded wagmi keys are what
  // lets the targetless injected connector reconnect on mount
  // (`isAuthorized` requires `injected.connected`; `recentConnectorId` puts
  // it first). Nothing above the provider is forced. Declare
  // `connectedWallet: '0x…'` on a scenario to use it; the stub answers only
  // the read methods a mounted app needs, and throws loudly on anything else
  // so a scenario that starts SIGNING fails instead of hanging.
  if (scenario?.connectedWallet) {
    await context.addInitScript(
      ({ addr, chainIdHex }) => {
        window.localStorage.setItem('wagmi.injected.connected', 'true')
        window.localStorage.setItem('wagmi.recentConnectorId', '"injected"')
        const provider = {
          isMetaMask: true,
          request: async ({ method }) => {
            if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [addr]
            if (method === 'eth_chainId') return chainIdHex
            if (method === 'net_version') return String(parseInt(chainIdHex, 16))
            throw new Error(`screenshot wallet stub: unanswered method ${method}`)
          },
          on: () => {},
          removeListener: () => {},
        }
        Object.defineProperty(window, 'ethereum', { value: provider, configurable: true })
      },
      {
        addr: scenario.connectedWallet,
        chainIdHex: `0x${FIXTURE_SAFE.chain_id.toString(16)}`,
      },
    )
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
    // #2194: the SAME `instanceof` check the scenario branch above makes, for
    // the same reason and one layer down. `fixtureFor` can now seed a route's
    // own failure (the delegate-balance 422), and `json()` would serve that
    // marker object as a 200 whose body happens to have an `error` key — a
    // fixture that looks like it is seeding an error state and is not.
    if (populated instanceof ScenarioHttpError) {
      return route.fulfill({
        status: populated.status,
        contentType: 'application/json',
        body: JSON.stringify(populated.body),
      })
    }
    if (populated !== null) return json(populated)
    // Anything unkeyed → a benign empty shape carrying every collection
    // key the hooks read, so a missing key never throws (e.g. a hook that
    // reads `.contacts`, which it then `.filter`s).
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
// On the shared fixture's own chain (84532), seeded from the shared fixture's
// own agent. `agent-ops` is the one fixture agent on the LEGACY rail with a
// `delegate_address`, and both are required: `EditAgentModal` hides the whole
// budget half on `delegator_hybrid` (#1079, `showBudgetFields`) and
// `useOnChainAllowances` keys its map by delegate.
//
// #2202: the rail marker is `account_type: 'safe'`, not `null` — migration
// `041_hybrid_accounts.ts:29` makes the column `NOT NULL DEFAULT 'safe'` under
// `CHECK (account_type IN ('safe','delegator_hybrid'))`, so `null` was never a
// value a `user_safes` row could hold. These rows now hang off `agent-ops`'s
// OWN account (`FIXTURE_LEGACY_SAFE`) rather than off the shared
// `delegator_hybrid` one, which is the account that actually has an
// AllowanceModule.
//
// #2224: the USDC row used to be justified as MATCHING `agent-ops`'s API
// allowance (500.000000 / 1440min) so the two would not photograph a
// contradiction where they render side by side. That reason is retired with
// the row: a legacy-rail agent's `allowances` array is `[]` on every read
// (`backend/src/routes/agents.ts:92-98`, `:113-121`), so there is no API figure
// left to agree or disagree with, and this is now the SOLE source for the
// legacy account's budget — it is what `/custody`'s AllowanceModule table
// renders. The numbers are kept rather than re-picked so the committed
// captures do not move for a reason unrelated to what changed; the guard that
// used to cross-check them against the API now pins them against this
// declaration, which is what it was always really proving.
//
// The delegate set is exactly the managed one — seeding a stranger here would
// render an "unmanaged delegate" warning in every capture.
//
// ── Why `agent-research`'s delegate is NOT here (#2194) ──────────────────────
//
// It has one now, and it still does not belong in this list. `getDelegates` is
// the AllowanceModule's own registry — written by `addDelegate` on the LEGACY
// Safe rail, which #1440/#2020 retired. A `delegator_hybrid` agent's spend
// authority is a delegation grant (`GET /agents/:id/delegations`), and nothing
// ever registers its delegate with the module. `agent-ops` is the one fixture
// agent on that legacy rail (`account_type: 'safe'`, #2202), so it is the one
// entry — and since #2202 the list hangs off ITS account, not the shared one.
//
// This is not a technicality about a registry nobody reads. `useOnChainAllowances`
// keys its map off THIS list, not off the `managedDelegates` argument
// (`hooks/useOnChainAllowances.ts:110-127`), and `AgentPanel.tsx:174-176` hands
// each card `onChainData.get(delegateKey)?.allowances`. Adding `agent-research`
// here would therefore render an AllowanceModule budget on its card — and
// `makeAllowanceChainFixture` answers `getTokenAllowance` from `rows` WITHOUT
// consulting the delegate argument, so the budget it rendered would be
// `agent-ops`'s 500 USDC / daily, next to its own 250 USDC / weekly delegation.
// Two spend limits for one agent, from two retired-and-live rails at once.
//
// Absent, `onChainData.get()` returns undefined and the card renders no
// AllowanceModule row, which is what the delegation rail actually looks like.
// No unmanaged-delegate warning either: `useAgentPanelState.ts:261-271`
// subtracts the MANAGED set from the on-chain one, and a delegate that is not
// on-chain cannot be in that difference. `chain-fed-capture-guard.test.ts`
// pins both halves.
export const SHARED_CHAIN_ROWS = [
  {
    token: resolveToken(FIXTURE_SAFE.chain_id, 'USDC').address,
    amount: 500_000000n,
    spent: 137_500000n,
    resetTimeMin: 1440,
  },
]
/**
 * The SHARED account's chain answers — a delegation-rail account, answered as one.
 *
 * #2202 moved `agent-ops` and its AllowanceModule off this account, and that
 * settled a question #2106 had already raised and worked around. `FIXTURE_SAFE`
 * is `delegator_hybrid`; a Hybrid DeleGator is not a Safe and has no
 * AllowanceModule, so `isModuleEnabled → true` is a state this account cannot
 * reach. `custody-delegation-rail` said exactly that ("The shared chain fixture
 * answers true — correct for the legacy Safe every other capture seeds, and
 * impossible here") and overrode it scenario-locally, because while `agent-ops`
 * claimed `account_type: null` there appeared to be a legacy account behind the
 * shared safe. There is not, and now it says so.
 *
 * `useOnChainAllowances` still ISSUES the `isModuleEnabled` read and then
 * returns early, so `/agents` remains a genuinely chain-fed capture rather than
 * a silent one — the read happens and is answered, it just answers "no module".
 */
// BOTH accounts, because a capture reads both. `/custody` renders one card per
// account (#2106) and only the legacy card mounts `useOnChainAllowances`, so a
// single-account answer throws on the other address and fails the run — which
// is how this was found rather than reasoned about.
export const answerSharedChainRead = makeAllowanceChainFixture({
  chainId: FIXTURE_SAFE.chain_id,
  accounts: [
    // The delegation-rail account: no module, and therefore no delegates or
    // rows to reach — `useOnChainAllowances` returns after the first read.
    { safeAddress: FIXTURE_SAFE.safe_address, delegates: [], rows: [], moduleEnabled: false },
    // `agent-ops`'s legacy Safe: the one that really has an AllowanceModule.
    {
      safeAddress: FIXTURE_LEGACY_SAFE.safe_address,
      delegates: [ADDR.delegate],
      rows: SHARED_CHAIN_ROWS,
    },
  ],
})

/**
 * The LEGACY account's chain answers, for whichever Safe address is on the
 * legacy rail in a given scenario (#2202).
 *
 * One factory call parameterised by the safe, because two scenarios need the
 * same legacy answers at two different addresses: `agents-legacy-rail` seeds
 * `agent-ops`'s own `FIXTURE_LEGACY_SAFE`, and `custody-legacy-rail` re-rails
 * the SHARED account and so needs them at `FIXTURE_SAFE`'s address.
 * `makeAllowanceChainFixture` checks the call's `to` against the address it was
 * built for, so a single shared instance would throw for one of them rather
 * than quietly answer the wrong account.
 */
export const legacyRailChainFor = (safe) =>
  makeAllowanceChainFixture({
    chainId: safe.chain_id,
    safeAddress: safe.safe_address,
    delegates: [ADDR.delegate],
    rows: SHARED_CHAIN_ROWS,
  })

/**
 * `agent-ops`'s own account alone.
 *
 * Exported for `chain-fed-capture-guard.test.ts`, which asserts the legacy
 * answers in isolation. Scenarios do NOT need it: `answerSharedChainRead`
 * above already answers for both of the fixture's accounts, so a scenario that
 * only changes which one is ACTIVE inherits the right answers.
 */
export const answerLegacyRailChainRead = legacyRailChainFor(FIXTURE_LEGACY_SAFE)

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

// #2202: derived from the LEGACY account, not from the shared `delegator_hybrid`
// one. This scenario photographs `EditAgentModal`'s AllowanceModule budget list,
// which `showBudgetFields` renders only for a NON-`delegator_hybrid` agent
// (#1079) — so the account behind it has to be the legacy one or the capture is
// of an empty modal. It used to inherit `FIXTURE_SAFE`, which carries no
// `account_type` at all and therefore read as legacy only by `railOf`'s
// "anything else" fallback (`lib/custody-rail.ts:37-38`). The rail is now
// stated rather than fallen into.
const BUDGET_FIXTURE_SAFE = {
  ...FIXTURE_LEGACY_SAFE,
  chain_id: BUDGET_CHAIN_ID,
  account_type: 'safe',
}

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
  /**
   * #2043: the agent list with NOTHING unrecorded — the note's absent half.
   *
   * The present half needs no scenario: the shared fixture's `agent-retired`
   * carries no `mcp_server_name` at all, so the plain `/agents` route capture
   * already shows the hoisted explanation. The conditional IS the design, and
   * a capture that only ever shows the note present proves half of it — a
   * note that rendered unconditionally would look identical.
   *
   * ── Why this override is reachable, per field (#2205/#2227/#2233) ────────
   *
   * Only ONE field changes, and only on `agent-retired`:
   *
   * | field | value | why the product can produce it |
   * |---|---|---|
   * | `mcp_server_name` | `'haven-data-feed'` | `normalizeMcpServerName` accepts it: 15 chars (≤64) and matching `/^haven(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/` (`backend/src/routes/agent-connection-setups.ts:143-149`). Written once at `POST /agent-connection-setups/register`. |
   *
   * The combination with this agent's OTHER fields is reachable too, which is
   * the check #2233 was filed over:
   *
   * | co-field | value | compatible because |
   * |---|---|---|
   * | `mcp_last_seen_at` | `null` | the name is written at REGISTRATION; `mcp_last_seen_at` is written by MCP tool calls. An agent wired with a current connector that has not yet called a tool has exactly this pair. |
   * | `status` | `'paused'` | pausing is a Haven-side status flip; it neither writes nor clears `mcp_server_name` (`infra/repositories/agents.ts:472-481` — "This UPDATE never touches mcp_server_name"). |
   * | `delegate_address` | `null` | orthogonal: a pre-column legacy artefact on this agent, unrelated to the wiring label. Unchanged from the shared fixture. |
   *
   * Nothing else in `FIXTURE_AGENTS` is touched: `agent-research` and
   * `agent-ops` already carry recorded names, which is why they are not
   * overridden here.
   */
  'mcp-name-all-recorded': {
    description:
      'The /agents list with every agent reporting an MCP server name — the hoisted "not recorded" explanation must be ABSENT (#2043)',
    api(apiPath) {
      if (apiPath === '/agents') {
        return {
          agents: FIXTURE_AGENTS.map((a) =>
            a.mcp_server_name ? a : { ...a, mcp_server_name: 'haven-data-feed' },
          ),
        }
      }
      return undefined
    },
    async run({ page, vp, shoot }) {
      await page.goto(`${BASE_URL}/agents`, { waitUntil: 'networkidle', timeout: 60_000 })
      await dismissMobileSidebar(page, vp)

      // Wait for EVERY card, not the first: the claim is about the whole list,
      // so a capture that raced the third card would be evidence of nothing —
      // and "no note" is exactly what a half-rendered list also looks like.
      for (const name of ['Research agent', 'Ops agent', 'Data-feed agent']) {
        await page.getByText(name, { exact: true }).first().waitFor({ timeout: 20_000 })
      }
      // Positive control for the absence: the three recorded names are on
      // screen, so the list really did render its MCP row.
      await page.getByText('haven-data-feed', { exact: true }).first().waitFor({ timeout: 20_000 })

      await shoot(page.locator('main').first(), 'list')
    },
  },
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
          // #2120: `approval.status` is `agent_connection_setups.approval_status`,
          // written only as 'not_started' | 'submitted' | 'proposed' | 'confirmed'.
          approval: { status: 'not_started', safe_tx_hash: null, tx_hash: null },
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
          // #2120: `approval.status` is `agent_connection_setups.approval_status`,
          // written only as 'not_started' | 'submitted' | 'proposed' | 'confirmed'.
          approval: { status: 'not_started', safe_tx_hash: null, tx_hash: null },
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
          // #2120: see above — 'active' is not a producible approval_status.
          approval: { status: 'confirmed', safe_tx_hash: null, tx_hash: null },
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
  'wrong-wallet': {
    description:
      'The wrong-wallet gate state (#2073): a hydrated hybrid signer set naming an EOA owner, a connected wallet that is NOT it — the header Wrong wallet pill and its popover',
    // ── Why this scenario exists ─────────────────────────────────────────────
    //
    // #2068 made the signer gate fail closed for an unrelated wallet, and
    // #2072's design review recorded that none of the states it re-routes was
    // capturable: the gate reads a localStorage-hydrated signer set AND a
    // wagmi-connected wallet, and the harness could express the first
    // (`scenario.seed`) but not the second. `connectedWallet` (the #2073 seam
    // in `newFixtureContext`) is the missing input. Everything above the
    // stubbed provider is the product's own code: wagmi reconnects the
    // injected connector, `useSafeOperationGate` compares the connected
    // address to the set's `owner_address`, and the header renders the
    // mismatch. The signer set arrives through the REAL hydration path — the
    // api() override below is what `AuthContext` reads and writes to the
    // device store; nothing seeds the store directly.
    connectedWallet: '0x' + '99'.repeat(20), // ≠ the owner below, by construction
    api(apiPath) {
      if (apiPath.startsWith('/accounts/hybrid/') && apiPath.endsWith('/signers')) {
        // Owner-only set: an EOA owner, zero enrolled passkeys — #2068's
        // shape, where the connected wallet's identity is the whole answer.
        return {
          account_address: FIXTURE_SAFE.safe_address,
          chain_id: FIXTURE_SAFE.chain_id,
          owner_address: '0x' + 'ee'.repeat(20),
          passkeys: [],
        }
      }
      return undefined
    },
    async run({ page, vp, shoot }) {
      await page.goto(`${BASE_URL}/dashboard`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      })
      await dismissMobileSidebar(page, vp)

      // The header names the mismatch. Waiting on the accessible name pins
      // the state through the real path — reconnect, hydration, gate — and a
      // run where the normal address pill renders instead FAILS here rather
      // than photographing the silent-disagreement defect as evidence.
      const pill = page.getByRole('button', { name: 'Wrong wallet' })
      await pill.waitFor({ timeout: 30_000 })
      const header = page.locator('header').first()
      await shoot(header, 'header-pill')

      // The fix is one click away: the wallet menu with Switch wallet.
      await pill.click()
      const popover = page.getByRole('dialog', { name: 'Wallet menu' })
      await popover.waitFor({ timeout: 15_000 })
      await popover.getByRole('button', { name: 'Switch wallet' }).waitFor({ timeout: 15_000 })
      // The mismatch note (design-review finding on #2073): the popover must
      // not photograph identical to the healthy connected state.
      await popover
        .getByText('This is not the wallet that controls this account', { exact: false })
        .waitFor({ timeout: 15_000 })
      await shoot(popover, 'popover')
    },
  },
  'custody-delegation-rail': {
    description: '/custody rendered for a DELEGATION-rail account (#2106)',
    // The account the shared fixture already describes (`account_type:
    // 'delegator_hybrid'`), but with the chain answering HONESTLY for that
    // rail: a Hybrid DeleGator has no AllowanceModule, so `isModuleEnabled`
    // is FALSE. The shared chain fixture answers true — correct for the
    // legacy Safe every other capture seeds, and impossible here.
    //
    // That distinction is the whole point of this scenario. A plain route
    // capture of `/custody` inherits the shared `true` and photographs a
    // delegation-rail account being told its spend control is the Safe
    // AllowanceModule — which is a real defect, but NOT the one #2106
    // describes, and it hides the two sentences the issue is actually about
    // ("AllowanceModule not enabled" / "No on-chain agent allowances on this
    // Safe"). Those only render when the module reads false, so the before/
    // after pair has to be taken here or it proves nothing.
    //
    // `moduleEnabled: false` makes `useOnChainAllowances` return early, so no
    // delegate or allowance read is reached and none needs seeding.
    chain: makeAllowanceChainFixture({
      chainId: FIXTURE_SAFE.chain_id,
      safeAddress: FIXTURE_SAFE.safe_address,
      delegates: [],
      rows: [],
      moduleEnabled: false,
    }),
    // The delegation-rail card mounts no chain hook at all — its proof comes
    // from `/accounts/hybrid/:address/signers` and `/agents/:id/delegations`.
    // Zero reads on `/custody` is therefore the correct observation HERE, and
    // only here: the legacy scenario below leaves the guard armed, and if this
    // card ever starts reading the chain the declaration is reported as stale.
    expectedSilentRoutes: [/^\/custody(\/|$)/],
    api() {
      return undefined
    },
    async run({ page, vp, shoot }) {
      await page.goto(`${BASE_URL}/custody`, { waitUntil: 'networkidle', timeout: 60_000 })
      await dismissMobileSidebar(page, vp)
      // Wait on the page's own heading rather than either branch's copy: this
      // scenario is run against BOTH the pre-fix and post-fix page, so a wait
      // keyed to one branch's wording would fail half the pair by design.
      await page.getByRole('heading', { name: 'Custody', level: 1 }).waitFor({ timeout: 30_000 })
      await shoot(page.locator('#main-content'), 'page')
    },
  },
  'custody-legacy-rail': {
    description: '/custody rendered for a LEGACY Safe-rail account (#2106)',
    // #2106 rail-branches `/custody` on `account_type`. The DELEGATION branch
    // is what a plain `npm run screenshot -- /custody` captures, because the
    // shared fixture's account is `delegator_hybrid`. The legacy branch is
    // therefore unreachable by route capture, and "the other branch is
    // unchanged" is exactly the claim that needs a picture rather than an
    // argument by symmetry — so this scenario puts the same account on the
    // other rail and shoots the same page.
    //
    // Only `/auth/me`, `/user/safes` and the Safe details read are overridden.
    //
    // #2202: the chain answer is no longer INHERITED. It used to be, because
    // `answerSharedChainRead` answered `isModuleEnabled` → true — but it
    // answered that for the shared `delegator_hybrid` account, which cannot
    // have an AllowanceModule at all. That was the chain-side half of the same
    // contradiction, and #2106 had already recorded it as impossible while
    // working around it in `custody-delegation-rail`. The shared answer now
    // says "no module", so this scenario states its own legacy answers
    // explicitly — at `FIXTURE_SAFE`'s address, because it re-rails the SHARED
    // account rather than switching to `agent-ops`'s.
    chain: legacyRailChainFor(FIXTURE_SAFE),
    api(apiPath) {
      const legacySafe = { ...FIXTURE_SAFE, account_type: 'safe' }
      if (apiPath === '/auth/me') return { ...FIXTURE_USER, safes: [legacySafe] }
      if (apiPath === '/user/safes') return { safes: [legacySafe] }
      if (apiPath.startsWith(`/safe/${FIXTURE_SAFE.safe_address}/details`)) {
        // Two owners, threshold 2 — the owners/threshold proof is the part of
        // this page that was ALWAYS true on this rail, so the capture has to
        // show it populated rather than the empty-fallback "— / 0".
        return {
          address: FIXTURE_SAFE.safe_address,
          owners: [APPROVER_WALLET, APPROVER_UNKNOWN],
          threshold: 2,
          nonce: 12,
        }
      }
      return undefined
    },
    async run({ page, vp, shoot }) {
      await page.goto(`${BASE_URL}/custody`, { waitUntil: 'networkidle', timeout: 60_000 })
      await dismissMobileSidebar(page, vp)
      // Wait on the legacy branch's OWN copy, not on a generic heading: a run
      // that somehow served the delegation branch fails here instead of
      // shooting the wrong card under this scenario's name.
      await page
        .getByText('Owners (control this Safe — Haven is not one)', { exact: false })
        .waitFor({ timeout: 30_000 })
      await shoot(page.locator('#main-content'), 'page')
    },
  },
  'agents-legacy-rail': {
    description:
      '/agents with the LEGACY account active — AgentCard\'s Revoke affordance and the on-chain AllowanceModule row (#2202)',
    // ── Why this scenario had to exist before #2202 could be fixed ───────────
    //
    // `agent-ops` used to claim `account_type: null` while pointing at the
    // shared `delegator_hybrid` safe. That impossible value was doing real
    // work: `AgentCard.tsx:63` derives `isDelegationAgent` from it, and the
    // rail decides which shutdown control the card offers — `Revoke` (the
    // AllowanceModule teardown, `:349`) on the legacy rail, `Remove` (#1402,
    // `:366`) on the delegation rail. A plain `/agents` capture photographed
    // BOTH, from one account, because one of the three agents was lying.
    //
    // Giving `agent-ops` its own legacy account fixes the contradiction, but
    // it does not by itself keep that evidence: `Revoke` also needs
    // `canUseWalletActions`, which `AgentPanel.tsx:196` binds to
    // `agentUsesActiveSafe` — an agent's wallet controls are gated to the
    // ACTIVE account (`useAgentPanelState.ts:220-235`). So on a default
    // capture, where the delegation account is active, `agent-ops` correctly
    // renders as an off-active-account agent and the legacy control is absent.
    //
    // The honest way to keep the branch photographed is therefore to reach it
    // the way a user does: SWITCH ACCOUNTS. That is what this scenario is —
    // the same coherent fixture, seen from the other account, which is exactly
    // what the account switcher (#625) exists for.
    //
    // Note what it does NOT override: no `api` hook at all. The fixture
    // already serves both accounts on `/auth/me` and all three agents on
    // `/agents`, so switching the active-account key is sufficient. A scenario
    // that had to restate the agent list to make this render would be evidence
    // that the fixture still disagreed with itself.
    seed: () => ({ [SEED_STORAGE_KEYS.activeSafe]: FIXTURE_LEGACY_SAFE.id }),
    // No `chain` override either: `answerSharedChainRead` answers for BOTH of
    // the fixture's accounts (#2202), so the AllowanceModule reads that follow
    // the active-account switch are already seeded. This scenario states one
    // thing — which account is active — and everything else is the shared
    // fixture, which is what makes it evidence about the fixture rather than
    // about itself.
    async run({ page, vp, shoot }) {
      await page.goto(`${BASE_URL}/agents`, { waitUntil: 'networkidle', timeout: 60_000 })
      await dismissMobileSidebar(page, vp)
      // Wait on the LEGACY control by name, not on a generic heading. If the
      // active-account switch ever stops taking, or the rail branch flips,
      // this run fails here instead of shooting the delegation rendering under
      // this scenario's name — the same reasoning `custody-legacy-rail` states.
      await page
        .getByRole('button', { name: 'Revoke Ops agent' })
        .waitFor({ timeout: 30_000 })
      // …and on the ON-CHAIN row, which is the other half of what the old
      // impossible value was buying.
      //
      // Waiting on the AMOUNT would prove nothing: the AllowanceModule row is
      // 500 USDC, so "500" renders identically whether the module answered or
      // the card took some other branch. The branches are told apart by their
      // own copy — `AllowanceBar` ends "… remaining"
      // (`AllowanceBar.tsx:86-89`) — so this waits on that and asserts the
      // not-answered branch is absent. A capture that quietly took the other
      // branch would otherwise be indistinguishable from the on-chain one,
      // which is this whole issue's defect class wearing a different hat.
      //
      // #2224 changed WHICH branch the failure would be. This used to check
      // for "Configured in Haven", the `ConfiguredAllowanceRow` caption, on
      // the reasoning that a failed module read falls back to the agent's DB
      // allowances. It cannot: `agent-ops` is on the legacy rail, so
      // `routes/agents.ts:92-98` serves it `allowances: []` and
      // `showConfiguredFallback` is unreachable for this card. With no
      // fallback to take, a module read that does not answer renders
      // "No agent budget configured" (`AgentCard.tsx`), and that is what is
      // asserted absent now — the honest discriminator for the branch the
      // product can actually reach.
      //
      // SCOPED to the Ops card, and that scoping is the guard working rather
      // than a convenience: the first version made its absence check
      // page-wide and failed, because the two DELEGATION-rail agents legitimately
      // render the granted-budget row — their authority is a grant, not an
      // AllowanceModule row. A page-wide absence check was asking the wrong
      // question, and it is the on-chain half of THIS card that the old
      // impossible value was buying. `AgentCard`'s root carries
      // `role="link"` + `aria-label="View <name>"` (`AgentCard.tsx:123-127`).
      const opsCard = page.getByRole('link', { name: 'View Ops agent' })
      await opsCard.getByText(/remaining/i).first().waitFor({ timeout: 30_000 })
      if (await opsCard.getByText('No agent budget configured').count()) {
        throw new Error(
          'agents-legacy-rail: the Ops card rendered no budget at all — the ' +
            'AllowanceModule read did not answer for the active account',
        )
      }
      await shoot(page.locator('#main-content'), 'page')
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
    // gate down a different branch. Putting the account on the Safe rail
    // (`account_type: 'safe'`) leaves it with no stored passkey, i.e.
    // `no_signer`, which is a hero that offers its actions. Nothing about the
    // modal under capture changes.
    //
    // #2202: this used to DROP `account_type` rather than set it. `railOf`
    // reads the two identically (`lib/custody-rail.ts:37-38`), so nothing
    // rendered differently — but an ABSENT `account_type` is not a state the
    // API can serve: the column is `NOT NULL DEFAULT 'safe'`
    // (`041_hybrid_accounts.ts:29`) and the wire type requires the field
    // (`core/src/api-types.ts:10025`). The legacy rail has a name; this uses it.
    api(apiPath) {
      if (apiPath === '/auth/me') return { ...FIXTURE_USER, safes: [{ ...FIXTURE_SAFE, account_type: 'safe' }] }
      // Same both-endpoints reasoning as the unresolved twin below.
      if (apiPath === '/user/safes') return { safes: [{ ...FIXTURE_SAFE, account_type: 'safe' }] }
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
      // #2202: the rail is NAMED here too, exactly as its resolved twin names
      // it — the pair is only evidence about `chain_id` if `chain_id` is the
      // one thing that differs, and `screenshot-fixture.test.ts` pins that.
      const safeWithoutChain = { ...FIXTURE_SAFE, account_type: 'safe' }
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
    // (84532), and the ONE override is the rail marker (`account_type: 'safe'`,
    // #2202 — see `add-funds` for why it is SET rather than dropped) so the
    // hero renders its action buttons instead of `PasskeyOtherDeviceNotice`.
    api(apiPath) {
      if (apiPath === '/auth/me') return { ...FIXTURE_USER, safes: [{ ...FIXTURE_SAFE, account_type: 'safe' }] }
      if (apiPath === '/user/safes') return { safes: [{ ...FIXTURE_SAFE, account_type: 'safe' }] }
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
      // #2202: the rail is NAMED here too, exactly as its resolved twin names
      // it — the pair is only evidence about `chain_id` if `chain_id` is the
      // one thing that differs, and `screenshot-fixture.test.ts` pins that.
      const safeWithoutChain = { ...FIXTURE_SAFE, account_type: 'safe' }
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
  // Resolved here, not at the spawn, so a malformed override fails before the
  // run does any work — and so a budget too small for a cold compile is called
  // out at the top of the log rather than 90 seconds later as a mystery timeout.
  const readinessBudgets = resolveReadinessBudgets()
  for (const problem of readinessBudgetProblems(readinessBudgets)) {
    console.warn(`⚠ screenshot: ${problem}`)
  }
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
      // The child handle is passed so the wait can end the moment `next dev`
      // dies, instead of waiting out a budget sized for a cold compile (#2108).
      await waitForServer(BASE_URL, { child: server, budgets: readinessBudgets, cwdLabel: path.relative(process.cwd(), ROOT) || ROOT })
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
  // POSITIVE evidence, per capture, that the route resolved rather than being
  // photographed mid-load (#2036): how much the route's own content region was
  // actually holding when the shutter fired. Recorded even on a clean run,
  // because "the guard passed" and "the guard ran and here is the margin" are
  // different claims, and only the second one survives being read later.
  const contentSettles = []
  // Captures whose CONTENT (not shell) arrived only after a wait. The
  // still-loading refusals live in `deletedCaptures` under cause
  // 'still-loading'; these are the ones the wait rescued.
  const contentRaced = []
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
          // No `allowBusy` here on purpose: `captureFullPage` derives the
          // tolerance from the page's own URL, so every consumer gets the same
          // answer (#2204 CI catch).
          const busyTolerance = busyToleranceFor(routePath)
          const { shell, content } = await captureFullPage(page, {
            path: file,
            label: `${routePath} · ${vp.name}`,
            viewportDevicePx: vp.height * DEVICE_SCALE_FACTOR,
          })
          captured.push(path.relative(ROOT, file))
          if (content) {
            contentSettles.push({
              route: routePath,
              viewport: vp.name,
              chars: content.chars,
              elements: content.elements,
              busy: content.busy ?? 0,
              waited_ms: content.waitedMs,
            })
            // The exemption's expiry date (#2204). A route declared
            // busy-tolerant that held nothing busy is a declaration nobody has
            // re-read; say so rather than carry it forever.
            if (busyTolerance && !(content.busy > 0)) {
              STALE_BUSY_DECLARATIONS.push({
                route: routePath,
                viewport: vp.name,
                reason: busyTolerance.reason,
              })
            }
            if (content.raced) {
              contentRaced.push({ route: routePath, viewport: vp.name, waitedMs: content.waitedMs })
            }
          }
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
        endChainWatch(scenario.expectedSilentRoutes ?? [])
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
        // What each route's OWN content region was holding at capture time
        // (#2036). A reader can check the margin between these numbers and the
        // floor instead of taking "the run was green" on trust — and a route
        // that quietly slid towards the floor is visible here before it starts
        // failing runs.
        content_settle: contentSettles,
        content_waits: contentRaced,
        // Busy-tolerance declarations (#2204) that turned out not to be needed
        // — the exemption's own expiry notice.
        stale_busy_declarations: STALE_BUSY_DECLARATIONS,
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
  if (contentRaced.length > 0) {
    console.log(
      `\nℹ ${contentRaced.length} capture(s) had to WAIT for the ROUTE'S CONTENT to resolve, not just the shell (#2036):`,
    )
    for (const e of contentRaced) {
      console.log(`  [${e.route} · ${e.viewport}] content region filled after ${e.waitedMs}ms`)
    }
  }
  if (contentSettles.length > 0) {
    console.log(
      `\nℹ route content confirmed present AND FINISHED at capture time (#2036/#2204) — floor is ` +
        `${MIN_CONTENT_CHARS} chars / ${MIN_CONTENT_ELEMENTS} elements in "${SCROLL_SHELL_ROOT}", ` +
        `and nothing in it may still be aria-busy:`,
    )
    for (const e of contentSettles) {
      console.log(
        `  [${e.route} · ${e.viewport}] ${e.chars} chars, ${e.elements} elements` +
          (e.busy > 0 ? `, ${e.busy} still-busy element(s) — tolerated by declaration` : ''),
      )
    }
  }
  if (STALE_BUSY_DECLARATIONS.length > 0) {
    console.error(
      `\n✗ ${STALE_BUSY_DECLARATIONS.length} busy-tolerance declaration(s) were not needed — ` +
        `BUSY_TOLERANT_CAPTURES in scripts/full-page-capture.mjs is stale (#2204):`,
    )
    for (const e of STALE_BUSY_DECLARATIONS) {
      console.error(`  [${e.route} · ${e.viewport}] held no aria-busy element — declared because: ${e.reason}`)
    }
    console.error(
      '  (remove the entry from BUSY_TOLERANT_CAPTURES — the exemption is only sound while the reason\n' +
        '   it names is still true, and a route that no longer needs it is a route the guard should be\n' +
        '   protecting)',
    )
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
  const failures = [
    viewportMismatches.length > 0 && `${viewportMismatches.length} PNG(s) not named after any resolved viewport`,
    gotoFailures.length > 0 && `${gotoFailures.length} route(s) failed to navigate`,
    deletedCaptures.length > 0 && `${deletedCaptures.length} capture(s) deleted as unusable`,
    CHAIN_READ_GAPS.length > 0 && `${CHAIN_READ_GAPS.length} chain-fed route(s) issued no on-chain reads`,
    CHAIN_SILENT_CAPTURES.length > 0 && `${CHAIN_SILENT_CAPTURES.length} silent chain-fed capture(s)`,
    // GATING, not advisory — review of #2204 caught this as a should-fix and it
    // was the right call. The whole claim made for `BUSY_TOLERANT_CAPTURES` is
    // that it SELF-EXPIRES; a stale declaration that only prints to stdout and
    // the manifest expires nothing, in a repo whose own playbook says the exit
    // code does not survive a pipe. Its sibling `CHAIN_SILENT_CAPTURES` fails
    // the run on exactly the mirror-image staleness, so the two mechanisms now
    // cost the same to leave rotting.
    STALE_BUSY_DECLARATIONS.length > 0 &&
      `${STALE_BUSY_DECLARATIONS.length} stale busy-tolerance declaration(s)`,
  ].filter(Boolean)
  if (failures.length > 0) {
    printRunResult(false, failures.join('; '))
    process.exit(1)
  }
  printRunResult(true, `${captured.length} PNG(s) in ${path.relative(process.cwd(), OUT_DIR) || OUT_DIR}`)
}

// Run only as a CLI (fixtureFor is imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('screenshot failed:', err instanceof Error ? err.message : err)
    printRunResult(false, err instanceof Error ? firstLine(err.message) : String(err))
    process.exit(1)
  })
}
