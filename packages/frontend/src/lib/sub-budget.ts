/**
 * Pure helpers for the "Issue sub-budget" modal (#3506): exact decimal→atomic
 * conversion, date→unix-seconds, and the plain-words copy for each refusal the
 * `POST /agents/:id/sub-budgets` route can answer. No React, no I/O.
 */
import { parseTokenAmount } from '@haven_ai/core'

export type SubBudgetAmountFailure = 'empty' | 'invalid' | 'too_many_decimals' | 'not_positive'

export type SubBudgetAmountResult = { ok: true; atomic: string } | { ok: false; reason: SubBudgetAmountFailure }

/** Exact decimal-string math — never a float. `"1.5"` at 6 decimals is `"1500000"`. */
export function parseSubBudgetAmount(input: string, decimals: number): SubBudgetAmountResult {
  const value = input.trim()
  if (value === '') return { ok: false, reason: 'empty' }
  // A leading minus is "not above zero", not "malformed".
  if (/^-\s*[0-9.]/.test(value)) return { ok: false, reason: 'not_positive' }
  if (!/^[0-9]*\.?[0-9]*$/.test(value)) return { ok: false, reason: 'invalid' }
  let atomic: bigint
  try {
    atomic = parseTokenAmount(value, decimals)
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    return { ok: false, reason: message.startsWith('too many decimals') ? 'too_many_decimals' : 'invalid' }
  }
  if (atomic <= 0n) return { ok: false, reason: 'not_positive' }
  return { ok: true, atomic: atomic.toString() }
}

export function amountErrorCopy(reason: SubBudgetAmountFailure, decimals: number): string | null {
  switch (reason) {
    case 'empty':
      return null
    case 'invalid':
      return 'Enter the amount as a plain number, like 25 or 12.50.'
    case 'too_many_decimals':
      return `Use at most ${decimals} decimal places.`
    case 'not_positive':
      return 'Enter an amount above zero.'
  }
}

/**
 * A calendar date (`YYYY-MM-DD`) → unix seconds for the END of that day (UTC),
 * clamped to the parent budget's own expiry when given — picking the parent's
 * last day must not be refused for outliving it by a few hours. Null when the
 * date is malformed or the result is not in the future.
 */
export function expiryDateToUnixSeconds(
  date: string,
  nowSec: number,
  parentExpiresAtSec?: number,
): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59)
  if (!Number.isFinite(ms)) return null
  let sec = Math.floor(ms / 1000)
  if (parentExpiresAtSec !== undefined && sec > parentExpiresAtSec) sec = parentExpiresAtSec
  return sec > nowSec ? sec : null
}

/**
 * True when the chosen calendar date ends after the parent budget does, so
 * {@link expiryDateToUnixSeconds} will pull it back to the parent's end. The
 * UI states that clamp instead of applying it silently (#3506 design review).
 */
export function endDateIsClamped(date: string, parentExpiresAtSec: number): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return false
  const endOfDaySec = Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59) / 1000)
  return Number.isFinite(endOfDaySec) && endOfDaySec > parentExpiresAtSec
}

/** A unix-seconds instant as a human date, e.g. "2 Jun 2027" (UTC, so stable in every timezone). */
export function formatSubBudgetDate(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

/** `YYYY-MM-DD` (UTC) for a unix-seconds instant — the `<input type="date">` format. */
export function unixSecondsToDateInput(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10)
}

/**
 * The plain-words reading of a refused issue. `delegatingName` is the agent
 * whose budget the slice comes out of. Never an error code, never "delegation".
 */
export function subBudgetRefusalCopy(
  err: { status?: number; body?: unknown },
  delegatingName: string,
  subAgentName: string,
): string {
  const body = (err.body ?? {}) as { error_code?: string; reason?: string }
  switch (body.error_code) {
    case 'sub_budget_wider_than_parent':
      if (body.reason === 'amount') {
        return `This is more than ${delegatingName}'s own budget allows per period. Lower the amount.`
      }
      if (body.reason === 'expiry') {
        return `This would last longer than ${delegatingName}'s own budget. Choose an earlier end date.`
      }
      if (body.reason === 'recipient') {
        return `${delegatingName}'s budget only pays one specific recipient, so this one must use the same recipient.`
      }
      return `This is wider than ${delegatingName}'s own budget allows. Narrow the amount, end date or recipient.`
    case 'parent_not_period_scoped':
      return `${delegatingName}'s budget covers more than one token, so it can't be shared yet. Set a single-token budget first.`
    case 'sub_budget_exceeds_remaining':
      return `${delegatingName} has already shared most of this budget with other agents. Lower the amount, or stop another sub-budget first.`
    case 'no_delegation_for_target':
      return `${delegatingName} has no active budget for this token and recipient. Set a budget first, then share part of it.`
    case 'not_delegation_rail':
      return `${subAgentName} isn't ready to receive a budget yet. Finish connecting it, then try again.`
    default:
      break
  }
  if (err.status === 404) return `Haven could not find ${subAgentName} in this account. Pick another agent.`
  return 'Haven could not issue this sub-budget. Check the details and try again.'
}
