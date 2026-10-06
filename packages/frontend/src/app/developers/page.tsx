import type { Metadata } from 'next'
import { DevelopersPage } from '@/components/marketing/site/developers/DevelopersPage'

export const metadata: Metadata = {
  title: 'For developers — Haven',
  description:
    'Bring your own agent. One command connects an agent, a local signer holds the only key, the budget is enforced on-chain.',
}

/** `/developers` (#3577, epic #3572), a public surface since the switch-over (#3579). */
export default function Developers() {
  return <DevelopersPage />
}
