/**
 * Render a THROWN scenario error with the structured context it carries
 * (#1518).
 *
 * WHY. A scenario reports a failure two ways: `return fail(...)`, where the
 * author chose the wording, and by THROWING, where the harness had been
 * keeping `e.message` and dropping everything else. That is a real loss,
 * because the SDK's errors are deliberately structured — `HavenApiError`
 * carries a `body`, and the funded-retry path fills it with exactly what a
 * triager needs:
 *
 *     throw new HavenApiError(
 *       'x402 retry failed after Haven funded the delegate wallet; …',
 *       merchant.merchant_status,
 *       { marker: 'x402_retry_rejected_after_funding', merchant_body, … },
 *     )
 *
 * The message is generic by construction — it reads the same whether the
 * merchant said "insufficient funds", returned a 500, or timed out. On
 * 2026-08-17 that cost a full extra triage round on `x402-delegation-3009`,
 * immediately after the same class of blindness (#1516, #1517) had been fixed
 * on the non-throwing path. Fixing it in the harness rather than per-scenario
 * means it covers every leg, including ones not yet written.
 *
 * Deliberately conservative: this only ADDS context to a message the scenario
 * already produced, is capped so one error cannot flood the report, and never
 * throws — a formatter that can fail the run it is explaining is worse than no
 * formatter.
 */

/** The fields worth surfacing, in the order a triager reads them. */
const INTERESTING_KEYS = [
  'marker',
  'merchant_status',
  'merchant_status_text',
  'merchant_body',
  'merchant_to',
  'delegate_to',
  'tx_hash',
  'payment_id',
  'code',
  'error',
  'message',
] as const

const MAX_VALUE = 200
const MAX_TOTAL = 700

function renderValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.trim() ? value.slice(0, MAX_VALUE) : null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value).slice(0, MAX_VALUE)
  } catch {
    return null
  }
}

/**
 * Build the detail line for a scenario that threw.
 *
 * Returns the error message, plus any structured context found on it. Safe on
 * any input, including non-Error throws.
 */
export function thrownErrorDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)

  // `body` is HavenApiError's payload; `data` covers hand-rolled errors that
  // follow the same convention.
  const carrier = err as { body?: unknown; data?: unknown; statusCode?: unknown } | null
  const payload = carrier?.body ?? carrier?.data
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    // No structured context. Still worth the status code when there is one —
    // it separates "merchant refused" from "merchant never answered".
    const status = carrier?.statusCode
    return typeof status === 'number' ? `${message} [HTTP ${status}]` : message
  }

  const record = payload as Record<string, unknown>
  const parts: string[] = []
  for (const key of INTERESTING_KEYS) {
    if (!(key in record)) continue
    const rendered = renderValue(record[key])
    if (rendered === null) continue
    // Don't echo the message back at itself.
    if (rendered === message) continue
    parts.push(`${key}=${rendered}`)
  }

  if (parts.length === 0) return message
  const context = parts.join(' ')
  return `${message} — ${context.slice(0, MAX_TOTAL)}`
}
