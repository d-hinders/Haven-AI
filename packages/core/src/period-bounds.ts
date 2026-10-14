/**
 * The one period-boundary computation (#3806, epic #3801).
 *
 * A delegation budget's period runs from the row's `start_date` (Unix
 * SECONDS): `start_date + k × period_seconds`. It is anchored on `start_date`
 * — not on creation time: budgets are signed with `startDate: nowSec - 60`
 * (`routes/agent-delegations.ts`), and a re-key's carry/steady pair keeps the
 * old boundary (`modules/agents/rekey-carry.ts`). Both sides of the wire —
 * the backend that computes `period_end` for a read and the frontend that
 * captions the next refill — import this ONE definition, so neither can drift
 * (`routes/agent-delegations.ts` and `infra/repositories/analytics.ts` used
 * to share it inside the backend only; the dashboard caption now needs the
 * same arithmetic).
 *
 * Pure seconds math on purpose: this package stays free of I/O and of any
 * clock. Callers pass `nowSec`; nobody here reads the time.
 *
 * Moved from `packages/backend/src/infra/chain/delegation-budget-reader.ts`
 * verbatim (#3693 introduced it there) — the arithmetic is unchanged.
 */
export function currentPeriodBounds(
  startDateSec: number,
  periodSeconds: number,
  nowSec: number,
): { start: number; end: number } {
  if (periodSeconds <= 0 || nowSec < startDateSec) return { start: startDateSec, end: startDateSec + periodSeconds }
  const elapsed = nowSec - startDateSec
  const periodsElapsed = Math.floor(elapsed / periodSeconds)
  const start = startDateSec + periodsElapsed * periodSeconds
  return { start, end: start + periodSeconds }
}
