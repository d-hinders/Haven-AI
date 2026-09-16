'use client'

import { ANALYTICS_RANGE_OPTIONS } from '@/lib/analytics-range'
import type { AnalyticsRangeValue } from '@/lib/analytics-range'
import { SegmentedControl } from '@/components/ui/SegmentedControl'

/**
 * The range control (#2947, epic #2944 slice C).
 *
 * A thin wrapper over `SegmentedControl` for exactly one reason: the three
 * windows and their labels are the page's contract with the endpoint's
 * `range` enum, and they must not be re-typed at a second call site. The
 * control itself is deliberately not the thing that persists — see
 * `lib/analytics-range.ts` for why the read lives in the `useState`
 * initialiser rather than in an effect, and the same reason applies to the
 * write: this component stays a pure control, and the client owns persistence
 * inside its `onChange` handler.
 */
export function RangeControl({
  value,
  onChange,
  disabled = false,
}: {
  value: AnalyticsRangeValue
  onChange: (value: AnalyticsRangeValue) => void
  disabled?: boolean
}) {
  return (
    <SegmentedControl
      ariaLabel="Analytics date range"
      options={ANALYTICS_RANGE_OPTIONS}
      value={value}
      onChange={onChange}
      disabled={disabled}
    />
  )
}

export default RangeControl
