'use client'

/**
 * Sales → Setup → Stripe deposit addresses (#4954, epic #4886; dev and Stripe
 * sandbox only; moved here from Settings → Business → Sales by #4983). The
 * design is the note on #4902, approved by the owner 2026-11-18 "with
 * unverified addresses for the demo".
 *
 * ## What it is
 *
 * A payment processor such as Stripe can receive USDC for the merchant at an
 * address Stripe controls. The owner registers that address here, and a sale
 * the merchant kit reports as paid to it is stored as a Stripe-held sale: the
 * Sales page counts it in revenue (#4981), marked "Received in Stripe" and
 * split out as "in Stripe", and it is never in a Haven balance (#4952).
 *
 * ## The address is the owner's word
 *
 * Haven cannot check that a Stripe-controlled address is the owner's. So one
 * `NoticeRow` says what unverified means for the whole section (one callout,
 * not one per address, so tinted callouts don't stack), and EVERY address
 * still carries the label itself: a "Not verified by Haven" badge and the
 * helper "Registered by you on …, not verified by Haven." A proof of address
 * ownership is required before any production use.
 *
 * ## Patterns
 *
 * One more part of `SalesSetupTab`'s padded card (#4983): a default
 * `Card.Section` with the same `mt-5 pt-5` as the parts above it, an
 * `h2 text-sm font-semibold` heading with a `text-xs ink-3` description, and
 * an `id` anchor (`#stripe-deposit-addresses`) like `#receiving-address`,
 * `#sales-keys` and `#kit-address`. It is NOT `divided` and carries no
 * horizontal padding of its own — the card is already padded, so either would
 * double-indent the part and cut the hairline short. Inside: a `DetailList`
 * with one row per address, shown in full as the Receive dialog shows an
 * address, with its copy and retire actions in the row's actions slot;
 * `StatusBadge` for the two states; `Modal` with `Input`, `DialogActions` and
 * `DialogResult` to register; `ConfirmDialog` to retire; `InlineAlert` for a
 * refusal, inside the dialog that was refused. A retired address stays listed,
 * marked Retired.
 *
 * ## Only while Sales is on
 *
 * The Sales page renders only while Sales is on (`SalesClient.tsx`), and the
 * Setup tab mounts only when it is selected, so the rule #4954 stated on the
 * Settings card holds here without new code.
 */

import { useState, type FormEvent } from 'react'
import { getAddress } from 'viem'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/CopyButton'
import { DetailList, type DetailListItem } from '@/components/ui/DetailList'
import { DialogActions } from '@/components/ui/DialogActions'
import { DialogResult } from '@/components/ui/DialogResult'
import { InlineAlert } from '@/components/ui/InlineAlert'
import Input from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { useToast } from '@/components/ui/Toast'
import { Address } from '@/components/haven'
import { NoticeRow } from '@/components/haven/NoticeRow'
import ConfirmDialog from '@/components/ConfirmDialog'
import { useT } from '@/context/LocaleContext'
import { useMerchantDepositAddresses } from '@/hooks/useMerchantDepositAddresses'
import { getChainConfig } from '@/lib/chains'
import { formatLongDate } from '@/lib/format'
import { isDepositAddressShape, type DepositAddress, type DepositAddressRefusal } from '@/lib/merchant-services'

/** The address as the Receive dialog shows one: checksummed, in full. The wire carries it lower-case. */
export function displayDepositAddress(address: string): string {
  try {
    return getAddress(address)
  } catch {
    return address
  }
}

