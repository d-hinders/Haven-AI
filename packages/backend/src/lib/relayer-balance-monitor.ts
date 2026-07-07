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
 * The last scan is cached in module state so `/health` can report relayer
 * status without a live RPC read on every probe. Read-only — never moves
 * funds and never blocks a payment.
 */

import { formatEther, parseEther } from 'ethers'
import { relayerPrivateKeyForChain } from '../config.js'
import { getChain, SUPPORTED_CHAIN_IDS } from './chains.js'
import { getRelayer } from './relayer.js'

// Same low-water mark as `warnIfRelayerLow` — enough for hundreds of
// transfers on Gnosis/Base at typical fees.
export const RELAYER_LOW_BALANCE_WEI = parseEther('0.01')

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
// relayer doesn't spam the channel every hour.
const lowAlerted = new Set<number>()

export function getRelayerBalanceStatus(): RelayerBalanceStatus[] {
  return [...lastStatus.values()].sort((a, b) => a.chainId - b.chainId)
}

/** POST a plain `{ text }` payload (Slack-compatible). Best-effort. */
async function sendWebhookAlert(url: string, text: string): Promise<void> {
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10_000),
  })
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
          lowAlerted.add(chainId)
          const url = process.env.DELEGATE_ALERT_WEBHOOK_URL
          if (url) {
            const symbol = getChain(chainId).nativeCurrency.symbol
            try {
              await sendWebhookAlert(
                url,
                `🚨 Relayer low on chain ${chainId}: ${formatEther(balance)} ${symbol} ` +
                  `(< ${formatEther(RELAYER_LOW_BALANCE_WEI)}) on ${relayer.address} — ` +
                  `top it up or relayed payments will start failing.`,
              )
            } catch (err) {
              // Best-effort: a failed alert must never affect the scan.
              log.warn(
                {
                  scope: 'relayer-balance-monitor',
                  chainId,
                  err: err instanceof Error ? err.message : String(err),
                },
                'relayer alert webhook failed (scan unaffected)',
              )
            }
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
}
