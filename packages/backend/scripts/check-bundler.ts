/**
 * #738 standing check: is the session-rail bundler/paymaster reachable and
 * serving our EntryPoint? Suitable as a manual probe or a cron/uptime check
 * (exit 0 = healthy, 1 = degraded/down, 2 = not configured).
 *
 * Checks, via the configured SESSION_RAIL_BUNDLER_URL (SECRET — never logged;
 * this script prints status only, never the URL):
 *   1. eth_supportedEntryPoints includes EntryPoint v0.7 (bundler up)
 *   2. pimlico_getUserOperationGasPrice answers (paymaster/oracle side up)
 *
 * Outage playbook: docs/operations/session-rail-vendor-ops.md §3.
 *
 * Run: npm run ops:check-bundler -w @haven/backend
 */

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
  const url = process.env.SESSION_RAIL_BUNDLER_URL ?? process.env.PILOT_BUNDLER_URL
  if (!url) {
    console.error('not configured: set SESSION_RAIL_BUNDLER_URL (or PILOT_BUNDLER_URL locally)')
    process.exit(2)
  }

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
    console.log('✅ session-rail vendor healthy')
  } else {
    console.log('❌ degraded — see docs/operations/session-rail-vendor-ops.md §3 (outage playbook)')
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('check-bundler failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
