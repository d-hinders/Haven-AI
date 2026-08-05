/**
 * Read-only mainnet (8453) reconciliation check (#1067).
 *
 * The dev QA harness is Base Sepolia only BY DESIGN — nothing automated may
 * ever move mainnet funds. This is what replaces automated coverage there:
 * a read-only probe an operator runs before/after the canary and on a
 * routine cadence. It MOVES NOTHING and holds no keys.
 *
 * Two halves, by where it runs:
 *
 * 1. FROM ANYWHERE (`HAVEN_API_URL` pointing at prod):
 *    - `/health` answers and reports ok
 *    - the relayer-balance monitor is ALIVE (its cached 8453 entry exists and
 *      `checkedAt` is fresh — the monitor is hourly, so stale > 2h means the
 *      monitor is dead even if the balance was fine when it last ran)
 *    - the 8453 relayer is not below its low-water mark
 *
 * 2. INSIDE THE PROD SHELL (DATABASE_URL present — Railway backend service):
 *    additionally runs the delegate-balance scan (SELECTs + RPC reads only)
 *    and fails on any `lingering` delegate — a funded delegate with no fresh
 *    in-flight payment is exactly the reconciliation debt the sweep exists
 *    to clear. Skipped with a pointer when DATABASE_URL is absent.
 *
 * Exit codes: 0 = clean · 1 = findings · 2 = could not check (treat as red).
 */

const MAINNET_CHAIN_ID = 8453
const MONITOR_STALE_MS = 2 * 60 * 60 * 1000 // 2× the hourly monitor interval

interface RelayerEntry {
  chainId: number
  address: string
  balanceWei: string
  low: boolean
  checkedAt: string
}

async function main(): Promise<void> {
  const apiUrl = (process.env.HAVEN_API_URL ?? '').trim().replace(/\/$/, '')
  if (!apiUrl) {
    console.error('HAVEN_API_URL is required (point it at the PROD backend)')
    process.exit(2)
  }

  let failed = false

  // ── half 1: /health + relayer-monitor liveness ────────────────────────────
  let health: { status?: string; relayer?: RelayerEntry[] }
  try {
    const res = await fetch(`${apiUrl}/health`)
    health = (await res.json()) as typeof health
    if (!res.ok || health.status !== 'ok') {
      console.error(`✗ /health is not ok (HTTP ${res.status}, status=${health.status})`)
      process.exit(2)
    }
    console.log('✅ /health ok')
  } catch (err) {
    console.error(`✗ could not reach ${apiUrl}/health: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }

  const entry = (health.relayer ?? []).find((r) => r.chainId === MAINNET_CHAIN_ID)
  if (!entry) {
    console.error(`✗ no relayer entry for chain ${MAINNET_CHAIN_ID} in /health — is the chain served?`)
    failed = true
  } else {
    const age = Date.now() - new Date(entry.checkedAt).getTime()
    if (!Number.isFinite(age) || age > MONITOR_STALE_MS) {
      console.error(
        `✗ relayer-balance monitor looks DEAD: 8453 entry checkedAt=${entry.checkedAt} ` +
          `(${Math.round(age / 60000)} min ago; hourly monitor, 120 min tolerance)`,
      )
      failed = true
    } else {
      console.log(`✅ relayer-balance monitor alive (checked ${Math.round(age / 60000)} min ago)`)
    }
    if (entry.low) {
      console.error(`✗ 8453 relayer ${entry.address} is BELOW its low-water mark (${entry.balanceWei} wei)`)
      failed = true
    } else {
      console.log(`✅ 8453 relayer funded (${Number(entry.balanceWei) / 1e18} ETH)`)
    }
  }

  // ── half 2: delegate lingering scan (prod shell only) ─────────────────────
  if (process.env.DATABASE_URL) {
    const { scanDelegateBalances } = await import('../src/lib/delegate-balance-monitor.js')
    const report = await scanDelegateBalances()
    const lingering = report.lingering
    if (lingering.length > 0) {
      console.error(`✗ ${lingering.length} LINGERING delegate(s) — reconciliation debt the sweep should clear:`)
      for (const f of lingering) {
        console.error(`   agent ${f.agentId} — see ops:check-delegate-balances for detail`)
      }
      failed = true
    } else {
      console.log(`✅ no lingering delegates (${report.findings.length} scanned)`)
    }
  } else {
    console.log(
      'ℹ️  delegate scan skipped — DATABASE_URL not set. Run this script (or ' +
        'ops:check-delegate-balances) in the Railway PROD backend shell for the lingering check.',
    )
  }

  process.exit(failed ? 1 : 0)
}

void main()
