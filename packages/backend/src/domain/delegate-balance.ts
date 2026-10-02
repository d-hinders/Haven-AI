/**
 * Delegate balance monitor TYPES (#714/#3458), lifted into their own
 * zero-import module (#3514) so the ops console's `GET /ops/health` can
 * project the monitor's last report WITHOUT importing the monitor itself —
 * the ops invariant-1 walk (`__tests__/ops.invariants.test.ts`) forbids the
 * ops console's graph from reaching `infra/delegate-*`, so anything ops
 * reads must live somewhere the monitor does not own. Types only: the
 * monitor's behaviour is unchanged.
 */

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
  /**
   * Delegates whose balance could not be read this round (#3458): a failed
   * chunk or chain now leaves up to a whole chunk unread, so the count is
   * reported and logged rather than silently shrinking `findings`.
   */
  unread: Array<{ agentId: string; chainId: number }>
  /**
   * Chains whose reader could not even be set up, with the error (#3458).
   * Only a configuration fault reaches this (a non-ERC-20 USDC address): a
   * retry will not fix it, so the reason is carried to the log.
   */
  chainErrors: Record<number, string>
  scannedAt: string
}
