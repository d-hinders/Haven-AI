'use client'

import { QrCode, ReceiptText } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Icon } from '@/components/ui/Icon'
import { StepChecklist, type StepChecklistRow } from '@/components/ui/StepChecklist'

/**
 * The first-run state (#4900, approved on #4894): the Sales account has
 * never been paid. An empty state that says what will appear, then the three
 * steps that connect a kit to Haven.
 *
 * Payments count as soon as they arrive, with or without these steps — the
 * chain is the truth — so the checklist is guidance, not a gate. Step 1 is
 * the clear next action (the address exists the moment Sales is on, and the
 * kit needs it). Step 2, the keys, is #4905 and not shipped, so it is honest
 * text with no button; step 3 is the Setup tab's kit address.
 */
export function SalesFirstRun({
  onShowAddress,
  setupHref,
}: {
  onShowAddress: () => void
  setupHref: string
}) {
  const rows: StepChecklistRow[] = [
    {
      id: 'receiving-address',
      state: 'active',
      number: 1,
      title: 'Put your receiving address in your kit',
      description: 'Your kit asks buyers to pay this address.',
      action: (
        <Button size="sm" leadingIcon={QrCode} onClick={onShowAddress} className="w-full sm:w-auto">
          Show address
        </Button>
      ),
    },
    {
      id: 'sales-key',
      state: 'pending',
      number: 2,
      title: 'Create a Sales key',
      description:
        'Your kit uses it to tell Haven what each payment was for. It can’t move money. Creating Sales keys on this page is coming.',
    },
    {
      id: 'kit-address',
      state: 'pending',
      actionable: true,
      number: 3,
      title: 'Tell Haven where your kit runs',
      description: 'So Sales can name your products.',
      action: (
        <Button href={`${setupHref}#kit-address`} variant="ghost" size="sm" className="w-full sm:w-auto">
          Add kit address
        </Button>
      ),
    },
  ]

  return (
    <div className="mt-6 space-y-4" data-testid="sales-first-run">
      <Card hover={false} className="p-6">
        <EmptyState
          bare
          icon={<Icon icon={ReceiptText} className="h-full w-full" />}
          tone="brand"
          title="No sales yet"
          body="When someone pays your Sales account, the payment shows here, with what it was for once your kit reports it."
        />
      </Card>
      <Card hover={false} className="overflow-hidden">
        <Card.Header
          as="h2"
          titleId="sales-first-run-steps"
          title="Get your first sale"
          description="Three things connect your kit to Haven. Payments count as soon as they arrive, even before these are done."
        />
        <div className="p-5">
          <StepChecklist aria-labelledby="sales-first-run-steps" headingAs="p" numbered rows={rows} />
        </div>
      </Card>
    </div>
  )
}

export default SalesFirstRun