export default function StripeDepositAddressesSection({ chainId }: { chainId: number }) {
  const t = useT()
  const copy = t.settings.sales.depositAddresses
  const { toast } = useToast()
  const { addresses, loading, failed, refetch, register, retire } = useMerchantDepositAddresses(true)

  const [registerOpen, setRegisterOpen] = useState(false)
  const [pendingRetire, setPendingRetire] = useState<DepositAddress | null>(null)
  const [retiring, setRetiring] = useState(false)
  const [retireError, setRetireError] = useState<DepositAddressRefusal | null>(null)

  const refusalText = (refusal: DepositAddressRefusal): string =>
    refusal.kind === 'refused' ? (refusal.detail ?? copy.refusal.refused) : copy.refusal[refusal.kind]

  async function confirmRetire() {
    if (pendingRetire === null) return
    setRetiring(true)
    setRetireError(null)
    const result = await retire(pendingRetire.id)
    setRetiring(false)
    if (result.ok) {
      setPendingRetire(null)
      return
    }
    setRetireError(result.refusal)
  }

  const items: DetailListItem[] = addresses.map((entry) => {
    const shown = displayDepositAddress(entry.address)
    const registered = formatLongDate(entry.registered_at)
    return {
      id: entry.id,
      label: copy.addressLabel,
      value: (
        <span className="block space-y-1.5" data-testid="sales-deposit-address">
          <span className="block break-all text-sm text-[var(--v2-ink)]">
            <Address value={shown} truncate={false} />
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <StatusBadge tone="warning">{copy.notVerified}</StatusBadge>
            {entry.active ? null : <StatusBadge tone="neutral">{copy.retired}</StatusBadge>}
          </span>
        </span>
      ),
      helper:
        entry.retired_at !== null
          ? copy.retiredHelper(registered, formatLongDate(entry.retired_at))
          : copy.registeredHelper(registered),
      actions: (
        <span className="flex flex-wrap items-center justify-end gap-2">
          {entry.active ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setRetireError(null)
                setPendingRetire(entry)
              }}
              aria-label={`${copy.retire} ${shown}`}
            >
              {copy.retire}
            </Button>
          ) : null}
          <CopyButton value={shown} label="address" text={copy.copy} onCopied={() => toast.success(copy.copied)} />
        </span>
      ),
    }
  })

  return (
    <Card.Section className="mt-5 pt-5">
      <div id="stripe-deposit-addresses" className="space-y-4" data-testid="sales-deposit-addresses">
        {/* Stacks below `sm`, as the card's own header does, so the
            description never squeezes into a narrow column beside the button. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-[var(--v2-ink)]">{copy.title}</h2>
            <p className="mt-1 text-xs text-[var(--v2-ink-3)]">{copy.description}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => setRegisterOpen(true)}
            disabled={loading && addresses.length === 0}
          >
            {copy.register}
          </Button>
        </div>

        <NoticeRow>{copy.notice}</NoticeRow>

        {loading && addresses.length === 0 ? (
          <div className="space-y-2" role="status" aria-busy="true" aria-label={copy.title}>
            <span className="sr-only">{copy.loading}</span>
            <Skeleton variant="text" className="h-4 w-full" />
            <Skeleton variant="text" className="h-4 w-48" />
          </div>
        ) : failed && addresses.length === 0 ? (
          <div className="space-y-3">
            <InlineAlert>{copy.loadError}</InlineAlert>
            <Button variant="ghost" size="sm" onClick={refetch}>
              {t.settings.sales.retry}
            </Button>
          </div>
        ) : addresses.length === 0 ? (
          <p className="text-sm text-[var(--v2-ink-3)]" data-testid="sales-deposit-addresses-empty">
            {copy.empty}
          </p>
        ) : (
          <DetailList items={items} />
        )}
      </div>

      {registerOpen ? (
        <RegisterDepositAddressDialog
          chainId={chainId}
          onClose={() => setRegisterOpen(false)}
          register={register}
          refusalText={refusalText}
        />
      ) : null}

      <ConfirmDialog
        open={pendingRetire !== null}
        onCancel={() => {
          if (retiring) return
          setPendingRetire(null)
          setRetireError(null)
        }}
        onConfirm={() => void confirmRetire()}
        title={copy.retireDialog.title}
        body={
          <div className="space-y-3">
            {pendingRetire ? (
              <p className="break-all text-sm text-[var(--v2-ink)]">
                <Address value={displayDepositAddress(pendingRetire.address)} truncate={false} />
              </p>
            ) : null}
            <p className="text-[var(--v2-ink-2)]">{copy.retireDialog.body}</p>
          </div>
        }
        confirmLabel={copy.retireDialog.confirm}
        cancelLabel={copy.retireDialog.cancel}
        loading={retiring}
        busyLabel={copy.retireDialog.working}
        error={retireError ? <InlineAlert>{refusalText(retireError)}</InlineAlert> : undefined}
      />
    </Card.Section>
  )
}

function RegisterDepositAddressDialog({
  chainId,
  onClose,
  register,
  refusalText,
}: {
  chainId: number
  onClose: () => void
  register: (address: string) => ReturnType<ReturnType<typeof useMerchantDepositAddresses>['register']>
  refusalText: (refusal: DepositAddressRefusal) => string
}) {
  const t = useT()
  const copy = t.settings.sales.depositAddresses.registerDialog
  const refusalCopy = t.settings.sales.depositAddresses.refusal
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function submit(event?: FormEvent) {
    event?.preventDefault()
    if (busy) return
    if (!isDepositAddressShape(value)) {
      setError(refusalCopy.invalid)
      return
    }
    setBusy(true)
    setError(null)
    const result = await register(value)
    setBusy(false)
    if (result.ok) {
      setDone(true)
      return
    }
    setError(refusalText(result.refusal))
  }

  const footer = done ? (
    <DialogActions>
      <Button onClick={onClose}>{copy.done}</Button>
    </DialogActions>
  ) : (
    <DialogActions>
      <Button variant="ghost" onClick={onClose} disabled={busy}>
        {copy.cancel}
      </Button>
      <Button onClick={() => void submit()} disabled={busy || value.trim() === ''}>
        {busy ? copy.working : copy.submit}
      </Button>
    </DialogActions>
  )

  return (
    <Modal
      open
      onClose={busy ? () => undefined : onClose}
      title={copy.title}
      subtitle={done ? undefined : copy.subtitle(getChainConfig(chainId).name)}
      footer={footer}
      showCloseButton
      closeButtonDisabled={busy}
      placement="top"
      panelTestId="register-deposit-address-dialog"
    >
      {done ? (
        <div data-testid="sales-deposit-registered">
          <DialogResult state="success" title={copy.doneTitle} description={copy.doneBody} announce />
        </div>
      ) : (
        <form className="space-y-3" onSubmit={(event) => void submit(event)} noValidate>
          <label htmlFor="stripe-deposit-address" className="block text-sm font-medium text-[var(--v2-ink)]">
            {copy.label}
          </label>
          <Input
            id="stripe-deposit-address"
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              setError(null)
            }}
            placeholder={copy.placeholder}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            invalid={error !== null}
            // On a refusal the alert below replaces the helper, so the one red
            // line is the error — never the "not verified" label.
            helperText={error ? undefined : copy.helper}
            aria-describedby={error ? 'stripe-deposit-address-error' : undefined}
            disabled={busy}
          />
          {error ? (
            <div id="stripe-deposit-address-error">
              <InlineAlert>{error}</InlineAlert>
            </div>
          ) : null}
        </form>
      )}
    </Modal>
  )
}
