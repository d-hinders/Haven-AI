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
import { MerchantKitSetupPrompt } from './MerchantKitSetupPrompt'
import { SalesKeysSection } from './SalesKeysSection'
import { SellerDefinition } from './SellerDefinition'
import StripeDepositAddressesSection from './StripeDepositAddressesSection'

/**
 * The helper under the product list address: what Haven reads, then what the
 * last read said. Seller-neutral (#4985): the address belongs to whatever the
 * merchant runs, not to the merchant kit.
 */
function productListHelper(catalogue: SalesCatalogue | null): React.ReactNode {
  const base = (
    <>
      The public address of your seller. Haven reads its product list from{' '}
      <span className="font-mono">/.well-known/x402</span> there and never sends anything to it.
    </>
  )
  if (catalogue === null || catalogue.deployment_url === null) return base
  const view = catalogueView(catalogue)
  const when = catalogue.last_read_at ? ` ${timeAgo(catalogue.last_read_at)}` : ''
  if (view === 'ok') return `Last read${when}. Products shows what it found.`
  if (view === 'never') return 'Saved. Haven has not read it yet. Products shows what it finds.'
  return `Saved. Haven couldn’t use it${when ? ` when it tried${when}` : ''}. Products says why.`
}

/**
 * The Setup tab (#4900, approved on #4894; the seller definition and the
 * optional product list address by #4985): where a seller is connected to the
 * Sales account — the receiving address, the Sales keys (a slot #4905 owns),
 * the product list address and, since #4983, the Stripe deposit addresses. One
 * Card, one `Card.Section` per part.
 *
 * - **The seller definition** opens the card, before Receiving address, so the
 *   word "seller" is introduced before any other use of it in this view.
 * - **Receiving address**: opens the Receive dialog the page already holds for
 *   the Sales account; no address is printed here.
 * - **Sales keys**: `SalesKeysSection`.
 * - **Product list address (optional)**: saved through
 *   `PUT /merchant-catalogue/deployment`, which stores and reads it at once. A
 *   refusal reads as the route words it. The first-run step "Add your product
 *   list (optional)" links here with `#kit-address`, and the field takes focus.
 *   The `#kit-address` anchor id and the `sales-kit-address*` ids stay: the
 *   first-run step links to the anchor. "Optional" means it may be left empty;
 *   removing an address once saved is out of scope (the route has no DELETE).
 * - **Set up with your coding agent**: `MerchantKitSetupPrompt`, the same
 *   function the first-run helper uses. Base Sepolia only.
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
  account: { name: string; chain_id: number; account_address: string }
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
      setError('Enter your seller’s address.')
      return
    }
    setError(null)
    const result = await catalogue.saveDeployment(trimmed)
    if (!result.ok) setError(result.message)
  }

  return (
    <div className="mt-6" data-testid="sales-setup-tab">
      <Card hover={false} className="p-5 md:p-6">
        <SellerDefinition />

        <div id="receiving-address" className="mt-5 flex flex-wrap items-start justify-between gap-3 border-t border-[var(--v2-border)] pt-5">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Receiving address</h2>
            <p className="mt-1 text-xs text-[var(--v2-ink-3)]">Put this in your seller as the address payments go to.</p>
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
            <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Product list address</h2>
            <p className="mt-1 text-xs text-[var(--v2-ink-3)]">Where your seller runs. Haven reads your product list from it.</p>
            <label htmlFor="sales-kit-address" className="mb-1.5 mt-3 block text-sm font-medium text-[var(--v2-ink)]">
              Product list address (optional)
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
                    placeholder="https://your-seller.example.com"
                    value={value}
                    onChange={(event) => {
                      setValue(event.target.value)
                      setError(null)
                    }}
                    invalid={error !== null}
                    helperText={error ?? productListHelper(catalogue.data)}
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

        <Card.Section className="mt-5 pt-5">
          <MerchantKitSetupPrompt accountAddress={account.account_address} chainId={account.chain_id} />
        </Card.Section>

        <StripeDepositAddressesSection chainId={account.chain_id} />
      </Card>
    </div>
  )
}

export default SalesSetupTab
