/**
 * The settle-exactly-once coordinator (#4890; docs/architecture/12-merchant-kit.md §6).
 *
 * Moved from `createX402PaymentProcessor` in
 * `packages/demo-merchant-mcp/src/x402.ts`. It is generic over the payment
 * rail: a rail hands it a `VerifiedPayment` whose `submit` sends the
 * settlement, and the coordinator guarantees the settlement is sent at most
 * once per payment authorization in this process, and records it in a
 * `ConsumedPaymentStore`.
 *
 * Two things stay process-local on purpose: the in-flight `attempts` map (a
 * second call for the same payment shares the first's promise), and the
 * `payments` map that re-serves a settled payment as the SAME object (callers
 * cache per-payment work by object identity). The store is the record.
 */
import { randomUUID } from 'node:crypto'
import type { Address, Hex } from 'viem'
import { encodePaymentResponseHeader } from '@x402/core/http'
import type { SettleResponse } from '@x402/core/types'
import type { PassportReference } from '@haven_ai/sdk'
import { paymentStoreKey, type ConsumedPaymentStore } from './consumed-payment-store.js'
import {
  AuthorizationAlreadyUsedError,
  PaymentError,
  SettlementRevertedError,
  ZERO_TX_HASH,
} from './payment-checks.js'

/**
 * #2969: the explicit truth about what actually happened on-chain, replacing
 * the #2970 boolean (`settled?: boolean`) that was inferred from
 * `txHash !== ZERO_TX_HASH`. A boolean could not distinguish the two
 * zero-hash paths from each other, and they are different facts:
 *
 *  - `settled_onchain`: the normal path — a real settlement transaction was
 *    submitted AND its receipt was observed (`confirmSubmittedPayment`).
 *  - `already_settled_earlier`: `AuthorizationAlreadyUsedError` recovery — the
 *    chain says this authorization (or, on erc7710, this settlement child)
 *    already moved the money in an EARLIER transaction that this process did
 *    not submit and cannot name. The goods are owed; there is no hash to show.
 *  - `settlement_unknown`: the `MERCHANT_SKIP_SETTLE_PRODUCT` QA hook — no
 *    settlement was ever attempted, so nothing is known either way.
 *
 * This is display/reporting-only — the wire to the buyer (`paymentResponse`,
 * `paymentResponseHeader`) is UNCHANGED, still carrying
 * `transaction: ZERO_TX_HASH` on the two non-settled paths exactly as before.
 * That is the x402 protocol surface; this field is not on it.
 */
export type SettlementState = 'settled_onchain' | 'already_settled_earlier' | 'settlement_unknown'

/**
 * #2969: the state is caller-supplied (the hash alone cannot tell the two
 * zero-hash paths apart), so pin the one thing the hash CAN say: a real hash
 * is `settled_onchain` and the zero hash never is. A caller that disagrees is
 * a bug, not a receipt — throw before anything is rendered or delivered.
 */
export function assertSettlementConsistent(txHash: Hex, settlement: SettlementState): void {
  const realHash = txHash !== ZERO_TX_HASH
  if (realHash !== (settlement === 'settled_onchain')) {
    throw new Error(`settlement "${settlement}" contradicts txHash ${txHash}`)
  }
}

export interface SettledPayment<P extends string = string, M extends string = string> {
  productId: P
  settlementMethod: M
  from: Address
  to: Address
  value: bigint
  nonce: Hex
  txHash: Hex
  paymentResponse: SettleResponse
  paymentResponseHeader: string
  /** #2969: see `SettlementState`. Always set, never inferred from `txHash`. */
  settlement: SettlementState
  /**
   * #4723: the `haven-passport` reference the payment carried, if any.
   *
   * Display/reporting-only, exactly like `settlement`: it is NOT on the x402
   * wire and the settle path never reads it. `null` means there is nothing to
   * check — the key was absent, or it was present but empty (the normal shape
   * for an agent with no passport, since the #4722 client only adds fields when
   * it has one). `{}` means the key was present but not a plain object: the
   * reference is malformed, and the check answers `subject_mismatch` rather
   * than silently treating it as absent.
   */
  passportReference: PassportReference | null
}

