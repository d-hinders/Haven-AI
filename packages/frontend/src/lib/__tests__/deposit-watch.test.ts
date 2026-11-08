import { describe, expect, it } from 'vitest'
import { INITIAL_DEPOSIT_WATCH, observeDeposit, type DepositWatchState } from '@/lib/deposit-watch'

/** #4705: the Receive deposit watch's rule, without a dialog. */
function run(reads: Array<[string, string | null]>) {
  let state: DepositWatchState = INITIAL_DEPOSIT_WATCH
  const arrivals: Array<bigint | null> = []
  for (const [accountId, value] of reads) {
    const result = observeDeposit(state, accountId, value)
    state = result.state
    arrivals.push(result.arrivedAtomic)
  }
  return { state, arrivals }
}

describe('observeDeposit (#4705)', () => {
  it('the first non-null read seeds and is never an arrival', () => {
    expect(run([['a', '25']]).arrivals).toEqual([null])
  })

  it('a rise is an arrival for the difference', () => {
    expect(run([['a', '10'], ['a', '35']]).arrivals).toEqual([null, 25n])
  })

  it('null and malformed reads change nothing', () => {
    const { arrivals, state } = run([['a', null], ['a', '10'], ['a', null], ['a', 'abc'], ['a', ''], ['a', '10']])
    expect(arrivals.every((value) => value === null)).toBe(true)
    expect(state.lastKnownAtomic).toBe(10n)
  })

  it('a read marked stale or unavailable changes nothing, like null', () => {
    let state: DepositWatchState = INITIAL_DEPOSIT_WATCH
    state = observeDeposit(state, 'a', '90').state
    const stale = observeDeposit(state, 'a', '100', { status: 'stale' })
    expect(stale.arrivedAtomic).toBeNull()
    expect(stale.state.lastKnownAtomic).toBe(90n)
    const unavailable = observeDeposit(INITIAL_DEPOSIT_WATCH, 'a', '0', { status: 'unavailable' })
    expect(unavailable.state.lastKnownAtomic).toBeNull()
  })

  it('a drop lowers the stored value, so a later deposit fires for its own amount', () => {
    expect(run([['a', '50'], ['a', '20'], ['a', '30']]).arrivals).toEqual([null, null, 10n])
  })

  it('switching accounts reseeds and never fires, even onto a larger balance', () => {
    expect(run([['a', '0'], ['b', '90'], ['b', '92']]).arrivals).toEqual([null, null, 2n])
  })

  it('switching to an account with no read yet waits for its first read to seed', () => {
    expect(run([['a', '0'], ['b', null], ['b', '90'], ['b', '95']]).arrivals).toEqual([null, null, null, 5n])
  })
})
