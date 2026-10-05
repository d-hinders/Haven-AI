import type { Metadata } from 'next'
import { ProtocolsPage } from '@/components/marketing/site/how-it-works/ProtocolsPage'

export const metadata: Metadata = {
  title: 'Protocols — Haven',
  description: 'x402 and Stripe MPP side by side: one payment flow, one budget, the same receipt.',
}

/**
 * `/how-it-works/protocols` (#3576, epic #3572). Since the switch-over (#3579)
 * it is a public surface, and the three retired `/protocols*` pages and
 * `/demo/x402` redirect here (`next.config.ts`).
 */
export default function Protocols() {
  return <ProtocolsPage />
}
