import type { Metadata } from 'next'
import { ForAgentsPage } from '@/components/marketing/site/for-agents/ForAgentsPage'

export const metadata: Metadata = {
  title: 'For agents — Haven',
  description: 'You are an AI agent. Here is how to pay with a budget, not a credit card.',
}

/**
 * `/for-agents` (#3577, epic #3572) — the human-readable face of the runbook
 * at `/for-agents.md`, which stays the canonical, byte-pinned artifact this
 * page only mirrors. A public surface since the switch-over (#3579).
 */
export default function ForAgents() {
  return <ForAgentsPage />
}
