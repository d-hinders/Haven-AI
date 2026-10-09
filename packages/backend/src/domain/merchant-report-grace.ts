import { config } from '../config.js'

/**
 * The merchant-report grace window (#2145, shared with #3767).
 *
 * This is a DOMAIN LEAF: it imports only config, so both `modules/payments`
 * (the payment status) and `modules/accounting` (the feed's pre-claim
 * deferral) can depend on it without creating a module cycle — the accounting
 * feed must wait out the SAME window on the SAME clock as the status.
 */

/**
 * #2145: how long after the funding leg confirms before a missing merchant
 * report means "the agent is gone" rather than "the agent is mid-retry".
 *
 * A live agent retries the merchant within seconds of the funding
 * confirmation; inside this window the status must not instruct a concurrent
 * second retry. The figure mirrors the delegate-balance monitor's
 * IN_FLIGHT_WINDOW_MIN (`infra/delegate-balance-monitor.ts`), which encodes
 * the same judgement about the same interval from the operator side.
 */
export const MERCHANT_REPORT_GRACE_MIN = 15

/**
 * Resolve the short grace period used only by the shared Base Sepolia QA
 * deployment. Production must retain the 15-minute recovery window: a faster
 * answer there could invite a concurrent retry while a live agent is still
 * between its funding confirmation and merchant retry.
 */
export function resolveMerchantReportGraceMin(
  rawOverride: string | undefined,
  deployChainIds: readonly number[],
): number {
  if (rawOverride === undefined || rawOverride.trim() === '') return MERCHANT_REPORT_GRACE_MIN

  // An unset chain allow-list means "all supported", so it is not a safe
  // development-only deployment. The opt-in is deliberately restricted to the
  // one-chain Base Sepolia environment rather than becoming a general timing
  // knob for payment status.
  if (deployChainIds.length !== 1 || deployChainIds[0] !== 84532) {
    throw new Error(
      'MERCHANT_REPORT_GRACE_MIN_OVERRIDE is allowed only when HAVEN_DEPLOY_CHAIN_IDS=84532 (Base Sepolia QA).',
    )
  }

  const minutes = Number(rawOverride)
  if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes < 0 || minutes > MERCHANT_REPORT_GRACE_MIN) {
    throw new Error(
      `MERCHANT_REPORT_GRACE_MIN_OVERRIDE must be an integer from 0 to ${MERCHANT_REPORT_GRACE_MIN}.`,
    )
  }
  return minutes
}

/**
 * #3767: EXPORTED, not a literal — the accounting feed's pre-claim deferral
 * (`modules/accounting/feed-orchestrator.ts`) waits out the SAME window on the
 * SAME clock, so the two features cannot drift apart. One resolved value,
 * including the QA override, feeds both.
 */
export const merchantReportGraceMin = resolveMerchantReportGraceMin(
  process.env.MERCHANT_REPORT_GRACE_MIN_OVERRIDE,
  config.deployChainIds,
)

export function merchantReportGraceElapsed(
  confirmedAt: string,
  now = Date.now(),
  graceMin = merchantReportGraceMin,
): boolean {
  const confirmedAtMs = new Date(confirmedAt).getTime()
  return Number.isFinite(confirmedAtMs) && now - confirmedAtMs >= graceMin * 60_000
}
