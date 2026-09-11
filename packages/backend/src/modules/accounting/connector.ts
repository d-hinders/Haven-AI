import type { FeedTransaction } from './feed-transaction.js'
import type { ProviderCompanyInfo } from './provider.js'

/**
 * Provider-agnostic accounting connector (epic #491, P1 #495; contract
 * extended by #2862, epic #2858).
 *
 * The feed pushes through this interface; Fortnox is the first adapter and
 * later providers (Accounted, Light, Igdrasil — listed in `registry.ts`) slot
 * in without callers (sync orchestration, backfill, retry, the generic
 * connection routes) knowing the provider. Per-provider adapters behind one
 * internal interface rather than an aggregator — see #491.
 *
 * ## The contract, and who enforces it
 *
 * Every connector must pass `__tests__/connector-conformance.ts` — the
 * parameterised suite is the contract's executable form and is run against
 * `InMemoryConnector` (below) and the Fortnox connector with recorded HTTP
 * fixtures. Adding a provider means implementing this interface, registering
 * it, and adding a conformance runner: `README.md` in this directory.
 */

/** The decrypted secrets blob of a connection — shape is per provider. */
export type ProviderSecrets = Record<string, unknown>

/**
 * A post-push finding about the GRANT rather than the push. The invoice is
 * delivered and the sync row stays `pushed` (with the note); what changes is
 * the connection's status, so the dashboard can ask for a re-consent. Never a
 * reason to re-push — that would double-post.
 */
export type DegradedConnectionStatus = 'scope_missing' | 'needs_reauthorisation' | 'revoked_at_provider'

export interface PushResult {
  /** Provider-side reference for the dedup ledger (#497); null when skipped. */
  externalRef: string | null
  status: 'pushed' | 'skipped'
  reason?: string
  /**
   * Non-fatal degradation on a successful push (#498) — e.g. the receipt
   * attachment failed or no receipt existed. Recorded on the sync row so the
   * state is observable; the push itself still counts as delivered.
   */
  note?: string
  /** See `DegradedConnectionStatus`. Only meaningful with `status: 'pushed'`. */
  connectionStatus?: DegradedConnectionStatus
}

/**
 * Read-back verification (#1362), provider-neutral. Snake_case because this
 * IS the wire shape of `GET /accounting/feed/verify/:paymentId` — the route
 * returns it verbatim, and the dashboard reads it.
 */
export interface AccountingVerification {
  /** The pushed record still exists at the provider under our reference. */
  registered: boolean
  /**
   * Why registered is false (#1376 review): 'deleted' = the provider no
   * longer has it; 'foreign_invoice' = a record EXISTS at that number but
   * carries someone else's external reference (company-switch collision).
   * Null when registered.
   */
  missing: 'deleted' | 'foreign_invoice' | null
  /** A human has booked it. Null when not registered. */
  booked: boolean | null
  /** Cancelled at the provider — registered but struck. Null when not registered. */
  cancelled: boolean | null
  /** The provider's own number for the record (what its UI shows). */
  invoice_number: number
  /** Voucher reference once booked, e.g. "A123 2026". Null until booked. */
  voucher: string | null
  invoice_date: string | null
  total: number | null
  checked_at: string
}

export type VerifyOutcome =
  | { ok: true; verification: AccountingVerification }
  | { ok: false; error_code: 'not_connected' | 'no_invoice_ref' }

export interface AccountingConnector {
  /** Stable provider id, e.g. 'fortnox'. Must match a `registry.ts` descriptor. */
  provider: string
  isConnected(userId: string): Promise<boolean>
  /** Push one non-asserting transaction. Should be idempotent per paymentId. */
  pushTransaction(userId: string, tx: FeedTransaction): Promise<PushResult>
  /**
   * Read back the record behind `externalRef` (the sync row's `external_ref`)
   * for `paymentId` — the payment id lets the connector detect a record that
   * exists at that number but is not ours (`missing: 'foreign_invoice'`).
   * Strictly read-only: asserts nothing, modifies nothing.
   */
  verify(userId: string, externalRef: string, paymentId: string): Promise<VerifyOutcome>
  /**
   * Who the grant belongs to, from the provider's own records. Called by the
   * generic connect flows with the FRESH secrets before they are stored, so a
   * company that books in the wrong currency is refused before anything lands.
   */
  getCompanyInfo(secrets: ProviderSecrets): Promise<ProviderCompanyInfo>
  /**
   * Revoke the grant at the provider. Called on disconnect ONLY when the
   * provider descriptor declares `capabilities.revoke`; a connector whose
   * provider cannot revoke implements this as a no-op.
   */
  revoke(secrets: ProviderSecrets): Promise<void>
}

// ── Connector registry ────────────────────────────────────────────────────────
//
// Instances, not descriptors: the live Fortnox adapter (#496, receipt
// attachment #498) is registered at startup when Fortnox is configured — see
// `registerConnector` in `src/index.ts`. The DESCRIPTORS (what exists, what is
// live) are in `registry.ts` and need no instance.
//
// If no real connector is registered (Fortnox not configured),
// `hasLiveConnector()` returns false, the orchestrator finds nothing, and the
// dashboard shows a "preview — not yet delivering" notice.

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

