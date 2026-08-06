/**
 * #714 manual probe: one delegate-balance scan against the configured
 * database + chain RPCs, printed as a table. Same logic the backend runs
 * hourly (lib/delegate-balance-monitor.ts) — this is the on-demand version
 * for ops/debugging. Read-only; never moves funds.
 *
 * Env: DATABASE_URL (+ RPC_URL_* / DELEGATE_DUST_ALERT_USDC as usual).
 * Run: npm run ops:check-delegate-balances -w @haven/backend
 */

import { ethers } from 'ethers'
import { scanDelegateBalances, dustAlertThresholdAtomic } from '../src/lib/delegate-balance-monitor.js'

const ICONS: Record<string, string> = {
  clear: '✅',
  in_flight: '✈️ ',
  dust: '🟡',
  lingering: '🚨',
}

async function main(): Promise<void> {
  const report = await scanDelegateBalances()

  if (report.findings.length === 0) {
    console.log('no active delegates to monitor')
    process.exit(0)
  }

  for (const f of report.findings) {
    console.log(
      `${ICONS[f.state]} ${f.state.padEnd(10)} ${ethers.formatUnits(f.balanceAtomic, 6).padStart(10)} USDC  ` +
        `chain ${String(f.chainId).padEnd(6)} ${f.agentName} (${f.delegateAddress})`,
    )
  }

  console.log('')
  console.log(
    `dust total: ${ethers.formatUnits(report.dustTotalAtomic, 6)} USDC ` +
      `(alert at ${ethers.formatUnits(dustAlertThresholdAtomic(), 6)})${report.dustAlert ? ' 🚨 THRESHOLD PASSED' : ''}`,
  )
  console.log(`lingering:  ${report.lingering.length}`)

  if (report.lingering.length > 0 || report.dustAlert) {
    console.log('')
    console.log('action: run the sweep for lingering balances / investigate settlement; see epic #713.')
    process.exit(1)
  }
  console.log('✅ all delegate balances nominal')
}

main().catch((e) => {
  console.error('check-delegate-balances failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
