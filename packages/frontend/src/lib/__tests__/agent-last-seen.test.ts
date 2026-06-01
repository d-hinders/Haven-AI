import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatAgentLastActivity,
  formatAgentLastActivityValue,
  formatAgentLastActivityTitle,
} from '../agent-last-seen'

describe('agent last-activity formatting', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('formats a populated timestamp as calm last-activity copy', () => {
    expect(formatAgentLastActivity('2026-06-01T10:00:00Z')).toBe('Last activity 2h ago')
    expect(formatAgentLastActivityValue('2026-06-01T10:00:00Z')).toBe('2h ago')
  })

  it('uses a clear empty-state label when the agent has no activity yet', () => {
    expect(formatAgentLastActivity(null)).toBe('No activity yet')
    expect(formatAgentLastActivityValue(undefined)).toBe('No activity yet')
  })

  it('treats invalid timestamps as no activity', () => {
    expect(formatAgentLastActivity('not-a-date')).toBe('No activity yet')
    expect(formatAgentLastActivityValue('not-a-date')).toBe('No activity yet')
    expect(formatAgentLastActivityTitle('not-a-date')).toBeUndefined()
  })
})
