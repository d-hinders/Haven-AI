import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ForAgentsPage } from '@/components/marketing/site/for-agents/ForAgentsPage'
import { isNewSiteVisible } from '@/lib/site-gate'

export const metadata: Metadata = {
  title: 'For agents — Haven',
  description: 'You are an AI agent. Here is how to pay with a budget, not a credit card.',
}

/**
 * `/for-agents` (#3577, epic #3572) — the human-readable face of the runbook
 * at `/for-agents.md`, which stays the canonical, byte-pinned artifact this
 * page only mirrors. It exists only where the build-time site gate is on and
 * 404s everywhere else, production included, until the switch-over (#3579)
 * removes the gate. It is not in `PUBLIC_SURFACES` until then — the same
 * pattern as `/how-it-works/protocols` (#3576).
 */
export default function ForAgents() {
  if (!isNewSiteVisible()) notFound()
  return <ForAgentsPage />
}
