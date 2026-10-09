/**
 * `npm run qa:balances -w packages/qa-agent` — the balances-only entry point
 * (#3631). Reads every wallet the QA flows depend on and writes one JSON
 * report; `scripts/ci/qa-balance-issue.mjs` turns it into the standing issue.
 *
 *   tsx src/balances-cli.ts [--history <in.json>] [--out <report.json>]
 *
 * `--history` is the previous run's history (missing or unreadable → start
 * empty). The report carries the updated history for the next run.
 *
 * Exit code: 1 when any wallet is `unknown` because a CONFIG value is missing
 * (the scheduled run goes red, so GitHub notifies the owner); 0 otherwise,
 * including when a read fails (an RPC or `/healthz` outage says nothing about
 * the wallet). Unlike `runPreflight`, a missing config never drops a row.
 *
 * Read-only except for bounded Base Sepolia faucet requests for the demo
 * merchant's settlement wallet and the dev relayer (#3836). Deliberately takes
 * no delegate private key and never signs or moves Haven or customer funds.
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { ethers } from 'ethers'
import { BASE_SEPOLIA_RPC } from './lib/chain.js'
import { CdpFaucetError, requestCdpEvmFaucet } from './lib/faucet.js'
import { HavenApi } from './lib/haven-api.js'
import {
  buildBalancesReport,
  collectBalanceReadings,
  MERCHANT_TOPUP_TARGET_WEI,
  readMerchant,
  readRelayer,
  RELAYER_TOPUP_TARGET_WEI,
  safeReason,
  TOP_UP_WALLETS,
  withDeadline,
  type BalanceReadings,
  type BalanceSources,
  type BalancesReport,
  type HistoryEntry,
  type Reading,
  type TopUpOutcome,
  type TopUpWallet,
} from './lib/balances.js'
import type { QaConfig } from './config.js'

/** Coinbase's documented Base Sepolia ETH amount per accepted faucet request. */
export const CDP_FAUCET_CLAIM_WEI = 100_000_000_000_000n
export const RELAYER_TOPUP_MAX_CLAIMS = 300
/**
 * One budget for BOTH wallets' faucet loops (#3836): the merchant loop runs
 * first and the relayer loop gets what is left, so the top-ups together never
 * spend more than this of the job's 10-minute timeout.
 */
export const TOPUP_RUN_BUDGET_MS = 6 * 60_000
export const TOPUP_CALL_TIMEOUT_MS = 10_000
export const TOPUP_DELAY_MS = 250
/** The only chain the CDP faucet serves; the merchant must report it before a claim. */
const FAUCET_CHAIN_ID = 84532

export function readHistory(path: string | undefined): HistoryEntry[] {
  if (!path) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    const entries = Array.isArray(parsed) ? parsed : (parsed as { history?: unknown })?.history
    return Array.isArray(entries)
      ? entries.filter(
          (e): e is HistoryEntry =>
            typeof e === 'object' && e !== null && typeof (e as HistoryEntry).date === 'string' &&
            typeof (e as HistoryEntry).balances === 'object',
        )
      : []
  } catch {
    return []
  }
}

/** Build the sources from the environment, naming exactly what is missing. */
export function sourcesFromEnv(env: NodeJS.ProcessEnv, provider: ethers.Provider, fetchImpl?: typeof fetch) {
  const apiUrl = env.QA_HAVEN_API_URL?.trim().replace(/\/+$/, '')
  const agentKey = env.QA_DELEGATION_AGENT_API_KEY?.trim()
  const api = apiUrl && agentKey ? new HavenApi({ apiUrl } as QaConfig, agentKey) : null
  return {
    api,
    apiMissing: !apiUrl ? 'QA_HAVEN_API_URL' : !agentKey ? 'QA_DELEGATION_AGENT_API_KEY' : null,
    demoMerchantUrl: env.QA_DEMO_MERCHANT_URL?.trim().replace(/\/+$/, '') || undefined,
    relayerAddress: env.QA_DEV_RELAYER_ADDRESS?.trim() || undefined,
    provider,
    fetchImpl,
  }
}

/**
 * A provider that fails FAST. ethers' defaults (a 300 s request timeout, up to
 * 12 retries on a 429 with backoff) let one rate-limited RPC outlast the
 * job's 10-minute budget (#3631 review M1); a read failure must become an
 * `unknown` row and a green run, not a killed job with no history upload.
 */
