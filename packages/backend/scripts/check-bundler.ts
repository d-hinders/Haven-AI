/**
 * #738 standing check: is the delegation-rail bundler/paymaster reachable and
 * serving our EntryPoint? Suitable as a manual probe or a cron/uptime check
 * (exit 0 = healthy, 1 = degraded/down, 2 = not configured).
 *
 * The credential is resolved through the RAIL'S OWN resolver
 * (`delegationRailBundlerUrl`) rather than read from the environment here, so
 * the probe can never drift from what the rail actually uses. It previously
 * read `SESSION_RAIL_BUNDLER_URL` — retired in #882 — which meant a green
 * probe proved nothing about the deployed environment.
 *
 * The URL is a SECRET (hosted bundler URLs embed the API key): this script
 * prints status only, never the URL.
 *   1. eth_supportedEntryPoints includes EntryPoint v0.7 (bundler up)
 *   2. pimlico_getUserOperationGasPrice answers (paymaster/oracle side up)
 *
 * Outage playbook: docs/operations/delegation-rail-vendor-ops.md §3.
 *
 * Run: npm run ops:check-bundler -w @haven/backend
 *      CHECK_BUNDLER_CHAIN_ID=8453 npm run ops:check-bundler -w @haven/backend
 */
import { delegationRailBundlerUrl } from '../src/lib/delegation-rail.js'
import { DELEGATION_RAIL_CHAIN_IDS } from '../src/lib/delegation-contracts.js'

const ENTRY_POINT_07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message ?? 'rpc error'}`)
  return body.result
}

async function main(): Promise<void> {
  // With ONE enabled chain the probe picks it; with several (8453 + 84532
  // since #908) an implicit default would silently probe the wrong one — the
  // single DELEGATION_RAIL_BUNDLER_URL is per-environment, so a Sepolia
  // credential answering a "chain 8453" probe would read as healthy while
  // proving nothing. Require the operator to say which chain they mean.
  const enabled = [...DELEGATION_RAIL_CHAIN_IDS]
  const explicit = process.env.CHECK_BUNDLER_CHAIN_ID
  if (!explicit && enabled.length > 1) {
    console.error(
      `multiple delegation-rail chains enabled (${enabled.join(', ')}) — set CHECK_BUNDLER_CHAIN_ID to the one this environment's DELEGATION_RAIL_BUNDLER_URL targets`,
    )
    process.exit(2)
  }
  const chainId = Number(explicit ?? enabled[0])

  let url: string
  try {
    url = delegationRailBundlerUrl(chainId)
  } catch (err) {
    // Same failure the rail itself would hit — unset credential, or a chain the
    // rail is not enabled on. Exit 2 = not configured, not "degraded".
    console.error(`not configured: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }
  console.log(`chain:     ${chainId}`)

  let healthy = true

  try {
    const entryPoints = (await rpc(url, 'eth_supportedEntryPoints')) as string[]
    const hasV07 = entryPoints.some((e) => e.toLowerCase() === ENTRY_POINT_07.toLowerCase())
    console.log(`bundler:   up — entry points: ${entryPoints.length}, v0.7 ${hasV07 ? '✅' : '❌ MISSING'}`)
    if (!hasV07) healthy = false
  } catch (err) {
    console.log(`bundler:   ❌ DOWN (${err instanceof Error ? err.message.slice(0, 80) : err})`)
    healthy = false
  }

  try {
    const price = (await rpc(url, 'pimlico_getUserOperationGasPrice')) as {
      fast?: { maxFeePerGas?: string }
    }
    console.log(`paymaster: up — gas oracle answering (fast.maxFeePerGas ${price?.fast?.maxFeePerGas ?? '?'})`)
  } catch (err) {
    console.log(`paymaster: ❌ gas oracle failed (${err instanceof Error ? err.message.slice(0, 80) : err})`)
    healthy = false
  }

  console.log('')
  if (healthy) {
    console.log('✅ delegation-rail vendor healthy')
  } else {
    console.log('❌ degraded — see docs/operations/delegation-rail-vendor-ops.md §3 (outage playbook)')
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('check-bundler failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
