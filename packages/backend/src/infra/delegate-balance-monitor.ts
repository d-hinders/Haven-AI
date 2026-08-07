/**
 * Delegate balance monitor (#714, epic #713 — delegate in-flight exposure).
 *
 * The x402 flow's structural weak point is the in-flight window: once the Safe
 * funds the delegate EOA, that balance sits outside every policy layer until
 * the merchant settles or the sweep recovers it. This monitor is the DETECT
 * mitigation: periodically read every active agent's delegate USDC balance and
 * flag what should not be there.
 *
 * Classification per delegate:
 * - `clear`      — zero balance: the normal steady state.
 * - `in_flight`  — balance present but the agent has a fresh pending payment;
 *                  expected, informational only.
 * - `dust`       — balance below the sweep floor (#700/#712 intentionally
 *                  leaves it). Per-delegate this is fine; the AGGREGATE across
 *                  all delegates is alerted when it passes a threshold.
 * - `lingering`  — balance at/above the sweep floor with no fresh pending
 *                  payment: funded but neither settled nor swept. This is the
 *                  alert condition — sweepable money sitting on a hot EOA.
 *
 * READ-ONLY by design: it logs (structured, `delegate-balance-monitor` scope)
 * and never moves funds — recovery stays with the existing sweep path.
 */

import { ethers } from 'ethers'
import {
  listAgentIdsWithFreshPendingIntents,
  listMonitoredDelegates,
} from './repositories/delegate-monitoring.js'
import { config } from '../config.js'
import { getChain } from '../domain/chains.js'
import { getTokenBalance } from '../rails/allowance-module.js'

const USDC_DECIMALS = 6

/** Payments younger than this mark a funded delegate as in-flight, not lingering. */
export const IN_FLIGHT_WINDOW_MIN = 15

export type DelegateBalanceState = 'clear' | 'in_flight' | 'dust' | 'lingering'

export interface DelegateBalanceFinding {
  agentId: string
  agentName: string
  delegateAddress: string
  chainId: number
  balanceAtomic: bigint
  state: DelegateBalanceState
}

export interface DelegateBalanceReport {
  findings: DelegateBalanceFinding[]
  /** Sum of all `dust` balances across delegates (atomic USDC). */
  dustTotalAtomic: bigint
  /** True when dustTotalAtomic passed the alert threshold. */
  dustAlert: boolean
  lingering: DelegateBalanceFinding[]
  scannedAt: string
}

/** The sweep floor in atomic USDC — balances below it are expected dust. */
export function sweepFloorAtomic(): bigint {
  return ethers.parseUnits(config.sweepMinUsdc || '1', USDC_DECIMALS)
}

/** Aggregate-dust alert threshold in atomic USDC (env, default 25 USDC). */
export function dustAlertThresholdAtomic(): bigint {
  return ethers.parseUnits(process.env.DELEGATE_DUST_ALERT_USDC || '25', USDC_DECIMALS)
}

/** Pure classification — see the state table in the header. */
export function classifyDelegateBalance(
  balanceAtomic: bigint,
  floorAtomic: bigint,
  hasFreshPendingPayment: boolean,
): DelegateBalanceState {
  if (balanceAtomic === 0n) return 'clear'
  if (hasFreshPendingPayment) return 'in_flight'
  if (balanceAtomic < floorAtomic) return 'dust'
  return 'lingering'
}

/** Active agents with a delegate, joined to their Safe's chain (repository, #999). */
async function loadMonitoredDelegates() {
  return listMonitoredDelegates()
}

/** Agent ids with a payment intent fresh enough to explain a funded delegate. */
async function loadAgentsWithFreshPendingPayments(agentIds: string[]): Promise<Set<string>> {
  return listAgentIdsWithFreshPendingIntents(agentIds, String(IN_FLIGHT_WINDOW_MIN))
}

function usdcAddressFor(chainId: number): string | null {
  try {
    const chain = getChain(chainId)
    const usdc = Object.values(chain.tokens).find((t) => t.symbol.toUpperCase() === 'USDC')
    return usdc?.address ?? null
  } catch {
    return null
  }
}

/**
 * One scan across all monitored delegates. Balance-read failures are skipped
 * (logged by the caller via the report being partial), never fatal — a flaky
 * RPC must not kill the monitor loop.
 */
export async function scanDelegateBalances(): Promise<DelegateBalanceReport> {
  const delegates = await loadMonitoredDelegates()
  const fresh = await loadAgentsWithFreshPendingPayments(delegates.map((d) => d.agent_id))
  const floor = sweepFloorAtomic()

  const findings: DelegateBalanceFinding[] = []
  for (const delegate of delegates) {
    const usdc = usdcAddressFor(delegate.chain_id)
    if (!usdc) continue // chain without USDC — nothing to monitor
    let balanceAtomic: bigint
    try {
      balanceAtomic = await getTokenBalance(delegate.chain_id, delegate.delegate_address, usdc)
    } catch {
      continue // RPC hiccup: skip this delegate this round
    }
    findings.push({
      agentId: delegate.agent_id,
      agentName: delegate.agent_name,
      delegateAddress: delegate.delegate_address,
      chainId: delegate.chain_id,
      balanceAtomic,
      state: classifyDelegateBalance(balanceAtomic, floor, fresh.has(delegate.agent_id)),
    })
  }

  const dustTotalAtomic = findings
    .filter((f) => f.state === 'dust')
    .reduce((sum, f) => sum + f.balanceAtomic, 0n)

  return {
    findings,
    dustTotalAtomic,
    dustAlert: dustTotalAtomic >= dustAlertThresholdAtomic(),
    lingering: findings.filter((f) => f.state === 'lingering'),
    scannedAt: new Date().toISOString(),
  }
}

