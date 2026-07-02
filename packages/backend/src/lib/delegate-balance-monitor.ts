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
import pool from '../db.js'
import { config } from '../config.js'
import { getChain } from './chains.js'
import { getTokenBalance } from './allowance-module.js'

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

interface MonitoredDelegate {
  agent_id: string
  agent_name: string
  delegate_address: string
  chain_id: number
}

/** Active agents with a delegate, joined to their Safe's chain. */
async function loadMonitoredDelegates(): Promise<MonitoredDelegate[]> {
  const result = await pool.query<MonitoredDelegate>(
    `SELECT a.id AS agent_id, a.name AS agent_name,
            a.delegate_address, us.chain_id
     FROM agents a
     JOIN user_safes us ON us.id = a.safe_id
     WHERE a.status = 'active' AND a.delegate_address IS NOT NULL`,
  )
  return result.rows
}

/** Agent ids with a payment intent fresh enough to explain a funded delegate. */
async function loadAgentsWithFreshPendingPayments(agentIds: string[]): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set()
  const result = await pool.query<{ agent_id: string }>(
    `SELECT DISTINCT agent_id FROM payment_intents
     WHERE agent_id = ANY($1)
       AND status IN ('pending_signature', 'submitted')
       AND created_at > NOW() - ($2 || ' minutes')::interval`,
    [agentIds, String(IN_FLIGHT_WINDOW_MIN)],
  )
  return new Set(result.rows.map((r) => r.agent_id))
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
  return report
}
