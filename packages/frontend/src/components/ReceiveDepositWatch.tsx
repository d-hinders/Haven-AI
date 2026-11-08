'use client'

import { useEffect, useRef } from 'react'
import { useDashboardOverview } from '@/hooks/useDashboardOverview'
import { INITIAL_DEPOSIT_WATCH, observeDeposit } from '@/lib/deposit-watch'
import { hasSeenFirstMoney, markFirstMoneySeen } from '@/lib/first-money'
import { formatUsdcArrival } from '@/lib/usdc-arrival'

export interface ReceiveArrival {
  accountId: string
  /** The arrived amount, formatted ("25.00") — the difference, not the balance. */
  amount: string
  /** Peak for this user's first money on this device, Step otherwise. */
  strength: 'peak' | 'step'
}

/**
 * Receive's deposit watch (#4705). Mounted by `ReceiveDialog` ONLY while it is
 * open on an account it can show an address for, so the overview it reads
 * (`useDashboardOverview`, polled about every 10 s while the tab is visible)
 * runs only while someone is waiting for money, and stops when the dialog
 * closes or the arrived state replaces the watch.
 *
 * The source is the overview's per-account USDC (`overview.accounts[]`,
 * #3803), never `useBalances`: a failed balance read there is `null`, never a
 * filler zero, and every row names its account. The arrival rule is
 * `lib/deposit-watch.ts`.
 *
 * "First" is decided on the first overview load after opening: every account
 * reads `funded === false` and this device has no first-money marker for the
 * user (`lib/first-money.ts`). Any account read as funded sets the marker, so
 * the dialog itself records money it sees — at open, and on the very read
 * that shows the arrival, so a Peak marks itself as it plays.
 * With no signed-in user there is no marker to key, so it is always Step.
 */
export function ReceiveDepositWatch({
  accountId,
  userId,
  onArrived,
}: {
  accountId: string
  userId: string | null
  onArrived: (arrival: ReceiveArrival) => void
}) {
  const { data } = useDashboardOverview()
  const watchRef = useRef(INITIAL_DEPOSIT_WATCH)
  const firstRef = useRef<boolean | null>(null)
  const onArrivedRef = useRef(onArrived)
  onArrivedRef.current = onArrived

  const accounts = data?.accounts
  useEffect(() => {
    if (!accounts) return
    if (firstRef.current === null) {
      firstRef.current =
        userId !== null &&
        !hasSeenFirstMoney(userId) &&
        accounts.length > 0 &&
        accounts.every((candidate) => candidate.funded === false)
    }
    if (userId !== null && accounts.some((candidate) => candidate.funded === true)) {
      markFirstMoneySeen(userId)
    }

    const account = accounts.find((candidate) => candidate.accountId === accountId)
    // An account the overview does not list has no read: nothing to watch.
    if (!account) return
    const { state, arrivedAtomic } = observeDeposit(
      watchRef.current,
      accountId,
      account.usdcBalanceAtomic,
      account.usdcBalanceFreshness,
    )
    watchRef.current = state
    if (arrivedAtomic === null) return
    const amount = formatUsdcArrival(arrivedAtomic.toString(), account.usdcDecimals)
    // Unknown decimals: the money is real but its size is not, and the
    // arrived state is a money statement — say nothing rather than guess.
    if (!amount) return
    // No separate mark for Peak: the read that shows the arrival reads the
    // account as funded, and that already set the marker above.
    // …and Peak needs this to be the only money in sight: money that landed
    // on another account while this dialog was open was seen first (and the
    // dashboard may already have toasted it).
    const peak =
      firstRef.current === true &&
      accounts.every((candidate) => candidate.accountId === accountId || candidate.funded !== true)
    onArrivedRef.current({ accountId, amount, strength: peak ? 'peak' : 'step' })
  }, [accounts, accountId, userId])

  return (
    <p className="inline-flex items-center gap-2 text-sm font-medium text-[var(--v2-brand)]">
      <span
        aria-hidden="true"
        className="inline-flex h-1.5 w-1.5 rounded-full bg-[var(--v2-brand)] animate-pending-pulse"
      />
      Watching for your deposit…
    </p>
  )
}

export default ReceiveDepositWatch
