import { describe, expect, it } from 'vitest'
import {
  RETIRED_AGENTS_REPORT_WINDOW_MINUTES,
  retiredAgentsReportWindowOpen,
} from '../agent-connection-setup.js'

// #3772 code review: a retired-agents report is accepted only from the
// connector run that registered the setup, not months later.
describe('retiredAgentsReportWindowOpen (#3772)', () => {
  const now = new Date('2026-10-13T12:00:00Z')
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000)

  it('is open at registration and through the last minute of the window', () => {
    expect(retiredAgentsReportWindowOpen(now, now)).toBe(true)
    expect(retiredAgentsReportWindowOpen(minutesAgo(RETIRED_AGENTS_REPORT_WINDOW_MINUTES), now)).toBe(true)
    expect(retiredAgentsReportWindowOpen(minutesAgo(5).toISOString(), now)).toBe(true)
  })

  it('is closed after the window, and for a setup never registered or a bad timestamp', () => {
    expect(retiredAgentsReportWindowOpen(minutesAgo(RETIRED_AGENTS_REPORT_WINDOW_MINUTES + 1), now)).toBe(false)
    expect(retiredAgentsReportWindowOpen(null, now)).toBe(false)
    expect(retiredAgentsReportWindowOpen(undefined, now)).toBe(false)
    expect(retiredAgentsReportWindowOpen('not a date', now)).toBe(false)
  })
})
