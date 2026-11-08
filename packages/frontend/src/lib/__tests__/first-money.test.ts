import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasSeenFirstMoney, markFirstMoneySeen } from '@/lib/first-money'

/** #4705: the first-money marker is per user, per device, and outlives the tab. */
describe('first-money marker (#4705)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  it('a device that has seen no money says so; marking records it in localStorage', () => {
    expect(hasSeenFirstMoney('user-1')).toBe(false)
    markFirstMoneySeen('user-1')
    expect(hasSeenFirstMoney('user-1')).toBe(true)
    expect(window.localStorage.getItem('haven-first-money-seen:user-1')).toBe('1')
  })

  it('per user: another user on this device has not seen money', () => {
    markFirstMoneySeen('user-1')
    expect(hasSeenFirstMoney('user-2')).toBe(false)
  })

  it('survives a sign-out: sessionStorage clearing leaves it', () => {
    markFirstMoneySeen('user-1')
    window.sessionStorage.clear()
    expect(hasSeenFirstMoney('user-1')).toBe(true)
  })

  it('storage that throws reads as seen (the weaker claim), and marking does not throw', () => {
    // The suite's localStorage is setup.ts's mock object, not a Storage.
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(hasSeenFirstMoney('user-1')).toBe(true)
    expect(() => markFirstMoneySeen('user-1')).not.toThrow()
  })
})