/**
 * Whether a real (non-test) accounting connector is registered, i.e. whether the
 * feed can actually deliver to an external tool. True once the live Fortnox
 * adapter (#496/#498/#956) registers at startup — i.e. whenever Fortnox is
 * configured. The dashboard uses this to flag sync as a preview when no live
 * connector exists. The in-memory test connector does not count.
 */
export function hasLiveConnector(): boolean {
  return listConnectors().some((c) => c.provider !== 'memory')
}

/** For tests — clear the registry between cases. */
export function clearConnectors(): void {
  registry.clear()
}

// ── In-memory adapter ──────────────────────────────────────────────────────────

/**
 * In-memory connector for tests and the conformance suite. Records pushes;
 * skips unconnected users; idempotent per `(userId, paymentId)`. The knobs
 * (`attachmentOutcome`, `companyInfo`, `markBooked`, `deleteInvoice`) exist so
 * the conformance suite can drive every contract case without HTTP.
 */
export class InMemoryConnector implements AccountingConnector {
  provider = 'memory'
  readonly connectedUsers = new Set<string>()
  readonly pushed: Array<{ userId: string; tx: FeedTransaction }> = []
  readonly revoked: ProviderSecrets[] = []
  /** What the attachment step does after a successful push. */
  attachmentOutcome: 'ok' | 'fail' | 'scope_missing' = 'ok'
  companyInfo: ProviderCompanyInfo = { externalCompanyId: 'mem-1', name: 'Memory AB', baseCurrency: 'SEK' }

  private nextInvoice = 1
  private readonly invoices = new Map<
    number,
    { userId: string; paymentId: string; booked: boolean; deleted: boolean; date: string; total: number | null }
  >()

  connect(userId: string): void {
    this.connectedUsers.add(userId)
  }

  disconnect(userId: string): void {
    this.connectedUsers.delete(userId)
  }

  async isConnected(userId: string): Promise<boolean> {
    return this.connectedUsers.has(userId)
  }

  async pushTransaction(userId: string, tx: FeedTransaction): Promise<PushResult> {
    if (!this.connectedUsers.has(userId)) {
      return { externalRef: null, status: 'skipped', reason: 'not_connected' }
    }
    const existing = [...this.invoices.entries()].find(
      ([, inv]) => inv.userId === userId && inv.paymentId === tx.paymentId,
    )
    if (existing) {
      return { externalRef: `memory:invoice:${existing[0]}`, status: 'skipped', reason: 'duplicate' }
    }
    const n = this.nextInvoice++
    this.invoices.set(n, {
      userId,
      paymentId: tx.paymentId,
      booked: false,
      deleted: false,
      date: tx.settledAt.slice(0, 10),
      total: tx.amountSek == null ? null : Number(tx.amountSek),
    })
    this.pushed.push({ userId, tx })
    const ref = `memory:invoice:${n}`
    if (this.attachmentOutcome === 'fail') {
      return { externalRef: ref, status: 'pushed', note: 'receipt attachment failed: memory attachment step failed' }
    }
    if (this.attachmentOutcome === 'scope_missing') {
      return {
        externalRef: ref,
        status: 'pushed',
        note: 'receipt attachment failed: insufficient scope for attachments',
        connectionStatus: 'scope_missing',
      }
    }
    return { externalRef: ref, status: 'pushed' }
  }

  async verify(userId: string, externalRef: string, paymentId: string): Promise<VerifyOutcome> {
    if (!this.connectedUsers.has(userId)) return { ok: false, error_code: 'not_connected' }
    const match = externalRef.match(/^memory:invoice:(\d+)$/)
    if (!match) return { ok: false, error_code: 'no_invoice_ref' }
    const n = Number(match[1])
    const inv = this.invoices.get(n)
    const checked_at = new Date().toISOString()
    if (!inv || inv.deleted) {
      return {
        ok: true,
        verification: {
          registered: false, missing: 'deleted', booked: null, cancelled: null,
          invoice_number: n, voucher: null, invoice_date: null, total: null, checked_at,
        },
      }
    }
    if (inv.paymentId !== paymentId) {
      return {
        ok: true,
        verification: {
          registered: false, missing: 'foreign_invoice', booked: null, cancelled: null,
          invoice_number: n, voucher: null, invoice_date: null, total: null, checked_at,
        },
      }
    }
    return {
      ok: true,
      verification: {
        registered: true, missing: null, booked: inv.booked, cancelled: false,
        invoice_number: n, voucher: inv.booked ? `M${n} 2026` : null,
        invoice_date: inv.date, total: inv.total, checked_at,
      },
    }
  }

  async getCompanyInfo(): Promise<ProviderCompanyInfo> {
    return this.companyInfo
  }

  async revoke(secrets: ProviderSecrets): Promise<void> {
    this.revoked.push(secrets)
  }

  /** Test knob: a human booked the invoice at the provider. */
  markBooked(externalRef: string): void {
    const inv = this.invoices.get(Number(externalRef.split(':').pop()))
    if (inv) inv.booked = true
  }

  /** Test knob: the invoice was deleted at the provider. */
  deleteInvoice(externalRef: string): void {
    const inv = this.invoices.get(Number(externalRef.split(':').pop()))
    if (inv) inv.deleted = true
  }
}
