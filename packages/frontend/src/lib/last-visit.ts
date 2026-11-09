/**
 * The "Since your last visit" latch (#4709, epic #4701 decision 4).
 *
 * One entry per tab, per signed-in user — the same `sessionStorage` shape
 * #4704's entry latch gives the balance count-up, under its own `last-visit`
 * key so neither consumer starves the other.
 *
 * The latch holds TWO things, and the order they are written in is the whole
 * retry-safety design:
 *
 * 1. `entryId` is generated and stored BEFORE `POST /user/visits` is called.
 *    A lost response is retried with the SAME id, and the server returns the
 *    same window instead of erasing it.
 * 2. `bounds` (`{ previous, current }`) are stored once the server answers.
 *    A reload or a return from another page then keeps the line for the whole
 *    entry without calling the server again — polling never writes.
 *
 * A latch with an `entryId` and no `bounds` is a call that has not succeeded
 * yet: the next mount retries it. A latch that cannot be read (storage throws,
 * or the JSON is corrupt) reads as "no latch", which means a fresh entry — the
 * same posture #4704's latch takes for an entrance it cannot remember.
 */

import { markEntered, readEntryState } from './entry-latch'

export interface VisitBounds {
  /** The previous entry's instant (ISO), or null on the first ever visit. */
  previous: string | null
  /** This entry's instant (ISO). */
  current: string
}

export interface LastVisitLatch {
  entryId: string
  bounds: VisitBounds | null
}

const CONSUMER = 'last-visit'

/** The latch this tab holds for `userId`, or null when it holds none. */
export function readLastVisitLatch(userId: string): LastVisitLatch | null {
  const state = readEntryState(CONSUMER, userId)
  if (!state.entered || state.value === null) return null
  try {
    const parsed = JSON.parse(state.value) as Partial<LastVisitLatch>
    if (typeof parsed.entryId !== 'string' || parsed.entryId.length === 0) return null
    const raw = parsed.bounds
    const bounds =
      raw && typeof raw.current === 'string'
        ? {
            previous: typeof raw.previous === 'string' ? raw.previous : null,
            current: raw.current,
          }
        : null
    return { entryId: parsed.entryId, bounds }
  } catch {
    return null
  }
}

/** Store the latch for `userId` — the entry id before the call, the bounds after it. */
export function writeLastVisitLatch(userId: string, latch: LastVisitLatch): void {
  markEntered(CONSUMER, userId, JSON.stringify(latch))
}

/**
 * A fresh entry id. `crypto.randomUUID` needs a secure context; a plain-http
 * LAN preview has no `randomUUID`, so a v4 is built from `getRandomValues`
 * there. The id is a retry key, not a secret — the last-resort `Math.random`
 * branch only keeps an ancient browser working.
 */
export function newVisitEntryId(): string {
  const cryptoApi = typeof globalThis === 'undefined' ? undefined : globalThis.crypto
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID()
  const bytes = new Uint8Array(16)
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
