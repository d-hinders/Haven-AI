/**
 * The consumed-payment store (#4890; docs/architecture/12-merchant-kit.md §6).
 *
 * The core records every payment it settles through this interface, and keeps
 * no map of its own for the record; each consumer supplies its own
 * implementation and policy. The demo merchant uses the in-memory one below
 * (nothing persisted, a restart forgets settled payments, exactly as before);
 * the paywall proxy will bring a SQLite one.
 */
import { createHash, randomUUID } from 'node:crypto'

export type ConsumedPaymentState =
  | 'settling'
  | 'settlement_unknown'
  | 'settled'
  | 'forwarding'
  | 'delivered'
  | 'failed'
  | 'exhausted'

export interface ConsumedPaymentRecord {
  key: string
  state: ConsumedPaymentState
  productId: string
  chain: string
  payer: string
  amount: string
  /** The authorization's `validBefore`, in seconds. */
  validBefore: number
  /** When the key was reserved; bounds how long a `settling` record's holder is trusted. */
  reservedAt: string
  /** Generated once, at reservation; the sale record's `merchant_reference`. */
  merchantReference: string
  /**
   * SHA-256 of the full signed authorization as presented: from, to, value,
   * validAfter, validBefore, nonce and the signature.
   */
  authorizationDigest: string
  txHash?: string
  settledAt?: string
  forwardingStartedAt?: string
  forwardCount: number
  deliveredAt?: string
  failedAt?: string
  failureReason?: string
  upstreamStatus?: number
  saleReported: boolean
}

export interface ConsumedPaymentStore {
  /**
   * Reserve the key BEFORE verify and settle. Returns `reserved` for a new
   * key, or the existing record when the key is known.
   */
  reserve(input: {
    key: string
    productId: string
    chain: string
    payer: string
    amount: string
    validBefore: number
    merchantReference: string
    authorizationDigest: string
    now: string
  }): Promise<
    // The token is returned here and nowhere else. The store keeps only its
    // SHA-256, in a column ConsumedPaymentRecord omits, so neither reserve's
    // known-key answer nor get ever returns it.
    { reserved: true; reservationToken: string } | { reserved: false; record: ConsumedPaymentRecord }
  >

  /**
   * Record the settlement, as one conditional update on the record's state.
   * - With the reserving request's `reservationToken`: a `settling` record
   *   whose stored token hash matches moves straight to `forwarding`,
   *   forwardCount 1, and the answer is `forward`. This is the in-process
   *   first forward, the only one that needs no proof.
   * - Without a token: a `settlement_unknown` record, or a `settling` record
   *   with no token hash (cleared at startup, or by a later request past
   *   `RESERVATION_DEADLINE_MS`), becomes `settled`, and the
   *   answer is `settled`. Forwarding it needs a proof.
   * - Anything else changes nothing and answers `not_settleable`; the caller
   *   reads the record again and answers by its state.
   */
  markSettled(
    key: string,
    input: { txHash: string; settledAt: string; reservationToken?: string },
  ): Promise<'forward' | 'settled' | 'not_settleable'>

  /**
   * settling → settlement_unknown, clearing the token hash: the reserving
   * request gave up learning the settle outcome and answers 503.
   */
  markSettlementUnknown(key: string, now: string): Promise<void>

  /**
   * settling → removed: any failure before settlement (verify rejected,
   * settle definitely failed with the authorization unused).
   */
  release(key: string): Promise<void>

  /**
   * Atomically move a settled, failed or stale forwarding record to
   * forwarding. The core calls it only after it has verified a
   * SIGN-IN-WITH-X proof from the record's payer; the store checks no proof.
   */
  beginForwarding(key: string, now: string): Promise<'forward' | 'in_flight' | 'delivered' | 'exhausted'>

  markDelivered(key: string, input: { upstreamStatus: number; deliveredAt: string }): Promise<void>

  markFailed(key: string, input: { reason: string; failedAt: string }): Promise<void>

  markSaleReported(key: string): Promise<void>

  get(key: string): Promise<ConsumedPaymentRecord | null>
}

/**
 * The key is the payment authorization's identity, not the transaction hash,
 * because a duplicate can arrive before the settlement transaction exists:
 * `eip3009:<chain>:<payer>:<nonce>` or
 * `erc7710:<chain>:<delegator>:<permissionContextHash>`, lower-cased. It is
 * derivable from the payment header alone.
 */
export function paymentStoreKey(
  method: 'eip3009' | 'erc7710' | (string & {}),
  chainId: number,
  payerOrDelegator: string,
  nonceOrContextHash: string,
): string {
  return `${method}:${chainId}:${payerOrDelegator}:${nonceOrContextHash}`.toLowerCase()
}

