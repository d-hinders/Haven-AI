import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ProtocolsPage } from '@/components/marketing/site/how-it-works/ProtocolsPage'
import { isNewSiteVisible } from '@/lib/site-gate'

export const metadata: Metadata = {
  title: 'Protocols — Haven',
  description: 'x402 and Stripe MPP side by side: one payment flow, one budget, the same receipt.',
}

/**
 * `/how-it-works/protocols` (#3576, epic #3572). It exists only where the
 * build-time site gate is on and 404s everywhere else, production included,
 * until the switch-over (#3579) removes the gate and redirects the three
 * `/protocols*` pages here. It is not in `PUBLIC_SURFACES` until then.
 */
export default function Protocols() {
  if (!isNewSiteVisible()) notFound()
  return <ProtocolsPage />
}
