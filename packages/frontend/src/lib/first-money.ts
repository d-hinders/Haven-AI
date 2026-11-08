/**
 * The first-money marker (#4705, epic #4701 decisions 7 and 8).
 *
 * Receive plays Peak for a user's FIRST money, once per device. "First" needs
 * a memory that outlives the dialog, the tab and a sign-out, so it is a
 * per-user `localStorage` flag (decision 8: "once" is per device; another
 * device may show Peak once more, and there is no server marker).
 *
 * It records that money has been SEEN, not that Peak played. It is set
 * whenever any of the user's accounts is observed with `funded === true` —
 * by the dashboard's overview (including #4704's closed-dialog toast path),
 * when Receive opens, and when Peak plays — so a first deposit seen with
 * Receive closed, followed by a drain and a refill, plays Step on the refill,
 * never Peak (the #4705 spec review's replay path).
 *
 * Unreadable storage reads as "already seen": Peak is the stronger claim
 * ("your first money"), so when the device cannot remember, it says the
 * weaker one.
 */

const PREFIX = 'haven-first-money-seen:'

/** True when this device has already seen money on this user's accounts. */
export function hasSeenFirstMoney(userId: string): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(`${PREFIX}${userId}`) === '1'
  } catch {
    return true
  }
}

/** Record that this device has seen money on this user's accounts. */
export function markFirstMoneySeen(userId: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(`${PREFIX}${userId}`, '1')
  } catch {
    // Unwritable storage already reads as "seen".
  }
}