/** The most times one payment is forwarded in all (§6, the states). */
export const MAX_FORWARDS_PER_PAYMENT = 3

export interface InMemoryConsumedPaymentStoreOptions {
  /** `forwarding` records older than this many ms are taken over by `beginForwarding`. Default: never. */
  takeoverAfterMs?: number
}

interface StoredPayment {
  record: ConsumedPaymentRecord
  /** SHA-256 of the reservation token; absent once cleared or never set. */
  tokenHash?: string
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * The demo merchant's store: a `Map` behind the interface. It honours the
 * interface's conditional semantics (the token is compared by hash and is
 * never returned by `get` or by `reserve`'s known-key answer), and a record
 * handed out is a copy, so a caller cannot edit the store's own.
 */
export function createInMemoryConsumedPaymentStore(
  options: InMemoryConsumedPaymentStoreOptions = {},
): ConsumedPaymentStore {
  const entries = new Map<string, StoredPayment>()
  const copy = (record: ConsumedPaymentRecord): ConsumedPaymentRecord => ({ ...record })

  return {
    async reserve(input) {
      const existing = entries.get(input.key)
      if (existing) return { reserved: false, record: copy(existing.record) }
      const reservationToken = randomUUID()
      entries.set(input.key, {
        tokenHash: hashToken(reservationToken),
        record: {
          key: input.key,
          state: 'settling',
          productId: input.productId,
          chain: input.chain,
          payer: input.payer,
          amount: input.amount,
          validBefore: input.validBefore,
          reservedAt: input.now,
          merchantReference: input.merchantReference,
          authorizationDigest: input.authorizationDigest,
          forwardCount: 0,
          saleReported: false,
        },
      })
      return { reserved: true, reservationToken }
    },

    async markSettled(key, input) {
      const entry = entries.get(key)
      if (!entry) return 'not_settleable'
      const { record } = entry
      if (input.reservationToken !== undefined) {
        if (record.state !== 'settling' || entry.tokenHash !== hashToken(input.reservationToken)) {
          return 'not_settleable'
        }
        record.state = 'forwarding'
        record.forwardCount = 1
        record.forwardingStartedAt = input.settledAt
        record.txHash = input.txHash
        record.settledAt = input.settledAt
        entry.tokenHash = undefined
        return 'forward'
      }
      if (record.state === 'settlement_unknown' || (record.state === 'settling' && entry.tokenHash === undefined)) {
        record.state = 'settled'
        record.txHash = input.txHash
        record.settledAt = input.settledAt
        return 'settled'
      }
      return 'not_settleable'
    },

    async markSettlementUnknown(key) {
      const entry = entries.get(key)
      if (!entry || entry.record.state !== 'settling') return
      entry.record.state = 'settlement_unknown'
      entry.tokenHash = undefined
    },

    async release(key) {
      const entry = entries.get(key)
      if (entry && entry.record.state === 'settling') entries.delete(key)
    },

    async beginForwarding(key, now) {
      const entry = entries.get(key)
      if (!entry) return 'in_flight'
      const { record } = entry
      if (record.state === 'delivered') return 'delivered'
      if (record.state === 'exhausted') return 'exhausted'
      if (record.state === 'forwarding') {
        const startedAt = record.forwardingStartedAt ? Date.parse(record.forwardingStartedAt) : NaN
        const stale =
          options.takeoverAfterMs !== undefined &&
          Number.isFinite(startedAt) &&
          Date.parse(now) - startedAt > options.takeoverAfterMs
        if (!stale) return 'in_flight'
        record.state = 'failed'
        record.failedAt = now
      }
      if (record.state === 'settled' || record.state === 'failed') {
        if (record.forwardCount >= MAX_FORWARDS_PER_PAYMENT) {
          record.state = 'exhausted'
          return 'exhausted'
        }
        record.state = 'forwarding'
        record.forwardCount += 1
        record.forwardingStartedAt = now
        return 'forward'
      }
      // `settling` and `settlement_unknown` are resolved by the core, not forwarded.
      return 'in_flight'
    },

    async markDelivered(key, input) {
      const entry = entries.get(key)
      if (!entry || entry.record.state !== 'forwarding') return
      entry.record.state = 'delivered'
      entry.record.upstreamStatus = input.upstreamStatus
      entry.record.deliveredAt = input.deliveredAt
    },

    async markFailed(key, input) {
      const entry = entries.get(key)
      if (!entry || entry.record.state !== 'forwarding') return
      entry.record.state = 'failed'
      entry.record.failureReason = input.reason
      entry.record.failedAt = input.failedAt
    },

    async markSaleReported(key) {
      const entry = entries.get(key)
      if (entry) entry.record.saleReported = true
    },

    async get(key) {
      const entry = entries.get(key)
      return entry ? copy(entry.record) : null
    },
  }
}
