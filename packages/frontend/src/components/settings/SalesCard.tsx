'use client'

/**
 * Settings → Business → Sales (#4904, epic #4885) — the third card, after
 * Company details and Accounting connections (owner decision 1 on #4894).
 *
 * ## The card is the switch
 *
 * The approved mockup (#4894, 2026-11-16) draws the card as `Card` +
 * `Card.Header` with the state badge and the one control in the header's
 * actions slot, and a `DetailList` of what the account is. There is no toggle
 * primitive in the design system and the mockup does not ask for one: the
 * control is a `Button` whose label is the action ("Turn on Sales" / "Turn off
 * Sales"), so the state is read from the badge and the action from the button.
 *
 * ## What each state says
 *
 * - **Never on** — the purpose line and the button. Nothing is kept, because
 *   nothing exists yet.
 * - **On** — the account (a `LinkChip` to its page) and its network (a
 *   `NetworkPill`).
 * - **Off** — the same account and network, plus the documented Detail list
 *   row "Sales keys / Keys not accepted while off" (design-system.md § Detail
 *   list): the account and its history are kept, and the keys stop working
 *   (owner decision 5 on #4894).
 * - **Loading / error** — a skeleton or a retry, never a blank and never a
 *   silent "off".
 *
 * ## Turning off asks first
 *
 * `ConfirmDialog` (the one confirmation pattern, #4570) says the account and
 * its history are kept and the keys stop working. A failed turn-off shows its
 * error INSIDE the dialog, so the user is looking at the thing that failed.
 *
 * ## The read is the shell's
 *
 * The setting comes from `MerchantServicesProvider` (mounted by
 * `AuthenticatedShell`), not from a read of this card's own: the Sales menu
 * entry (#4900), Analytics (#4901) and the key screens (#4905) all read the
 * same answer, and a second read could disagree with the first for a frame.
 */

import { useState } from 'react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { DetailList } from '@/components/ui/DetailList'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { LinkChip } from '@/components/ui/LinkChip'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatusBadge } from '@/components/ui/StatusBadge'
import ConfirmDialog from '@/components/ConfirmDialog'
import NetworkPill from '@/components/NetworkPill'
import { useT } from '@/context/LocaleContext'
import { useMerchantServicesContext } from '@/context/MerchantServicesContext'
import { salesCardState } from '@/lib/merchant-services'
import TurnOnSalesDialog from './TurnOnSalesDialog'
import StripeDepositAddressesSection from './StripeDepositAddressesSection'

export default function SalesCard() {
  const t = useT()
  const copy = t.settings.sales
  const { status, state, merchantAccount, refresh, turnOff } = useMerchantServicesContext()

  const [turnOnOpen, setTurnOnOpen] = useState(false)
  const [turnOffOpen, setTurnOffOpen] = useState(false)
  const [turningOff, setTurningOff] = useState(false)
  const [turnOffError, setTurnOffError] = useState<string | null>(null)

  const cardState = salesCardState(status, state)

  async function confirmTurnOff() {
    setTurningOff(true)
    setTurnOffError(null)
    const result = await turnOff()
    setTurningOff(false)
    if (result.ok) {
      setTurnOffOpen(false)
      return
    }
    setTurnOffError(copy.offDialog.error)
  }

  const headerActions =
    cardState === 'on' ? (
      <Button variant="ghost" onClick={() => setTurnOffOpen(true)}>
        {copy.turnOff}
      </Button>
    ) : cardState === 'never_on' || cardState === 'off' ? (
      <Button onClick={() => setTurnOnOpen(true)}>{copy.turnOn}</Button>
    ) : null

  const description =
    cardState === 'on'
      ? copy.detail.on
      : cardState === 'off'
        ? copy.detail.off
        : cardState === 'never_on'
          ? copy.detail.neverOn
          : undefined

  return (
    <>
      {/* The card is a `<section>` so the visual spec has a stable clip anchor:
          `Card` does not forward `data-testid` (its props are a closed set), and
          a baseline of the whole Business tab would fail on any unrelated card
          change — the #2318 "green tick read wider than the thing it measured"
          shape. */}
      <section data-testid="sales-card">
        <Card hover={false}>
          <Card.Header
            title={copy.title}
            description={description}
            actions={
              <>
                {cardState === 'on' || cardState === 'off' ? (
                  <StatusBadge tone={cardState === 'on' ? 'success' : 'neutral'}>
                    {cardState === 'on' ? copy.state.on : copy.state.off}
                  </StatusBadge>
                ) : null}
                {headerActions}
              </>
            }
          />

          {cardState === 'loading' ? (
            <div className="space-y-3 px-5 py-4" role="status" aria-busy="true" aria-label={copy.title}>
              <span className="sr-only">{copy.loading}</span>
              <Skeleton variant="text" className="h-4 w-40" />
              <Skeleton variant="text" className="h-4 w-56" />
            </div>
          ) : null}

          {cardState === 'error' ? (
            <div className="space-y-3 px-5 py-4">
              <InlineAlert>{copy.loadError}</InlineAlert>
              <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                {copy.retry}
              </Button>
            </div>
          ) : null}

          {merchantAccount !== null && (cardState === 'on' || cardState === 'off') ? (
            <div className="px-5 py-4">
              <DetailList
                items={[
                  {
                    label: copy.accountLabel,
                    value: (
                      <LinkChip href={`/accounts/${merchantAccount.id}`}>{merchantAccount.name}</LinkChip>
                    ),
                  },
                  {
                    label: copy.networkLabel,
                    value: <NetworkPill chainId={merchantAccount.chain_id} />,
                  },
                  ...(cardState === 'off'
                    ? [
                        {
                          label: copy.keysLabel,
                          value: copy.keysRefused,
                          helper: copy.keysRefusedHelper,
                        },
                      ]
                    : []),
                ]}
              />
            </div>
          ) : null}

          {/* #4954: Stripe deposit addresses, only while Sales is on — off means
              off, and the route answers an empty list then anyway. */}
          {merchantAccount !== null && cardState === 'on' ? (
            <StripeDepositAddressesSection chainId={merchantAccount.chain_id} />
          ) : null}
        </Card>
      </section>

      <TurnOnSalesDialog open={turnOnOpen} onClose={() => setTurnOnOpen(false)} />

      <ConfirmDialog
        open={turnOffOpen}
        onCancel={() => {
          if (turningOff) return
          setTurnOffOpen(false)
          setTurnOffError(null)
        }}
        onConfirm={() => void confirmTurnOff()}
        title={copy.offDialog.title}
        body={copy.offDialog.body}
        confirmLabel={copy.offDialog.confirm}
        cancelLabel={copy.offDialog.cancel}
        loading={turningOff}
        busyLabel={copy.offDialog.working}
        error={turnOffError ? <InlineAlert>{turnOffError}</InlineAlert> : undefined}
      />
    </>
  )
}
