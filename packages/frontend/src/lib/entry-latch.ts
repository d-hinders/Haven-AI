/**
 * The entry latch (#4704, epic #4701 decision 3): "has this tab already had
 * its entrance?", per tab and per signed-in user.
 *
 * Owner decision 3 on #4701 is the spec:
 *
 * | What happens                                         | Entrance? |
 * |------------------------------------------------------|-----------|
 * | Open Haven in a new tab, or launch it on your phone  | yes       |
 * | Sign out and back in                                 | yes       |
 * | Go to another page and return                        | no        |
 * | Reload the page                                      | no        |
 * | Something updates while the page is open             | no        |
 *
 * `sessionStorage` gives exactly that shape: it lives per tab, survives a
 * reload and in-app navigation, and a new tab starts empty. Sign-out clears
 * the keys (`clearEntryLatches`, called from `AuthContext`), so signing back
 * in is an entrance again. Accepted residual: a sign-out in ANOTHER tab does
 * not clear this tab's keys.
 *
 * **One key per consumer**, so neither consumer starves the other: the
 * balance count-up (`count-up`, this slice) and "Since your last visit"
 * (`last-visit`, #4709) each read and mark their own key. Reading and marking
 * are separate calls: a consumer decides at render time and marks once it has
 * acted.
 *
 * Storage that throws (private mode, a blocked origin) reads as "already
 * entered": an entrance animation is decoration, so when this tab cannot
 * remember having played it, it does not play rather than risk playing on
 * every visit. Marking then does nothing.
 */

export type EntryConsumer = 'count-up' | 'last-visit'

const PREFIX = 'haven-entry:'

function latchKey(consumer: EntryConsumer, userId: string): string {
  return `${PREFIX}${consumer}:${userId}`
}

/** What this tab remembers about one consumer's entrance. */
export interface EntryLatchState {
  /** True when this tab has already had its entrance (or cannot remember). */
  entered: boolean
  /** The value stored with the entrance, or null when there is none. */
  value: string | null
}

/**
 * Read one consumer's latch. Storage that throws (private mode, a blocked
 * origin) reads as `{ entered: true, value: null }`: an entrance animation is
 * decoration, so when this tab cannot remember having played it, it does not
 * play rather than risk playing on every visit.
 *
 * `value` is what lets a consumer remember more than "yes": #4709 stores its
 * entry id and the window bounds under `last-visit`, so a reload or a return
 * from another page keeps the line for the whole entry.
 */
export function readEntryState(consumer: EntryConsumer, userId: string): EntryLatchState {
  if (typeof window === 'undefined') return { entered: true, value: null }
  try {
    const value = window.sessionStorage.getItem(latchKey(consumer, userId))
    return value === null ? { entered: false, value: null } : { entered: true, value }
  } catch {
    return { entered: true, value: null }
  }
}

/** True when this tab has already had its entrance for this consumer and user. */
export function hasEntered(consumer: EntryConsumer, userId: string): boolean {
  return readEntryState(consumer, userId).entered
}

/**
 * Record that this tab has had its entrance for this consumer and user.
 * `value` defaults to `'1'` — the count-up's marker; #4709 passes its entry
 * state as JSON.
 */
export function markEntered(consumer: EntryConsumer, userId: string, value = '1'): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(latchKey(consumer, userId), value)
  } catch {
    // Unwritable storage: `hasEntered` already reads as entered.
  }
}

/** Clear every consumer's latch in this tab — sign-out, so signing back in is an entrance. */
export function clearEntryLatches(): void {
  if (typeof window === 'undefined') return
  try {
    const keys: string[] = []
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i)
      if (key?.startsWith(PREFIX)) keys.push(key)
    }
    for (const key of keys) window.sessionStorage.removeItem(key)
  } catch {
    // Nothing to clear in storage that cannot be read.
  }
}