/** Rail-agnostic description of one verified payment, ready to settle exactly once. */
export interface VerifiedPayment<M extends string = string> {
  /** The payer: the EIP-3009 `from`, or the ERC-7710 delegator. With `settlementMethod`
   *  and `nonce` this is the payment's identity (`paymentStoreKey`). */
  payer: Address
  payTo: Address
  /** EIP-3009: the authorization nonce. erc7710: the permissionContext hash — one
   *  redemption per delegation in this demo; multi-redemption budget delegations are
   *  intentionally not supported here, the on-chain caveats are the real enforcement. */
  nonce: Hex
  settlementMethod: M
  /** #4723: the `haven-passport` reference the payload carried, if any. */
  passportReference: PassportReference | null
  /** The authorization's `validBefore`, in seconds; 0 when the rail has none. */
  validBefore: number
  /** SHA-256 hex of the payment header as presented. */
  authorizationDigest: string
  submit: () => Promise<Hex>
}

export function buildSettledPayment<P extends string, M extends string>(
  params: {
    network: `eip155:${number}`
    productId: P
    verified: Pick<VerifiedPayment<M>, 'payer' | 'payTo' | 'nonce' | 'settlementMethod' | 'passportReference'>
    expectedAmount: bigint
  },
  txHash: Hex,
  settlement: SettlementState,
): SettledPayment<P, M> {
  assertSettlementConsistent(txHash, settlement)
  const response: SettleResponse = {
    success: true,
    payer: params.verified.payer,
    transaction: txHash,
    network: params.network,
    amount: params.expectedAmount.toString(),
  }
  return {
    productId: params.productId,
    settlementMethod: params.verified.settlementMethod,
    from: params.verified.payer,
    to: params.verified.payTo,
    value: params.expectedAmount,
    nonce: params.verified.nonce,
    txHash,
    // #2969: explicit, caller-supplied state — see `SettlementState`.
    settlement,
    // #4723: display-only, never on the wire.
    passportReference: params.verified.passportReference,
    paymentResponse: response,
    paymentResponseHeader: encodePaymentResponseHeader(response),
  }
}

export interface SettleOnceOptions {
  store: ConsumedPaymentStore
  chainId: number
  /** Resolves once the transaction is mined and succeeded; rejects with
   *  `SettlementRevertedError` when it was mined and reverted. */
  waitForReceipt: (txHash: Hex) => Promise<void>
}

export interface SettleOnceParams<P extends string, M extends string> {
  productId: P
  verified: VerifiedPayment<M>
  expectedAmount: bigint
}

interface SettlementAttempt {
  productId: string
  txHash?: Hex
  reservationToken?: string
  promise?: Promise<SettledPayment<string, string>>
}

