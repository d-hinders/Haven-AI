'use client'

/**
 * Settings → Business → Sales (#4904, epic #4885; reshaped by #4983) — the
 * third section, after Company details and Accounting connections (owner
 * decision 1 on #4894).
 *
 * ## One `SettingsSection`, like Accounting
 *
 * #4983 (owner decision 2026-11-19: "The settings sales part should be a
 * separate section like Accounting with more context on the sales product")
 * replaced the #4894 mockup's `Card` + `Card.Header` band with the shape
 * Company details and Accounting already use: the title sits ABOVE the card in
 * the same `v2-text-h3` scale, the body is `px-6`, and the band's square top
 * corners — `Card` rounds itself but does not clip its children, and
 * `CardHeader` paints `--v2-surface` edge to edge — go with it.
 * `data-testid="sales-card"` sits on the `SettingsSection` itself, which
 * forwards it to its `<section>`; there is no second `<section>`.
 *
 * ## The status and the switch are a `SettingsRow`
 *
 * As in `ConnectionRow`: the On / Off `StatusBadge` is the row's value and
 * Turn on Sales / Turn off Sales is its action. The heading's `action` slot is
 * a LINK, never a button (design-system.md § Detail-page section rule), so it
 * carries only "Open the Sales page" — and only while Sales is on, because
 * `/sales` answers not found when Sales is off or was never on
 * (`SalesClient.tsx`).
 *
 * ## What each state says
 *
 * - **Never on** — the product context (what Sales is, and who the seller can
 *   be) and the one control. Nothing is kept, because nothing exists yet.
 * - **On** — the state line, the account (a `LinkChip` to its page) and its
 *   network (a `NetworkPill`).
 * - **Off** — the same product context, the owner's kept-account line as the
 *   section's `note`, the same account and network rows, and the "Sales keys /
 *   Keys not accepted while off" row: the account and its history are kept,
 *   and the keys stop working (owner decision 5 on #4894).
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
 *
 * ## Stripe deposit addresses moved out (#4983)
 *
 * #4954's `StripeDepositAddressesSection` used to render inside this card's on
 * state. The owner moved it to Sales → Setup ("Yes move Stripe deposit
 * address"), where the rest of a seller's setup lives; this card no longer
 * imports it, and the only-while-on rule carries there because the Sales page
 * renders only while Sales is on.
 */

import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { LinkChip } from '@/components/ui/LinkChip'
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatusBadge } from '@/components/ui/StatusBadge'
import ConfirmDialog from '@/components/ConfirmDialog'
import NetworkPill from '@/components/NetworkPill'
import { useT } from '@/context/LocaleContext'
import { useMerchantServicesContext } from '@/context/MerchantServicesContext'
import { salesCardState } from '@/lib/merchant-services'
import TurnOnSalesDialog from './TurnOnSalesDialog'

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

  // The product context, in the two states where the reader has not seen what
  // Sales is yet. On, the state line says what is true now and the heading's
  // link leads to the fuller surface.
  const description =
    cardState === 'on'
      ? copy.detail.on
      : cardState === 'never_on' || cardState === 'off'
        ? copy.description
        : undefined

  // The owner's kept-account line (decision 5 on #4894) — a responsibility
  // line under the description, not a second description.
  const note = cardState === 'off' ? copy.detail.off : undefined

  const switchAction =
    cardState === 'on' ? (
      <Button variant="ghost" size="sm" onClick={() => setTurnOffOpen(true)}>
        {copy.turnOff}
      </Button>
    ) : cardState === 'never_on' || cardState === 'off' ? (
      <Button size="sm" onClick={() => setTurnOnOpen(true)}>
        {copy.turnOn}
      </Button>
    ) : null

  return (
    <>
      <SettingsSection
        title={copy.title}
        description={description}
        note={note}
        action={
          cardState === 'on' ? (
            <Link
              href="/sales"
              className="rounded-sm text-sm font-medium text-[var(--v2-brand)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
            >
              {copy.openSalesPage}
            </Link>
          ) : undefined
        }
        data-testid="sales-card"
      >
        {cardState === 'loading' ? (
          <div className="space-y-3 px-6 py-4" role="status" aria-busy="true" aria-label={copy.title}>
            <span className="sr-only">{copy.loading}</span>
            <Skeleton variant="text" className="h-4 w-40" />
            <Skeleton variant="text" className="h-4 w-56" />
          </div>
        ) : null}

        {cardState === 'error' ? (
          <div className="space-y-3 px-6 py-4">
            <InlineAlert>{copy.loadError}</InlineAlert>
            <Button variant="ghost" size="sm" onClick={() => void refresh()}>
              {copy.retry}
            </Button>
          </div>
        ) : null}

        {cardState === 'never_on' || cardState === 'off' || cardState === 'on' ? (
          <SettingsRow
            data-testid="sales-status-row"
            label={copy.statusLabel}
            value={
              cardState === 'never_on' ? undefined : (
                <StatusBadge tone={cardState === 'on' ? 'success' : 'neutral'}>
                  {cardState === 'on' ? copy.state.on : copy.state.off}
                </StatusBadge>
              )
            }
            detail={cardState === 'never_on' ? copy.detail.neverOn : undefined}
            action={switchAction}
          />
        ) : null}

        {merchantAccount !== null && (cardState === 'on' || cardState === 'off') ? (
          <>
            <SettingsRow
              label={copy.accountLabel}
              value={<LinkChip href={`/accounts/${merchantAccount.id}`}>{merchantAccount.name}</LinkChip>}
            />
            <SettingsRow
              label={copy.networkLabel}
              value={<NetworkPill chainId={merchantAccount.chain_id} />}
            />
            {cardState === 'off' ? (
              <SettingsRow
                label={copy.keysLabel}
                value={copy.keysRefused}
                detail={copy.keysRefusedHelper}
              />
            ) : null}
          </>
        ) : null}
      </SettingsSection>

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
