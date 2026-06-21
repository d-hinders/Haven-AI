import type { ReportingTransaction } from './reporting-transaction.js'

/**
 * Provider-agnostic accounting connector (epic #491, P1 #495).
 *
 * The feed pushes through this interface; Fortnox is the first adapter, Visma /
 * Bokio / Xero slot in later without callers (sync orchestration, backfill,
 * retry) knowing the provider. (Unified aggregators like Codat/Rutter have weak
 * Nordic coverage, so per-provider adapters behind one internal interface is the
 * scalable choice — see #491.)
 */
export interface PushResult {
  /** Provider-side reference for the dedup ledger (#497); null when skipped. */
  externalRef: string | null
  status: 'pushed' | 'skipped'
  reason?: string
}

export interface AccountingConnector {
  /** Stable provider id, e.g. 'fortnox'. */
  provider: string
  isConnected(userId: string): Promise<boolean>
  /** Push one non-asserting transaction. Should be idempotent per paymentId. */
  pushTransaction(userId: string, tx: ReportingTransaction): Promise<PushResult>
}

// ── Registry ─────────────────────────────────────────────────────────────────

const registry = new Map<string, AccountingConnector>()

export function registerConnector(connector: AccountingConnector): void {
  registry.set(connector.provider, connector)
}

export function getConnector(provider: string): AccountingConnector | undefined {
  return registry.get(provider)
}

export function listConnectors(): AccountingConnector[] {
  return [...registry.values()]
}

/** For tests — clear the registry between cases. */
export function clearConnectors(): void {
  registry.clear()
}

// ── In-memory adapter ──────────────────────────────────────────────────────────

/**
 * In-memory connector for tests and the orchestration sub-issue (#499), which
 * can land before the real Fortnox adapter (#496). Records pushes; skips
 * unconnected users. Idempotent per `(userId, paymentId)`.
 */
export class InMemoryConnector implements AccountingConnector {
  provider = 'memory'
  readonly connectedUsers = new Set<string>()
  readonly pushed: Array<{ userId: string; tx: ReportingTransaction }> = []

  connect(userId: string): void {
    this.connectedUsers.add(userId)
  }

  async isConnected(userId: string): Promise<boolean> {
    return this.connectedUsers.has(userId)
  }

  async pushTransaction(userId: string, tx: ReportingTransaction): Promise<PushResult> {
    if (!this.connectedUsers.has(userId)) {
      return { externalRef: null, status: 'skipped', reason: 'not_connected' }
    }
    const ref = `mem:${userId}:${tx.paymentId}`
    if (this.pushed.some((p) => p.userId === userId && p.tx.paymentId === tx.paymentId)) {
      return { externalRef: ref, status: 'skipped', reason: 'duplicate' }
    }
    this.pushed.push({ userId, tx })
    return { externalRef: ref, status: 'pushed' }
  }
}
