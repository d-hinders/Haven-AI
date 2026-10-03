import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { DevelopersPage } from '@/components/marketing/site/developers/DevelopersPage'
import { isNewSiteVisible } from '@/lib/site-gate'

export const metadata: Metadata = {
  title: 'For developers — Haven',
  description:
    'Bring your own agent. One command connects an agent, a local signer holds the only key, the budget is enforced on-chain.',
}

/**
 * `/developers` (#3577, epic #3572). It exists only where the build-time site
 * gate is on and 404s everywhere else, production included, until the
 * switch-over (#3579) removes the gate. It is not in `PUBLIC_SURFACES` until
 * then — the same pattern as `/how-it-works/protocols` (#3576).
 */
export default function Developers() {
  if (!isNewSiteVisible()) notFound()
  return <DevelopersPage />
}