export function boundedProvider(url: string = BASE_SEPOLIA_RPC): ethers.JsonRpcProvider {
  const req = new ethers.FetchRequest(url)
  req.timeout = 20_000
  req.setThrottleParams({ maxAttempts: 2 })
  return new ethers.JsonRpcProvider(req, 84532, { staticNetwork: true })
}

type FaucetRequest = typeof requestCdpEvmFaucet

/**
 * A stable `X-Idempotency-Key` per run, attempt, wallet and claim. Each wallet
 * has its own namespace: sharing one would give the merchant's claim N the
 * relayer's claim N key, and CDP would treat it as a replay (#3836). The
 * relayer's namespace is unchanged from #3655, pinned by a test.
 */
export function deterministicClaimId(
  wallet: TopUpWallet,
  runId: string | undefined,
  runAttempt: string | undefined,
  claim: number,
): string {
  if (!runId) return randomUUID()
  const attempt = runAttempt?.trim() || '1'
  const hex = createHash('sha256')
    .update(`qa-${wallet}-topup:${runId}:${attempt}:${claim}`)
    .digest('hex')
    .slice(0, 32)
    .split('')
  hex[12] = '4'
  hex[16] = '8'
  const s = hex.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

function skippedTopUp(stopReason: TopUpOutcome['stopReason'], reason?: string): TopUpOutcome {
  return { status: 'skipped', claimsMade: 0, amountReceivedAtomic: '0', stopReason, ...(reason ? { reason } : {}) }
}

interface TopUpDeps {
  requestFaucet?: FaucetRequest
  sleep?: (ms: number) => Promise<void>
  nowMs?: () => number
  /** Epoch ms after which no further claim starts; shared by both wallets' loops. */
  deadlineAt?: number
}

function cdpCredentials(env: NodeJS.ProcessEnv): { apiKeyId: string; apiKeySecret: string } | null {
  const apiKeyId = env.QA_CDP_API_KEY_ID?.trim()
  const apiKeySecret = env.QA_CDP_API_KEY_SECRET?.trim()
  return apiKeyId && apiKeySecret ? { apiKeyId, apiKeySecret } : null
}

/**
 * Claim toward `targetWei` for one wallet, one bounded request at a time. Stops
 * at the target, the cap (when one is given), a 429, any other faucet error, or
 * the deadline. Without a cap the target bounds the loop: balance ≥ 0, so at
 * most ceil(target / claim) claims.
 */
async function claimToTarget(
  wallet: TopUpWallet,
  address: string,
  balance: bigint,
  targetWei: bigint,
  maxClaims: number | undefined,
  credentials: { apiKeyId: string; apiKeySecret: string },
  env: NodeJS.ProcessEnv,
  deps: TopUpDeps,
): Promise<TopUpOutcome> {
  const needed = targetWei > balance ? targetWei - balance : 0n
  const claimsToTarget = Number((needed + CDP_FAUCET_CLAIM_WEI - 1n) / CDP_FAUCET_CLAIM_WEI)
  const plannedClaims = maxClaims === undefined ? claimsToTarget : Math.min(claimsToTarget, maxClaims)
  const requestFaucet = deps.requestFaucet ?? requestCdpEvmFaucet
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const nowMs = deps.nowMs ?? Date.now
  const deadlineAt = deps.deadlineAt ?? nowMs() + TOPUP_RUN_BUDGET_MS
  let claimsMade = 0
  let stopReason: TopUpOutcome['stopReason'] =
    maxClaims !== undefined && claimsToTarget >= maxClaims ? 'claim-cap-reached' : 'target-requests-complete'
  let reason: string | undefined

  for (let claim = 1; claim <= plannedClaims; claim++) {
    if (nowMs() >= deadlineAt) {
      stopReason = 'run-budget-exhausted'
      break
    }
    try {
      await requestFaucet({
        address,
        chainId: FAUCET_CHAIN_ID,
        ...credentials,
        idempotencyKey: deterministicClaimId(wallet, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT, claim),
        timeoutMs: TOPUP_CALL_TIMEOUT_MS,
      })
      claimsMade++
    } catch (error) {
      stopReason = error instanceof CdpFaucetError && error.status === 429 ? 'rate-limited' : 'faucet-error'
      reason = safeReason('faucet request failed', error)
      break
    }
    if (claim < plannedClaims) await sleep(TOPUP_DELAY_MS)
  }

  return {
    status: 'attempted',
    claimsMade,
    // The post-loop read supplies what actually arrived. An accepted faucet
    // response is not confirmation of an increased balance.
    amountReceivedAtomic: '0',
    stopReason,
    ...(reason ? { reason } : {}),
  }
}

/** The dev relayer: topped up to 0.03 ETH when its band is `warn` or `critical` (#3655). */
export async function topUpRelayer(
  readings: BalanceReadings,
  provisional: BalancesReport,
  env: NodeJS.ProcessEnv,
  deps: TopUpDeps = {},
): Promise<TopUpOutcome> {
  const row = provisional.rows.find((candidate) => candidate.key === 'relayer')
  const reading = readings.relayer
  const credentials = cdpCredentials(env)
  if (!credentials) return skippedTopUp('missing-credentials')
  if (!row || !reading.ok || (row.band !== 'warn' && row.band !== 'critical')) {
    return skippedTopUp('not-needed', 'the relayer was not `warn` or `critical`')
  }
  return claimToTarget('relayer', reading.address, reading.atomic, RELAYER_TOPUP_TARGET_WEI, RELAYER_TOPUP_MAX_CLAIMS, credentials, env, deps)
}

/**
 * The demo merchant's settlement wallet (#3836): topped up whenever it is
 * readable, on 84532, and below its target — NOT on band. Its `critical` floor
 * is its own refusal point and its fallback `warn` floor is hours of burn, so a
 * daily band trigger lets it run dry between runs (2026-10-09). The claim count
 * is bounded by the target itself: at most ceil(target / claim).
 */
export async function topUpMerchant(
  readings: BalanceReadings,
  env: NodeJS.ProcessEnv,
  deps: TopUpDeps & { merchantTargetWei?: bigint } = {},
): Promise<TopUpOutcome> {
  const reading = readings.merchant
  const target = deps.merchantTargetWei ?? MERCHANT_TOPUP_TARGET_WEI
  const credentials = cdpCredentials(env)
  if (!credentials) return skippedTopUp('missing-credentials')
  if (!reading.ok) return skippedTopUp('not-needed', 'the merchant balance could not be read')
  if (reading.chainId !== FAUCET_CHAIN_ID) {
    return skippedTopUp(
      'wrong-chain',
      reading.chainId === undefined
        ? 'merchant /healthz reports no chain_id'
        : `merchant /healthz reports chain ${reading.chainId}, not ${FAUCET_CHAIN_ID}`,
    )
  }
  if (!ethers.isAddress(reading.address)) return skippedTopUp('invalid-address', 'merchant /healthz settlement address is not an address')
  if (reading.atomic >= target) {
    return skippedTopUp('not-needed', `the merchant was at or above its ${ethers.formatEther(target)} ETH target`)
  }
  return claimToTarget('merchant', reading.address, reading.atomic, target, undefined, credentials, env, deps)
}

/**
 * Both wallets' top-ups under ONE deadline, merchant first: it needs at most
 * ceil(target / claim) claims, and below its fail floor it refuses every
 * payment. A merchant 429 or error ends only the merchant loop.
 */
export async function runTopUps(
  readings: BalanceReadings,
  provisional: BalancesReport,
  env: NodeJS.ProcessEnv,
  deps: TopUpDeps & { merchantTargetWei?: bigint } = {},
): Promise<Record<TopUpWallet, TopUpOutcome>> {
  const nowMs = deps.nowMs ?? Date.now
  const shared = { ...deps, deadlineAt: deps.deadlineAt ?? nowMs() + TOPUP_RUN_BUDGET_MS }
  const merchant = await topUpMerchant(readings, env, shared)
  const relayer = await topUpRelayer(readings, provisional, env, shared)
  return { merchant, relayer }
}

/**
 * Re-read one wallet after the top-ups. A failed or timed-out re-read keeps the
 * PRE-top-up reading: replacing a `critical` reading with `unknown` would hide
 * it, since `unknown` never opens the standing issue (#3836).
 */
async function rereadAfterTopUp(
  wallet: TopUpWallet,
  before: Reading,
  outcome: TopUpOutcome,
  sources: BalanceSources,
  deadlineMs: number,
): Promise<Reading> {
  const reader = wallet === 'merchant' ? readMerchant : readRelayer
  const after = await withDeadline(reader(sources), deadlineMs, (): Reading => ({
    ok: false,
    reason: `post-top-up read timed out after ${Math.round(deadlineMs / 1000)} s`,
  }))
  if (!after.ok) {
    const note = `post-top-up read failed (${after.reason}); showing the pre-top-up reading`
    outcome.reason = outcome.reason ? `${outcome.reason}; ${note}` : note
    return before
  }
  if (before.ok && after.atomic > before.atomic) {
    outcome.amountReceivedAtomic = (after.atomic - before.atomic).toString()
  }
  return after
}

export async function runBalances(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: {
    provider?: ethers.Provider
    fetchImpl?: typeof fetch
    api?: ReturnType<typeof sourcesFromEnv>['api']
    now?: Date
    requestFaucet?: FaucetRequest
    sleep?: (ms: number) => Promise<void>
    nowMs?: () => number
    deadlineMs?: number
    merchantTargetWei?: bigint
  } = {},
): Promise<{ report: BalancesReport; exitCode: number }> {
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`)
    return i === -1 ? undefined : argv[i + 1]
  }
  const provider = deps.provider ?? boundedProvider()
  const src = sourcesFromEnv(env, provider, deps.fetchImpl)
  const api = deps.api !== undefined ? deps.api : src.api
  const sources = { ...src, api: src.apiMissing ? null : api }
  const history = readHistory(arg('history'))
  const readings = await collectBalanceReadings(sources, deps.deadlineMs)
  const provisional = buildBalancesReport(readings, history, deps.now)
  const topUps = await runTopUps(readings, provisional, env, deps)
  // Re-read only after BOTH loops: a faucet call returns a transaction hash,
  // not a confirmation, so this gives the merchant's claims time to be mined.
  for (const wallet of TOP_UP_WALLETS) {
    if (topUps[wallet].status !== 'attempted') continue
    readings[wallet] = await rereadAfterTopUp(wallet, readings[wallet], topUps[wallet], sources, deps.deadlineMs ?? 30_000)
  }
  const report = buildBalancesReport(readings, history, deps.now)
  report.topUps = topUps
  // Name the exact missing variable on the treasury row (the reader only
  // knows "no API").
  if (src.apiMissing) {
    const row = report.rows.find((r) => r.key === 'treasury')
    if (row) row.reason = `config missing: ${src.apiMissing}`
  }
  const out = arg('out')
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
  return { report, exitCode: report.configMissing ? 1 : 0 }
}

/** One log line per wallet: `merchant top-up: …` / `relayer top-up: …`. */
export function topUpLogLine(wallet: TopUpWallet, outcome: TopUpOutcome | undefined): string | null {
  if (!outcome) return null
  if (outcome.stopReason === 'missing-credentials') return `${wallet} top-up: skipped: no CDP credentials`
  if (outcome.status === 'skipped') {
    return `${wallet} top-up: skipped (${outcome.stopReason})${outcome.reason ? ` — ${outcome.reason}` : ''}`
  }
  return (
    `${wallet} top-up: ${outcome.claimsMade} claim(s), ${ethers.formatEther(outcome.amountReceivedAtomic)} ETH, ${outcome.stopReason}` +
    (outcome.reason ? ` — ${outcome.reason}` : '')
  )
}

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('balances-cli.ts')
  } catch {
    return false
  }
})()

if (isMain) {
  runBalances(process.argv.slice(2))
    .then(({ report, exitCode }) => {
      for (const r of report.rows) {
        const where = r.address ? ` ${r.address}` : ''
        const bal = r.balance !== undefined ? `${r.balance} ${r.unit}` : '—'
        const runway = r.runwayDays !== undefined ? `, runway ${r.runwayDays} d` : ''
        console.log(`${r.band.padEnd(8)} ${r.name}${where}: ${bal}${runway}${r.reason ? ` — ${r.reason}` : ''}`)
      }
      for (const wallet of TOP_UP_WALLETS) {
        const line = topUpLogLine(wallet, report.topUps?.[wallet])
        if (line) console.log(line)
      }
      if (exitCode !== 0) console.error('qa:balances: a required config value is missing (see the unknown rows above)')
      process.exit(exitCode)
    })
    .catch((error) => {
      console.error(`qa:balances: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      process.exit(2)
    })
}