export function createSettleOnce<P extends string = string, M extends string = string>(
  options: SettleOnceOptions,
): (params: SettleOnceParams<P, M>) => Promise<SettledPayment<P, M>> {
  const { store, chainId } = options
  const network = `eip155:${chainId}` as const
  const attempts = new Map<string, SettlementAttempt>()
  // The payment as first served, by store key: re-serving it returns this very object.
  const payments = new Map<string, SettledPayment<P, M>>()

  async function settleOnce(params: SettleOnceParams<P, M>): Promise<SettledPayment<P, M>> {
    const { verified } = params
    const key = paymentStoreKey(verified.settlementMethod, chainId, verified.payer, verified.nonce)

    const existing = payments.get(key)
    if (existing) {
      if (existing.productId !== params.productId) {
        throw new PaymentError('Payment authorization has already settled a different product')
      }
      return existing
    }

    const attempt = attempts.get(key)
    if (attempt) {
      if (attempt.productId !== params.productId) {
        throw new PaymentError('Payment authorization is already settling a different product')
      }
      if (attempt.promise) {
        return (await attempt.promise) as SettledPayment<P, M>
      }
      if (attempt.txHash) {
        const retry = confirmSubmittedPayment(params, key, attempt.txHash, attempt.reservationToken)
        attempt.promise = retry
        try {
          return await retry
        } finally {
          attempt.promise = undefined
        }
      }
    }

    const nextAttempt: SettlementAttempt = { productId: params.productId }
    attempts.set(key, nextAttempt)
    const promise = (async (): Promise<SettledPayment<P, M>> => {
      // Reserved just before the settlement is sent, after every check the
      // rail makes: the store holds a payment from here until it is settled
      // or released.
      const reservation = await store.reserve({
        key,
        productId: params.productId,
        chain: network,
        payer: verified.payer,
        amount: params.expectedAmount.toString(),
        validBefore: verified.validBefore,
        merchantReference: randomUUID(),
        authorizationDigest: verified.authorizationDigest,
        now: new Date().toISOString(),
      })
      if (!reservation.reserved) {
        // Known to the store but not to this process's maps (a persistent
        // store after a restart). Another product's payment is refused; the
        // same product's is not settled again from here.
        if (reservation.record.productId !== params.productId) {
          throw new PaymentError('Payment authorization has already settled a different product')
        }
        throw new PaymentError(
          'This payment authorization is already recorded and is not being settled by this request. Retry the same payment header shortly.',
        )
      }
      nextAttempt.reservationToken = reservation.reservationToken

      let txHash: Hex
      try {
        txHash = await verified.submit()
      } catch (err) {
        if (err instanceof AuthorizationAlreadyUsedError) {
          // The chain says this authorization already moved the money (#1519).
          // In-memory `payments`/`attempts` are the fast path; the chain is the
          // TRUTH, and it survives the restarts they do not. Record the
          // settlement so the buyer is told what actually happened — the goods
          // are owed — rather than being charged and handed a 402.
          // #4851: the CDP path may recover the transaction that moved it
          // from USDC's own events; then the receipt carries that reference.
          const payment = err.txHash
            ? buildSettledPayment({ ...params, network }, err.txHash, 'settled_onchain')
            : buildSettledPayment({ ...params, network }, ZERO_TX_HASH, 'already_settled_earlier')
          payments.set(key, payment)
          await recordSettled(key, payment.txHash, reservation.reservationToken)
          return payment
        }
        // `submit` threw before anything is known to have moved: the key is
        // free again, so a retry reserves it afresh.
        await store.release(key)
        throw err
      }
      nextAttempt.txHash = txHash
      return confirmSubmittedPayment(params, key, txHash, reservation.reservationToken)
    })()

    nextAttempt.promise = promise
    try {
      return await promise
    } finally {
      nextAttempt.promise = undefined
      // #3099: an attempt with no tx hash is over — either `submit` threw (retry
      // must resubmit) or the chain said the authorization was already used
      // (the `payments` cache now answers every later call for this key before
      // `attempts` is consulted, and a different product is refused by the
      // product check above). The clause `&& !payments.has(key)` that used to
      // guard this delete was unreachable in any observable way, so it is gone
      // rather than left as a guard nothing can test. The delete itself IS
      // observable: after a generic submit failure a different product on the
      // same authorization must not be refused by the stale in-flight record —
      // pinned by the test that mutates this `if` away.
      if (!nextAttempt.txHash) {
        attempts.delete(key)
      }
    }
  }

  async function recordSettled(key: string, txHash: Hex, reservationToken: string | undefined): Promise<void> {
    // The settlement is on-chain whatever the store says; a store that fails
    // here must not turn a paid purchase into a refusal.
    try {
      await store.markSettled(key, { txHash, settledAt: new Date().toISOString(), reservationToken })
    } catch (err) {
      console.error('[x402] consumed-payment store: markSettled failed', {
        key,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      })
    }
  }

  async function confirmSubmittedPayment(
    params: SettleOnceParams<P, M>,
    key: string,
    txHash: Hex,
    reservationToken: string | undefined,
  ): Promise<SettledPayment<P, M>> {
    try {
      await options.waitForReceipt(txHash)
    } catch (err) {
      if (err instanceof SettlementRevertedError) {
        // #1278: a mined-and-reverted tx is final for THIS submission but not
        // for the authorization — clear the attempt so the buyer's next retry
        // resubmits instead of re-confirming the dead hash forever. Any other
        // error is treated as transient and keeps the hash for re-confirmation.
        attempts.delete(key)
        await store.release(key)
        throw new PaymentError(
          `Settlement transaction reverted on-chain (${txHash}). ` +
            'Retry the request with the same payment header to resubmit.',
        )
      }
      throw err
    }
    const payment = buildSettledPayment({ ...params, network }, txHash, 'settled_onchain')
    payments.set(key, payment)
    await recordSettled(key, txHash, reservationToken)
    return payment
  }

  return settleOnce
}
