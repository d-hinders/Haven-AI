import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearEntryLatches, hasEntered, markEntered } from '@/lib/entry-latch'

/**
 * #4704: the entry latch is per tab (sessionStorage), per user, and per
 * consumer, and sign-out clears it.
 */
describe('entry latch (#4704)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    window.sessionStorage.clear()
  })

  it('a fresh tab has not entered; marking records it', () => {
    expect(hasEntered('count-up', 'user-1')).toBe(false)
    markEntered('count-up', 'user-1')
    expect(hasEntered('count-up', 'user-1')).toBe(true)
  })

  it('one key per consumer: marking count-up does not consume last-visit', () => {
    markEntered('count-up', 'user-1')
    expect(hasEntered('last-visit', 'user-1')).toBe(false)
  })

  it('per user: another user signing in on this tab still gets an entrance', () => {
    markEntered('count-up', 'user-1')
    expect(hasEntered('count-up', 'user-2')).toBe(false)
  })

  it('clearEntryLatches removes every consumer and leaves unrelated keys alone', () => {
    markEntered('count-up', 'user-1')
    markEntered('last-visit', 'user-1')
    window.sessionStorage.setItem('unrelated', 'keep')
    clearEntryLatches()
    expect(hasEntered('count-up', 'user-1')).toBe(false)
    expect(hasEntered('last-visit', 'user-1')).toBe(false)
    expect(window.sessionStorage.getItem('unrelated')).toBe('keep')
  })

  it('storage that throws reads as already entered, and marking does not throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(hasEntered('count-up', 'user-1')).toBe(true)
    expect(() => markEntered('count-up', 'user-1')).not.toThrow()
    expect(() => clearEntryLatches()).not.toThrow()
  })
})
