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
 * Read-only. Deliberately takes no delegate private key.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { ethers } from 'ethers'
import { BASE_SEPOLIA_RPC } from './lib/chain.js'
import { HavenApi } from './lib/haven-api.js'
import { collectBalances, type BalancesReport, type HistoryEntry } from './lib/balances.js'
import type { QaConfig } from './config.js'

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

export async function runBalances(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: { provider?: ethers.Provider; fetchImpl?: typeof fetch; api?: ReturnType<typeof sourcesFromEnv>['api']; now?: Date } = {},
): Promise<{ report: BalancesReport; exitCode: number }> {
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`)
    return i === -1 ? undefined : argv[i + 1]
  }
  const provider = deps.provider ?? boundedProvider()
  const src = sourcesFromEnv(env, provider, deps.fetchImpl)
  const api = deps.api !== undefined ? deps.api : src.api
  const report = await collectBalances({ ...src, api: src.apiMissing ? null : api }, readHistory(arg('history')), deps.now)
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
      if (exitCode !== 0) console.error('qa:balances: a required config value is missing (see the unknown rows above)')
      process.exit(exitCode)
    })
    .catch((error) => {
      console.error(`qa:balances: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      process.exit(2)
    })
}
