/**
 * Relayer balance monitor.
 *
 * Hourly read-only scan of the relayer EOA's native balance on every
 * supported chain that has a relayer key configured. Below the low-water
 * mark it logs a warning and pushes an edge-triggered webhook alert (same
 * channel as the delegate monitor, `DELEGATE_ALERT_WEBHOOK_URL`) — the
 * relayer going dry mid-traffic previously surfaced only as failing
 * payments, because `warnIfRelayerLow` was a bare console.warn that the
 * payment path never called.
 *
 * The last scan is cached in module state so `/health/ops` can report relayer
 * status without a live RPC read on every probe. Read-only — never moves
 * funds and never blocks a payment.
 */

import { formatEther } from 'ethers'
import { relayerPrivateKeyForChain } from '../config.js'
import { getChain, SUPPORTED_CHAIN_IDS } from '../domain/chains.js'
import { getRelayer, RELAYER_LOW_BALANCE_WEI } from './relayer.js'
import { relayerSpendSummary } from './relayer-spend-guard.js'
import { sendDelegateAlertWebhook } from './delegate-alert-webhook.js'

export interface RelayerBalanceStatus {
  chainId: number
  address: string
  balanceWei: string
  low: boolean
  checkedAt: string
}

interface MonitorLogger {
  info: (obj: Record<string, unknown>, msg: string) => void
  warn: (obj: Record<string, unknown>, msg: string) => void
}

// Last scan result, per chain — served by getRelayerBalanceStatus() so the
// health endpoint never pays an RPC round-trip.
const lastStatus = new Map<number, RelayerBalanceStatus>()

// Edge-trigger state: chains already alerted low. A chain alerts once when it
// crosses below the mark and re-arms when it recovers, so a persistently low
// relayer doesn't spam the channel every hour. A chain is committed here only
// AFTER its webhook was accepted (#3345) — a failed delivery stays un-armed
// so the next scan retries while the balance is still low.
const lowAlerted = new Set<number>()

export function getRelayerBalanceStatus(): RelayerBalanceStatus[] {
  return [...lastStatus.values()].sort((a, b) => a.chainId - b.chainId)
}

/** Reset the module-private edge state (test seam — `lowAlerted`). */
export function resetRelayerAlertStateForTests(): void {
  lowAlerted.clear()
}

export async function runRelayerBalanceMonitor(log: MonitorLogger): Promise<void> {
  for (const chainId of SUPPORTED_CHAIN_IDS) {
    // Only scan chains this environment actually relays on.
    if (!relayerPrivateKeyForChain(chainId)) continue

    try {
      const relayer = getRelayer(chainId)
      const provider = relayer.provider
      if (!provider) continue
      const balance = await provider.getBalance(relayer.address)
      const low = balance < RELAYER_LOW_BALANCE_WEI

      lastStatus.set(chainId, {
        chainId,
        address: relayer.address,
        balanceWei: balance.toString(),
        low,
        checkedAt: new Date().toISOString(),
      })

      if (low) {
        log.warn(
          {
            scope: 'relayer-balance-monitor',
            chainId,
            relayer: relayer.address,
            balance: formatEther(balance),
          },
          'Relayer balance below low-water mark',
        )
        if (!lowAlerted.has(chainId)) {
          const url = process.env.DELEGATE_ALERT_WEBHOOK_URL
          if (!url) {
            // Log-only mode (no webhook configured): the warning above is the
            // whole alert — treat the episode as handled, as before #3345.
            lowAlerted.add(chainId)
          } else {
            const symbol = getChain(chainId).nativeCurrency.symbol
            // Delivered decides the edge commit (#3345): the shared sender
            // returns false on a 4xx/5xx or network error instead of
            // throwing, so the failure can never masquerade as this catch's
            // "relayer balance read failed" — and the chain stays un-armed
            // so the next scan retries while the balance is still low.
            const delivered = await sendDelegateAlertWebhook(
              url,
              `🚨 Relayer low on chain ${chainId}: ${formatEther(balance)} ${symbol} ` +
                `(< ${formatEther(RELAYER_LOW_BALANCE_WEI)}) on ${relayer.address} — ` +
                `top it up or relayed payments will start failing.`,
              log,
              'relayer-balance-monitor',
            )
            if (delivered) lowAlerted.add(chainId)
          }
        }
      } else {
        lowAlerted.delete(chainId)
      }
    } catch (err) {
      // A chain whose RPC is down must not stop the scan of the others.
      log.warn(
        {
          scope: 'relayer-balance-monitor',
          chainId,
          err: err instanceof Error ? err.message : String(err),
        },
        'relayer balance read failed',
      )
    }
  }

  // #717: cost attribution rides the same hourly scan — per-chain/per-op
  // relayer spend over the trailing 24h, so "who is burning the gas" is a
  // log query, not an incident investigation. Best-effort like the alerts.
  try {
    const summary = await relayerSpendSummary(24)
    if (summary.length > 0) {
      log.info(
        { scope: 'relayer-balance-monitor', spend24h: summary },
        'relayer spend, trailing 24h (per chain/operation)',
      )
    }
  } catch (err) {
    log.warn(
      { scope: 'relayer-balance-monitor', err: err instanceof Error ? err.message : String(err) },
      'relayer spend summary failed (scan unaffected)',
    )
  }
}
