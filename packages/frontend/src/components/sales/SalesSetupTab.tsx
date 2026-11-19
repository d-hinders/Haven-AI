'use client'

import { useEffect, useRef, useState } from 'react'
import { QrCode } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Skeleton } from '@/components/ui/Skeleton'
import NetworkPill from '@/components/NetworkPill'
import type { UseMerchantCatalogueResult } from '@/hooks/useMerchantCatalogue'
import { timeAgo } from '@/lib/format'
import { catalogueView, type SalesCatalogue } from '@/lib/sales'
import { SalesKeysSection } from './SalesKeysSection'
import StripeDepositAddressesSection from './StripeDepositAddressesSection'

/** The helper under the kit address: the mockup's first-run copy, then what the last read said. */
function kitHelper(catalogue: SalesCatalogue | null): string {
  const base = 'The public address of your kit. Haven reads your product list from it; it never sends anything there.'
  if (catalogue === null || catalogue.deployment_url === null) return base
  const view = catalogueView(catalogue)
  const when = catalogue.last_read_at ? ` ${timeAgo(catalogue.last_read_at)}` : ''
  if (view === 'ok') return `Last read${when}. Products shows what it found.`
  if (view === 'never') return 'Saved. Haven has not read it yet. Products shows what it finds.'
  return `Saved. Haven couldn’t use it${when ? ` when it tried${when}` : ''}. Products says why.`
}

/**
 * The Setup tab (#4900, approved on #4894): where a seller is connected to the
 * Sales account — the receiving address, the Sales keys (a slot #4905 owns),
 * the kit address and, since #4983, the Stripe deposit addresses. One Card,
 * one `Card.Section` per part.
 *
 * - **Receiving address**: opens the Receive dialog the page already holds for
 *   the Sales account; no address is printed here.
 * - **Sales keys**: `SalesKeysSection`.
 * - **Kit address**: saved through `PUT /merchant-catalogue/deployment`, which
 *   stores and reads it at once. A refusal reads as the route words it. The
 *   first-run step "Tell Haven where your kit runs" links here with
 *   `#kit-address`, and the field takes focus.
 * - **Stripe deposit addresses**: `StripeDepositAddressesSection`, moved here
 *   from Settings → Business → Sales by #4983 (owner decision 2026-11-19:
 *   "Yes move Stripe deposit address"). It is one more part of this card, so
 *   it takes the card's padding and the parts' heading scale rather than its
 *   old `Card.Section divided` wrapper.
 */
export function SalesSetupTab({
  account,
  catalogue,
  onShowAddress,
}: {
  account: { name: string; chain_id: number }
  catalogue: UseMerchantCatalogueResult
  onShowAddress: () => void
}) {
  const saved = catalogue.data?.deployment_url ?? ''
  const [value, setValue] = useState(saved)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // The saved address fills the field when the read answers, and again when a
  // save changes it; what the owner is typing is never overwritten mid-edit.
  const lastSaved = useRef(saved)
  useEffect(() => {
    if (saved !== lastSaved.current) {
      lastSaved.current = saved
      setValue(saved)
    }
  }, [saved])

  // The first-run step links to `#kit-address`: land with the field ready.
  useEffect(() => {
    if (window.location.hash === '#kit-address') inputRef.current?.focus()
  }, [])

  const trimmed = value.trim()
  const unchanged = trimmed === saved
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (trimmed === '') {
      setError('Enter the address of your kit.')
      return
    }
    setError(null)
    const result = await catalogue.saveDeployment(trimmed)
    if (!result.ok) setError(result.message)
  }

  return (
    <div className="mt-6" data-testid="sales-setup-tab">
      <Card hover={false} className="p-5 md:p-6">
        <div id="receiving-address" className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Receiving address</h2>
            <p className="mt-1 text-xs text-[var(--v2-ink-3)]">Put this in your kit as the address payments go to.</p>
            <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-[var(--v2-ink-2)]">
              {account.name} <NetworkPill chainId={account.chain_id} /> payments in USDC
            </p>
          </div>
          <Button variant="ghost" size="sm" leadingIcon={QrCode} onClick={onShowAddress}>
            Show address
          </Button>
        </div>

        <Card.Section className="mt-5 pt-5">
          <SalesKeysSection />
        </Card.Section>

        <Card.Section className="mt-5 pt-5">
          <form id="kit-address" onSubmit={(event) => void submit(event)} noValidate>
            <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Kit address</h2>
            <p className="mt-1 text-xs text-[var(--v2-ink-3)]">Where your kit runs. Haven reads your product list from it.</p>
            <label htmlFor="sales-kit-address" className="mb-1.5 mt-3 block text-sm font-medium text-[var(--v2-ink)]">
              Kit address
            </label>
            {catalogue.loading && catalogue.data === null ? (
              <Skeleton variant="rect" className="h-9 w-full max-w-xl" />
            ) : (
              <div className="flex max-w-xl flex-col gap-2 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1">
                  <Input
                    id="sales-kit-address"
                    ref={inputRef}
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    placeholder="https://your-kit.example.com"
                    value={value}
                    onChange={(event) => {
                      setValue(event.target.value)
                      setError(null)
                    }}
                    invalid={error !== null}
                    helperText={error ?? kitHelper(catalogue.data)}
                    helperTextId="sales-kit-address-help"
                    aria-describedby="sales-kit-address-help"
                    disabled={catalogue.saving}
                  />
                </div>
                <Button type="submit" variant="ghost" disabled={catalogue.saving || unchanged}>
                  {catalogue.saving ? 'Saving…' : 'Save'}
                </Button>
              </div>
            )}
          </form>
        </Card.Section>

        <StripeDepositAddressesSection chainId={account.chain_id} />
      </Card>
    </div>
  )
}

export default SalesSetupTab
