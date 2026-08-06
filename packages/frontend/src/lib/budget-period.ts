import { RESET_PERIODS } from './allowance-module'

/**
 * Human phrasing for an allowance/budget reset period, shared by the
 * connect-agent flow and the agent panel (#989 pattern absorption — the same
 * mapping used to be copied into each component).
 */
export function budgetPeriodLabel(mins: number): string {
  const label = (RESET_PERIODS.find((period) => period.value === mins)?.label ?? `${mins}m`).toLowerCase()
  if (label === 'one-time') return 'total budget'
  if (label === 'daily') return 'per day'
  if (label === 'weekly') return 'per week'
  if (label === 'monthly') return 'per month'
  return `every ${label}`
}