interface MonitorLogger {
  info(obj: unknown, msg: string): void
  warn(obj: unknown, msg: string): void
}

/** Format atomic USDC for logs. */
function usdc(atomic: bigint): string {
  return ethers.formatUnits(atomic, USDC_DECIMALS)
}

/**
 * Run one scan and emit the alerts. WARN for every lingering balance and for
 * an aggregate-dust breach; INFO summary otherwise. The log scope
 * `delegate-balance-monitor` is the alert hook (log-based alerting first —
 * the #714 issue defers dashboards).
 */
export async function runDelegateBalanceMonitor(log: MonitorLogger): Promise<DelegateBalanceReport> {
  const report = await scanDelegateBalances()

  for (const finding of report.lingering) {
    log.warn(
      {
        scope: 'delegate-balance-monitor',
        agentId: finding.agentId,
        agent: finding.agentName,
        delegate: finding.delegateAddress,
        chainId: finding.chainId,
        balanceUsdc: usdc(finding.balanceAtomic),
      },
      'LINGERING delegate balance — at/above the sweep floor with no fresh pending payment; ' +
        'sweepable funds are sitting on a hot EOA (run the sweep / investigate settlement)',
    )
  }

  if (report.dustAlert) {
    log.warn(
      {
        scope: 'delegate-balance-monitor',
        dustTotalUsdc: usdc(report.dustTotalAtomic),
        thresholdUsdc: usdc(dustAlertThresholdAtomic()),
        delegates: report.findings.filter((f) => f.state === 'dust').length,
      },
      'DUST accumulation across delegates passed the alert threshold — consider a below-floor sweep pass',
    )
  }

  log.info(
    {
      scope: 'delegate-balance-monitor',
      scanned: report.findings.length,
      lingering: report.lingering.length,
      dustTotalUsdc: usdc(report.dustTotalAtomic),
    },
    'delegate balance scan complete',
  )

  // Real alerting (#777) — best-effort, edge-triggered so an hourly re-scan of
  // the same condition does not spam. Failure here never affects the scan.
  await dispatchAlerts(report, log)

  return report
}

// ── Webhook alerting (#777) ─────────────────────────────────────────────────
//
// A lingering balance or an aggregate-dust breach is worth a real ping, not
// just a log line. Alerts are edge-triggered against in-memory state: a
// lingering finding pings once when it appears and again only after it clears
// and returns; the dust breach pings on the below→above crossing. State is
// per-process (resets on redeploy — an acceptable at-most-once re-ping); a
// durable store is a later step if the channel needs guaranteed dedup.

export interface AlertState {
  /** Agent+chain keys currently in a lingering episode we have already pinged. */
  lingeringKeys: Set<string>
  /** Whether the dust breach is currently active (edge tracking). */
  dustActive: boolean
}

export function newAlertState(): AlertState {
  return { lingeringKeys: new Set(), dustActive: false }
}

const moduleAlertState = newAlertState()

function lingeringKey(f: DelegateBalanceFinding): string {
  return `${f.agentId}:${f.chainId}`
}

/**
 * Pure alert decision: which messages to send this scan, and the next state.
 * Edge-triggered — no message for a condition already alerted and still true.
 */
export function computeAlerts(
  report: DelegateBalanceReport,
  state: AlertState,
): { messages: string[]; nextState: AlertState } {
  const messages: string[] = []
  const currentKeys = new Set(report.lingering.map(lingeringKey))

  for (const f of report.lingering) {
    if (!state.lingeringKeys.has(lingeringKey(f))) {
      messages.push(
        `🚨 Lingering delegate balance: ${usdc(f.balanceAtomic)} USDC on ${f.delegateAddress} ` +
          `(agent "${f.agentName}", chain ${f.chainId}) — sweepable funds on a hot EOA. Run the sweep / check settlement.`,
      )
    }
  }

  if (report.dustAlert && !state.dustActive) {
    messages.push(
      `🟡 Delegate dust crossed the alert threshold: ${usdc(report.dustTotalAtomic)} USDC total ` +
        `(threshold ${usdc(dustAlertThresholdAtomic())}). Consider a below-floor sweep pass.`,
    )
  }

  return { messages, nextState: { lingeringKeys: currentKeys, dustActive: report.dustAlert } }
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

async function dispatchAlerts(report: DelegateBalanceReport, log: MonitorLogger): Promise<void> {
  const { messages, nextState } = computeAlerts(report, moduleAlertState)
  moduleAlertState.lingeringKeys = nextState.lingeringKeys
  moduleAlertState.dustActive = nextState.dustActive

  const url = process.env.DELEGATE_ALERT_WEBHOOK_URL
  if (!url || messages.length === 0) return

  for (const text of messages) {
    try {
      await sendWebhookAlert(url, text)
    } catch (err) {
      // Best-effort: a failed alert must never affect the scan or funds.
      log.warn(
        { scope: 'delegate-balance-monitor', err: err instanceof Error ? err.message : String(err) },
        'delegate alert webhook failed (scan unaffected)',
      )
    }
  }
}
