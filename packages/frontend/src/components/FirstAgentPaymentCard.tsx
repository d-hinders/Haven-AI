'use client'

/**
 * The first agent payment, as its own card (#4707, epic #4701).
 *
 * Until this slice the moment Haven's promise came true was one line inside
 * "Needs attention" (`SetupCompleteLine`). That card is for things that need
 * the owner; a milestone is not one. So the line moved out here, and "Needs
 * attention" went back to meaning what it says — with its existing empty state
 * when nothing else applies.
 *
 * ## What it claims, and what it refuses to
 *
 * The card names a REAL payment: the agent, the amount, the counterparty and
 * when. It renders only when `GET /dashboard/first-agent-payment` returned a
 * qualifying row — a confirmed payment whose merchant leg is proven. Loading,
 * an error, a 404 from an older backend and a `null` row all render nothing
 * (the caller does not mount this component at all in those cases).
 *
 * ## Peak
 *
 * `Milestone` Peak plays once per device, on a per-user browser marker, because
 * the card itself stays until dismissed. It plays even when the payment
 * happened while the owner was away, but never for a payment more than seven
 * days old (owner decision 1 on #4701). The rules live in
 * `lib/first-agent-payment.ts`; this component only asks them.
 *
 * The card is a `role="status"` region exactly when Peak plays, so the moment
 * is announced once. Under reduced motion `Milestone` withholds the animation
 * class while the region — and its announcement — still happens.
 *
 * ## Copy
 *
 * The amount is the booked fiat in the viewer's currency, or the token amount
 * when that fiat would read `0.00` (a sub-cent payment never reads `$0.00`).
 * The counterparty is a contact name, else a receipt name, else the x402
 * resource host — never an address. "just now" comes from the row's own time;
 * an older row says its date.
 */

import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { Milestone } from '@/components/ui/Milestone'
import { merchantNameFromParts } from '@/lib/dashboard-summary'
import {
  firstAgentPaymentAmount,
  firstAgentPaymentWhen,
  markFirstAgentPaymentPeakPlayed,
  shouldPlayFirstAgentPaymentPeak,
  type FirstAgentPaymentCurrency,
} from '@/lib/first-agent-payment'
import type { FirstAgentPayment } from '@/hooks/useFirstAgentPayment'

interface Props {
  payment: FirstAgentPayment
  currency: FirstAgentPaymentCurrency
  /** The signed-in user — the Peak marker is per user, per device. */
  userId: string
  onDismiss: () => void
}

export default function FirstAgentPaymentCard({ payment, currency, userId, onDismiss }: Props) {
  // Decided on the card's FIRST render, so `role="status"` is present from the
  // moment the region exists rather than being added to a live element later.
  // The card only mounts once a row has arrived, so this is a client render.
  const [peak] = useState(() =>
    shouldPlayFirstAgentPaymentPeak({ userId, confirmedAt: payment.confirmedAt }),
  )
  useEffect(() => {
    if (peak) markFirstAgentPaymentPeakPlayed(userId)
  }, [peak, userId])

  const merchant = merchantNameFromParts(payment)
  const amount = firstAgentPaymentAmount(payment, currency)
  const when = firstAgentPaymentWhen(payment.confirmedAt)
  // No displayable counterparty name: the sentence drops the "to …" clause
  // rather than naming an address (#3810 rule 4).
  const body = merchant ? `${amount} to ${merchant}, ${when}.` : `${amount}, ${when}.`

  return (
    <div role={peak ? 'status' : undefined}>
      <Card as="article" hover={false} className="overflow-hidden v2-animate-slide-in">
        <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <Milestone strength="peak" play={peak} className="flex-shrink-0">
              <span
                aria-hidden="true"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--v2-success)] text-[var(--v2-ink-on-brand)]"
              >
                <Icon icon={Check} className="h-4 w-4" strokeWidth={2} />
              </span>
            </Milestone>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-[var(--v2-ink)]">
                {payment.agentName} made its first payment
              </h2>
              <p className="mt-0.5 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                {body} You&rsquo;re set up.
              </p>
            </div>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2 pl-11 sm:pl-0">
            <Button variant="ghost" size="sm" href="/transactions">
              View transaction
            </Button>
            <Button variant="tertiary" size="sm" onClick={onDismiss}>
              Dismiss
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
