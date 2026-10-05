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
 * Read-only except for bounded Base Sepolia faucet requests for the dev
 * relayer. Deliberately takes no delegate private key and never signs or moves
 * Haven or customer funds.
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
  readRelayer,
  RELAYER_TOPUP_TARGET_WEI,
  safeReason,
  withDeadline,
  type BalanceReadings,
  type BalancesReport,
  type HistoryEntry,
} from './lib/balances.js'
import type { QaConfig } from './config.js'

/** Coinbase's documented Base Sepolia ETH amount per accepted faucet request. */
export const CDP_FAUCET_CLAIM_WEI = 100_000_000_000_000n
export const RELAYER_TOPUP_MAX_CLAIMS = 300
export const RELAYER_TOPUP_RUN_BUDGET_MS = 6 * 60_000
export const RELAYER_TOPUP_CALL_TIMEOUT_MS = 10_000
export const RELAYER_TOPUP_DELAY_MS = 250

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

function deterministicClaimId(
  runId: string | undefined,
  runAttempt: string | undefined,
  claim: number,
): string {
  if (!runId) return randomUUID()
  const attempt = runAttempt?.trim() || '1'
  const hex = createHash('sha256')
    .update(`qa-relayer-topup:${runId}:${attempt}:${claim}`)
    .digest('hex')
    .slice(0, 32)
    .split('')
  hex[12] = '4'
  hex[16] = '8'
  const s = hex.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

function skippedTopUp(stopReason: 'not-needed' | 'missing-credentials'): NonNullable<BalancesReport['topUp']> {
  return { status: 'skipped', claimsMade: 0, amountReceivedAtomic: '0', stopReason }
}

export async function topUpRelayer(
  readings: BalanceReadings,
  provisional: BalancesReport,
  env: NodeJS.ProcessEnv,
  deps: {
    requestFaucet?: FaucetRequest
    sleep?: (ms: number) => Promise<void>
    nowMs?: () => number
  } = {},
): Promise<NonNullable<BalancesReport['topUp']>> {
  const row = provisional.rows.find((candidate) => candidate.key === 'relayer')
  const reading = readings.relayer
  const apiKeyId = env.QA_CDP_API_KEY_ID?.trim()
  const apiKeySecret = env.QA_CDP_API_KEY_SECRET?.trim()
  if (!apiKeyId || !apiKeySecret) return skippedTopUp('missing-credentials')
  if (!row || !reading.ok || (row.band !== 'warn' && row.band !== 'critical')) return skippedTopUp('not-needed')

  const needed = RELAYER_TOPUP_TARGET_WEI > reading.atomic ? RELAYER_TOPUP_TARGET_WEI - reading.atomic : 0n
  const claimsToTarget = Number((needed + CDP_FAUCET_CLAIM_WEI - 1n) / CDP_FAUCET_CLAIM_WEI)
  const plannedClaims = Math.min(claimsToTarget, RELAYER_TOPUP_MAX_CLAIMS)
  const requestFaucet = deps.requestFaucet ?? requestCdpEvmFaucet
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const nowMs = deps.nowMs ?? Date.now
  const started = nowMs()
  let claimsMade = 0
  let stopReason: NonNullable<BalancesReport['topUp']>['stopReason'] =
    claimsToTarget >= RELAYER_TOPUP_MAX_CLAIMS ? 'claim-cap-reached' : 'target-requests-complete'
  let reason: string | undefined

  for (let claim = 1; claim <= plannedClaims; claim++) {
    if (nowMs() - started >= RELAYER_TOPUP_RUN_BUDGET_MS) {
      stopReason = 'run-budget-exhausted'
      break
    }
    try {
      await requestFaucet({
        address: reading.address,
        chainId: 84532,
        apiKeyId,
        apiKeySecret,
        idempotencyKey: deterministicClaimId(env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT, claim),
        timeoutMs: RELAYER_TOPUP_CALL_TIMEOUT_MS,
      })
      claimsMade++
    } catch (error) {
      stopReason = error instanceof CdpFaucetError && error.status === 429 ? 'rate-limited' : 'faucet-error'
      reason = safeReason('faucet request failed', error)
      break
    }
    if (claim < plannedClaims) await sleep(RELAYER_TOPUP_DELAY_MS)
  }

  return {
    status: 'attempted',
    claimsMade,
    // The post-loop chain read below supplies what actually arrived. An
    // accepted faucet response is not confirmation of an increased balance.
    amountReceivedAtomic: '0',
    stopReason,
    ...(reason ? { reason } : {}),
  }
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
  const topUp = await topUpRelayer(readings, provisional, env, deps)
  if (topUp.status === 'attempted') {
    const before = readings.relayer
    readings.relayer = await withDeadline(readRelayer(sources), deps.deadlineMs ?? 30_000, () => ({
      ok: false,
      reason: `post-top-up read timed out after ${Math.round((deps.deadlineMs ?? 30_000) / 1000)} s`,
    }))
    const after = readings.relayer
    if (before.ok && after.ok && after.atomic > before.atomic) {
      topUp.amountReceivedAtomic = (after.atomic - before.atomic).toString()
    }
  }
  const report = buildBalancesReport(readings, history, deps.now)
  report.topUp = topUp
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
      const topUp = report.topUp
      if (topUp?.stopReason === 'missing-credentials') console.log('top-up skipped: no CDP credentials')
      else if (topUp) {
        console.log(
          `relayer top-up: ${topUp.claimsMade} claim(s), ${ethers.formatEther(topUp.amountReceivedAtomic)} ETH, ${topUp.stopReason}` +
            (topUp.reason ? ` — ${topUp.reason}` : ''),
        )
      }
      if (exitCode !== 0) console.error('qa:balances: a required config value is missing (see the unknown rows above)')
      process.exit(exitCode)
    })
    .catch((error) => {
      console.error(`qa:balances: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      process.exit(2)
    })
}
