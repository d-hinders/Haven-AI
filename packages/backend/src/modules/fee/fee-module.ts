import {
  getRecordedFeeRow,
  insertPaymentFee,
  type RecordedFeeRow,
} from '../../infra/repositories/payment-fees.js'
import { config } from '../../config.js'

/**
 * Haven platform fee module — scaffold slice of epic #386.
 *
 * Owns the fee **policy + accounting** (how much, why, idempotency, recording);
 * a per-rail `RailFeeExecutor` (deferred) owns only the on-chain settlement
 * mechanics. This slice ships the zero-fee path and the ledger: while
 * `config.feeEnabled` is false the quote is always zero and **no funds move**.
 *
 * Non-negotiables carried from #386:
 * - The fee is a surcharge on the payer, never a skim — enforced where the
 *   executor draws funds (deferred), not here.
 * - Idempotent per `paymentId`: recording twice never double-charges.
 * - The zero-fee path (flag off, free tier, local MCP) is first-class.
 */

export interface FeeContext {
  paymentId: string
  rail: string
  /** Gross amount being paid to the merchant, atomic units. */
  grossAtomic: bigint
  token: string
  userId: string
}

export interface FeeQuote {
  paymentId: string
  rail: string
  feeAtomic: bigint
  feeToken: string
  /** Fee as basis points of gross (0 while dark). */
  basisPoints: number
  /** True when no fee applies — the executor cleanly no-ops. */
  isZero: boolean
}

/**
 * On-chain settlement mechanics for one rail. Implementations (x402, MPP) are
 * deferred sub-issues of #386 — they move funds and need pricing + treasury +
 * regulatory review. The interface is declared here so the module's boundary is
 * explicit and rails plug in without re-deriving fee logic.
 */
export interface RailFeeExecutor {
  rail: string
  /** Settle the fee on-chain, returning a tx reference. */
  collect(quote: FeeQuote, ctx: FeeContext): Promise<{ txRef: string }>
}

function zeroQuote(ctx: FeeContext): FeeQuote {
  return {
    paymentId: ctx.paymentId,
    rail: ctx.rail,
    feeAtomic: 0n,
    feeToken: ctx.token,
    basisPoints: 0,
    isZero: true,
  }
}

/**
 * Quote the fee for a payment. Pure. Returns a zero quote while the module is
 * dark (no rate source wired yet) — real, server-driven rates are a deferred
 * sub-issue. Never throws.
 */
export function quoteFee(ctx: FeeContext): FeeQuote {
  if (!config.feeEnabled) return zeroQuote(ctx)
  // Pricing is server-driven and not yet wired — until it is, the safe default
  // is zero so no funds move even if the flag is flipped early.
  return zeroQuote(ctx)
}

/**
 * Record a settled fee in the central ledger, idempotently per `paymentId`.
 * Writing a zero-fee row is the dark-mode behaviour — it gives the bookkeeping
 * export a complete, reconcilable fee history without collecting anything.
 */
export async function recordSettledFee(
  quote: FeeQuote,
  opts: { feeSek?: string | null; txRef?: string | null } = {},
): Promise<void> {
  // SQL lives in infra/repositories/payment-fees.ts (#999) — idempotent per
  // paymentId there (ON CONFLICT DO NOTHING).
  await insertPaymentFee({
    paymentId: quote.paymentId,
    rail: quote.rail,
    feeAmountAtomic: quote.feeAtomic.toString(),
    feeToken: quote.feeToken,
    feeSek: opts.feeSek ?? null,
    txRef: opts.txRef ?? null,
  })
}

export type RecordedFee = RecordedFeeRow

export async function getRecordedFee(paymentId: string): Promise<RecordedFee | null> {
  return getRecordedFeeRow(paymentId)
}

/** The #386 module surface (quote + recordSettled), for callers/shells. */
export const HavenFeeModule = {
  quote: quoteFee,
  recordSettled: recordSettledFee,
}
