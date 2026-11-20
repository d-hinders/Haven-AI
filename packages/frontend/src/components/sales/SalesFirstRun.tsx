'use client'

import { QrCode, ReceiptText } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Icon } from '@/components/ui/Icon'
import { StepChecklist, type StepChecklistRow, type StepChecklistState } from '@/components/ui/StepChecklist'
import type { UseMerchantCatalogueResult } from '@/hooks/useMerchantCatalogue'
import { useMerchantKeys } from '@/hooks/useMerchantKeys'
import { catalogueView } from '@/lib/sales'
import { MerchantKitSetupPrompt } from './MerchantKitSetupPrompt'
import { SellerDefinition } from './SellerDefinition'

/** The count stays over three even though step 3 is optional (#4985). */
const STEP_COUNT = 3

/**
 * The first-run state (#4900, approved on #4894; observed steps and the seller
 * definition by #4985): the Sales account has never been paid.
 *
 * The seller is introduced FIRST — `SellerDefinition` sits above the empty
 * state, so "…once your seller reports it" comes after the definition. Then the
 * three steps that connect a seller to Haven.
 *
 * **Each step's state comes from a read, and no step is ever done without an
 * observation** (#4985):
 *
 * 1. *Put your receiving address in your seller* — `catalogueView === 'ok'`.
 *    The backend records `ok` only when the seller's document names this
 *    network and its `payTo` is this account.
 * 2. *Create a Sales key* — at least one key with `revoked_at === null`.
 * 3. *Add your product list (optional)* — an address is saved AND its last read
 *    reached a kit document (`ok` or `mismatch`). On `mismatch` the seller
 *    answers but pays elsewhere, so step 3 can be done while step 1 is not, and
 *    step 1's row says which part is wrong. `mismatch_reason` is free text and
 *    is never parsed.
 *
 * A step may UN-TICK: a scheduled read that turns `ok` into `unreachable`, or a
 * revoked key, puts the step back to not done (owner decision 2026-11-19, "Yes,
 * it can un-tick"). The checklist is guidance, not a gate — payments count as
 * soon as they arrive — so a failed read leaves its step not done and shows no
 * error, and while either read is loading no step shows done and no count
 * renders.
 *
 * The first step not done is `active`; the rows after it are `pending` and stay
 * `actionable`. Done rows carry no action, following the dashboard guide's
 * precedent. The keys read is this helper's own `useMerchantKeys` instance, so
 * `SalesKeysSection`'s signature stays unchanged.
 */
export function SalesFirstRun({
  catalogue,
  account,
  onShowAddress,
  setupHref,
}: {
  catalogue: UseMerchantCatalogueResult
  account: { name: string; chain_id: number; account_address: string }
  onShowAddress: () => void
  setupHref: string
}) {
  const keys = useMerchantKeys()

  // A settled read is the only thing that may mark a step done. `loading` is
  // true while either read is in flight, so no step flips from active to done
  // after first paint without an answer.
  const loading = (catalogue.loading && catalogue.data === null) || keys.loading
  const view = catalogue.data === null ? null : catalogueView(catalogue.data)

  const done = [
    !loading && view === 'ok',
    !loading && keys.keys.some((key) => key.revoked_at === null),
    !loading &&
      catalogue.data !== null &&
      catalogue.data.deployment_url !== null &&
      (view === 'ok' || view === 'mismatch'),
  ]
  const doneCount = done.filter(Boolean).length
  const allDone = doneCount === STEP_COUNT
  const firstOpen = done.indexOf(false)

  const stateOf = (index: number): StepChecklistState => {
    if (done[index]) return 'done'
    return index === firstOpen ? 'active' : 'pending'
  }

  const step1Description = [
    'Your seller asks buyers to pay this address.',
    view === 'mismatch' ? 'Your seller’s product list pays another account or network.' : null,
    'Haven confirms this when it reads your product list, or at your first sale.',
  ]
    .filter(Boolean)
    .join(' ')

  const rows: StepChecklistRow[] = [
    {
      id: 'receiving-address',
      state: stateOf(0),
      number: 1,
      title: 'Put your receiving address in your seller',
      description: step1Description,
      action: done[0] ? undefined : (
        <Button size="sm" leadingIcon={QrCode} onClick={onShowAddress} className="w-full sm:w-auto">
          Show address
        </Button>
      ),
    },
    {
      id: 'sales-key',
      state: stateOf(1),
      actionable: !done[1],
      number: 2,
      title: 'Create a Sales key',
      description: 'Your seller uses it to tell Haven what each payment was for. It can’t move money.',
      action: done[1] ? undefined : (
        <Button href={`${setupHref}#sales-keys`} variant="ghost" size="sm" className="w-full sm:w-auto">
          Go to Sales keys
        </Button>
      ),
    },
    {
      id: 'kit-address',
      state: stateOf(2),
      actionable: !done[2],
      number: 3,
      title: 'Add your product list (optional)',
      description: 'So Sales can name your products.',
      action: done[2] ? undefined : (
        <Button href={`${setupHref}#kit-address`} variant="ghost" size="sm" className="w-full sm:w-auto">
          Add product list address
        </Button>
      ),
    },
  ]

  return (
    <div className="mt-6 space-y-4" data-testid="sales-first-run">
      <Card hover={false} className="p-6">
        <SellerDefinition />
        <div className="mt-5 border-t border-[var(--v2-border)] pt-5">
          <EmptyState
            bare
            icon={<Icon icon={ReceiptText} className="h-full w-full" />}
            tone="brand"
            title="No sales yet"
            body="When someone pays your Sales account, the payment shows here, with what it was for once your seller reports it."
          />
        </div>
      </Card>
      <Card hover={false} className="overflow-hidden">
        <Card.Header
          as="h2"
          titleId="sales-first-run-steps"
          title="Get your first sale"
          description={
            allDone
              ? 'Your seller is connected. Sales appear here when someone pays.'
              : 'Two things connect your seller to Haven, and a third is optional. Payments count as soon as they arrive, even before these are done.'
          }
          actions={
            loading ? undefined : (
              <span className="text-xs text-[var(--v2-ink-3)] v2-tabular" data-testid="sales-first-run-count">
                {`${doneCount} of ${STEP_COUNT} done`}
              </span>
            )
          }
        />
        <div className="p-5">
          <StepChecklist aria-labelledby="sales-first-run-steps" headingAs="p" numbered rows={rows} />
          <MerchantKitSetupPrompt
            accountAddress={account.account_address}
            chainId={account.chain_id}
            className="mt-5 border-t border-[var(--v2-border)] pt-5"
          />
        </div>
      </Card>
    </div>
  )
}

export default SalesFirstRun
