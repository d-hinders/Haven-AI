import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatAgentLastSeen,
  formatAgentLastSeenValue,
  formatAgentLastSeenTitle,
} from '../agent-last-seen'

describe('agent last-seen formatting', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('formats a populated timestamp as calm last-seen copy', () => {
    expect(formatAgentLastSeen('2026-06-01T10:00:00Z')).toBe('Last seen 2h ago')
    expect(formatAgentLastSeenValue('2026-06-01T10:00:00Z')).toBe('2h ago')
  })

  it('uses a clear empty-state label when the agent has not connected yet', () => {
    expect(formatAgentLastSeen(null)).toBe('Not connected yet')
    expect(formatAgentLastSeenValue(undefined)).toBe('Not connected yet')
  })

  it('treats invalid timestamps as not connected', () => {
    expect(formatAgentLastSeen('not-a-date')).toBe('Not connected yet')
    expect(formatAgentLastSeenValue('not-a-date')).toBe('Not connected yet')
    expect(formatAgentLastSeenTitle('not-a-date')).toBeUndefined()
  })
})
