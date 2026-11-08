import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  newVisitEntryId,
  readLastVisitLatch,
  writeLastVisitLatch,
} from '@/lib/last-visit'

/**
 * #4709: the "Since your last visit" latch. The entry id is stored BEFORE the
 * call (so a lost response is retried with the same id) and the bounds are
 * stored after it (so a reload keeps the line without calling the server).
 */
describe('last-visit latch (#4709)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    window.sessionStorage.clear()
  })

  it('a fresh tab holds no latch', () => {
    expect(readLastVisitLatch('user-1')).toBeNull()
  })

  it('stores the entry id before the bounds, and reads both back', () => {
    writeLastVisitLatch('user-1', { entryId: 'entry-1', bounds: null })
    expect(readLastVisitLatch('user-1')).toEqual({ entryId: 'entry-1', bounds: null })

    writeLastVisitLatch('user-1', {
      entryId: 'entry-1',
      bounds: { previous: '2026-11-02T10:00:00.000Z', current: '2026-11-03T10:00:00.000Z' },
    })
    expect(readLastVisitLatch('user-1')).toEqual({
      entryId: 'entry-1',
      bounds: { previous: '2026-11-02T10:00:00.000Z', current: '2026-11-03T10:00:00.000Z' },
    })
  })

  it('a first ever visit keeps a null previous', () => {
    writeLastVisitLatch('user-1', {
      entryId: 'entry-1',
      bounds: { previous: null, current: '2026-11-03T10:00:00.000Z' },
    })
    expect(readLastVisitLatch('user-1')?.bounds?.previous).toBeNull()
  })

  it('is per user', () => {
    writeLastVisitLatch('user-1', { entryId: 'entry-1', bounds: null })
    expect(readLastVisitLatch('user-2')).toBeNull()
  })

  it('corrupt JSON reads as no latch — a fresh entry, never a guessed window', () => {
    window.sessionStorage.setItem('haven-entry:last-visit:user-1', '{not json')
    expect(readLastVisitLatch('user-1')).toBeNull()
  })

  it('a latch with no entry id reads as no latch', () => {
    window.sessionStorage.setItem('haven-entry:last-visit:user-1', JSON.stringify({ bounds: null }))
    expect(readLastVisitLatch('user-1')).toBeNull()
  })

  it('storage that throws reads as no latch and writing does not throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(readLastVisitLatch('user-1')).toBeNull()
    expect(() => writeLastVisitLatch('user-1', { entryId: 'entry-1', bounds: null })).not.toThrow()
  })
})

describe('newVisitEntryId (#4709)', () => {
  it('is a v4 UUID', () => {
    expect(newVisitEntryId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('is different every time', () => {
    expect(newVisitEntryId()).not.toBe(newVisitEntryId())
  })
})
