/**
 * The Receive dialog's deposit watch (#4705) — a pure rule over the
 * overview's per-account USDC reads, so it can be tested without a dialog.
 *
 * The source is `overview.accounts[]` (#3803), never `useBalances`: an arrival
 * is a money statement, and a failed balance read there is `null` (unknown),
 * never a filler zero that a later real read would turn into a fake deposit.
 *
 * - The first non-null read after opening, or after switching accounts,
 *   SEEDS the last known value. It is never an arrival.
 * - A later non-null read ABOVE it is an arrival, for the difference.
 * - A read BELOW it lowers the stored value, so a later deposit still fires
 *   for its own amount.
 * - `null` (or a malformed read) changes nothing.
 *
 * Accepted residual (the spec): an agent paying in the same ~10 s poll as a
 * deposit understates the arrived amount.
 */

export interface DepositWatchState {
  accountId: string | null
  lastKnownAtomic: bigint | null
}

export const INITIAL_DEPOSIT_WATCH: DepositWatchState = { accountId: null, lastKnownAtomic: null }

function parseAtomic(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined || value.trim() === '') return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

export function observeDeposit(
  state: DepositWatchState,
  accountId: string,
  usdcBalanceAtomic: string | null | undefined,
): { state: DepositWatchState; arrivedAtomic: bigint | null } {
  const read = parseAtomic(usdcBalanceAtomic)
  if (state.accountId !== accountId) {
    // A different account: start over, seeding from this read if it is known.
    return { state: { accountId, lastKnownAtomic: read }, arrivedAtomic: null }
  }
  if (read === null) return { state, arrivedAtomic: null }
  if (state.lastKnownAtomic === null) {
    return { state: { accountId, lastKnownAtomic: read }, arrivedAtomic: null }
  }
  if (read > state.lastKnownAtomic) {
    return { state: { accountId, lastKnownAtomic: read }, arrivedAtomic: read - state.lastKnownAtomic }
  }
  if (read < state.lastKnownAtomic) {
    return { state: { accountId, lastKnownAtomic: read }, arrivedAtomic: null }
  }
  return { state, arrivedAtomic: null }
}
